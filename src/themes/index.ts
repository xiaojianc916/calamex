/**
 * themes/index.ts — 主题系统对外入口
 *
 * 消费者只应通过此文件 import；禁止直接 import 内部子模块。
 *
 * 公开 API：
 *  - getThemeManager()              取得单例管理器
 *  - onThemeChanged()               订阅主题切换事件（非 CSS 消费者使用）
 *  - buildTerminalTheme()           终端主题构造函数（由 useIntegratedTerminal 消费）
 *  - type IRoles                    供高级自定义插槽引用
 *  - type TVariantId                变体 ID 字面量
 *  - type IThemeChangedDetail       事件 payload
 */

export type { IXtermTheme } from './derive/terminal';
export { buildTerminalTheme } from './derive/terminal';
export type { IComponentTokens, IThemeChangedDetail, IThemeVariant, TVariantId } from './runtime/manager';
export { createThemeManager, getThemeManager, onThemeChanged } from './runtime/manager';
export type { IRoles } from './tokens/types';
