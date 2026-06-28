import { computed, onBeforeUnmount, onMounted, type Ref, ref } from 'vue';
import { aiService } from '@/services/ipc/ai.service';
import { logger } from '@/utils/platform/logger';
import { computeBackoffDelayMs, SUGGESTION_POOL_MAX_ATTEMPTS } from './suggestionPoolBackoff';

/**
 * 空态建议项视图模型。
 *
 * 历史上此类型借用 @copilotkit/core 的 `Suggestion`；移除 CopilotKit 第二管线后，
 * 这里内联一个等价的最小自有类型，彻底切断对该依赖的耦合（建议生成本就走自建
 * pipeline：静态兜底池 + narrator 词池缓存，从不经过 CopilotKit 运行时）。
 */
export interface Suggestion {
  title: string;
  message: string;
  isLoading: boolean;
}

/**
 * 兜底建议池：免费小模型(narrator)不可用时使用。
 * 严格按 src-tauri/src/ai/gateway/suggestions.rs 的规则编写：
 * - 每条 7-15 个汉字字符；
 * - 简体中文生活/通识话题，严禁代码、编程、命令行、API、调试、配置、框架等开发话题；
 * - 覆盖 健康/生活/科学/文学/历史/艺术/学习/效率/旅行/饮食/心理/科技/自然/哲学/沟通；
 * - 疑问/祈使/陈述句式混合，末尾不带标点，任意“前两个字”重复 <= 3 次。
 * 共 90 条（对齐网关 MAX_SUGGESTION_POOL_SIZE），每次随机取 DISPLAY_COUNT 条展示。
 */
const STATIC_POOL: readonly string[] = [
  '久坐之后如何快速放松肩颈',
  '每天喝多少水才算足够',
  '为什么熬夜后更难入睡',
  '三个改善久坐的小动作',
  '讲讲深呼吸为何能减压',
  '护眼的二十二十法则',
  '衣服上的油渍怎么去除',
  '如何让毛巾恢复松软',
  '冰箱除味的几个妙招',
  '推荐几个收纳小技巧',
  '雨天鞋子快速变干的办法',
  '为什么切洋葱会让人流泪',
  '为什么天空在白天是蓝色',
  '用比喻讲讲什么是熵增',
  '彩虹是怎么形成的',
  '介绍相对论的基本思想',
  '哪些动物能在深海发光',
  '闪电和雷声为何不同步',
  '唐诗里最孤独的一句',
  '推荐一本被低估的小说',
  '为何红楼梦没有写完',
  '讲讲莎士比亚的悲剧',
  '哪些诗人写过明月',
  '比较李白和杜甫的诗风',
  '唐宋八大家为何没有李白',
  '古人怎么计算月亮距离',
  '丝绸之路到底有多长',
  '介绍一位被遗忘的发明家',
  '哪个朝代的服饰最华丽',
  '长城最初是为了防御谁',
  '用电影解释什么是存在主义',
  '介绍一种小众的乐器',
  '梵高的画为何充满漩涡',
  '怎样欣赏一幅抽象画',
  '推荐几首适合雨天的音乐',
  '哪些建筑被称为凝固音乐',
  '如何用费曼法学新知识',
  '记不住单词有什么办法',
  '间隔重复为何更高效',
  '列出三种高效笔记法',
  '怎样坚持每天阅读',
  '碎片时间能学好一门外语吗',
  '如何专注而不被打断',
  '番茄工作法到底怎么用',
  '列出告别拖延的小方法',
  '早晨第一小时该做什么',
  '怎样制定可执行的计划',
  '三个减少分心的环境改造',
  '第一次独自旅行要注意什么',
  '有哪些小众的海边小城',
  '怎么精简旅行的行李',
  '有哪些经典的徒步路线',
  '长途飞行怎么缓解疲劳',
  '旅行为何能缓解焦虑',
  '一道适合周末做的家常菜',
  '面包为何要二次发酵',
  '泡好一杯手冲咖啡的窍门',
  '哪种地方小吃值得一试',
  '隔夜饭菜还能放心吃吗',
  '三种解腻又开胃的饮品',
  '焦虑的时候怎么平静下来',
  '为何独处也是一种能力',
  '三个缓解压力的小习惯',
  '慢慢建立自信的方法',
  '拖延背后的心理原因',
  '哪种习惯能提升幸福感',
  '手机电池为何越用越不耐用',
  '卫星是怎么定位你的位置',
  '手机为何越用越卡',
  '微波炉加热食物的原理',
  '无线充电到底是什么原理',
  '有哪些科技来自航天',
  '候鸟如何找到迁徙方向',
  '树叶到了秋天为何变红',
  '大海的颜色为何会变化',
  '哪种植物能在沙漠存活',
  '萤火虫为何会发光',
  '一种奇特的深海生物',
  '自由意志真的存在吗',
  '用电车难题聊聊选择',
  '什么是真正的幸福生活',
  '我们为何害怕未知',
  '时间到底是不是幻觉',
  '比较东方和西方的智慧',
  '怎么拒绝别人又不伤感情',
  '第一次见面怎么找话题',
  '表达不同意见的得体方式',
  '列出几句高情商回应',
  '倾听为何比表达更重要',
  '非暴力沟通的核心是什么',
];

/** 免费小模型(narrator endpoint)建议词池请求参数。 */
const POOL_LOCALE = 'zh-CN';
/** narrator 词池请求数量，对齐网关 MAX_SUGGESTION_POOL_SIZE。 */
const POOL_COUNT = 90;
const POOL_TOPICS = [
  '健康',
  '生活小知识',
  '科学',
  '文学',
  '历史',
  '艺术',
  '学习',
  '效率',
  '旅行',
  '饮食',
  '心理',
  '科技',
  '自然',
  '哲学',
  '沟通',
] as const;
/** 空态一次展示的建议数量（多行交错铺排）。 */
const DISPLAY_COUNT = 9;
/** 建议标题最大展示长度，超出截断加省略号。 */
const TITLE_MAX_LENGTH = 15;
/**
 * 预取短超时兜底：挂载后最多等这么久就一次性铺出建议。
 * 缓存读取是本地 IPC，通常远快于此；超时即用静态兜底一次性提交，
 * 避免“先空等再弹出”，也不会出现“先静态后刷新”的二次跳变。
 */
const SUGGESTION_REVEAL_TIMEOUT_MS = 400;

const toSuggestion = (message: string): Suggestion => {
  const title =
    message.length > TITLE_MAX_LENGTH ? `${message.slice(0, TITLE_MAX_LENGTH)}…` : message;
  return { title, message, isLoading: false };
};

/** 去重 + 去空白：归一化词池，保证候选项互不相同。 */
const dedupePool = (pool: readonly string[]): string[] =>
  Array.from(new Set(pool.map((item) => item.trim()).filter(Boolean)));

/** 静态兜底池只需去重一次，后续每次抽取直接复用。 */
const STATIC_POOL_UNIQUE: readonly string[] = dedupePool(STATIC_POOL);

/**
 * 从词池里去重并随机挑选至多 DISPLAY_COUNT 条，避免每次都一样。
 * 用部分 Fisher–Yates：只洗前 k 个位置（k = 展示数），把全量 O(n) 洗牌降到 O(k)，
 * 且每次只把选中的元素与其后随机位置交换，统计上等价于完整洗牌后取前 k 个。
 */
export const pickFromPool = (pool: readonly string[]): Suggestion[] => {
  const unique = pool === STATIC_POOL ? STATIC_POOL_UNIQUE.slice() : dedupePool(pool);
  const pickCount = Math.min(DISPLAY_COUNT, unique.length);
  for (let i = 0; i < pickCount; i += 1) {
    const j = i + Math.floor(Math.random() * (unique.length - i));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, pickCount).map(toSuggestion);
};

const withContent = (items: readonly Suggestion[]): Suggestion[] =>
  items.filter((item) => item.message.trim().length > 0);

export interface IUseCopilotSuggestionsResult {
  suggestions: Ref<readonly Suggestion[]>;
  suggestionTexts: Ref<readonly string[]>;
}

export const useCopilotSuggestions = (): IUseCopilotSuggestionsResult => {
  // 静态兜底：抽取一次，作为缓存未就绪时的一次性兜底来源（永不重抽）。
  const fallbackPool = pickFromPool(STATIC_POOL);

  // 唯一对外暴露的展示集合：挂载时预取，决定后只提交一次，之后绝不替换，
  // 从根上杜绝“先显示一批、再被动态池刷新成另一批”的视觉跳变。
  const displayed = ref<Suggestion[]>([]);
  let committed = false;

  // 组件卸载后停止后台重试，并清理待触发的定时器，避免泄漏与无谓调用。
  let disposed = false;
  let revealTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRevealTimer = (): void => {
    if (revealTimer !== null) {
      clearTimeout(revealTimer);
      revealTimer = null;
    }
  };

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  // 一次性提交展示集合：首个有内容的决定生效，后续来源（含后台补偿）都不再覆盖。
  const commit = (items: readonly Suggestion[]): void => {
    if (committed || disposed) {
      return;
    }
    const next = withContent(items);
    if (next.length === 0) {
      return;
    }
    committed = true;
    clearRevealTimer();
    displayed.value = [...next];
  };

  // 兜底提交：缓存未就绪 / 短超时到点时，用静态兜底池一次性铺出。
  const commitFallback = (): void => {
    commit(fallbackPool);
  };

  // 后台补偿：仅用于把动态词池写入缓存以温暖“下次启动”，
  // 绝不回灌当前已提交的展示集合（否则又会触发二次刷新）。
  // narrator 依赖 agent-sidecar 子进程，冷启动 / 瞬时抖动会让首次生成失败，
  // 这里按指数退避做若干次有界重试。
  const warmPoolCache = async (attempt = 0): Promise<void> => {
    if (disposed) {
      return;
    }

    try {
      const generated = await aiService.generateSuggestionPool({
        count: POOL_COUNT,
        locale: POOL_LOCALE,
        topics: [...POOL_TOPICS],
      });
      if (generated?.suggestions && generated.suggestions.length > 0) {
        return;
      }

      // 调用成功但池为空：按失败处理，进入退避重试。
      throw new Error('suggestion pool is empty');
    } catch (err) {
      if (disposed) {
        return;
      }

      const nextAttempt = attempt + 1;
      if (nextAttempt >= SUGGESTION_POOL_MAX_ATTEMPTS) {
        // 耗尽重试：不再静默吞错，记 error 暴露真实失败原因；UI 继续用已提交内容。
        logger.error({
          event: 'ai.suggestion_pool_generate_exhausted',
          attempts: nextAttempt,
          err,
        });
        return;
      }

      logger.warn({
        event: 'ai.suggestion_pool_load_failed',
        attempt: nextAttempt,
        err,
      });
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void warmPoolCache(nextAttempt);
      }, computeBackoffDelayMs(attempt));
    }
  };

  // 预取：挂载即读缓存。命中且早于短超时 -> 用动态词池一次性铺出；
  // 未命中 / 失败 -> 立即兜底提交（避免空等），并后台补偿生成以温暖下次启动缓存。
  const prefetchPool = async (): Promise<void> => {
    let cachedSuggestions: readonly string[] | undefined;

    try {
      const cached = await aiService.getSuggestionPoolCache();
      cachedSuggestions = cached?.suggestions ?? undefined;
    } catch (err) {
      logger.warn({ event: 'ai.suggestion_pool_cache_failed', err });
    }

    if (disposed || committed) {
      return;
    }

    if (cachedSuggestions && cachedSuggestions.length > 0) {
      commit(pickFromPool(cachedSuggestions));
      return;
    }

    // 缓存未就绪：立即兜底提交，避免空等；并后台补偿生成温暖下次启动缓存。
    commitFallback();
    void warmPoolCache();
  };

  onMounted(() => {
    // 短超时兜底：即使缓存读取偏慢，最多等 SUGGESTION_REVEAL_TIMEOUT_MS 也会一次性铺出，
    // 不会出现“先静态、后刷新”的二次跳变。
    revealTimer = setTimeout(() => {
      revealTimer = null;
      commitFallback();
    }, SUGGESTION_REVEAL_TIMEOUT_MS);
    void prefetchPool();
  });

  onBeforeUnmount(() => {
    disposed = true;
    clearRevealTimer();
    clearRetryTimer();
  });

  // 已提交即定格：suggestions 始终是那一批一次性铺出的内容，绝不再变。
  const suggestions = computed<readonly Suggestion[]>(() => displayed.value);

  const suggestionTexts = computed<readonly string[]>(() =>
    suggestions.value.map((item) => item.message),
  );

  return { suggestions, suggestionTexts };
};
