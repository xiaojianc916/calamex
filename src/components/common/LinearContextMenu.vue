<template>
  <Teleport to="body">
    <div
class="linear-context-menu-root" :class="{
      'is-light': props.theme === 'light',
      'is-submenu-left': props.submenuDirection === 'left',
    }" @contextmenu.prevent>
      <MotionDropdown class="cmx linear-context-menu" :open="props.open" :origin="motionOrigin" :style="rootStyle">
        <template v-for="(group, groupIndex) in props.groups" :key="group.key">
          <div class="cmx-hd">{{ group.title }}</div>

          <template v-for="item in group.items" :key="item.key">
            <div v-if="item.children?.length" class="cmx-sub" @mouseenter="handleItemMouseEnter(item)">
              <button
type="button" class="cmx-i"
                :class="{ disabled: item.disabled, active: activeSubmenuKey === item.key }" :disabled="item.disabled"
                @pointerdown.prevent.stop="handleItemSelect(item)">
                <span class="ic">
                  <LinearContextMenuIcon :icon="item.icon" />
                </span>
                <span class="lb">{{ item.label }}</span>
                <span class="arr" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="m9 6 6 6-6 6" />
                  </svg>
                </span>
              </button>

              <div v-if="activeSubmenuKey === item.key" class="cmx-fly">
                <div class="cmx">
                  <button
v-for="child in item.children" :key="child.key" type="button" class="cmx-i"
                    :class="{ disabled: child.disabled }" :disabled="child.disabled"
                    @pointerdown.prevent.stop="handleItemSelect(child)">
                    <span class="ic">
                      <LinearContextMenuIcon :icon="child.icon" />
                    </span>
                    <span class="lb">{{ child.label }}</span>
                    <span v-if="child.shortcut?.length" class="kh" aria-hidden="true">
                      <kbd v-for="key in child.shortcut" :key="`${child.key}-${key}`">{{ key }}</kbd>
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <button
v-else type="button" class="cmx-i" :class="{ disabled: item.disabled }" :disabled="item.disabled"
              @mouseenter="handleItemMouseEnter(item)" @pointerdown.prevent.stop="handleItemSelect(item)">
              <span class="ic">
                <LinearContextMenuIcon :icon="item.icon" />
              </span>
              <span class="lb">{{ item.label }}</span>
              <span v-if="item.shortcut?.length" class="kh" aria-hidden="true">
                <kbd v-for="key in item.shortcut" :key="`${item.key}-${key}`">{{ key }}</kbd>
              </span>
            </button>
          </template>

          <div v-if="groupIndex < props.groups.length - 1" class="cmx-sep" />
        </template>
      </MotionDropdown>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import MotionDropdown from '@/components/business/MotionDropdown.vue';
import type {
  ILinearContextMenuGroup,
  ILinearContextMenuItem,
} from '@/components/common/linear-context-menu.types';
import LinearContextMenuIcon from '@/components/common/LinearContextMenuIcon.vue';
import type { TThemeMode } from '@/types/app';
import type { TDropdownMotionOrigin } from '@/types/motion';
import { computed, ref, watch } from 'vue';

const props = defineProps<{
  open: boolean;
  x: number;
  y: number;
  groups: ILinearContextMenuGroup[];
  theme: TThemeMode;
  submenuDirection: 'left' | 'right';
}>();

const emit = defineEmits<{
  select: [item: ILinearContextMenuItem];
}>();

const activeSubmenuKey = ref<string | null>(null);

const rootStyle = computed(() => ({
  left: `${props.x}px`,
  top: `${props.y}px`,
}));

const motionOrigin = computed<TDropdownMotionOrigin>(() => {
  if (typeof window === 'undefined') {
    return 'top left';
  }

  const vertical = props.y > window.innerHeight * 0.56 ? 'bottom' : 'top';
  const horizontal = props.x > window.innerWidth * 0.68 ? 'right' : 'left';
  return `${vertical} ${horizontal}`;
});

const handleItemMouseEnter = (item: ILinearContextMenuItem): void => {
  activeSubmenuKey.value = item.children?.length && !item.disabled ? item.key : null;
};

const handleItemSelect = (item: ILinearContextMenuItem): void => {
  if (item.disabled) {
    return;
  }

  if (item.children?.length) {
    activeSubmenuKey.value = item.key;
    return;
  }

  emit('select', item);
};

watch(
  () => props.open,
  (open) => {
    if (!open) {
      activeSubmenuKey.value = null;
    }
  },
);
</script>

<style scoped>
.linear-context-menu-root {
  --cm-bg: var(--bg-0);
  --cm-bg-1: var(--bg-1);
  --cm-bg-2: var(--overlay-bg, var(--bg-4));
  --cm-bg-3: var(--overlay-bg-depth, var(--bg-3));
  --cm-bg-h: var(--bg-h);
  --cm-bg-sel: var(--accent-muted);
  --cm-fg: var(--text-primary);
  --cm-fg-1: var(--text-secondary);
  --cm-fg-2: var(--text-tertiary);
  --cm-fg-3: var(--text-quaternary);
  --cm-fg-4: var(--editor-context-menu-disabled);
  --cm-bd: var(--border-subtle);
  --cm-bd-st: var(--border-strong);
  --cm-ac: var(--settings-accent);
  --ac-fg: #eef0ff;
  --ff:
    -apple-system, 'Inter Variable', 'Inter', 'SF Pro Text', 'Segoe UI', Roboto, sans-serif;
  --fm: ui-monospace, 'Berkeley Mono', 'SF Mono', 'JetBrains Mono', Menlo, monospace;
  --r: 8px;
  --rs: 6px;
  --sh:
    0 10px 38px -10px rgba(0, 0, 0, 0.7),
    0 10px 20px -15px rgba(0, 0, 0, 0.5),
    inset 0 0 0 1px rgba(255, 255, 255, 0.04);
  position: fixed;
  inset: 0;
  z-index: 1600;
  pointer-events: none;
  font: 400 13px/1.5 var(--ff);
  letter-spacing: -0.003em;
  -webkit-font-smoothing: antialiased;
}

.linear-context-menu-root.is-light {
  --cm-bg-2: var(--overlay-bg, var(--bg-4));
  --cm-bg-3: var(--overlay-bg-depth, var(--bg-3));
  --cm-bg-h: var(--bg-h);
  --cm-bg-sel: var(--accent-muted);
  --cm-fg: var(--text-primary);
  --cm-fg-1: var(--text-secondary);
  --cm-fg-2: var(--text-tertiary);
  --cm-fg-3: var(--text-quaternary);
  --cm-fg-4: var(--editor-context-menu-disabled);
  --cm-bd: var(--border-subtle);
  --cm-bd-st: var(--border-strong);
  --cm-ac: var(--settings-accent);
  --ac-fg: #0f172a;
  --sh:
    0 14px 40px -16px rgba(15, 23, 42, 0.18),
    0 10px 18px -14px rgba(15, 23, 42, 0.12),
    inset 0 0 0 1px rgba(255, 255, 255, 0.92);
}

.cmx {
  min-width: 224px;
  border: 1px solid var(--cm-bd-st);
  border-radius: var(--r);
  background: var(--cm-bg-2);
  padding: 4px;
  box-shadow: var(--sh);
  user-select: none;
  color: var(--cm-fg-1);
  position: relative;
  pointer-events: auto;
}

.linear-context-menu {
  position: fixed;
}

.cmx-hd {
  padding: 8px 10px 4px;
  color: var(--cm-fg-3);
  font: 500 10.5px/1.3 var(--ff);
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

.cmx-i {
  display: flex;
  min-height: 28px;
  width: 100%;
  align-items: center;
  gap: 10px;
  border: none;
  border-radius: var(--rs);
  background: transparent;
  padding: 6px 10px;
  color: var(--cm-fg-1);
  text-align: left;
  cursor: default;
  transition:
    background 80ms ease,
    color 80ms ease;
}

.cmx-i:hover,
.cmx-i:focus-visible,
.cmx-i.active {
  background: var(--cm-bg-h);
  color: var(--cm-fg);
  outline: none;
}

.cmx-i.disabled {
  color: var(--cm-fg-4);
  opacity: 1;
  pointer-events: none;
}

.cmx-i.disabled .ic,
.cmx-i.disabled .arr,
.cmx-i.disabled .kh kbd {
  color: var(--cm-fg-4);
}

.cmx-i.disabled .kh kbd {
  background: color-mix(in srgb, var(--editor-context-menu-kbd-bg) 88%, var(--cm-fg-4) 12%);
}

.ic {
  width: 16px;
  height: 16px;
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--cm-fg-2);
}

.cmx-i:hover .ic,
.cmx-i:focus-visible .ic,
.cmx-i.active .ic {
  color: currentColor;
}

.ic :global(svg) {
  width: 14px;
  height: 14px;
}

.lb {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.kh {
  display: inline-flex;
  gap: 2px;
  margin-left: auto;
  flex: none;
}

.kh kbd {
  min-width: 17px;
  border: none;
  border-radius: 3.5px;
  background: var(--editor-context-menu-kbd-bg);
  padding: 2.5px 5px;
  color: var(--cm-fg-2);
  font: 500 10.5px/1 var(--fm);
  letter-spacing: 0;
  text-align: center;
  box-shadow: none;
}

.linear-context-menu-root.is-light .kh kbd {
  background: var(--editor-context-menu-kbd-bg);
}

.cmx-i:hover .kh kbd,
.cmx-i:focus-visible .kh kbd {
  background: var(--editor-context-menu-kbd-hover-bg);
  color: var(--cm-fg-1);
}

.linear-context-menu-root.is-light .cmx-i:hover .kh kbd,
.linear-context-menu-root.is-light .cmx-i:focus-visible .kh kbd {
  background: var(--editor-context-menu-kbd-hover-bg);
}

.arr {
  margin-left: auto;
  width: 12px;
  height: 12px;
  display: inline-flex;
  color: var(--cm-fg-3);
}

.arr svg {
  width: 12px;
  height: 12px;
  stroke: currentColor;
  fill: none;
  stroke-width: 1.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.cmx-i:hover .arr,
.cmx-i.active .arr {
  color: currentColor;
}

.cmx-sep {
  height: 1px;
  margin: 4px -4px;
  background: var(--cm-bd);
}

.cmx-sub {
  position: relative;
}

.cmx-fly {
  position: absolute;
  top: -4px;
  left: calc(100% + 2px);
  z-index: 1;
}

.linear-context-menu-root.is-submenu-left .cmx-fly {
  left: auto;
  right: calc(100% + 2px);
}

@media (prefers-reduced-motion: reduce) {
  .cmx-i {
    transition: none;
  }
}
</style>
