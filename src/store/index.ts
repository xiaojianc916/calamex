/**
 * src/store/index.ts
 * Pinia 实例创建与插件注册（R-8.5.1）。
 *
 * 职责：
 *  - 创建唯一的 Pinia 实例并注册 pinia-plugin-persistedstate。
 *  - 执行一次性数据迁移：将旧存储格式（v0: 裸 IAppSettings 对象）
 *    迁移到新 key 体系（v1: pinia 序列化格式 { settings: IAppSettings }）。
 *
 * 迁移逻辑必须在 Pinia 初始化之前同步完成，确保 plugin hydrate
 * 能读到已迁移的数据。
 */
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';

/** 旧存储 key（v0 格式：裸 IAppSettings JSON） */
const V0_SETTINGS_KEY = 'sh-editor-app-settings';
/** v0 遗留主题 key */
const V0_LEGACY_THEME_KEY = 'sh-editor-theme';
/** 新存储 key（v1 格式：pinia-plugin-persistedstate 序列化:{settings:{...}}） */
export const APP_STORE_KEY = 'shell-ide.app';

/**
 * 数据迁移 v0 → v1。
 *
 * 规则：
 * - 若新 key 已存在，说明已迁移过；清理残留旧 key 后退出。
 * - 若旧主设置 key 存在，将其包装为 pinia 格式写入新 key；移除旧 key。
 * - 若仅存在旧主题 key，将其作为 themePreference 写入新 key；移除旧 key。
 * - 始终清除 V0_LEGACY_THEME_KEY。
 *
 * 迁移版本：1（migration version 1）
 */
function migrateV0toV1(): void {
    if (typeof window === 'undefined') return;

    let storage: Storage | null = null;
    try {
        storage = window.localStorage;
    } catch {
        return; // localStorage 被策略禁用
    }
    if (!storage) return;

    // 新 key 已存在 → 已迁移过，仅清理残留旧 key
    if (storage.getItem(APP_STORE_KEY) !== null) {
        try {
            storage.removeItem(V0_SETTINGS_KEY);
            storage.removeItem(V0_LEGACY_THEME_KEY);
        } catch {
            // ignore
        }
        return;
    }

    // 尝试从旧主设置 key 迁移（v0 格式为裸 IAppSettings JSON）
    const oldData = storage.getItem(V0_SETTINGS_KEY);
    if (oldData !== null) {
        try {
            const parsed: unknown = JSON.parse(oldData);
            // pinia-plugin-persistedstate pick:['settings'] 存储格式为 { settings: IAppSettings }
            storage.setItem(APP_STORE_KEY, JSON.stringify({ settings: parsed }));
        } catch {
            // 数据损坏，以默认值启动；不写入新 key
        }
        try {
            storage.removeItem(V0_SETTINGS_KEY);
            storage.removeItem(V0_LEGACY_THEME_KEY);
        } catch {
            // ignore
        }
        return;
    }

    // 仅存在旧主题 key（最早期版本）→ 读取主题偏好写入新 key
    const VALID_THEME_PREFS = ['dark', 'light', 'system'] as const;
    const legacyTheme = storage.getItem(V0_LEGACY_THEME_KEY);
    if (legacyTheme !== null && (VALID_THEME_PREFS as readonly string[]).includes(legacyTheme)) {
        try {
            const partialSettings = { appearance: { themePreference: legacyTheme } };
            storage.setItem(APP_STORE_KEY, JSON.stringify({ settings: partialSettings }));
        } catch {
            // ignore
        }
    }
    try {
        storage.removeItem(V0_LEGACY_THEME_KEY);
    } catch {
        // ignore
    }
}

// 迁移同步执行，必须在 Pinia 初始化前完成
migrateV0toV1();

export const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
