<template>
  <div class="source-control-github-auth-wrap">
    <button
      type="button"
      class="source-control-github-auth"
      :class="{
        'is-connected': authStore.isAuthenticated,
        'is-loading': authStore.isLoading && !authStore.status.authenticated,
        'is-authorizing': Boolean(authStore.deviceAuth),
      }"
      :disabled="disabled"
      :title="authStore.title"
      :aria-label="authStore.title"
      @click.stop="handlePrimaryClick"
    >
      <img
        v-if="authStore.status.authenticated && authStore.status.avatarUrl"
        class="source-control-github-auth-avatar"
        :src="authStore.status.avatarUrl"
        alt=""
        referrerpolicy="no-referrer"
      />
      <span
        v-else
        class="source-control-github-auth-icon"
        :class="authStore.isLoading && !authStore.status.authenticated ? 'icon-[lucide--loader-circle]' : 'icon-[lucide--github]'"
        aria-hidden="true"
      />
      <span class="source-control-github-auth-label" v-text="authStore.displayLabel" />
    </button>

    <button
      v-if="showInlineAction"
      type="button"
      class="source-control-github-auth-inline-action"
      :title="inlineActionLabel"
      :aria-label="inlineActionLabel"
      @click.stop="handleInlineAction"
    >
      <span class="source-control-github-auth-icon" :class="inlineActionIcon" aria-hidden="true" />
    </button>

    <section
      v-if="authStore.deviceAuth"
      class="source-control-github-device-card"
      aria-live="polite"
      @click.stop
    >
      <div class="source-control-github-device-head">
        <span class="source-control-github-device-mark icon-[lucide--github]" aria-hidden="true" />
        <div class="source-control-github-device-title-group">
          <p class="source-control-github-device-title">GitHub 授权</p>
          <p class="source-control-github-device-subtitle">验证码已复制，浏览器完成后会自动连接</p>
        </div>
      </div>

      <button
        type="button"
        class="source-control-github-device-code"
        title="复制验证码"
        aria-label="复制 GitHub 验证码"
        @click="handleCopyCode"
      >
        <span v-text="authStore.deviceAuth.userCode" />
      </button>

      <div class="source-control-github-device-actions">
        <button type="button" class="source-control-github-device-btn" @click="handleCopyCode">
          复制验证码
        </button>
        <button
          type="button"
          class="source-control-github-device-btn is-primary"
          @click="handleReopenPage"
        >
          打开 GitHub
        </button>
      </div>

      <div class="source-control-github-device-footer">
        <div class="source-control-github-device-status">
          <span class="source-control-github-device-pulse" aria-hidden="true" />
          <span>等待授权确认</span>
        </div>
        <button type="button" class="source-control-github-device-cancel" @click="handleCancelAuth">
          取消
        </button>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue';
import { useGitHubAuthStore } from '@/store/github-auth';

const props = defineProps<{
  repositoryRootPath: string | null;
}>();

const authStore = useGitHubAuthStore();
const disabled = computed(
  () =>
    !props.repositoryRootPath ||
    (authStore.isLoading && !authStore.status.authenticated && !authStore.deviceAuth),
);
const showInlineAction = computed(() => Boolean(authStore.deviceAuth) || authStore.isAuthenticated);
const inlineActionLabel = computed(() => (authStore.deviceAuth ? '复制验证码' : '切换账号'));
const inlineActionIcon = computed(() =>
  authStore.deviceAuth ? 'icon-[lucide--copy]' : 'icon-[lucide--refresh-cw]',
);

const handlePrimaryClick = async (): Promise<void> => {
  if (disabled.value) return;

  if (authStore.deviceAuth) {
    authStore.reopenVerificationPage();
    return;
  }

  if (authStore.isAuthenticated) {
    return;
  }

  await authStore.startDeviceAuth();
};

const handleCopyCode = async (): Promise<void> => {
  await authStore.copyDeviceCode();
};

const handleReopenPage = (): void => {
  authStore.reopenVerificationPage();
};

const handleCancelAuth = (): void => {
  authStore.cancelDeviceAuth();
};

const handleInlineAction = async (): Promise<void> => {
  if (authStore.deviceAuth) {
    await authStore.copyDeviceCode();
    return;
  }

  await authStore.switchAccount();
};

watch(
  () => props.repositoryRootPath,
  (repositoryRootPath) => {
    authStore.setRepositoryRootPath(repositoryRootPath);
  },
  { immediate: true },
);
</script>
