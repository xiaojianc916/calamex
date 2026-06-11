<script setup lang="ts">
import { Eye, EyeOff } from '@lucide/vue';
import FieldError from '@/components/common/FieldError.vue';
import { Button } from '@/components/ui/button';
import { Field, FieldGroup, FieldLabel, FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ISshAuthOption } from '@/types/ssh';
import type { SshAuthMode } from '@/types/ssh/connection.schema';

defineProps<{
  host: string;
  port: string;
  username: string;
  authMode: SshAuthMode;
  identityPath: string;
  password: string;
  errors: Partial<Record<string, string | undefined>>;
  authOptions: ISshAuthOption[];
  isConnecting: boolean;
  isPasswordVisible: boolean;
  passwordInputType: string;
  statusText: string;
  errorText: string;
  isDisconnected: boolean;
}>();

const emit = defineEmits<{
  'update:host': [value: string];
  'update:port': [value: string];
  'update:username': [value: string];
  'update:identityPath': [value: string];
  'update:password': [value: string];
  'auth-mode-change': [value: unknown];
  'toggle-password': [];
  submit: [];
  cancel: [];
}>();
</script>

<template>
  <form class="ssh-connect-form" :class="{ 'ssh-connect-form--disconnected': isDisconnected }"
    @submit.prevent="emit('submit')">
    <FieldSet class="ssh-connect-fieldset">
      <FieldGroup class="ssh-connect-fields">
        <div class="ssh-connect-grid">
          <Field class="ssh-connect-field">
            <FieldLabel for="ssh-connect-host" class="ssh-connect-label">
              主机地址
            </FieldLabel>
            <Input id="ssh-connect-host" :model-value="host" type="text" placeholder="192.168.217.129"
              autocomplete="off" class="ssh-connect-input" :aria-invalid="Boolean(errors.host)"
              @update:model-value="emit('update:host', String($event))" />
            <FieldError v-if="errors.host" :message="errors.host" />
          </Field>

          <Field class="ssh-connect-field ssh-connect-field--port">
            <FieldLabel for="ssh-connect-port" class="ssh-connect-label">
              端口
            </FieldLabel>
            <Input id="ssh-connect-port" :model-value="port" type="text" placeholder="22" inputmode="numeric"
              autocomplete="off" class="ssh-connect-input" :aria-invalid="Boolean(errors.port)"
              @update:model-value="emit('update:port', String($event))" />
            <FieldError v-if="errors.port" :message="errors.port" />
          </Field>
        </div>

        <Field class="ssh-connect-field">
          <FieldLabel for="ssh-connect-username" class="ssh-connect-label">
            用户名
          </FieldLabel>
          <Input id="ssh-connect-username" :model-value="username" type="text" placeholder="root" autocomplete="off"
            class="ssh-connect-input" :aria-invalid="Boolean(errors.username)"
            @update:model-value="emit('update:username', String($event))" />
          <FieldError v-if="errors.username" :message="errors.username" />
        </Field>

        <Field class="ssh-connect-field">
          <FieldLabel for="ssh-connect-auth-mode" class="ssh-connect-label">
            认证方式
          </FieldLabel>
          <Select :model-value="authMode" @update:model-value="emit('auth-mode-change', $event)">
            <SelectTrigger id="ssh-connect-auth-mode" aria-label="选择 SSH 认证方式" class="ssh-connect-select-trigger">
              <SelectValue placeholder="选择认证方式" />
            </SelectTrigger>
            <SelectContent
              class="ssh-connect-select-content data-[state=open]:animate-none data-[state=closed]:animate-none data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[side=bottom]:slide-in-from-top-0 data-[side=left]:slide-in-from-right-0 data-[side=right]:slide-in-from-left-0 data-[side=top]:slide-in-from-bottom-0">
              <SelectItem v-for="option in authOptions" :key="option.value" :value="option.value"
                class="ssh-connect-select-item" v-text="option.label" />
            </SelectContent>
          </Select>
        </Field>

        <Field v-if="authMode === 'key'" class="ssh-connect-field">
          <FieldLabel for="ssh-connect-identity-path" class="ssh-connect-label">
            私钥路径
          </FieldLabel>
          <Input id="ssh-connect-identity-path" :model-value="identityPath" type="text" placeholder="~/.ssh/id_rsa"
            autocomplete="off" class="ssh-connect-input" :aria-invalid="Boolean(errors.identityPath)"
            @update:model-value="emit('update:identityPath', String($event))" />
          <FieldError v-if="errors.identityPath" :message="errors.identityPath" />
        </Field>

        <Field v-else class="ssh-connect-field">
          <FieldLabel for="ssh-connect-password" class="ssh-connect-label">
            登录密码
          </FieldLabel>
          <div class="ssh-password-input-wrap">
            <Input id="ssh-connect-password" :model-value="password" :type="passwordInputType"
              placeholder="输入 SSH 登录密码" autocomplete="current-password"
              class="ssh-connect-input ssh-connect-input--password" :aria-invalid="Boolean(errors.password)"
              @update:model-value="emit('update:password', String($event))" />
            <button type="button" class="ssh-password-toggle" :aria-label="isPasswordVisible ? '隐藏密码' : '显示密码'"
              :title="isPasswordVisible ? '隐藏密码' : '显示密码'" @click="emit('toggle-password')">
              <Eye v-if="isPasswordVisible" aria-hidden="true" />
              <EyeOff v-else aria-hidden="true" />
            </button>
          </div>
          <FieldError v-if="errors.password" :message="errors.password" />
        </Field>
      </FieldGroup>
    </FieldSet>

    <div class="ssh-form-actions">
      <Button type="submit" class="ssh-connect-action ssh-connect-action--submit" :disabled="isConnecting"
        v-text="isConnecting ? '连接中…' : '连接'" />
      <Button type="button" variant="outline" class="ssh-connect-action ssh-connect-action--cancel"
        :disabled="isConnecting" @click="emit('cancel')">
        取消
      </Button>
    </div>

    <div v-if="statusText || errorText" class="ssh-connect-feedback" :class="{ 'is-error': Boolean(errorText) }"
      aria-live="polite" v-text="errorText || statusText" />
  </form>
</template>
