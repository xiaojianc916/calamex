import { z } from 'zod';

const SSH_AUTH_MODES = ['password', 'key'] as const;
export type SshAuthMode = (typeof SSH_AUTH_MODES)[number];

// 跟旧代码完全一致的字符规则
const HOST_PATTERN = /^[a-zA-Z0-9.\-_:]+$/;
const USER_PATTERN = /^[a-zA-Z0-9.\-_]+$/;
const PORT_PATTERN = /^\d+$/;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((char) => char.charCodeAt(0) < 32);

/** 表单值类型:全部 string,跟 <input type="text"> 的 v-model 对齐 */
export interface SshConnectionFormValues {
  host: string;
  port: string;
  username: string;
  authMode: SshAuthMode;
  identityPath: string;
  password: string;
}

/** 内层 object schema,供 z.infer 推干净类型 */
const sshConnectionObjectSchema = z.object({
  host: z
    .string()
    .trim()
    .min(1, '请填写主机地址。')
    .regex(HOST_PATTERN, '主机地址只能包含字母、数字、点、短横线、下划线或冒号。'),

  port: z
    .string()
    .trim()
    .min(1, '请填写端口。')
    .regex(PORT_PATTERN, '端口必须是 1 到 65535 之间的整数。')
    .refine((v) => {
      const n = Number.parseInt(v, 10);
      return Number.isInteger(n) && n >= 1 && n <= 65535;
    }, '端口必须是 1 到 65535 之间的整数。'),

  username: z
    .string()
    .trim()
    .min(1, '请填写用户名。')
    .regex(USER_PATTERN, '用户名只能包含字母、数字、点、短横线或下划线。'),

  authMode: z.enum(SSH_AUTH_MODES),

  identityPath: z.string(),
  password: z.string(),
});

/** 完整 schema:含条件校验(authMode === 'password' 时密码必填,路径不能含换行) */
export const sshConnectionSchema = sshConnectionObjectSchema.superRefine((val, ctx) => {
  const identityPath = val.identityPath.trim();
  if (val.authMode === 'key' && !identityPath) {
    ctx.addIssue({
      code: 'custom',
      path: ['identityPath'],
      message: '请填写私钥路径。',
    });
  } else if (identityPath && hasControlCharacter(identityPath)) {
    ctx.addIssue({
      code: 'custom',
      path: ['identityPath'],
      message: '私钥路径不能包含控制字符。',
    });
  }

  if (val.authMode === 'password') {
    if (!val.password) {
      ctx.addIssue({ code: 'custom', path: ['password'], message: '请填写登录密码。' });
    } else if (hasControlCharacter(val.password)) {
      ctx.addIssue({
        code: 'custom',
        path: ['password'],
        message: '登录密码不能包含控制字符。',
      });
    }
  }
});

/** 给 Tauri 后端的强类型 payload(port 已 parseInt) */
export interface SshConnectionPayload {
  host: string;
  port: number;
  username: string;
  authMode: SshAuthMode;
  identityPath: string | null;
  password: string | null;
}

/** 把校验通过的表单值转成 Tauri payload */
export function toSshConnectionPayload(values: SshConnectionFormValues): SshConnectionPayload {
  return {
    host: values.host.trim(),
    port: Number.parseInt(values.port.trim(), 10),
    username: values.username.trim(),
    authMode: values.authMode,
    identityPath: values.authMode === 'key' ? values.identityPath.trim() || null : null,
    password: values.authMode === 'password' ? values.password : null,
  };
}
