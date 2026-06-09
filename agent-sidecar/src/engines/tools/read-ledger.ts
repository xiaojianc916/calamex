/**
 * 工作区「读后写」账本：记录每个文件最近一次被 read_file 读取时的 mtime。
 *
 * 取 Zed「编辑前必须先读」的安全契约 + Mastra Workspace 的 requireReadBeforeWrite
 * 钩子：禁用 Mastra 内置 read_file 后，由唯一的 read_file 工具向账本登记，
 * 写入/编辑工具的闸门据此判定该路径是否已读且未过期。
 */
export interface IWorkspaceReadLedger {
	/** 登记一次成功读取：记录该路径读取时刻的 mtime（毫秒）。 */
	record(path: string, modifiedAtMs: number): void;
	/** 该路径是否已读且自读取以来 mtime 未变（即编辑可不必再次强制读取）。 */
	isFresh(path: string, modifiedAtMs: number): boolean;
}

export const createWorkspaceReadLedger = (): IWorkspaceReadLedger => {
	const lastReadModifiedAtMs = new Map<string, number>();
	return {
		record: (path, modifiedAtMs) => {
			lastReadModifiedAtMs.set(path, modifiedAtMs);
		},
		isFresh: (path, modifiedAtMs) => lastReadModifiedAtMs.get(path) === modifiedAtMs,
	};
};
