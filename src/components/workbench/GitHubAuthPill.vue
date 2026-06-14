<template>
  <div ref="rootRef" class="source-control-github-auth-wrap">
    <button
      type="button"
      class="source-control-github-auth"
      :class="{
        'is-connected': authStore.isAuthenticated,
        'is-loading': authStore.isLoading && !authStore.status.authenticated,
        'is-authorizing': authStore.isAuthorizing,
      }"
      :disabled="isButtonDisabled"
      :title="authStore.title"
      :aria-label="authStore.title"
      :aria-expanded="isPopoverOpen"
      aria-haspopup="menu"
      @click.stop="handlePrimaryClick"
    >
      <span
        v-if="authAvatarUrl"
        class="source-control-github-auth-avatar-frame"
        aria-hidden="true"
      >
        <Github class="source-control-github-auth-icon" />
        <img
          v-show="isAuthAvatarLoaded"
          class="source-control-github-auth-avatar"
          :src="authAvatarUrl"
          alt=""
          referrerpolicy="no-referrer"
          @load="handleAuthAvatarLoad"
          @error="handleAuthAvatarError"
        />
      </span>
      <LucideIcon
        v-else
        class="source-control-github-auth-icon"
        :name="authStore.isLoading && !authStore.status.authenticated ? 'loader-circle' : 'github'"
        aria-hidden="true"
      />
    </button>

    <section
      v-if="isMenuOpen"
      class="source-control-github-menu"
      role="menu"
      aria-label="GitHub 登录信息"
      @click.stop
    >
      <template v-if="authStore.isAuthenticated">
        <header class="source-control-github-menu-profile">
          <span
            v-if="menuAvatarUrl"
            class="source-control-github-menu-avatar-frame"
            aria-hidden="true"
          >
            <Github class="source-control-github-menu-mark" />
            <img
              v-show="isMenuAvatarLoaded"
              class="source-control-github-menu-avatar"
              :src="menuAvatarUrl"
              alt=""
              referrerpolicy="no-referrer"
              @load="handleMenuAvatarLoad"
              @error="handleMenuAvatarError"
            />
          </span>
          <Github class="source-control-github-menu-mark" v-else aria-hidden="true" />
          <span class="source-control-github-menu-profile-copy">
            <strong v-text="displayName" />
            <span v-if="profileSubtitle" v-text="profileSubtitle" />
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
            <ExternalLink aria-hidden="true" />
            <span>打开 GitHub 主页</span>
          </button>
          <button
            type="button"
            class="source-control-github-menu-item"
            role="menuitem"
            :disabled="!canStartAuth"
            @click="handleSwitchAccount"
          >
            <RefreshCw aria-hidden="true" />
            <span>切换账号</span>
          </button>
        </div>
      </template>

      <template v-else>
        <header class="source-control-github-menu-profile">
          <Github class="source-control-github-menu-mark" aria-hidden="true" />
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
  </div>
</template>

<script setup lang="ts">
import { ExternalLink, RefreshCw } from '@lucide/vue';
import { useEventListener } from '@vueuse/core';
import { computed, ref, watch } from 'vue';
import Github from '@/components/ui/icon/GithubIcon.vue';
import LucideIcon from '@/components/ui/icon/LucideIcon.vue';
import { useGitHubAuthStore } from '@/store/github-auth';

const props = defineProps<{
  repositoryRootPath: string | null;
}>();

const authStore = useGitHubAuthStore();
const rootRef = ref<HTMLElement | null>(null);
const isMenuOpen = ref(false);
const isAuthAvatarLoaded = ref(false);
const isMenuAvatarLoaded = ref(false);
const authAvatarLoadFailed = ref(false);
const menuAvatarLoadFailed = ref(false);

const isButtonDisabled = computed(
  () => authStore.isLoading && !authStore.status.authenticated && !authStore.isAuthorizing,
);
const canStartAuth = computed(() => Boolean(props.repositoryRootPath) && !authStore.isLoading);
const isPopoverOpen = computed(() => isMenuOpen.value);
const displayName = computed(() => authStore.status.name || authStore.status.login || 'GitHub');
const profileSubtitle = computed(() => authStore.status.email || authStore.status.login || '');
const rawAvatarUrl = computed(() =>
  authStore.status.authenticated ? authStore.status.avatarUrl || '' : '',
);
const authAvatarUrl = computed(() =>
  rawAvatarUrl.value && !authAvatarLoadFailed.value ? rawAvatarUrl.value : '',
);
const menuAvatarUrl = computed(() =>
  rawAvatarUrl.value && !menuAvatarLoadFailed.value ? rawAvatarUrl.value : '',
);

const closeMenu = (): void => {
  isMenuOpen.value = false;
};

const handlePrimaryClick = (): void => {
  if (isButtonDisabled.value) return;
  isMenuOpen.value = !isMenuOpen.value;
};

const handleAuthAvatarLoad = (): void => {
  isAuthAvatarLoaded.value = true;
};

const handleAuthAvatarError = (): void => {
  authAvatarLoadFailed.value = true;
  isAuthAvatarLoaded.value = false;
};

const handleMenuAvatarLoad = (): void => {
  isMenuAvatarLoaded.value = true;
};

const handleMenuAvatarError = (): void => {
  menuAvatarLoadFailed.value = true;
  isMenuAvatarLoaded.value = false;
};

const handleStartAuth = async (): Promise<void> => {
  if (!canStartAuth.value) return;
  closeMenu();
  await authStore.startAuth();
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

watch(rawAvatarUrl, () => {
  isAuthAvatarLoaded.value = false;
  isMenuAvatarLoaded.value = false;
  authAvatarLoadFailed.value = false;
  menuAvatarLoadFailed.value = false;
});

useEventListener(window, 'pointerdown', handleWindowPointerDown, { capture: true });
useEventListener(window, 'keydown', handleWindowKeydown);
</script>
