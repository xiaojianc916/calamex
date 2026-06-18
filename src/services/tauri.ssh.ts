import { commands } from '@/bindings/tauri';
import { useDialog } from '@/composables/useDialog';
import { type AppError, isAppError } from '@/types/app-error';
import type { ITauriService } from '@/types/tauri';
import { type ICommandMeta, runCommand } from './tauri.ipc-define';
import { buildPayloadMetricsOmittingTextFields } from './tauri.ipc-metrics';
import type { IIpcCallOptions } from './tauri.ipc-types';

/**
 * SSH invoke 层：从手写 Zod 契约迁入 tauri-specta 生成绑定（commands.*）。
 *
 * - 入参 / 出参类型以 Rust 为单一事实源，经 src/bindings/tauri.ts 生成。
 * - 仪表化外壳改用声明式 metadata 表（SSH_COMMAND_META + runCommand），运行期行为与原
 *   手写 callSpectaCommand 逐字段一致：审计 / 超时 / 取消 / 错误归一 / 入参出参度量。
 * - 主机密钥变更（host-key-changed）的确认弹窗与无感重试逻辑原样保留。
 */

type TSshRequest<K extends keyof ITauriService> = Parameters<ITauriService[K]>[0];
type TSshResult<K extends keyof ITauriService> = Awaited<ReturnType<ITauriService[K]>>;

/**
 * 前端 IPC 超时预算。
 *
 * 必须 ≥ 后端对应命令的「建连 + 操作」预算，否则会在后端仍在正常传输时就被前端
 * 提前判为超时（大文件 / 高延迟链路尤甚），并让后端继续跑成孤儿操作。
 * 后端建连预算约 30s；下方各项在此基础上叠加对应操作预算并留出余量，
 * 以便后端带语义的超时错误先返回。
 */
const SSH_CONNECT_BUDGET_MS = 30_000;
const SSH_LIST_TIMEOUT_MS = SSH_CONNECT_BUDGET_MS + 45_000; // 后端列目录 ≈ 30s，总 75s
const SSH_TRANSFER_TIMEOUT_MS = SSH_CONNECT_BUDGET_MS + 330_000; // 后端传输 300s，总 360s
const SSH_PREVIEW_READ_TIMEOUT_MS = SSH_CONNECT_BUDGET_MS + 75_000; // 后端预览读 60s，总 105s
const SSH_MUTATION_TIMEOUT_MS = SSH_CONNECT_BUDGET_MS + 45_000; // 后端写/删/改/建目录 ≈ 30s，总 75s

const isCanceledIpcError = (error: unknown): boolean =>
  isAppError(error) && error.code === 'ipc.canceled';

const SSH_SENSITIVE_INPUT_FIELDS = [
  'password',
  'identityPath',
  'localPath',
  'remotePath',
  'remoteDirectory',
  'path',
  'content',
] as const;

const measureSshSensitiveInput = (value: Record<string, unknown>) =>
  buildPayloadMetricsOmittingTextFields(value, SSH_SENSITIVE_INPUT_FIELDS);

/**
 * SSH Tauri 命令的声明式包装元数据表。每条语义与原手写 callSpectaCommand 逐字段对齐。
 */
const SSH_COMMAND_META = {
  testSshConnection: {
    command: 'test_ssh_connection',
    guardHint: '测试 SSH 连接',
    idempotent: true,
    timeoutMs: 15_000,
    audit: 'sensitive',
    measureInput: measureSshSensitiveInput,
  },
  saveSshPassword: {
    command: 'save_ssh_password',
    guardHint: '保存 SSH 密码',
    audit: 'sensitive',
    measureInput: measureSshSensitiveInput,
  },
  getSshPassword: {
    command: 'get_ssh_password',
    guardHint: '读取 SSH 密码',
    idempotent: true,
    audit: 'sensitive',
    measureInput: measureSshSensitiveInput,
    measureOutput: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, ['password'])
        : { bytes: 0 },
  },
  listSshConfigHosts: {
    command: 'list_ssh_config_hosts',
    guardHint: '读取 SSH 配置主机',
    idempotent: true,
    audit: 'sensitive',
  },
  listSshDirectory: {
    command: 'list_ssh_directory',
    guardHint: '读取 SSH 远端目录',
    idempotent: true,
    timeoutMs: SSH_LIST_TIMEOUT_MS,
    audit: 'sensitive',
    measureInput: measureSshSensitiveInput,
  },
  downloadSshFile: {
    command: 'download_ssh_file',
    guardHint: '下载 SSH 远端文件',
    audit: 'sensitive',
    timeoutMs: SSH_TRANSFER_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  uploadSshFile: {
    command: 'upload_ssh_file',
    guardHint: '上传 SSH 远端文件',
    audit: 'sensitive',
    timeoutMs: SSH_TRANSFER_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  readSshFile: {
    command: 'read_ssh_file',
    guardHint: '读取 SSH 远端文件',
    idempotent: true,
    audit: 'sensitive',
    timeoutMs: SSH_PREVIEW_READ_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
    measureOutput: (value) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, [
            'content',
            'remotePath',
          ])
        : { bytes: 0 },
  },
  writeSshFile: {
    command: 'write_ssh_file',
    guardHint: '写入 SSH 远端文件',
    audit: 'sensitive',
    timeoutMs: SSH_MUTATION_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  deleteSshPath: {
    command: 'delete_ssh_path',
    guardHint: '删除 SSH 远端路径',
    audit: 'sensitive',
    timeoutMs: SSH_MUTATION_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  renameSshPath: {
    command: 'rename_ssh_path',
    guardHint: '重命名 SSH 远端路径',
    audit: 'sensitive',
    timeoutMs: SSH_MUTATION_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  createSshDirectory: {
    command: 'create_ssh_directory',
    guardHint: '创建 SSH 远端目录',
    audit: 'sensitive',
    timeoutMs: SSH_MUTATION_TIMEOUT_MS,
    measureInput: measureSshSensitiveInput,
  },
  trustSshHostKey: {
    command: 'trust_ssh_host_key',
    guardHint: '信任变更后的 SSH 主机密钥',
    audit: 'sensitive',
    timeoutMs: 15_000,
    measureInput: measureSshSensitiveInput,
  },
} satisfies Record<string, ICommandMeta>;

const testSshConnectionIpc = (
  payload: TSshRequest<'testSshConnection'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'testSshConnection'>> =>
  runCommand(SSH_COMMAND_META.testSshConnection, payload, options, () =>
    commands.testSshConnection(payload),
  );

const saveSshPasswordIpc = (
  payload: TSshRequest<'saveSshPassword'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'saveSshPassword'>> =>
  runCommand(SSH_COMMAND_META.saveSshPassword, payload, options, () =>
    commands.saveSshPassword(payload),
  );

const getSshPasswordIpc = (
  payload: TSshRequest<'getSshPassword'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'getSshPassword'>> =>
  runCommand(SSH_COMMAND_META.getSshPassword, payload, options, () =>
    commands.getSshPassword(payload),
  );

const listSshConfigHostsIpc = (
  options?: IIpcCallOptions,
): Promise<TSshResult<'listSshConfigHosts'>> =>
  runCommand(SSH_COMMAND_META.listSshConfigHosts, undefined, options, () =>
    commands.listSshConfigHosts(),
  );

const listSshDirectoryIpc = (
  payload: TSshRequest<'listSshDirectory'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'listSshDirectory'>> =>
  runCommand(SSH_COMMAND_META.listSshDirectory, payload, options, () =>
    commands.listSshDirectory(payload),
  );

const downloadSshFileIpc = (
  payload: TSshRequest<'downloadSshFile'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'downloadSshFile'>> =>
  runCommand(SSH_COMMAND_META.downloadSshFile, payload, options, () =>
    commands.downloadSshFile(payload),
  );

const uploadSshFileIpc = (
  payload: TSshRequest<'uploadSshFile'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'uploadSshFile'>> =>
  runCommand(SSH_COMMAND_META.uploadSshFile, payload, options, () =>
    commands.uploadSshFile(payload),
  );

const readSshFileIpc = (
  payload: TSshRequest<'readSshFile'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'readSshFile'>> =>
  runCommand(SSH_COMMAND_META.readSshFile, payload, options, () => commands.readSshFile(payload));

const writeSshFileIpc = (
  payload: TSshRequest<'writeSshFile'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'writeSshFile'>> =>
  runCommand(SSH_COMMAND_META.writeSshFile, payload, options, () => commands.writeSshFile(payload));

const deleteSshPathIpc = (
  payload: TSshRequest<'deleteSshPath'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'deleteSshPath'>> =>
  runCommand(SSH_COMMAND_META.deleteSshPath, payload, options, () =>
    commands.deleteSshPath(payload),
  );

const renameSshPathIpc = (
  payload: TSshRequest<'renameSshPath'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'renameSshPath'>> =>
  runCommand(SSH_COMMAND_META.renameSshPath, payload, options, () =>
    commands.renameSshPath(payload),
  );

const createSshDirectoryIpc = (
  payload: TSshRequest<'createSshDirectory'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'createSshDirectory'>> =>
  runCommand(SSH_COMMAND_META.createSshDirectory, payload, options, () =>
    commands.createSshDirectory(payload),
  );

/**
 * SSH 主机密钥变更处理。
 *
 * 后端在检测到 known_hosts 中已记录的主机密钥发生变化时，不再直接拒绝，而是返回
 * 携带 `ssh/host-key-changed::<fingerprint>` 标记的错误（文件类操作）或在
 * `test_ssh_connection` 的结构化返回中以 `code` 体现。前端在此弹出危险确认弹窗，
 * 用户确认后调用 `trust_ssh_host_key` 记录新密钥为信任并无感重试原操作。
 */
const SSH_HOST_KEY_CHANGED_CODE = 'ssh/host-key-changed';

interface ISshHostKeyEndpoint {
  host: string;
  port: number;
}

const trustSshHostKeyIpc = (
  endpoint: ISshHostKeyEndpoint,
  options?: IIpcCallOptions,
): Promise<{ trusted: boolean }> =>
  runCommand(SSH_COMMAND_META.trustSshHostKey, endpoint, options, () =>
    commands.trustSshHostKey(endpoint.host, endpoint.port),
  );

const extractChangedHostKeyFingerprint = (message: string): string | null => {
  const marker = `${SSH_HOST_KEY_CHANGED_CODE}::`;
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) {
    return null;
  }

  const rawFingerprint = message.slice(markerIndex + marker.length).trim();
  if (!rawFingerprint) {
    return null;
  }

  const [fingerprint] = rawFingerprint.split(/\s+/);
  return fingerprint || null;
};

const isHostKeyChangedError = (error: unknown): error is AppError =>
  isAppError(error) && error.message.includes(SSH_HOST_KEY_CHANGED_CODE);

const confirmTrustChangedHostKey = async (
  endpoint: ISshHostKeyEndpoint,
  fingerprint: string | null,
): Promise<boolean> => {
  const target = `${endpoint.host}:${endpoint.port}`;
  const fingerprintLine = fingerprint ? `新的密钥指纹：${fingerprint}。` : '';
  const action = await useDialog().confirm({
    title: '主机密钥已变更',
    description: `服务器 ${target} 的主机密钥与本地记录不一致。${fingerprintLine}这可能是服务器重装，也可能是中间人攻击。确认信任后将记录新密钥并继续。`,
    variant: 'danger',
    confirmText: '信任并继续',
    cancelText: '取消',
  });
  return action === 'confirm';
};

const withChangedHostKeyPrompt = <TInput extends ISshHostKeyEndpoint, TOutput>(
  operation: (input: TInput, options?: IIpcCallOptions) => Promise<TOutput>,
) => {
  return async (input: TInput, options?: IIpcCallOptions): Promise<TOutput> => {
    try {
      return await operation(input, options);
    } catch (error) {
      if (!isHostKeyChangedError(error)) {
        throw error;
      }

      const fingerprint = extractChangedHostKeyFingerprint(error.message);
      const trusted = await confirmTrustChangedHostKey(input, fingerprint);
      if (!trusted) {
        throw error;
      }

      await trustSshHostKeyIpc({ host: input.host, port: input.port }, options);
      return operation(input, options);
    }
  };
};

const testSshConnectionWithHostKeyPrompt: typeof testSshConnectionIpc = async (input, options) => {
  const result = await testSshConnectionIpc(input, options);
  if (result.code !== SSH_HOST_KEY_CHANGED_CODE) {
    return result;
  }

  const fingerprint = extractChangedHostKeyFingerprint(result.message);
  const endpoint: ISshHostKeyEndpoint = { host: input.host, port: input.port };
  const trusted = await confirmTrustChangedHostKey(endpoint, fingerprint);
  if (!trusted) {
    return result;
  }

  await trustSshHostKeyIpc({ host: endpoint.host, port: endpoint.port }, options);
  return testSshConnectionIpc(input, options);
};

/**
 * 覆盖上传保护。
 *
 * 上传的真实目标是 `remoteDirectory` 与本地文件名拼接后的远端文件。若该文件已存在，
 * 直接上传会（在后端安全替换下）覆盖原文件 —— 对真实使用者这可能是误操作。
 * 这里在上传前先探测目标目录，发现同名文件时弹出危险确认弹窗；用户取消则中止上传。
 * 探测失败（权限 / 网络 / 主机密钥变更等）不阻断上传，退化为直接上传，由后端的
 * 原子替换保证覆盖本身的安全性。
 */
const SSH_UPLOAD_CANCELLED_MESSAGE = '已取消覆盖上传：远端同名文件保持不变。';

const localBaseName = (localPath: string): string => {
  const segments = localPath.split(/[\\/]/);
  return segments[segments.length - 1] ?? localPath;
};

const remoteUploadTargetExists = async (
  payload: TSshRequest<'uploadSshFile'>,
  options?: IIpcCallOptions,
): Promise<boolean> => {
  const fileName = localBaseName(payload.localPath);
  if (!fileName) {
    return false;
  }

  const listing = await listSshDirectoryIpc(
    {
      host: payload.host,
      port: payload.port,
      username: payload.username,
      authMode: payload.authMode,
      identityPath: payload.identityPath,
      password: payload.password,
      path: payload.remoteDirectory,
    },
    options,
  );

  return listing.entries.some((entry) => entry.kind !== 'directory' && entry.name === fileName);
};

const confirmOverwriteRemoteUpload = async (
  fileName: string,
  remoteDirectory: string,
): Promise<boolean> => {
  const action = await useDialog().confirm({
    title: '覆盖远端文件',
    description: `目标目录 ${remoteDirectory} 中已存在文件「${fileName}」。继续上传将覆盖原文件，此操作不可撤销。确认要覆盖吗？`,
    variant: 'danger',
    confirmText: '覆盖上传',
    cancelText: '取消',
  });
  return action === 'confirm';
};

const uploadWithHostKeyPrompt = withChangedHostKeyPrompt(uploadSshFileIpc);

const uploadSshFileWithOverwritePrompt = async (
  payload: TSshRequest<'uploadSshFile'>,
  options?: IIpcCallOptions,
): Promise<TSshResult<'uploadSshFile'>> => {
  let targetExists = false;
  try {
    targetExists = await remoteUploadTargetExists(payload, options);
  } catch (error) {
    if (isCanceledIpcError(error)) {
      throw error;
    }
    // 探测失败不应阻断上传：退化为直接上传，由后端安全替换保证覆盖的原子性。
    targetExists = false;
  }

  if (targetExists) {
    const fileName = localBaseName(payload.localPath);
    const confirmed = await confirmOverwriteRemoteUpload(fileName, payload.remoteDirectory);
    if (!confirmed) {
      throw new Error(SSH_UPLOAD_CANCELLED_MESSAGE);
    }
  }

  return uploadWithHostKeyPrompt(payload, options);
};

type TSshTauriService = Pick<
  ITauriService,
  | 'testSshConnection'
  | 'saveSshPassword'
  | 'getSshPassword'
  | 'listSshConfigHosts'
  | 'listSshDirectory'
  | 'downloadSshFile'
  | 'uploadSshFile'
  | 'readSshFile'
  | 'writeSshFile'
  | 'deleteSshPath'
  | 'renameSshPath'
  | 'createSshDirectory'
>;

export const sshTauriService: TSshTauriService = {
  testSshConnection: testSshConnectionWithHostKeyPrompt,

  saveSshPassword: saveSshPasswordIpc,

  getSshPassword: getSshPasswordIpc,

  listSshConfigHosts: (options?: IIpcCallOptions) => listSshConfigHostsIpc(options),

  listSshDirectory: withChangedHostKeyPrompt(listSshDirectoryIpc),

  downloadSshFile: withChangedHostKeyPrompt(downloadSshFileIpc),

  uploadSshFile: uploadSshFileWithOverwritePrompt,

  readSshFile: withChangedHostKeyPrompt(readSshFileIpc),

  writeSshFile: withChangedHostKeyPrompt(writeSshFileIpc),

  deleteSshPath: withChangedHostKeyPrompt(deleteSshPathIpc),

  renameSshPath: withChangedHostKeyPrompt(renameSshPathIpc),

  createSshDirectory: withChangedHostKeyPrompt(createSshDirectoryIpc),
};
