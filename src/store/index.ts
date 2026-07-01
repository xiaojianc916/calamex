/**
 * src/store/index.ts
 * Pinia 实例创建与插件注册 (R-8.5.1)。
 *
 * 职责:
 *  - 创建唯一的 Pinia 实例并注册 pinia-plugin-persistedstate。
 *  - 执行一次性数据迁移:将旧存储格式 (v0: 裸 IAppSettings 对象)
 *    迁移到新 key 体系 (v1: pinia 序列化格式 { settings: IAppSettings })。
 *
 * 迁移逻辑必须在 Pinia 初始化之前同步完成,确保 plugin hydrate
 * 能读到已迁移的数据。
 *
 * 注意:本模块的 import 副作用就是触发迁移。测试中如需 stub
 * window.localStorage,必须在 import './store/index' 之前完成。
 */
import { createPinia } from 'pinia';
import piniaPluginPersistedstate from 'pinia-plugin-persistedstate';

/** 旧存储 key (v0 格式:裸 IAppSettings JSON) */
const V0_SETTINGS_KEY = 'sh-editor-app-settings';
/** v0 遗留主题 key */
const V0_LEGACY_THEME_KEY = 'sh-editor-theme';
/** 新存储 key (v1 格式:pinia-plugin-persistedstate 序列化 {settings:{...}}) */
export const APP_STORE_KEY = 'shell-ide.app';

const VALID_THEME_PREFS = ['dark', 'light', 'system'] as const;
type TLegacyThemePref = (typeof VALID_THEME_PREFS)[number];

const isValidThemePref = (value: string | null): value is TLegacyThemePref =>
  value !== null && (VALID_THEME_PREFS as readonly string[]).includes(value);

/**
 * removeItem 在规范上不抛错,但部分受限环境 (沙箱 / 严格隐私模式) 行为不稳。
 * 用统一 helper 把样板 try/catch 包起来。
 */
const safeRemoveItem = (storage: Storage, key: string): void => {
  try {
    storage.removeItem(key);
  } catch {
    // 受限环境:无视
  }
};

/**
 * 尝试将 v0 payload 包装写入 APP_STORE_KEY。
 *
 * 返回 `'ok'` 表示新 key 已写入,可以安全删除旧 key;
 * 返回 `'corrupted'` 表示旧数据无法 parse,删除旧 key 让其以默认值启动;
 * 返回 `'write-failed'` 表示新 key 写入失败 (quota / disabled),
 *   **必须保留旧 key**,下次启动再试。
 */
const tryWriteV1Payload = (
  storage: Storage,
  rawOldData: string,
  wrap: (parsed: unknown) => unknown,
): 'ok' | 'corrupted' | 'write-failed' => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawOldData);
  } catch {
    return 'corrupted';
  }
  try {
    storage.setItem(APP_STORE_KEY, JSON.stringify(wrap(parsed)));
    return 'ok';
  } catch {
    return 'write-failed';
  }
};

/**
 * 数据迁移 v0 → v1。
 *
 * 规则:
 * - 若新 key 已存在,说明已迁移过;清理残留旧 key 后退出。
 * - 若旧主设置 key 存在,将其包装为 pinia 格式写入新 key;
 *   **仅在写入成功或源数据损坏时删除旧 key**;若写入失败 (quota) 则保留,
 *   下次启动重试,避免用户设置丢失。
 * - 若仅存在旧主题 key,将其作为 themePreference 写入新 key,语义同上。
 *
 * 迁移版本:1 (migration version 1)
 */
const MIGRATION_DONE_FLAG = 'shell-ide.migrated.v1';

function migrateV0toV1(): void {
  if (typeof window === 'undefined') return;
  // 已迁移过：一次布尔判断即返回，省去多次旧 key 探测。
  try {
    if (window.localStorage.getItem(MIGRATION_DONE_FLAG) === '1') return;
  } catch {
    return;
  }

  let storage: Storage;
  try {
    storage = window.localStorage;
  } catch {
    return; // localStorage 被策略禁用
  }

  // 新 key 已存在 → 已迁移过,仅清理残留旧 key
  if (storage.getItem(APP_STORE_KEY) !== null) {
    safeRemoveItem(storage, V0_SETTINGS_KEY);
    safeRemoveItem(storage, V0_LEGACY_THEME_KEY);
    return;
  }

  // 路径 A:从旧主设置 key 迁移
  const oldSettings = storage.getItem(V0_SETTINGS_KEY);
  if (oldSettings !== null) {
    const result = tryWriteV1Payload(storage, oldSettings, (parsed) => ({
      settings: parsed,
    }));
    if (result === 'ok' || result === 'corrupted') {
      // 成功迁移,或源已损坏 → 都应清掉旧 key
      safeRemoveItem(storage, V0_SETTINGS_KEY);
      safeRemoveItem(storage, V0_LEGACY_THEME_KEY);
    }
    // result === 'write-failed':保留旧 key,下次启动再迁移
    return;
  }

  // 路径 B:仅存在旧主题 key (最早期版本) → 读取主题偏好写入新 key
  const legacyTheme = storage.getItem(V0_LEGACY_THEME_KEY);
  if (isValidThemePref(legacyTheme)) {
    try {
      storage.setItem(
        APP_STORE_KEY,
        JSON.stringify({
          settings: { appearance: { themePreference: legacyTheme } },
        }),
      );
      // 写入成功才删旧 key
      safeRemoveItem(storage, V0_LEGACY_THEME_KEY);
    } catch {
      // 写入失败:保留旧 theme key 下次再试
    }
    return;
  }

  // 没有可识别的旧数据 (或值非合法主题字符串) → 仍然清掉这个孤儿 key
  safeRemoveItem(storage, V0_LEGACY_THEME_KEY);
}

// 迁移同步执行,必须在 Pinia 初始化前完成
migrateV0toV1();
try {
  window.localStorage.setItem('shell-ide.migrated.v1', '1');
} catch {
  /* 受限环境:无视,下次再探测 */
}

export const pinia = createPinia();
pinia.use(piniaPluginPersistedstate);
