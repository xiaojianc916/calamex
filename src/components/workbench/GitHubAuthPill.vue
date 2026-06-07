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
      :aria-expanded="String(isMenuOpen && authStore.isAuthenticated)"
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

    <div v-if="isMenuOpen && authStore.isAuthenticated" class="source-control-github-auth-menu">
      <button
        type="button"
        class="source-control-github-auth-menu-btn"
        title="打开 GitHub"
        aria-label="打开 GitHub"
        @click.stop="handleOpenProfile"
      >
        <span class="source-control-github-auth-icon icon-[lucide--external-link]" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="source-control-github-auth-menu-btn"
        title="切换账号"
        aria-label="切换账号"
        @click.stop="handleSwitchAccount"
      >
        <span class="source-control-github-auth-icon icon-[lucide--refresh-cw]" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useGitHubAuthStore } from '@/store/github-auth';

const props = defineProps<{
  repositoryRootPath: string | null;
}>();

const authStore = useGitHubAuthStore();
const isMenuOpen = ref(false);
const disabled = computed(
  () =>
    !props.repositoryRootPath ||
    (authStore.isLoading && !authStore.status.authenticated && !authStore.deviceAuth),
);

const closeMenu = (): void => {
  isMenuOpen.value = false;
};

const handlePrimaryClick = async (): Promise<void> => {
  if (disabled.value) return;

  if (authStore.deviceAuth) {
    authStore.reopenVerificationPage();
    return;
  }

  if (authStore.isAuthenticated) {
    isMenuOpen.value = !isMenuOpen.value;
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

const handleOpenProfile = (): void => {
  closeMenu();
  authStore.openProfile();
};

const handleSwitchAccount = async (): Promise<void> => {
  closeMenu();
  await authStore.switchAccount();
};

const handleDocumentPointerDown = (event: PointerEvent): void => {
  if (
    event.target instanceof Element &&
    event.target.closest('.source-control-github-auth-wrap')
  ) {
    return;
  }
  closeMenu();
};

watch(
  () => props.repositoryRootPath,
  (repositoryRootPath) => {
    closeMenu();
    authStore.setRepositoryRootPath(repositoryRootPath);
  },
  { immediate: true },
);

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', handleDocumentPointerDown, true);
}

onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  }
});
</script>
