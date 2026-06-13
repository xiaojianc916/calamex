// ═══════════════════════════════════════════════════════════════
// Shell 片段库 — 图标名映射
// 将目录中语义化的图标 ID 映射为 LucideIcon 使用的 mask 类名。
// 类别图标与片段图标共用此映射，避免在多个组件中重复维护。
// ═══════════════════════════════════════════════════════════════

/** 语义图标 ID → LucideIcon mask 名称 */
export const TEMPLATE_ICON_MAP: Record<string, string> = {
  // 类别图标
  star: 'star',
  clock: 'clock',
  rocket: 'rocket',
  'book-open': 'book-open',
  terminal: 'terminal',
  settings: 'settings',
  'shield-check': 'shield-check',
  lock: 'lock',
  type: 'type',
  braces: 'braces',
  calendar: 'calendar',
  database: 'database',
  'message-square': 'message-square',
  list: 'list',
  loader: 'loader',
  'file-text': 'file-text',
  'git-branch': 'git-branch',
  folder: 'folder',
  'file-search': 'file-search',
  cpu: 'cpu',
  globe: 'globe',
  'bar-chart-2': 'chart-bar', // ChartBar
  bell: 'bell',
  'alert-triangle': 'alert-triangle',
  'trash-2': 'trash-2',
  'log-out': 'log-out',
  bug: 'bug',
  shield: 'shield',
  'test-tube': 'test-tube',
  // 片段图标
  info: 'info',
  'rotate-cw': 'rotate-cw',
  'refresh-cw': 'refresh-cw',
  hash: 'hash',
  tag: 'tag',
  'help-circle': 'help-circle',
  flag: 'flag',
  'arrow-right': 'arrow-right',
  key: 'key',
  layers: 'layers',
  file: 'file',
  search: 'search',
  package: 'package',
  monitor: 'monitor',
  'user-check': 'user-check',
  'hard-drive': 'hard-drive',
  scissors: 'scissors',
  'arrow-down-az': 'arrow-down-a-z', // 路径是 a-z
  'arrow-up-az': 'arrow-up-a-z', // 路径是 a-z
  replace: 'replace',
  'text-cursor-input': 'text-cursor-input',
  'at-sign': 'at-sign',
  brackets: 'brackets',
  repeat: 'repeat',
  'git-branch-plus': 'git-branch-plus',
  combine: 'combine',
  'calendar-minus': 'calendar-minus',
  'calendar-clock': 'calendar-clock',
  filter: 'filter',
  wrench: 'wrench',
  'arrow-left-right': 'arrow-left-right',
  'mouse-pointer': 'mouse-pointer',
  'chevron-right': 'chevron-right',
  'list-ordered': 'list-ordered',
  'octagon-alert': 'octagon-alert',
  save: 'save',
  'timer-off': 'timer-off',
  'git-fork': 'git-fork',
  'file-check': 'file-check',
  'file-plus': 'file-plus',
  'file-clock': 'file-clock',
  'file-x': 'file-x',
  copy: 'copy',
  ruler: 'ruler',
  table: 'table-2', // Table2
  'arrow-up-down': 'arrow-up-down',
  cone: 'cone',
  ban: 'ban',
  send: 'send',
  plug: 'plug',
  mail: 'mail',
  webhook: 'webhook',
  'message-circle': 'message-circle',
  'bell-ring': 'bell-ring',
  skull: 'skull',
  asterisk: 'asterisk',
  broom: 'brush', // Brush
  'folder-x': 'folder-x',
  'undo-2': 'undo-2',
  code: 'code-xml', // CodeXml
  'terminal-square': 'square-terminal', // SquareTerminal
  'eye-off': 'eye-off',
  equal: 'equal',
  'grid-3x3': 'grid-3x3',
  'file-code': 'file-code',
  check: 'check',
  'shield-alert': 'alert-triangle', // 近似
  regex: 'brackets', // 近似
  'text-cursor': 'text-cursor-input', // 近似
  'bar-chart': 'chart-bar', // ChartBar
  pipeline: 'file', // 近似
};

/** 未命中映射时回退到的通用代码图标。 */
const FALLBACK_ICON = 'file-code';

/** 解析片段/类别图标名，未命中时回退到通用代码图标。 */
export function getIcon(name: string): string {
  return TEMPLATE_ICON_MAP[name] ?? FALLBACK_ICON;
}
