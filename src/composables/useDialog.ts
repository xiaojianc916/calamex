
interface DialogOptions {
    title: string;
    description: string;
    confirmText?: string;
    cancelText?: string;
    variant?: 'default' | 'warning' | 'danger';
}

export function useDialog() {
    // 这里用 Promise + window 事件模拟，实际项目建议用 Shadcn Dialog 组件全局实现
    const confirm = (options: DialogOptions): Promise<void> => {
        return new Promise((resolve, reject) => {
            window.dispatchEvent(
                new CustomEvent('app-dialog', {
                    detail: {
                        ...options,
                        onConfirm: () => resolve(),
                        onCancel: () => reject('cancel'),
                    },
                })
            );
        });
    };
    return { confirm };
}
