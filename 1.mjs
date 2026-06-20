// fix-usemessage-unify-pipeline.mjs
// 用法：
//   node fix-usemessage-unify-pipeline.mjs --check   # 干跑，不写盘
//   node fix-usemessage-unify-pipeline.mjs           # 应用
// 在仓库根目录(D:\com.xiaojianc\my_desktop_app)运行。改完跑 pnpm lint && pnpm typecheck && pnpm test。
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';

const REPO_ROOT = process.env.REPO_ROOT ?? process.cwd();
const CHECK_ONLY = process.argv.includes('--check') || process.argv.includes('--dry-run');

const MESSAGE_PATH = 'src/composables/useMessage.ts';
const SPEC_PATH = 'src/composables/useMessage.spec.ts';

const NEW_MESSAGE = String.raw`// composables/useMessage.ts
import { type ExternalToast, toast } from 'vue-sonner';
import { createPrefixedId } from '@/utils/core/id';

export type TMessageType = 'success' | 'error' | 'warning' | 'info' | 'loading';

export interface MessageOptions {
  /** 持续时间（毫秒）。传入 0 或 Infinity 表示不自动关闭。*/
  duration?: number;
  /** 次要说明文本。*/
  description?: string;
  /** 自定义 id；若传入相同 id 会复用/覆盖同一条消息（便于 loading → success 转换）。*/
  id?: string;
  /** 关闭时的回调。*/
  onClose?: () => void;
}

export interface MessageHandle {
  id: string;
  update: (message: string, options?: MessageOptions) => MessageHandle;
  dismiss: () => void;
}

const DEFAULT_DURATIONS: Record<TMessageType, number> = {
  success: 2400,
  info: 2400,
  warning: 3600,
  error: 4800,
  loading: Number.POSITIVE_INFINITY,
};

const toToastOptions = (options: MessageOptions | undefined): ExternalToast => ({
  ...(options?.id ? { id: options.id } : {}),
  ...(options?.description ? { description: options.description } : {}),
  ...(options?.duration !== undefined ? { duration: options.duration } : {}),
  ...(options?.onClose ? { onDismiss: options.onClose } : {}),
  closeButton: true,
});

// 统一管线：每种消息类型 → vue-sonner 渲染策略。vue-sonner 的 <Toaster>（见 App.vue）
// 是唯一的可视化通知通道。null 表示该类型默认不弹窗（success / info 静默，避免频繁打扰），
// 但仍会顺手关闭同 id 上可能残留的进行中 Toast（如 loading 转圈）。
const TOAST_RENDERERS: Record<
  TMessageType,
  ((message: string, options: ExternalToast) => void) | null
> = {
  success: null,
  info: null,
  warning: (message, options) => toast.warning(message, options),
  error: (message, options) => toast.error(message, options),
  loading: (message, options) => toast.loading(message, options),
};

/** 生成消息唯一 ID，复用 utils/core/id.ts 的 UUID 标准实现。*/
const generateMessageId = (): string => createPrefixedId('msg');

const showMessage = (
  type: TMessageType,
  message: string,
  options?: MessageOptions,
): MessageHandle => {
  const id = options?.id ?? generateMessageId();
  const duration = options?.duration ?? DEFAULT_DURATIONS[type];

  const render = TOAST_RENDERERS[type];
  if (render) {
    render(message, toToastOptions({ ...options, id, duration }));
  } else if (options?.id) {
    // 静默类型（success / info）：清除同 id 上可能残留的进行中 Toast（如 loading → success）。
    toast.dismiss(options.id);
  }

  return {
    id,
    update: (nextMessage, nextOptions) =>
      showMessage(type, nextMessage, { ...options, ...nextOptions, id }),
    dismiss: () => toast.dismiss(id),
  };
};

export function useMessage() {
  const factory =
    (type: TMessageType) =>
    (message: string, options?: MessageOptions): MessageHandle =>
      showMessage(type, message, options);

  const success = factory('success');
  const error = factory('error');
  const warning = factory('warning');
  const info = factory('info');
  const loading = factory('loading');

  /**
   * 把一个 Promise 绑定到一条消息上：进行中显示 loading，成功/失败自动切换文案。
   * 支持 messages 的字符串或函数形式。
   */
  const promise = <T>(
    input: Promise<T> | (() => Promise<T>),
    messages: {
      loading: string;
      success: string | ((value: T) => string);
      error: string | ((reason: unknown) => string);
    },
    options?: MessageOptions,
  ): Promise<T> => {
    const handle = loading(messages.loading, { ...options, duration: Number.POSITIVE_INFINITY });
    const run = typeof input === 'function' ? input() : input;
    return run.then(
      (value) => {
        const text =
          typeof messages.success === 'function' ? messages.success(value) : messages.success;
        showMessage('success', text, { ...options, id: handle.id });
        return value;
      },
      (reason) => {
        const text = typeof messages.error === 'function' ? messages.error(reason) : messages.error;
        showMessage('error', text, { ...options, id: handle.id });
        throw reason;
      },
    );
  };

  /** 按 id 关闭；不传 id 表示关闭全部。*/
  const dismiss = (id?: string): void => {
    toast.dismiss(id);
  };

  return {
    success,
    error,
    warning,
    info,
    loading,
    promise,
    dismiss,
  };
}

export type UseMessageReturn = ReturnType<typeof useMessage>;
`;

const NEW_SPEC = String.raw`import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMessage } from '@/composables/useMessage';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  loading: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock('vue-sonner', () => ({
  toast: toastMock,
}));

describe('useMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('error 通过 Sonner toast 弹出，并透传 id/description/duration', () => {
    const handle = useMessage().error('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
    });

    expect(handle.id).toBe('save-error');
    expect(toastMock.error).toHaveBeenCalledWith('保存失败', {
      id: 'save-error',
      description: '网络连接中断，请稍后重试。',
      duration: 7_000,
      closeButton: true,
    });
  });

  it('dismiss(id) 关闭对应的 Sonner toast', () => {
    useMessage().dismiss('save-error');
    expect(toastMock.dismiss).toHaveBeenCalledWith('save-error');
  });

  it('成功消息不弹出 Toast，但会清除同 id 上残留的进行中 Toast', () => {
    useMessage().success('保存成功', { id: 'save-ok' });
    expect(toastMock.success).not.toHaveBeenCalled();
    expect(toastMock.dismiss).toHaveBeenCalledWith('save-ok');
  });

  it('info 提示不弹出 Toast', () => {
    useMessage().info('仅供参考的提示');
    expect(toastMock.info).not.toHaveBeenCalled();
  });

  it('警告与错误仍然弹出 Toast', () => {
    useMessage().warning('请注意检查输入');
    useMessage().error('操作失败');
    expect(toastMock.warning).toHaveBeenCalledTimes(1);
    expect(toastMock.error).toHaveBeenCalledTimes(1);
  });

  it('loading 进度仍然弹出 Toast', () => {
    useMessage().loading('正在保存…');
    expect(toastMock.loading).toHaveBeenCalledTimes(1);
  });
});
`;

// ① 安全检查：除目标文件外，全仓不得有任何 app-message / MessageDetail / DismissDetail 消费方。
const SCAN_DIR = resolve(REPO_ROOT, 'src');
const TARGETS = new Set([resolve(REPO_ROOT, MESSAGE_PATH), resolve(REPO_ROOT, SPEC_PATH)]);
const NEEDLES = ['app-message', 'MessageDetail', 'DismissDetail'];
const offenders = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs);
      continue;
    }
    if (!/\.(ts|tsx|vue|js|mjs)$/.test(name) || TARGETS.has(abs)) continue;
    const text = readFileSync(abs, 'utf8');
    const hit = NEEDLES.find((n) => text.includes(n));
    if (hit) offenders.push(relative(REPO_ROOT, abs) + '  ←  ' + hit);
  }
};
if (existsSync(SCAN_DIR)) walk(SCAN_DIR);
if (offenders.length > 0) {
  console.error('✗ 仍有文件引用旧事件通道，已中止以免破坏功能：');
  for (const f of offenders) console.error('   - ' + f);
  process.exit(1);
}
console.log('✓ 安全检查通过：除 useMessage 自身外，无任何 app-message 消费方。');

// ② 幂等写入（旧指纹校验）
const apply = (relPath, next, oldSentinel, newSentinel) => {
  const abs = resolve(REPO_ROOT, relPath);
  if (!existsSync(abs)) {
    console.error('✗ 找不到文件: ' + relPath);
    process.exit(1);
  }
  const cur = readFileSync(abs, 'utf8');
  if (!cur.includes(oldSentinel) && cur.includes(newSentinel)) {
    console.log('= 已是新版本，跳过: ' + relPath);
    return;
  }
  if (!cur.includes(oldSentinel)) {
    console.error('✗ 内容与预期旧版本不符（缺 "' + oldSentinel + '"），中止: ' + relPath);
    process.exit(1);
  }
  if (CHECK_ONLY) {
    console.log('- 将重写: ' + relPath);
    return;
  }
  writeFileSync(abs, next, 'utf8');
  console.log('✓ 已重写: ' + relPath);
};

apply(MESSAGE_PATH, NEW_MESSAGE, 'app-message', 'TOAST_RENDERERS');
apply(SPEC_PATH, NEW_SPEC, 'app-message', 'dismiss(id) 关闭对应的 Sonner toast');

console.log(
  CHECK_ONLY
    ? '--check 完成（未写盘）。'
    : '完成。请运行: pnpm lint && pnpm typecheck && pnpm test（git restore 可还原）。',
);