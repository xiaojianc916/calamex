
interface MessageOptions {
    duration?: number;
}

export function useMessage() {
    // 这里用简单的 window 事件模拟，实际项目建议用 Shadcn Toast/Alert 组件全局实现
    const show = (type: 'success' | 'error' | 'warning', message: string, options?: MessageOptions) => {
        window.dispatchEvent(
            new CustomEvent('app-message', { detail: { type, message, ...options } })
        );
    };
    return {
        success: (msg: string, options?: MessageOptions) => show('success', msg, options),
        error: (msg: string, options?: MessageOptions) => show('error', msg, options),
        warning: (msg: string, options?: MessageOptions) => show('warning', msg, options),
    };
}
