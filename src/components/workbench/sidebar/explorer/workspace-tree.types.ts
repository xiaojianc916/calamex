import type { IWorkspaceEntry } from '@/types/editor';

/**
 * 文件树渲染用的“扁平行”模型。
 *
 * 资源管理器原先用递归组件渲染目录树；为支持虚拟化（@tanstack/vue-virtual），
 * 需要把可见的树结构拍平成一维行列表。每一行用判别联合区分类型：
 * - entry：文件 / 目录条目（携带缩进层级、是否展开、是否显示折叠箭头）
 * - loading：目录正在读取的占位行
 * - empty：空目录占位行
 * - inline-create：行内新建文件 / 文件夹的输入行
 *
 * level 表示缩进层级（与原递归组件一致，根为 0），用于复用既有的缩进样式。
 */
export type TWorkspaceTreeRow =
  | {
      type: 'entry';
      key: string;
      entry: IWorkspaceEntry;
      level: number;
      expanded: boolean;
      showChevron: boolean;
    }
  | { type: 'loading'; key: string; level: number }
  | { type: 'empty'; key: string; level: number }
  | { type: 'inline-create'; key: string; parentPath: string; level: number };
