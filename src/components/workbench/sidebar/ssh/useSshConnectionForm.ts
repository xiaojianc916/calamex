import { computed, reactive, ref, toRefs } from 'vue';
import { tauriService } from '@/services/tauri';
import { useSshStore } from '@/store/ssh';
import {
  type SshAuthMode,
  type SshConnectionFormValues,
  type SshConnectionPayload,
  sshConnectionSchema,
  toSshConnectionPayload,
} from '@/types/ssh/connection.schema';
import type { ISshFileWriteRequest } from '@/types/tauri';
import { DEFAULT_SSH_PORT } from './ssh-sidebar.constants';

/** 字段级错误信息:字段名 -> 第一条校验错误文案 */
type SshConnectionFieldErrors = Record<string, string>;

export const useSshConnectionForm = () => {
  const sshStore = useSshStore();

  const isAuthMode = (value: unknown): value is SshAuthMode =>
    value === 'password' || value === 'key';

  const buildInitialFormValues = (): SshConnectionFormValues => {
    const stored = sshStore.connectionForm;
    return {
      host: stored?.host ?? '',
      port: stored?.port ?? DEFAULT_SSH_PORT,
      username: stored?.username ?? '',
      authMode: isAuthMode(stored?.authMode) ? stored.authMode : 'password',
      identityPath: stored?.identityPath ?? '',
      password: stored?.password ?? '',
    };
  };

  // 构造时快照一份初始值:resetForm() 无参时回到这份快照,与原 vee-validate 行为一致。
  const initialFormValues = buildInitialFormValues();
  const connectionForm = reactive<SshConnectionFormValues>({ ...initialFormValues });
  const connectionFieldErrors = reactive<SshConnectionFieldErrors>({});

  const { host, port, username, authMode, identityPath, password } = toRefs(connectionForm);

  const clearConnectionFieldErrors = (): void => {
    for (const key of Object.keys(connectionFieldErrors)) {
      delete connectionFieldErrors[key];
    }
  };

  // 每个字段只保留第一条错误,行为对齐表单库的 errors 映射。
  const applyValidationIssues = (
    issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
  ): void => {
    clearConnectionFieldErrors();
    for (const issue of issues) {
      const key = issue.path[0];
      if (typeof key === 'string' && connectionFieldErrors[key] === undefined) {
        connectionFieldErrors[key] = issue.message;
      }
    }
  };

  const validateConnection = async (): Promise<{ valid: boolean }> => {
    const result = sshConnectionSchema.safeParse({ ...connectionForm });
    if (result.success) {
      clearConnectionFieldErrors();
      return { valid: true };
    }
    applyValidationIssues(result.error.issues);
    return { valid: false };
  };

  const handleVeeSubmit =
    (onValid: (values: SshConnectionFormValues) => unknown | Promise<unknown>) =>
    async (event?: Event): Promise<void> => {
      event?.preventDefault();
      const { valid } = await validateConnection();
      if (!valid) return;
      await onValid({ ...connectionForm });
    };

  const setFieldValue = <K extends keyof SshConnectionFormValues>(
    field: K,
    value: SshConnectionFormValues[K],
  ): void => {
    connectionForm[field] = value;
  };

  const resetForm = (options?: { values?: SshConnectionFormValues }): void => {
    Object.assign(connectionForm, options?.values ?? { ...initialFormValues });
    clearConnectionFieldErrors();
  };

  const isPasswordVisible = ref(false);
  const passwordInputType = computed(() => (isPasswordVisible.value ? 'text' : 'password'));
  const activeSshConnectionRequest = ref<SshConnectionPayload | null>(null);

  const syncFormToStore = (): void => {
    sshStore.connectionForm.host = connectionForm.host;
    sshStore.connectionForm.port = connectionForm.port;
    sshStore.connectionForm.username = connectionForm.username;
    sshStore.connectionForm.authMode = connectionForm.authMode;
    sshStore.connectionForm.identityPath = connectionForm.identityPath;
    sshStore.connectionForm.password = connectionForm.password;
  };

  const createSshConnectionTestRequest = (): SshConnectionPayload =>
    toSshConnectionPayload(connectionForm);

  const createSshConnectionRequest = (): SshConnectionPayload =>
    activeSshConnectionRequest.value ?? createSshConnectionTestRequest();

  const createSshDirectoryRequest = (path: string) => ({
    ...createSshConnectionRequest(),
    path,
  });

  const createSshFileTransferRequest = (remotePath: string, localPath: string) => ({
    ...createSshConnectionRequest(),
    remotePath,
    localPath,
  });

  const createSshFileUploadRequest = (localPath: string, remoteDirectory: string) => ({
    ...createSshConnectionRequest(),
    localPath,
    remoteDirectory,
  });

  const createSshPathDeleteRequest = (remotePath: string) => ({
    ...createSshConnectionRequest(),
    remotePath,
  });

  const createSshPathRenameRequest = (remotePath: string, newName: string) => ({
    ...createSshConnectionRequest(),
    remotePath,
    newName,
  });

  const createSshDirectoryCreateRequest = (remoteDirectory: string, name: string) => ({
    ...createSshConnectionRequest(),
    remoteDirectory,
    name,
  });

  const createSshFileReadRequest = (remotePath: string) => ({
    ...createSshConnectionRequest(),
    remotePath,
  });

  const createSshFileWriteRequest = (
    remotePath: string,
    content: string,
    encoding: ISshFileWriteRequest['encoding'],
    lineEnding: ISshFileWriteRequest['lineEnding'],
  ) => ({
    ...createSshConnectionRequest(),
    remotePath,
    content,
    encoding,
    lineEnding,
  });

  const createSshPasswordIdentityRequest = () => ({
    host: connectionForm.host.trim(),
    port: Number.parseInt(connectionForm.port.trim(), 10),
    username: connectionForm.username.trim(),
  });

  const saveCurrentSshPassword = async (): Promise<void> => {
    if (connectionForm.authMode !== 'password') return;
    await tauriService.saveSshPassword({
      ...createSshPasswordIdentityRequest(),
      password: connectionForm.password,
    });
  };

  return {
    connectionForm,
    connectionFieldErrors,
    host,
    port,
    username,
    authMode,
    identityPath,
    password,
    isPasswordVisible,
    passwordInputType,
    activeSshConnectionRequest,
    isAuthMode,
    handleVeeSubmit,
    resetForm,
    setFieldValue,
    validateConnection,
    syncFormToStore,
    createSshConnectionTestRequest,
    createSshConnectionRequest,
    createSshDirectoryRequest,
    createSshFileTransferRequest,
    createSshFileUploadRequest,
    createSshPathDeleteRequest,
    createSshPathRenameRequest,
    createSshDirectoryCreateRequest,
    createSshFileReadRequest,
    createSshFileWriteRequest,
    createSshPasswordIdentityRequest,
    saveCurrentSshPassword,
  };
};
