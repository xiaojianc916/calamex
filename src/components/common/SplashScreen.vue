<template>
  <div class="splash-screen" :class="{ 'is-leaving': isLeaving }">
    <div
      class="splash-editor"
      :class="{ 'is-error': Boolean(error) }"
      :role="error ? 'alert' : 'status'"
      aria-live="polite"
    >
      <div class="splash-editor-top">
        <span class="splash-dot splash-dot-red" />
        <span class="splash-dot splash-dot-yellow" />
        <span class="splash-dot splash-dot-green" />
        <div class="splash-title">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m8.5 8.5-4 3.5 4 3.5" />
            <path d="m15.5 8.5 4 3.5-4 3.5" />
          </svg>
          <span>system-loader.js</span>
        </div>
      </div>

      <div v-if="error" class="splash-log-area">
        <div class="splash-log-line splash-log-line-error">[error] {{ error.title }}</div>
        <div class="splash-log-line">[message] {{ error.message }}</div>
        <div class="splash-log-divider" />
        <pre class="splash-log-pre">{{ error.detail }}</pre>
      </div>

      <div v-else class="splash-code-area">
        <div v-for="(line, lineIndex) in codeLines" :key="lineIndex" class="splash-code-line">
          <template v-for="fragment in resolveVisibleFragments(lineIndex)" :key="fragment.key">
            <span :class="fragment.className">{{ fragment.text }}</span>
          </template>
          <span v-if="activeLineIndex === lineIndex && !isLeaving" class="splash-cursor" />
        </div>
      </div>

      <div class="splash-progress-wrap">
        <div class="splash-progress-bar" :class="{ 'is-error': Boolean(error) }">
          <div class="splash-progress" :style="{ width: `${roundedProgress}%` }" />
        </div>
      </div>

      <div class="splash-status" :class="{ 'is-error': Boolean(error) }">
        <span v-if="!error" class="splash-spinner" />
        <span v-else class="splash-error-indicator">!</span>
        <span>{{ statusText }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { IRuntimeErrorState } from '@/utils/runtime-diagnostics';

interface ICodeFragment {
  text: string;
  className?: string;
}

interface IVisibleFragment extends ICodeFragment {
  key: string;
}

interface IBootstrapSplashState {
  startedAt: number;
  visibleCharacters: number;
  progress: number;
  handoff?: boolean;
}

declare global {
  interface Window {
    __SH_SPLASH_BOOTSTRAP_STATE__?: IBootstrapSplashState;
  }
}

const props = withDefaults(
  defineProps<{
    ready: boolean;
    error?: IRuntimeErrorState | null;
    minimumDuration?: number;
  }>(),
  {
    error: null,
    minimumDuration: 2000,
  },
);

const emit = defineEmits<{
  'leave-start': [];
  'after-leave': [];
}>();

const codeLines: ICodeFragment[][] = [
  [
    { text: 'import', className: 'splash-keyword' },
    { text: ' { System } ' },
    { text: 'from', className: 'splash-keyword' },
    { text: " '@core/system'", className: 'splash-string' },
    { text: ';' },
  ],
  [
    { text: 'const', className: 'splash-keyword' },
    { text: ' ' },
    { text: 'engine', className: 'splash-variable' },
    { text: ' = ' },
    { text: 'new', className: 'splash-keyword' },
    { text: ' ' },
    { text: 'CoreEngine', className: 'splash-function' },
    { text: '();' },
  ],
  [{ text: '// Initializing core modules and rendering', className: 'splash-comment' }],
  [
    { text: 'await', className: 'splash-keyword' },
    { text: ' ' },
    { text: 'engine', className: 'splash-variable' },
    { text: '.' },
    { text: 'startup', className: 'splash-function' },
    { text: '();' },
  ],
];

const FADE_DELAY = 320;
const FADE_DURATION = 820;

const lineLengths = codeLines.map((line) =>
  line.reduce((total, fragment) => total + fragment.text.length, 0),
);

const totalCharacters = lineLengths.reduce((total, length) => total + length, 0);

const resolveBootstrapState = (): IBootstrapSplashState | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  return window.__SH_SPLASH_BOOTSTRAP_STATE__ ?? null;
};

const bootstrapState = resolveBootstrapState();
const startedAt = bootstrapState?.startedAt ?? performance.now();
const visibleCharacters = ref(
  Math.min(totalCharacters, Math.max(0, Math.floor(bootstrapState?.visibleCharacters ?? 0))),
);
const progress = ref(Math.min(100, Math.max(0, bootstrapState?.progress ?? 0)));
const progressTarget = ref(progress.value);
const isLeaving = ref(false);
let animationFrame = 0;
let typingTimer: number | undefined;
let fadeDelayTimer: number | undefined;
let afterLeaveTimer: number | undefined;

const roundedProgress = computed(() => Math.min(100, Number(progress.value.toFixed(1))));

const isTypingComplete = computed(() => visibleCharacters.value >= totalCharacters);

const activeLineIndex = computed(() => {
  let remaining = visibleCharacters.value;

  for (let index = 0; index < lineLengths.length; index += 1) {
    if (remaining <= lineLengths[index]) {
      return index;
    }

    remaining -= lineLengths[index];
  }

  return lineLengths.length - 1;
});

const statusText = computed(() => {
  if (props.error) {
    return '启动失败，请查看错误日志。';
  }

  if (isLeaving.value || progress.value >= 99) {
    return '即将进入编辑器...';
  }

  if (props.ready) {
    return '编辑器资源已就绪，正在完成启动...';
  }

  if (progress.value >= 62) {
    return '正在加载工作台模块...';
  }

  return '正在初始化资源，请稍候...';
});

const getLineVisibleCharacters = (lineIndex: number): number => {
  const previousCharacters = lineLengths
    .slice(0, lineIndex)
    .reduce((total, length) => total + length, 0);

  return Math.max(0, Math.min(lineLengths[lineIndex], visibleCharacters.value - previousCharacters));
};

const resolveVisibleFragments = (lineIndex: number): IVisibleFragment[] => {
  let remaining = getLineVisibleCharacters(lineIndex);

  return codeLines[lineIndex]
    .map((fragment, fragmentIndex) => {
      const visibleLength = Math.max(0, Math.min(fragment.text.length, remaining));
      remaining -= visibleLength;

      return {
        ...fragment,
        key: `${lineIndex}-${fragmentIndex}`,
        text: fragment.text.slice(0, visibleLength),
      };
    })
    .filter((fragment) => fragment.text.length > 0);
};

const resolveCharacterAt = (position: number): string => {
  let remaining = position;

  for (const line of codeLines) {
    for (const fragment of line) {
      if (remaining < fragment.text.length) {
        return fragment.text[remaining] ?? '';
      }

      remaining -= fragment.text.length;
    }
  }

  return '';
};

const hasCompletedLineAt = (characterCount: number): boolean => {
  if (characterCount >= totalCharacters) {
    return false;
  }

  let cumulativeLength = 0;
  return lineLengths.some((length) => {
    cumulativeLength += length;
    return cumulativeLength === characterCount;
  });
};

const randomBetween = (min: number, max: number): number => min + Math.random() * (max - min);

const getTypingDelay = (character: string, completedLine: boolean): number => {
  if (completedLine) {
    return randomBetween(150, 260);
  }

  const elapsed = performance.now() - startedAt;
  const shouldCatchUp = props.ready && elapsed >= props.minimumDuration * 0.72;
  let minDelay = shouldCatchUp ? 8 : 24;
  let maxDelay = shouldCatchUp ? 22 : 58;

  if (character === ' ') {
    minDelay *= 0.45;
    maxDelay *= 0.64;
  } else if (/[,.;()]/.test(character)) {
    minDelay += 16;
    maxDelay += 38;
  }

  return randomBetween(minDelay, maxDelay);
};

const scheduleTyping = (delay = 120): void => {
  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  typingTimer = window.setTimeout(typeNextCharacter, delay);
};

const typeNextCharacter = (): void => {
  if (props.error || isLeaving.value || isTypingComplete.value) {
    return;
  }

  const nextCharacterCount = visibleCharacters.value + 1;
  const character = resolveCharacterAt(nextCharacterCount - 1);
  visibleCharacters.value = nextCharacterCount;
  progressTarget.value = Math.max(
    progressTarget.value,
    (nextCharacterCount / totalCharacters) * 74,
  );
  scheduleTyping(getTypingDelay(character, hasCompletedLineAt(nextCharacterCount)));
};

const beginLeave = (): void => {
  if (isLeaving.value || props.error) {
    return;
  }

  fadeDelayTimer = window.setTimeout(() => {
    isLeaving.value = true;
    emit('leave-start');

    afterLeaveTimer = window.setTimeout(() => {
      emit('after-leave');
    }, FADE_DURATION);
  }, FADE_DELAY);
};

const updateProgress = (now: number): void => {
  if (isLeaving.value || props.error) {
    progress.value = props.error ? 100 : progress.value;
    return;
  }

  const elapsed = now - startedAt;
  const timelineRatio = Math.min(1, elapsed / props.minimumDuration);
  const typingRatio = visibleCharacters.value / totalCharacters;
  const typingTarget = Math.min(82, typingRatio * 72 + timelineRatio * 10);
  const loadingTarget = props.ready
    ? Math.min(96, Math.max(typingTarget, 72 + timelineRatio * 20))
    : Math.min(88, Math.max(typingTarget, 6 + timelineRatio * 44 + Math.log1p(elapsed / 260) * 5));
  const target =
    props.ready && isTypingComplete.value && elapsed >= props.minimumDuration ? 100 : loadingTarget;

  progressTarget.value = Math.max(progressTarget.value, target);

  const remainingProgress = progressTarget.value - progress.value;
  if (remainingProgress > 0) {
    progress.value = Math.min(
      progressTarget.value,
      progress.value + Math.max(0.08, remainingProgress * 0.12),
    );
  }

  if (progressTarget.value >= 100 && progress.value >= 99.6) {
    progress.value = 100;
    beginLeave();
    return;
  }

  animationFrame = window.requestAnimationFrame(updateProgress);
};

watch(
  () => props.ready,
  (ready) => {
    if (
      !props.error &&
      ready &&
      isTypingComplete.value &&
      performance.now() - startedAt >= props.minimumDuration
    ) {
      progressTarget.value = 100;
    }
  },
);

watch(
  () => props.error,
  (error) => {
    if (!error) {
      return;
    }

    progress.value = 100;
    progressTarget.value = 100;
    isLeaving.value = false;
    window.cancelAnimationFrame(animationFrame);

    if (typingTimer) {
      window.clearTimeout(typingTimer);
      typingTimer = undefined;
    }

    if (fadeDelayTimer) {
      window.clearTimeout(fadeDelayTimer);
      fadeDelayTimer = undefined;
    }

    if (afterLeaveTimer) {
      window.clearTimeout(afterLeaveTimer);
      afterLeaveTimer = undefined;
    }
  },
);

onMounted(() => {
  if (bootstrapState) {
    bootstrapState.handoff = true;
  }

  if (!isTypingComplete.value) {
    scheduleTyping(80);
  }

  animationFrame = window.requestAnimationFrame(updateProgress);
});

onBeforeUnmount(() => {
  window.cancelAnimationFrame(animationFrame);

  if (typingTimer) {
    window.clearTimeout(typingTimer);
  }

  if (fadeDelayTimer) {
    window.clearTimeout(fadeDelayTimer);
  }

  if (afterLeaveTimer) {
    window.clearTimeout(afterLeaveTimer);
  }
});
</script>
