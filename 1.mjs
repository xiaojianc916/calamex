// apply-mode-unify.mjs
// 把模式选择器统一为「按 Agent 静态映射」的单一 <Select> 实现：
//   - builtin → chat / agent / plan（绑 activeMode，保留既有发送路由）
//   - kimi    → 普通 / Plan / Auto / YOLO（官方四个，静态表；kimi-cli 不经 ACP 公示 modes）
// 同时删除：旧的齿轮内 hover 二级菜单整套 + 死的后端拉取（sessionModes / sessionConfigOptions）。
//
// 用法：
//   node apply-mode-unify.mjs --dry   # 只检查命中，不写盘
//   node apply-mode-unify.mjs         # 实际写盘
import { readFileSync, writeFileSync } from 'node:fs';

const DRY = process.argv.includes('--dry');
const j = (...lines) => lines.join('\n');

const F1 = 'src/components/business/ai/chat/AiPromptInput.vue';
const F2 = 'src/components/business/ai/shell/AiAssistantPanel.vue';

const edits = [
  // ============================================================
  //  F1: AiPromptInput.vue
  // ============================================================
  { file: F1, label: 'F1.imports-lucide', old: j(
`import {`,
`  ArrowUp,`,
`  Bot,`,
`  Check,`,
`  ChevronRight,`,
`  Globe,`,
`  MessageCircle,`,
`  Network,`,
`  Paintbrush,`,
`  Paperclip,`,
`  Plus,`,
`  Route,`,
`  Settings2,`,
`  SlidersHorizontal,`,
`  Square,`,
`  Workflow,`,
`} from '@lucide/vue';`), new: j(
`import {`,
`  ArrowUp,`,
`  Bot,`,
`  ChevronRight,`,
`  Globe,`,
`  Network,`,
`  Paintbrush,`,
`  Paperclip,`,
`  Plus,`,
`  Route,`,
`  Settings2,`,
`  Square,`,
`} from '@lucide/vue';`) },

  { file: F1, label: 'F1.imports-vue+vueuse', old: j(
`import { useTimeoutFn } from '@vueuse/core';`,
`import { computed, onBeforeUnmount, onMounted, ref, useAttrs, watch } from 'vue';`),
    new: `import { computed, onMounted, ref, useAttrs, watch } from 'vue';` },

  { file: F1, label: 'F1.imports-sidecar', old: j(
`import type {`,
`  IAcpSessionConfigOption,`,
`  IAcpSessionConfigOptionsState,`,
`  IAcpSessionMode,`,
`  IAcpSessionModesState,`,
`} from '@/types/ai/sidecar';`,
`import type { ISelectedSkill, ISkillSummary } from '@/types/ai/skill';`),
    new: `import type { ISelectedSkill, ISkillSummary } from '@/types/ai/skill';` },

  { file: F1, label: 'F1.iface-IPoint', old: j(
`interface IPoint {`,
`  x: number;`,
`  y: number;`,
`}`,
``,
`/**`,
` * 当前会话可用的 Agent 后端：`), new: j(
`/**`,
` * 当前会话可用的 Agent 后端：`) },

  { file: F1, label: 'F1.model-kimiMode', old: j(
`const selectedAgent = defineModel<TAiPromptAgentKind>('agentBackend', {`,
`  default: 'kimi',`,
`});`), new: j(
`const selectedAgent = defineModel<TAiPromptAgentKind>('agentBackend', {`,
`  default: 'kimi',`,
`});`,
``,
`// Kimi Code 当前选中的内置模式（普通 / Plan / Auto / YOLO），与 builtin 的 activeMode 解耦。`,
`const kimiMode = defineModel<string>('kimiMode', { default: 'normal' });`) },

  { file: F1, label: 'F1.refs', old: j(
`const isComposing = ref(false);`,
`const isModeSubmenuOpen = ref(false);`,
`const modeMenuItemElement = ref<HTMLElement | null>(null);`,
`const modeSubmenuRef = ref<HTMLElement | null>(null);`,
`const pendingAttachmentDrafts = ref<IAiAttachedFile[]>([]);`), new: j(
`const isComposing = ref(false);`,
`const pendingAttachmentDrafts = ref<IAiAttachedFile[]>([]);`) },

  { file: F1, label: 'F1.modeOptions+KIMI', old: j(
`const MODE_SUBMENU_CLOSE_DELAY_MS = 180;`,
``,
`const modeOptions: IAiPromptModeOption[] = [`,
`  { key: 'chat', label: 'chat' },`,
`  { key: 'agent', label: 'agent' },`,
`  { key: 'plan', label: 'plan' },`,
`];`), new: j(
`const modeOptions: IAiPromptModeOption[] = [`,
`  { key: 'chat', label: 'chat' },`,
`  { key: 'agent', label: 'agent' },`,
`  { key: 'plan', label: 'plan' },`,
`];`,
``,
`// Kimi Code 官方内置模式（固定集合，非 ACP 动态公示）。`,
`const KIMI_MODES: { key: string; label: string }[] = [`,
`  { key: 'normal', label: '普通' },`,
`  { key: 'plan', label: 'Plan' },`,
`  { key: 'auto', label: 'Auto' },`,
`  { key: 'yolo', label: 'YOLO' },`,
`];`) },

  { file: F1, label: 'F1.computeds-modeselect', old: j(
`const activeModeOption = computed(`,
`  () => modeOptions.find((option) => option.key === activeMode.value) ?? modeOptions[0],`,
`);`,
``,
`// ACP 会话配置项选择器（config_options 全量迁移）：仅 Kimi ACP agent 且后端下发配置项时`,
`// 显示；每个 config option 渲染为独立下拉，VM 由父级经 useAcpSessionConfigOptions 下传，`,
`// 选择时回投 (configId, valueId) 原文。`,
`const sessionConfigOptionList = computed(() => props.sessionConfigOptions?.configOptions ?? []);`,
``,
`const sessionConfigOptionsVisible = computed(`,
`  () => selectedAgent.value === 'kimi' && sessionConfigOptionList.value.length > 0,`,
`);`,
``,
`const resolveSessionConfigOptionLabel = (option: IAcpSessionConfigOption): string => {`,
`  const current = option.options.find((item) => item.value === option.currentValue);`,
`  return current?.name ?? option.name;`,
`};`,
``,
`const handleSessionConfigOptionChange = (configId: string, value: unknown): void => {`,
`  if (typeof value !== 'string' || !value.trim()) {`,
`    return;`,
`  }`,
`  const option = sessionConfigOptionList.value.find((item) => item.id === configId);`,
`  if (!option || value === option.currentValue) {`,
`    return;`,
`  }`,
`  emit('sessionConfigOptionChange', configId, value);`,
`};`,
``,
`// ACP 会话模式选择器（session/set_mode）：仅 Kimi ACP agent 且后端公示 availableModes 时显示，`,
`// 复用 Kimi 内置模式语义（绝不本地伪造 chat/agent/plan）。currentModeId 默认高亮 agent 公示值。`,
`const sessionModeList = computed<IAcpSessionMode[]>(() => props.sessionModes?.availableModes ?? []);`,
``,
`const sessionModesVisible = computed(`,
`  () => selectedAgent.value === 'kimi' && sessionModeList.value.length > 0,`,
`);`,
``,
`const sessionModeCurrentId = computed(() => props.sessionModes?.currentModeId ?? '');`,
``,
`const resolveSessionModeLabel = (): string => {`,
`  const current = sessionModeList.value.find((mode) => mode.id === sessionModeCurrentId.value);`,
`  return current?.name ?? '模式';`,
`};`,
``,
`const handleSessionModeChange = (value: unknown): void => {`,
`  if (typeof value !== 'string' || !value.trim()) {`,
`    return;`,
`  }`,
`  if (value === sessionModeCurrentId.value) {`,
`    return;`,
`  }`,
`  emit('sessionModeChange', value);`,
`};`), new: j(
`// 模式选择器（统一实现）：按当前 Agent 决定可选模式集，单一 <Select> 渲染。`,
`// - builtin：执行模式 chat / agent / plan，绑定 activeMode（驱动既有发送路由）。`,
`// - kimi：Kimi 官方内置模式 普通 / Plan / Auto / YOLO，绑定 kimiMode（静态表，非 ACP 动态）。`,
`const modeSelectItems = computed<{ key: string; label: string }[]>(() =>`,
`  selectedAgent.value === 'kimi' ? KIMI_MODES : modeOptions,`,
`);`,
``,
`const modeSelectValue = computed(() =>`,
`  selectedAgent.value === 'kimi' ? kimiMode.value : activeMode.value,`,
`);`,
``,
`const modeSelectLabel = computed(() => {`,
`  const current = modeSelectItems.value.find((item) => item.key === modeSelectValue.value);`,
`  return current?.label ?? modeSelectItems.value[0]?.label ?? '模式';`,
`});`,
``,
`const handleModeSelect = (value: unknown): void => {`,
`  if (typeof value !== 'string' || !value.trim()) {`,
`    return;`,
`  }`,
`  if (selectedAgent.value === 'kimi') {`,
`    kimiMode.value = value;`,
`    return;`,
`  }`,
`  handleModeChange(value);`,
`};`) },

  { file: F1, label: 'F1.del-hover-block', old: j(
`// -------------------------------------------------------------------------`,
`// 二级菜单 hover intent：安全走廊算法`,
`// -------------------------------------------------------------------------`,
`// immediate: false —— 仅在 scheduleModeSubmenuClose 时手动 start；`,
`// openModeSubmenu / closeModeSubmenu / 进入意图区域时 stop 取消待关。`,
`const { start: startModeSubmenuCloseTimer, stop: clearModeSubmenuCloseTimer } = useTimeoutFn(`,
`  () => {`,
`    isModeSubmenuOpen.value = false;`,
`  },`,
`  MODE_SUBMENU_CLOSE_DELAY_MS,`,
`  { immediate: false },`,
`);`,
``,
`const closeModeSubmenu = (): void => {`,
`  clearModeSubmenuCloseTimer();`,
`  isModeSubmenuOpen.value = false;`,
`};`,
``,
`const openModeSubmenu = (): void => {`,
`  clearModeSubmenuCloseTimer();`,
`  isModeSubmenuOpen.value = true;`,
`};`,
``,
`const scheduleModeSubmenuClose = (): void => {`,
`  clearModeSubmenuCloseTimer();`,
`  startModeSubmenuCloseTimer();`,
`};`,
``,
`const isPointInsideRect = (point: IPoint, rect: DOMRect, padding = 0): boolean =>`,
`  point.x >= rect.left - padding &&`,
`  point.x <= rect.right + padding &&`,
`  point.y >= rect.top - padding &&`,
`  point.y <= rect.bottom + padding;`,
``,
`const isPointInsideConvexPolygon = (point: IPoint, polygon: readonly IPoint[]): boolean => {`,
`  if (polygon.length < 3) {`,
`    return false;`,
`  }`,
``,
`  let sign = 0;`,
``,
`  for (let index = 0; index < polygon.length; index += 1) {`,
`    const current = polygon[index];`,
`    const next = polygon[(index + 1) % polygon.length];`,
``,
`    if (!current || !next) {`,
`      return false;`,
`    }`,
``,
`    const cross =`,
`      (next.x - current.x) * (point.y - current.y) - (next.y - current.y) * (point.x - current.x);`,
``,
`    if (Math.abs(cross) < 0.01) {`,
`      continue;`,
`    }`,
``,
`    const currentSign = cross > 0 ? 1 : -1;`,
``,
`    if (sign === 0) {`,
`      sign = currentSign;`,
`    } else if (sign !== currentSign) {`,
`      return false;`,
`    }`,
`  }`,
``,
`  return true;`,
`};`,
``,
`const isPointerInModeSubmenuIntentArea = (event: PointerEvent): boolean => {`,
`  const trigger = modeMenuItemElement.value;`,
`  const submenu = modeSubmenuRef.value;`,
``,
`  if (!trigger || !submenu) {`,
`    return false;`,
`  }`,
``,
`  const point = { x: event.clientX, y: event.clientY };`,
`  const triggerRect = trigger.getBoundingClientRect();`,
`  const submenuRect = submenu.getBoundingClientRect();`,
``,
`  if (isPointInsideRect(point, triggerRect, 8) || isPointInsideRect(point, submenuRect, 8)) {`,
`    return true;`,
`  }`,
``,
`  const bridge: IPoint[] = [`,
`    { x: triggerRect.right - 2, y: triggerRect.top - 10 },`,
`    { x: submenuRect.left + 2, y: submenuRect.top - 14 },`,
`    { x: submenuRect.left + 2, y: submenuRect.bottom + 14 },`,
`    { x: triggerRect.right - 2, y: triggerRect.bottom + 10 },`,
`  ];`,
``,
`  return isPointInsideConvexPolygon(point, bridge);`,
`};`,
``,
`const handleModeSubmenuDocumentPointerMove = (event: PointerEvent): void => {`,
`  if (!isModeSubmenuOpen.value) {`,
`    return;`,
`  }`,
``,
`  if (isPointerInModeSubmenuIntentArea(event)) {`,
`    clearModeSubmenuCloseTimer();`,
`    return;`,
`  }`,
``,
`  scheduleModeSubmenuClose();`,
`};`,
``,
`const handleModeMenuItemPointerEnter = (event: PointerEvent): void => {`,
`  modeMenuItemElement.value =`,
`    event.currentTarget instanceof HTMLElement ? event.currentTarget : null;`,
`  openModeSubmenu();`,
`};`,
``,
`const selectModeOption = (value: TAiAssistantMode): void => {`,
`  handleModeChange(value);`,
`  closeModeSubmenu();`,
`};`,
``,
`watch(isModeSubmenuOpen, (open) => {`,
`  if (typeof document === 'undefined') {`,
`    return;`,
`  }`,
``,
`  if (open) {`,
`    document.addEventListener('pointermove', handleModeSubmenuDocumentPointerMove, {`,
`      passive: true,`,
`    });`,
`  } else {`,
`    document.removeEventListener('pointermove', handleModeSubmenuDocumentPointerMove);`,
`    clearModeSubmenuCloseTimer();`,
`  }`,
`});`), new: '' },

  { file: F1, label: 'F1.del-onBeforeUnmount', old: j(
`onMounted(() => {`,
`  applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);`,
`});`,
``,
`onBeforeUnmount(() => {`,
`  if (typeof document !== 'undefined') {`,
`    document.removeEventListener('pointermove', handleModeSubmenuDocumentPointerMove);`,
`  }`,
`});`), new: j(
`onMounted(() => {`,
`  applyValueToEditor(modelValue.value ?? '', selectedSkills.value ?? []);`,
`});`) },

  { file: F1, label: 'F1.props', old: j(
`  executionMode: TAiExecutionMode;`,
`  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;`,
`  isSessionConfigOptionSwitching?: boolean;`,
`  sessionModes?: IAcpSessionModesState | null;`,
`  isSessionModeSwitching?: boolean;`,
`  resolveAttachment: (file: File) => Promise<boolean>;`), new: j(
`  executionMode: TAiExecutionMode;`,
`  resolveAttachment: (file: File) => Promise<boolean>;`) },

  { file: F1, label: 'F1.emits', old: j(
`  executionModeChange: [mode: TAiExecutionMode];`,
`  sessionConfigOptionChange: [configId: string, valueId: string];`,
`  sessionModeChange: [modeId: string];`,
`  informationSourcesOpen: [];`), new: j(
`  executionModeChange: [mode: TAiExecutionMode];`,
`  informationSourcesOpen: [];`) },

  { file: F1, label: 'F1.tpl-del-old-mode-item', old: j(
`                <DropdownMenuItem`,
`                  v-if="!sessionModesVisible"`,
`                  class="ai-settings-menu-item is-mode"`,
`                  @pointerenter="handleModeMenuItemPointerEnter"`,
`                  @pointerleave="scheduleModeSubmenuClose"`,
`                  @select.prevent`,
`                  @click.stop="openModeSubmenu"`,
`                >`,
`                  <Route class="ai-settings-menu-icon" />`,
`                  <span class="ai-settings-menu-label">模式</span>`,
`                  <span class="ai-settings-menu-value" v-text="activeModeOption.label"></span>`,
`                  <ChevronRight class="ai-settings-menu-chevron" />`,
`                  <div`,
`                    v-if="isModeSubmenuOpen"`,
`                    ref="modeSubmenuRef"`,
`                    class="ai-mode-submenu"`,
`                    @pointerenter="openModeSubmenu"`,
`                    @pointerleave="scheduleModeSubmenuClose"`,
`                  >`,
`                    <button`,
`                      v-for="option in modeOptions"`,
`                      :key="option.key"`,
`                      type="button"`,
`                      class="ai-mode-submenu-item"`,
`                      :class="{ 'is-active': activeMode === option.key }"`,
`                      @click="selectModeOption(option.key)"`,
`                    >`,
`                      <MessageCircle class="ai-mode-submenu-icon" v-if="option.key === 'chat'" />`,
`                      <Workflow class="ai-mode-submenu-icon" v-else-if="option.key === 'plan'" />`,
`                      <SlidersHorizontal class="ai-mode-submenu-icon" v-else />`,
`                      <span class="ai-mode-submenu-copy">`,
`                        <span class="ai-mode-submenu-label" v-text="option.label"></span>`,
`                      </span>`,
`                      <Check class="ai-mode-submenu-check" v-if="activeMode === option.key" />`,
`                    </button>`,
`                  </div>`,
`                </DropdownMenuItem>`), new: '' },

  { file: F1, label: 'F1.tpl-plan-toggle-vif', old: j(
`                <DropdownMenuItem`,
`                  v-if="activeMode === 'plan'"`,
`                  class="ai-settings-menu-item"`,
`                  :disabled="disabled"`,
`                  @select.prevent="toggleExecutionMode"`,
`                >`), new: j(
`                <DropdownMenuItem`,
`                  v-if="selectedAgent === 'builtin' && activeMode === 'plan'"`,
`                  class="ai-settings-menu-item"`,
`                  :disabled="disabled"`,
`                  @select.prevent="toggleExecutionMode"`,
`                >`) },

  { file: F1, label: 'F1.tpl-mode-select', old: j(
`            <Select`,
`              v-if="sessionModesVisible"`,
`              :model-value="sessionModeCurrentId"`,
`              :disabled="disabled || isSessionModeSwitching"`,
`              @update:model-value="handleSessionModeChange"`,
`            >`,
`              <SelectTrigger aria-label="选择模式" class="ai-agent-trigger">`,
`                <SlidersHorizontal class="ai-agent-trigger__icon" :stroke-width="1.6" />`,
`                <span class="ai-agent-trigger__label" v-text="resolveSessionModeLabel()"></span>`,
`              </SelectTrigger>`,
`              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">`,
`                <SelectLabel class="ai-agent-section-label">模式</SelectLabel>`,
`                <SelectGroup>`,
`                  <SelectItem`,
`                    v-for="mode in sessionModeList"`,
`                    :key="mode.id"`,
`                    class="ai-agent-item"`,
`                    :value="mode.id"`,
`                  >`,
`                    <span class="ai-agent-item__label" v-text="mode.name"></span>`,
`                  </SelectItem>`,
`                </SelectGroup>`,
`              </SelectContent>`,
`            </Select>`,
`            <template v-if="sessionConfigOptionsVisible">`,
`              <Select`,
`                v-for="configOption in sessionConfigOptionList"`,
`                :key="configOption.id"`,
`                :model-value="configOption.currentValue"`,
`                :disabled="disabled || isSessionConfigOptionSwitching"`,
`                @update:model-value="(value) => handleSessionConfigOptionChange(configOption.id, value)"`,
`              >`,
`                <SelectTrigger :aria-label="configOption.name" class="ai-agent-trigger">`,
`                  <SlidersHorizontal class="ai-agent-trigger__icon" :stroke-width="1.6" />`,
`                  <span`,
`                    class="ai-agent-trigger__label"`,
`                    v-text="resolveSessionConfigOptionLabel(configOption)"`,
`                  ></span>`,
`                </SelectTrigger>`,
`                <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">`,
`                  <SelectLabel class="ai-agent-section-label" v-text="configOption.name"></SelectLabel>`,
`                  <SelectGroup>`,
`                    <SelectItem`,
`                      v-for="opt in configOption.options"`,
`                      :key="opt.value"`,
`                      class="ai-agent-item"`,
`                      :value="opt.value"`,
`                    >`,
`                      <span class="ai-agent-item__label" v-text="opt.name"></span>`,
`                    </SelectItem>`,
`                  </SelectGroup>`,
`                </SelectContent>`,
`              </Select>`,
`            </template>`), new: j(
`            <Select`,
`              :model-value="modeSelectValue"`,
`              :disabled="disabled"`,
`              @update:model-value="handleModeSelect"`,
`            >`,
`              <SelectTrigger aria-label="选择模式" class="ai-agent-trigger">`,
`                <Route class="ai-agent-trigger__icon" :stroke-width="1.6" />`,
`                <span class="ai-agent-trigger__label" v-text="modeSelectLabel"></span>`,
`              </SelectTrigger>`,
`              <SelectContent side="top" align="start" :side-offset="8" class="ai-agent-content">`,
`                <SelectLabel class="ai-agent-section-label">模式</SelectLabel>`,
`                <SelectGroup>`,
`                  <SelectItem`,
`                    v-for="mode in modeSelectItems"`,
`                    :key="mode.key"`,
`                    class="ai-agent-item"`,
`                    :value="mode.key"`,
`                  >`,
`                    <span class="ai-agent-item__label" v-text="mode.label"></span>`,
`                  </SelectItem>`,
`                </SelectGroup>`,
`              </SelectContent>`,
`            </Select>`) },

  { file: F1, label: 'F1.css-is-mode-hover', old: j(
`.ai-settings-menu-item[data-highlighted],`,
`.ai-settings-menu-item[data-state='open'],`,
`.ai-settings-menu-item.is-mode:hover {`,
`  background: var(--ai-menu-hover);`,
`  color: var(--ai-menu-text);`,
`}`), new: j(
`.ai-settings-menu-item[data-highlighted],`,
`.ai-settings-menu-item[data-state='open'] {`,
`  background: var(--ai-menu-hover);`,
`  color: var(--ai-menu-text);`,
`}`) },

  { file: F1, label: 'F1.css-settings-menu-value', old: j(
`.ai-settings-menu-value {`,
`  color: var(--ai-menu-muted);`,
`  font-size: 13px;`,
`  text-transform: lowercase;`,
`}`), new: '' },

  { file: F1, label: 'F1.css-mode-submenu', old: j(
`.ai-mode-submenu {`,
`  position: absolute;`,
`  left: calc(100% + 6px);`,
`  top: auto;`,
`  bottom: 0;`,
`  z-index: 70;`,
`  display: grid;`,
`  width: min(200px, calc(100vw - 24px));`,
`  max-height: min(240px, calc(100vh - 32px));`,
`  overflow-y: auto;`,
`  gap: 2px;`,
`  border: 1px solid #eeedeb;`,
`  border-radius: 8px;`,
`  background: var(--ai-menu-bg);`,
`  padding: 5px;`,
`  box-shadow: var(--ai-menu-shadow);`,
`}`,
``,
`.ai-mode-submenu::before {`,
`  position: absolute;`,
`  top: -8px;`,
`  bottom: -8px;`,
`  left: -12px;`,
`  width: 12px;`,
`  content: '';`,
`}`,
``,
`.ai-mode-submenu-item {`,
`  display: grid;`,
`  grid-template-columns: 20px minmax(0, 1fr) 18px;`,
`  gap: 9px;`,
`  min-height: 34px;`,
`  align-items: center;`,
`  border: 0;`,
`  border-radius: 7px;`,
`  background: transparent;`,
`  color: var(--ai-menu-text);`,
`  padding: 6px 8px;`,
`  text-align: left;`,
`}`,
``,
`.ai-mode-submenu-item:hover,`,
`.ai-mode-submenu-item.is-active {`,
`  background: var(--ai-menu-hover);`,
`}`,
``,
`.ai-mode-submenu-icon,`,
`.ai-mode-submenu-check {`,
`  width: 18px;`,
`  height: 18px;`,
`  stroke-width: 1.8;`,
`}`,
``,
`.ai-mode-submenu-copy {`,
`  display: grid;`,
`  min-width: 0;`,
`  gap: 4px;`,
`}`,
``,
`.ai-mode-submenu-label {`,
`  color: var(--ai-menu-text);`,
`  font-size: 14px;`,
`  line-height: 1.2;`,
`}`), new: '' },

  // ============================================================
  //  F2: AiAssistantPanel.vue
  // ============================================================
  { file: F2, label: 'F2.import-vue', old:
`import { computed, defineAsyncComponent, onMounted, ref, watch } from 'vue';`, new:
`import { computed, defineAsyncComponent, onMounted, ref } from 'vue';` },

  { file: F2, label: 'F2.prompt-props', old: j(
`        <AiPromptInput v-else v-model="assistant.draft.value" v-model:active-mode="assistant.activeMode.value"`,
`          v-model:agent-backend="sessionAgentBackend"`,
`          :session-config-options="assistant.acpSessionConfigOptions.state.value"`,
`          :is-session-config-option-switching="assistant.acpSessionConfigOptions.isSwitching.value"`,
`          :session-modes="assistant.acpSessionModes.state.value"`,
`          :is-session-mode-switching="assistant.acpSessionModes.isSwitching.value"`,
`          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"`), new: j(
`        <AiPromptInput v-else v-model="assistant.draft.value" v-model:active-mode="assistant.activeMode.value"`,
`          v-model:agent-backend="sessionAgentBackend"`,
`          :disabled="composerDisabled" :stop-visible="assistant.isSending.value"`) },

  { file: F2, label: 'F2.prompt-emits', old: j(
`          @execution-mode-change="handlePromptExecutionModeChange"`,
``,
`          @session-config-option-change="handleSessionConfigOptionChange"`,
`          @session-mode-change="handleSessionModeChange"`,
`          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"`), new: j(
`          @execution-mode-change="handlePromptExecutionModeChange"`,
`          @information-sources-open="openPromptInformationSources" @personalization-open="openPromptPersonalization"`) },

  { file: F2, label: 'F2.del-handlers', old: j(
`// ACP 会话配置项切换（config_options 全量迁移发送侧）：选择器回投透传给`,
`// useAcpSessionConfigOptions.selectConfigOption（乐观更新 + setSessionConfigOption 回投，`,
`// 失败回滚并提示）。`,
`const handleSessionConfigOptionChange = async (`,
`  configId: string,`,
`  valueId: string,`,
`): Promise<void> => {`,
`  const threadId = assistant.activeConversationId.value;`,
`  if (!threadId) {`,
`    return;`,
`  }`,
`  try {`,
`    await assistant.acpSessionConfigOptions.selectConfigOption(threadId, configId, valueId);`,
`  } catch (error) {`,
`    assistant.error.value = toErrorMessage(error, '切换会话配置失败。');`,
`  }`,
`};`,
``,
`// ACP 会话模式切换（session/set_mode）：选择器回投透传给 useAcpSessionModes.selectMode`,
`// （乐观更新 + setSessionMode 回投，失败回滚并提示）。复用 Kimi 内置模式语义。`,
`const handleSessionModeChange = async (modeId: string): Promise<void> => {`,
`  const threadId = assistant.activeConversationId.value;`,
`  if (!threadId) {`,
`    return;`,
`  }`,
`  try {`,
`    await assistant.acpSessionModes.selectMode(threadId, modeId);`,
`  } catch (error) {`,
`    assistant.error.value = toErrorMessage(error, '切换会话模式失败。');`,
`  }`,
`};`), new: '' },

  { file: F2, label: 'F2.del-refresh+watch', old: j(
`// Kimi 默认即为当前会话后端，但 loadModes 此前仅在「手动切到 kimi」时触发；`,
`// 这里补齐：挂载即 kimi、会话切换、以及每轮回复结束（此时 ACP 会话已建立）后`,
`// 重新拉取内置模式，确保 availableModes 非空、模式选择器能正常替换硬编码菜单。`,
`const refreshKimiSessionModes = (): void => {`,
`  if (sessionAgentBackend.value !== 'kimi') {`,
`    return;`,
`  }`,
``,
`  const threadId = assistant.activeConversationId.value;`,
``,
`  if (!threadId) {`,
`    return;`,
`  }`,
``,
`  void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);`,
`  void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);`,
`};`,
``,
`watch(`,
`  () =>`,
`    [`,
`      sessionAgentBackend.value,`,
`      assistant.activeConversationId.value,`,
`      assistant.isSending.value,`,
`    ] as const,`,
`  ([backend, threadId, isSending], previous) => {`,
`    if (backend !== 'kimi' || !threadId || isSending) {`,
`      return;`,
`    }`,
``,
`    const backendChanged = !previous || previous[0] !== backend;`,
`    const threadChanged = !previous || previous[1] !== threadId;`,
`    const sendingJustFinished = Boolean(previous) && previous[2] === true;`,
``,
`    if (backendChanged || threadChanged || sendingJustFinished) {`,
`      refreshKimiSessionModes();`,
`    }`,
`  },`,
`  { immediate: true },`,
`);`), new: '' },

  { file: F2, label: 'F2.handleAgentBackendChange', old: j(
`const handleAgentBackendChange = (agent: unknown): void => {`,
`  if (!isSessionAgentBackend(agent)) {`,
`    return;`,
`  }`,
``,
`  sessionAgentBackend.value = agent;`,
`  assistant.error.value = '';`,
``,
`  if (agent === 'kimi') {`,
`    const threadId = assistant.activeConversationId.value;`,
``,
`    if (threadId) {`,
`      void assistant.acpSessionConfigOptions.loadConfigOptions(threadId).catch(() => undefined);`,
`      void assistant.acpSessionModes.loadModes(threadId).catch(() => undefined);`,
`    }`,
`  }`,
`};`), new: j(
`const handleAgentBackendChange = (agent: unknown): void => {`,
`  if (!isSessionAgentBackend(agent)) {`,
`    return;`,
`  }`,
``,
`  sessionAgentBackend.value = agent;`,
`  assistant.error.value = '';`,
`};`) },
];

// ---------------- 运行器 ----------------
const byFile = new Map();
for (const e of edits) {
  if (!byFile.has(e.file)) byFile.set(e.file, []);
  byFile.get(e.file).push(e);
}

let hadError = false;

for (const [file, fileEdits] of byFile) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`✗ 读取失败 ${file}: ${err.message}`);
    hadError = true;
    continue;
  }

  // 统一按 \n 处理锚点，写回时还原原始 EOL。
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = raw.split('\r\n').join('\n');

  let applied = 0;
  let skipped = 0;

  for (const e of fileEdits) {
    const count = text.split(e.old).length - 1;
    if (count === 1) {
      text = text.split(e.old).join(e.new);
      applied += 1;
      console.log(`  ✓ ${e.label}`);
    } else if (count === 0) {
      // 锚点不在：可能已应用过（幂等）。new 非空且已存在则视为已应用，否则报错。
      const alreadyApplied = e.new !== '' && text.includes(e.new);
      if (alreadyApplied) {
        skipped += 1;
        console.log(`  ↷ ${e.label} (已应用，跳过)`);
      } else {
        console.error(`  ✗ ${e.label} (锚点未命中，且未检测到目标内容)`);
        hadError = true;
      }
    } else {
      console.error(`  ✗ ${e.label} (锚点命中 ${count} 次，需唯一，已中止该文件)`);
      hadError = true;
    }
  }

  // 收敛删除留下的多余空行（避免 no-multiple-empty-lines）。
  text = text.replace(/\n{3,}/g, '\n\n');

  const out = text.split('\n').join(eol);

  console.log(`${file}: 应用 ${applied}，跳过 ${skipped}`);

  if (!DRY && !hadError && out !== raw) {
    writeFileSync(file, out, 'utf8');
    console.log(`  → 已写入 ${file}`);
  } else if (!DRY && out === raw) {
    console.log(`  → 无变化，未写入 ${file}`);
  }
}

if (hadError) {
  console.error('\n存在未命中/冲突的锚点，未对相关文件写盘。请把上面 ✗ 的行贴回来。');
  process.exit(1);
} else {
  console.log(`\n${DRY ? '[dry-run] 全部锚点命中，可去掉 --dry 实跑。' : '完成。请重新 tauri dev 验证。'}`);
}