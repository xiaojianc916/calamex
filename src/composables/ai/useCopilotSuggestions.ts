import type { Suggestion } from '@copilotkit/core';
import { useConfigureSuggestions, useSuggestions } from '@copilotkit/vue';
import { computed, onBeforeUnmount, onMounted, type Ref, ref } from 'vue';
import { aiService } from '@/services/ipc/ai.service';
import { logger } from '@/utils/logger';
import { computeBackoffDelayMs, SUGGESTION_POOL_MAX_ATTEMPTS } from './suggestionPoolBackoff';

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
/** AI 面板先完成首帧展示，再在后台慢慢加载动态建议池。 */
const BACKGROUND_POOL_START_DELAY_MS = 1_200;

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
  // 静态兜底：创建一次、永不重赋，保证任何时候都有 DISPLAY_COUNT 条可展示。
  const fallbackRef = ref<Suggestion[]>(pickFromPool(STATIC_POOL));

  // CopilotKit 运行时提供的建议 ref。我们走自建 pipeline 时它通常为空，
  // 绝不能让这个空 ref 覆盖静态兜底。
  let ckSuggestions: Ref<Suggestion[]> = ref<Suggestion[]>([]);

  try {
    useConfigureSuggestions({
      suggestions: fallbackRef.value,
      available: 'before-first-message',
    });
    const result = useSuggestions({ agentId: 'default' });
    ckSuggestions = result.suggestions as unknown as Ref<Suggestion[]>;
  } catch {
    // Provider absent — 保持空 ref，后面会回退到静态兜底。
  }

  // 走免费小模型(narrator endpoint, 例如 zhipuai/glm-4.7-flash)生成的建议词池。
  const poolSuggestions = ref<Suggestion[]>([]);

  // 组件卸载后停止后台重试，并清理待触发的定时器，避免泄漏与无谓调用。
  let disposed = false;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearRetryTimer = (): void => {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const applyPool = (pool: readonly string[] | undefined | null): boolean => {
    if (pool && pool.length > 0) {
      poolSuggestions.value = pickFromPool(pool);
      return true;
    }
    return false;
  };

  // 后台自愈：命中缓存即用；否则调小模型生成；失败按指数退避有界重试。
  // narrator 依赖 agent-sidecar 子进程，冷启动 / 瞬时抖动会让首次生成失败，
  // 过去一次失败即永久回退静态池，这里给它若干次后台补偿机会。
  const ensurePool = async (attempt = 0): Promise<void> => {
    if (disposed || poolSuggestions.value.length > 0) {
      return;
    }

    try {
      // 仅首次尝试读缓存：命中可省一次小模型调用。
      if (attempt === 0) {
        const cached = await aiService.getSuggestionPoolCache();
        if (applyPool(cached?.suggestions)) {
          return;
        }
      }

      const generated = await aiService.generateSuggestionPool({
        count: POOL_COUNT,
        locale: POOL_LOCALE,
        topics: [...POOL_TOPICS],
      });
      if (applyPool(generated?.suggestions)) {
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
        // 耗尽重试：不再静默吞错，记 error 暴露真实失败原因；UI 继续用静态兜底。
        logger.error({
          event: 'copilotkit.suggestion_pool_generate_exhausted',
          attempts: nextAttempt,
          err,
        });
        return;
      }

      logger.warn({
        event: 'copilotkit.suggestion_pool_load_failed',
        attempt: nextAttempt,
        err,
      });
      retryTimer = setTimeout(() => {
        retryTimer = null;
        void ensurePool(nextAttempt);
      }, computeBackoffDelayMs(attempt));
    }
  };

  onMounted(() => {
    // 动态建议池不是 AI 面板首屏必要内容：先显示静态兜底，等界面首帧稳定后
    // 再后台读取缓存 / 生成词池，避免挂载阶段唤醒 sidecar 或 narrator 小模型。
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void ensurePool();
    }, BACKGROUND_POOL_START_DELAY_MS);
  });

  onBeforeUnmount(() => {
    disposed = true;
    clearRetryTimer();
  });

  // 优先级：narrator 池 -> CopilotKit 池 -> 静态兜底，始终能兑出内容。
  const suggestions = computed<readonly Suggestion[]>(() => {
    const fromPool = withContent(poolSuggestions.value);
    if (fromPool.length > 0) {
      return fromPool;
    }

    const fromCopilotKit = withContent(ckSuggestions.value);
    if (fromCopilotKit.length > 0) {
      return fromCopilotKit;
    }

    return withContent(fallbackRef.value);
  });

  const suggestionTexts = computed<readonly string[]>(() =>
    suggestions.value.map((item) => item.message),
  );

  return { suggestions, suggestionTexts };
};
