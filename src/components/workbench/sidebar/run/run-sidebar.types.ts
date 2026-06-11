// ═══════════════════════════════════════════════════════════════
// Shell 片段库 — 类型定义
// ═══════════════════════════════════════════════════════════════

export type TPhaseId = 'mine' | 'pre' | 'dat' | 'int' | 'exe' | 'out' | 'end' | 'cro';

export interface ISnippetItem {
  /** 图标 ID（对应 lucide 图标名） */
  icon: string;
  /** 触发词 */
  trigger: string;
  /** 中文描述 */
  description: string;
}

export interface ISnippetCategory {
  /** 图标 ID（对应 lucide 图标名） */
  icon: string;
  /** 类别名称 */
  name: string;
  /** 是否为新增类别 */
  isNew?: boolean;
  /** 类别下的片段列表 */
  items: ISnippetItem[];
}

export interface IPhase {
  id: TPhaseId;
  /** 阶段标签 */
  label: string;
  /** 阶段颜色 */
  color: string;
  /** 默认展开 */
  open?: boolean;
  /** 该阶段下的类别列表 */
  categories: ISnippetCategory[];
}
