<script setup lang="ts">
import { Sparkles, Terminal } from '@lucide/vue';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { IAcpAvailableCommand } from '@/types/ai/sidecar';
import type { ISkillSummary } from '@/types/ai/skill';

/** / 菜单锚点:取自输入框容器的视口矩形,用于把浮层贴在输入框上方。 */
interface ISlashAnchorRect {
  left: number;
  top: number;
  width: number;
}

const props = defineProps<{
  open: boolean;
  /** '/' 之后已输入的过滤文本(不含斜杠)。 */
  query: string;
  skills: readonly ISkillSummary[];
  anchorRect: ISlashAnchorRect | null;
  /**
   * 为 true 时由 ACP 公示命令驱动（Kimi 等外部 Agent 的内置命令 + 技能），
   * 选中 emit select-command(name)；为 false（自研 builtin Agent）维持技能列表。
   */
  acp?: boolean;
  /** ACP available_commands_update 归一后的命令清单（acp 为 true 时消费）。 */
  commands?: readonly IAcpAvailableCommand[];
}>();

const emit = defineEmits<{
  (event: 'select-skill', slug: string): void;
  (event: 'select-command', name: string): void;
  (event: 'close'): void;
}>();

// 命令区:本期仅占位 / 参考,保持与设计图一致但不可点选。
const placeholderCommands = [
  { name: '/compact', description: '压缩当前对话上下文' },
  { name: '/goal', description: '设定本次任务目标' },
  { name: '/skill', description: '加载指定技能后再继续任务' },
] as const;

const activeIndex = ref(0);

const normalizedQuery = computed(() => props.query.trim().toLowerCase());

const filteredSkills = computed(() => {
  const keyword = normalizedQuery.value;
  if (!keyword) {
    return [...props.skills];
  }
  return props.skills.filter((skill) => {
    const haystack = `${skill.name} ${skill.slug} ${skill.description}`.toLowerCase();
    return haystack.includes(keyword);
  });
});

const filteredCommands = computed(() => {
  const list = props.commands ?? [];
  const keyword = normalizedQuery.value;
  if (!keyword) {
    return [...list];
  }
  return list.filter((command) => {
    const haystack = `${command.name} ${command.description}`.toLowerCase();
    return haystack.includes(keyword);
  });
});

// 当前可被键盘 / 点击选中的条目数:ACP 模式取命令,自研模式取技能。
const activeCount = computed(() =>
  props.acp ? filteredCommands.value.length : filteredSkills.value.length,
);

// ACP 模式命令为空:区分「会话尚未公示命令」与「过滤无匹配」。
const acpEmptyHint = computed(() =>
  (props.commands?.length ?? 0) === 0 ? '会话开始后将出现可用命令' : '没有匹配的命令',
);

const menuStyle = computed(() => {
  const rect = props.anchorRect;
  if (!rect) {
    return { display: 'none' } as const;
  }
  const gap = 8;
  return {
    left: `${rect.left}px`,
    width: `${rect.width}px`,
    bottom: `${Math.max(gap, window.innerHeight - rect.top + gap)}px`,
  };
});

const clampActiveIndex = (): void => {
  const count = activeCount.value;
  if (count === 0) {
    activeIndex.value = 0;
    return;
  }
  if (activeIndex.value > count - 1) {
    activeIndex.value = count - 1;
  }
  if (activeIndex.value < 0) {
    activeIndex.value = 0;
  }
};

const moveActive = (delta: number): void => {
  const count = activeCount.value;
  if (count === 0) {
    return;
  }
  activeIndex.value = (activeIndex.value + delta + count) % count;
};

const confirmActive = (): void => {
  if (props.acp) {
    const command = filteredCommands.value[activeIndex.value];
    if (command) {
      emit('select-command', command.name);
    }
    return;
  }
  const skill = filteredSkills.value[activeIndex.value];
  if (skill) {
    emit('select-skill', skill.slug);
  }
};

const onSelectSkill = (slug: string): void => {
  emit('select-skill', slug);
};

const onSelectCommand = (name: string): void => {
  emit('select-command', name);
};

// 捕获阶段拦截方向键 / 回车 / Esc,避免事件落到输入框造成换行或提交。
const handleKeydown = (event: KeyboardEvent): void => {
  if (!props.open) {
    return;
  }
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault();
      event.stopPropagation();
      moveActive(1);
      break;
    case 'ArrowUp':
      event.preventDefault();
      event.stopPropagation();
      moveActive(-1);
      break;
    case 'Enter':
      if (activeCount.value > 0) {
        event.preventDefault();
        event.stopPropagation();
        confirmActive();
      }
      break;
    case 'Tab':
      if (activeCount.value > 0) {
        event.preventDefault();
        event.stopPropagation();
        confirmActive();
      }
      break;
    case 'Escape':
      event.preventDefault();
      event.stopPropagation();
      emit('close');
      break;
    default:
      break;
  }
};

const bindKeyListener = (): void => {
  document.addEventListener('keydown', handleKeydown, true);
};

const unbindKeyListener = (): void => {
  document.removeEventListener('keydown', handleKeydown, true);
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeIndex.value = 0;
      bindKeyListener();
    } else {
      unbindKeyListener();
    }
  },
  { immediate: true },
);

watch(
  () => props.query,
  () => {
    activeIndex.value = 0;
  },
);

watch(activeCount, () => {
  clampActiveIndex();
});

onBeforeUnmount(() => {
  unbindKeyListener();
});
</script>

<template>
  <Teleport to="body">
    <!-- 透明遮罩:仅用于点击关闭,不阻挡视觉(浮层本体覆盖在对话上方) -->
    <div v-if="open" class="slash-overlay" @mousedown.self="emit('close')">
      <div
        class="slash-menu"
        role="listbox"
        aria-label="技能与命令"
        :style="menuStyle"
        @mousedown.prevent
      >
        <section class="slash-section">
          <p class="slash-section__title">命令</p>
          <button
            v-for="command in placeholderCommands"
            :key="command.name"
            type="button"
            class="slash-item slash-item--disabled"
            disabled
          >
            <Terminal class="slash-item__icon" aria-hidden="true" />
            <span class="slash-item__text">
              <span class="slash-item__name" v-text="command.name" />
              <span class="slash-item__desc" v-text="command.description" />
            </span>
            <span class="slash-item__badge">即将推出</span>
          </button>
        </section>

        <section class="slash-section">
          <p class="slash-section__title">技能</p>
          <p v-if="filteredSkills.length === 0" class="slash-empty">
            <Sparkles aria-hidden="true" />
            没有匹配的技能
          </p>
          <button
            v-for="(skill, index) in filteredSkills"
            :key="skill.slug"
            type="button"
            class="slash-item"
            :class="{ 'slash-item--active': index === activeIndex }"
            role="option"
            :aria-selected="index === activeIndex"
            @mouseenter="activeIndex = index"
            @click="onSelect(skill.slug)"
          >
            <Sparkles class="slash-item__icon" aria-hidden="true" />
            <span class="slash-item__text">
              <span class="slash-item__name" v-text="skill.name" />
              <span v-if="skill.description" class="slash-item__desc" v-text="skill.description" />
            </span>
          </button>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.slash-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 50);
  background: transparent;
}

.slash-menu {
  position: fixed;
  max-height: min(320px, 50vh);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px;
  border: 1px solid #ececec;
  border-radius: 14px;
  background: #ffffff;
  box-shadow: 0 18px 48px rgb(15 23 42 / 16%);
  color: #18181b;
}

.slash-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slash-section + .slash-section {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #f1f1f1;
}

.slash-section__title {
  margin: 2px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: #a1a1aa;
  text-transform: uppercase;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  color: inherit;
  transition: background 0.12s ease;
}

.slash-item--active {
  background: #f4f4f5;
}

.slash-item--disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.slash-item__icon {
  flex: none;
  width: 16px;
  height: 16px;
  color: #71717a;
}

.slash-item__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  flex: 1 1 auto;
}

.slash-item__name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.slash-item__desc {
  font-size: 12px;
  color: #71717a;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.slash-item__badge {
  flex: none;
  font-size: 10px;
  color: #a1a1aa;
  padding: 2px 6px;
  border-radius: 999px;
  background: #f4f4f5;
}

.slash-empty {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
  margin: 0;
  font-size: 12px;
  color: #a1a1aa;
}
</style>
