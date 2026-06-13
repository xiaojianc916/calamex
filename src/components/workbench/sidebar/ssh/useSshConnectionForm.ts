import { toTypedSchema } from '@vee-validate/zod';
import { useForm } from 'vee-validate';
import { computed, ref } from 'vue';
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

  const {
    values: connectionForm,
    errors: connectionFieldErrors,
    defineField,
    handleSubmit: handleVeeSubmit,
    resetForm,
    setFieldValue,
    validate: validateConnection,
  } = useForm<SshConnectionFormValues>({
    validationSchema: toTypedSchema(sshConnectionSchema),
    initialValues: buildInitialFormValues(),
    validateOnMount: false,
  });

  const [host] = defineField('host');
  const [port] = defineField('port');
  const [username] = defineField('username');
  const [authMode] = defineField('authMode');
  const [identityPath] = defineField('identityPath');
  const [password] = defineField('password');

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
