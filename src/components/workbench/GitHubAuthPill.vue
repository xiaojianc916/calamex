<template>
  <div ref="rootRef" class="source-control-github-auth-wrap">
    <button
      type="button"
      class="source-control-github-auth"
      :class="{
        'is-connected': authStore.isAuthenticated,
        'is-loading': authStore.isLoading && !authStore.status.authenticated,
        'is-authorizing': Boolean(authStore.deviceAuth),
      }"
      :disabled="isButtonDisabled"
      :title="authStore.title"
      :aria-label="authStore.title"
      :aria-expanded="isPopoverOpen"
      aria-haspopup="menu"
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
    </button>

    <section
      v-if="isMenuOpen && !authStore.deviceAuth"
      class="source-control-github-menu"
      role="menu"
      aria-label="GitHub 登录信息"
      @click.stop
    >
      <template v-if="authStore.isAuthenticated">
        <header class="source-control-github-menu-profile">
          <img
            v-if="authStore.status.avatarUrl"
            class="source-control-github-menu-avatar"
            :src="authStore.status.avatarUrl"
            alt=""
            referrerpolicy="no-referrer"
          />
          <span v-else class="source-control-github-menu-mark icon-[lucide--github]" aria-hidden="true" />
          <span class="source-control-github-menu-profile-copy">
            <strong v-text="displayName" />
            <span v-if="authStore.status.login" v-text="authStore.status.login" />
          </span>
        </header>

        <div class="source-control-github-menu-actions">
          <button
            v-if="authStore.status.htmlUrl"
            type="button"
            class="source-control-github-menu-item"
            role="menuitem"
            @click="handleOpenProfile"
          >
            <span class="icon-[lucide--external-link]" aria-hidden="true" />
            <span>打开 GitHub 主页</span>
          </button>
          <button
            type="button"
            class="source-control-github-menu-item"
            role="menuitem"
            :disabled="!canStartAuth"
            @click="handleSwitchAccount"
          >
            <span class="icon-[lucide--refresh-cw]" aria-hidden="true" />
            <span>切换账号</span>
          </button>
        </div>
      </template>

      <template v-else>
        <header class="source-control-github-menu-profile">
          <span class="source-control-github-menu-mark icon-[lucide--github]" aria-hidden="true" />
          <span class="source-control-github-menu-profile-copy">
            <strong>GitHub</strong>
            <span v-text="authStore.status.message || '连接账号后可查看 Pull Request 与远程信息。'" />
          </span>
        </header>

        <button
          type="button"
          class="source-control-github-menu-connect"
          :disabled="!canStartAuth"
          @click="handleStartAuth"
        >
          连接 GitHub
        </button>
      </template>
    </section>

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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useGitHubAuthStore } from '@/store/github-auth';

const props = defineProps<{
  repositoryRootPath: string | null;
}>();

const authStore = useGitHubAuthStore();
const rootRef = ref<HTMLElement | null>(null);
const isMenuOpen = ref(false);

const isButtonDisabled = computed(
  () => authStore.isLoading && !authStore.status.authenticated && !authStore.deviceAuth,
);
const canStartAuth = computed(() => Boolean(props.repositoryRootPath) && !authStore.isLoading);
const isPopoverOpen = computed(() => isMenuOpen.value || Boolean(authStore.deviceAuth));
const displayName = computed(
  () => authStore.status.name || authStore.status.login || 'GitHub',
);

const closeMenu = (): void => {
  isMenuOpen.value = false;
};

const handlePrimaryClick = (): void => {
  if (isButtonDisabled.value) return;
  isMenuOpen.value = !isMenuOpen.value;
};

const handleStartAuth = async (): Promise<void> => {
  if (!canStartAuth.value) return;
  closeMenu();
  await authStore.startDeviceAuth();
};

const handleSwitchAccount = async (): Promise<void> => {
  if (!canStartAuth.value) return;
  closeMenu();
  await authStore.switchAccount();
};

const handleOpenProfile = (): void => {
  closeMenu();
  authStore.openProfile();
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

const handleWindowPointerDown = (event: PointerEvent): void => {
  if (!isPopoverOpen.value) return;
  const target = event.target;
  if (target instanceof Node && rootRef.value?.contains(target)) return;
  closeMenu();
};

const handleWindowKeydown = (event: KeyboardEvent): void => {
  if (event.key === 'Escape') {
    closeMenu();
  }
};

watch(
  () => props.repositoryRootPath,
  (repositoryRootPath) => {
    closeMenu();
    authStore.setRepositoryRootPath(repositoryRootPath);
  },
  { immediate: true },
);

onMounted(() => {
  window.addEventListener('pointerdown', handleWindowPointerDown, true);
  window.addEventListener('keydown', handleWindowKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener('pointerdown', handleWindowPointerDown, true);
  window.removeEventListener('keydown', handleWindowKeydown);
});
</script>
