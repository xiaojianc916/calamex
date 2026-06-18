// apply-FE2-and-P4-coldstart.mjs
// FE-2：tab 栏用 store 稳定标题 + 每 tab 连接状态(error/closed)可见提示。
// P4 续：冷启动「正在启动 WSL…」可见状态 + 慢冷启动文案升级。
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const J = (lines) => lines.join('\n');

const SPECS = [
  // ── P4：session.ts 冷启动状态 ─────────────────────────────────────────────
  {
    path: 'src/terminal/session.ts',
    edits: [
      {
        id: 'cold-start-const',
        done: 'TERMINAL_COLD_START_HINT_DELAY_MS',
        find: J([
          'const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;',
          'const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;',
        ]),
        replace: J([
          'const TERMINAL_HEARTBEAT_INTERVAL_MS = 10_000;',
          '// 冷启动状态升级延迟：WSL 首次冷启动（发行版 VM 冷）可能需十余秒。连接超过此延迟仍未就绪时，',
          '// 把状态文案升级为「首次启动可能较慢」，让用户知道仍在启动而非卡死。对照 VSCode 终端「正在启动…」反馈。',
          'const TERMINAL_COLD_START_HINT_DELAY_MS = 6_000;',
          'const TERMINAL_LAYOUT_SETTLE_DELAY_MS = 72;',
        ]),
      },
      {
        id: 'cold-start-timer-start',
        done: 'const coldStartHintTimerId =',
        find: J([
          "    this._emitStatus('connecting', '正在连接 WSL2 终端…');",
          '    await nextTick();',
          "    this._emitBufferDiagnostic('ensure-connect:before-initial-layout');",
          '    this._syncTerminalLayout();',
          '    try {',
          '      let payload = await this._tauri.ensureTerminalSession({',
        ]),
        replace: J([
          "    this._emitStatus('connecting', '正在启动 WSL…');",
          '    await nextTick();',
          "    this._emitBufferDiagnostic('ensure-connect:before-initial-layout');",
          '    this._syncTerminalLayout();',
          '    // 冷启动状态升级：连接迟迟未就绪时（WSL 首次冷启动可能十余秒）把文案升级，让用户知道仍在',
          '    // 启动而非卡死；无论成功 / 失败都会在 finally 清除该定时器，避免覆盖最终的 ready / error 文案。',
          '    const coldStartHintTimerId =',
          "      typeof window !== 'undefined'",
          '        ? window.setTimeout(() => {',
          "            if (this.status.value === 'connecting') {",
          "              this._emitStatus('connecting', '正在启动 WSL…（首次启动可能较慢，请稍候）');",
          '            }',
          '          }, TERMINAL_COLD_START_HINT_DELAY_MS)',
          '        : null;',
          '    try {',
          '      let payload = await this._tauri.ensureTerminalSession({',
        ]),
      },
      {
        id: 'cold-start-timer-clear',
        done: 'window.clearTimeout(coldStartHintTimerId)',
        find: J([
          '    } catch (error) {',
          "      const message = toErrorMessage(error, '连接 WSL2 终端失败。');",
          "      this._emitStatus('error', message);",
          '      terminal.writeln(`\\x1b[31m${message}\\x1b[0m`, () => {',
          '        this._scheduleViewportSync({ scrollToBottom: true });',
          '      });',
          '    }',
          '  }',
        ]),
        replace: J([
          '    } catch (error) {',
          "      const message = toErrorMessage(error, '连接 WSL2 终端失败。');",
          "      this._emitStatus('error', message);",
          '      terminal.writeln(`\\x1b[31m${message}\\x1b[0m`, () => {',
          '        this._scheduleViewportSync({ scrollToBottom: true });',
          '      });',
          '    } finally {',
          '      if (coldStartHintTimerId !== null) {',
          '        window.clearTimeout(coldStartHintTimerId);',
          '      }',
          '    }',
          '  }',
        ]),
      },
    ],
  },

  // ── P4：EmbeddedTerminal 加载态显示 statusMessage ─────────────────────────
  {
    path: 'src/components/workbench/EmbeddedTerminal.vue',
    edits: [
      {
        id: 'loading-status-message',
        done: `v-text="statusMessage || '终端加载中'"`,
        find: '          <p class="embedded-terminal-loading-title">终端加载中</p>',
        replace:
          '          <p class="embedded-terminal-loading-title" v-text="statusMessage || \'终端加载中\'" />',
      },
    ],
  },

  // ── FE-2：TerminalTabBar 标题 + 每 tab 状态点 ─────────────────────────────
  {
    path: 'src/components/workbench/TerminalTabBar.vue',
    edits: [
      {
        id: 'tabbar-vfor-drop-index',
        done: 'v-for="tab in tabs"',
        find: J(['        v-for="(tab, index) in tabs"', '        :key="tab.sessionId"']),
        replace: J(['        v-for="tab in tabs"', '        :key="tab.sessionId"']),
      },
      {
        id: 'tabbar-label-title',
        done: 'v-text="tab.title"',
        find: `        <span class="terminal-tab-label" v-text="'终端 ' + (index + 1)" />`,
        replace: '        <span class="terminal-tab-label" v-text="tab.title" />',
      },
      {
        id: 'tabbar-status-dot',
        done: 'terminal-tab-status-dot--error',
        find: J([
          '        <span',
          '          v-if="runningSessionIds.includes(tab.sessionId)"',
          '          class="terminal-tab-running-dot"',
          '          aria-label="运行中"',
          '          title="运行中"',
          '        />',
        ]),
        replace: J([
          '        <span',
          '          v-if="runningSessionIds.includes(tab.sessionId)"',
          '          class="terminal-tab-running-dot"',
          '          aria-label="运行中"',
          '          title="运行中"',
          '        />',
          '        <span',
          '          v-else-if="isSessionUnhealthy(tab.sessionId)"',
          '          class="terminal-tab-status-dot terminal-tab-status-dot--error"',
          '          aria-label="终端连接中断"',
          '          title="连接中断，点击该终端可重连"',
          '        />',
        ]),
      },
      {
        id: 'tabbar-script-props',
        done: 'isSessionUnhealthy',
        find: J([
          "import type { ITerminalTab } from '@/store/terminalTabs';",
          '',
          'defineProps<{',
          '  tabs: ITerminalTab[];',
          '  activeSessionId: string;',
          '  runningSessionIds: string[];',
          '}>();',
        ]),
        replace: J([
          "import type { ITerminalTab } from '@/store/terminalTabs';",
          '',
          'const props = defineProps<{',
          '  tabs: ITerminalTab[];',
          '  activeSessionId: string;',
          '  runningSessionIds: string[];',
          '  statusBySession?: Record<string, string>;',
          '}>();',
          '',
          '/** 非激活 tab 的连接异常（error / closed）也要在 tab 上给出可见提示，便于发现后台终端掉线。 */',
          'const isSessionUnhealthy = (sessionId: string): boolean => {',
          '  const status = props.statusBySession?.[sessionId];',
          "  return status === 'error' || status === 'closed';",
          '};',
        ]),
      },
      {
        id: 'tabbar-status-dot-css',
        done: '.terminal-tab-status-dot--error {',
        find: J([
          '.terminal-tab-running-dot {',
          '  flex-shrink: 0;',
          '  width: 7px;',
          '  height: 7px;',
          '  border-radius: 50%;',
          '  background: var(--success, #22c55e);',
          '  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.18);',
          '  animation: terminal-tab-running-pulse 1.6s ease-in-out infinite;',
          '}',
        ]),
        replace: J([
          '.terminal-tab-running-dot {',
          '  flex-shrink: 0;',
          '  width: 7px;',
          '  height: 7px;',
          '  border-radius: 50%;',
          '  background: var(--success, #22c55e);',
          '  box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.18);',
          '  animation: terminal-tab-running-pulse 1.6s ease-in-out infinite;',
          '}',
          '',
          '.terminal-tab-status-dot {',
          '  flex-shrink: 0;',
          '  width: 7px;',
          '  height: 7px;',
          '  border-radius: 50%;',
          '}',
          '',
          '.terminal-tab-status-dot--error {',
          '  background: var(--danger, #ef4444);',
          '  box-shadow: 0 0 0 2px rgba(239, 68, 68, 0.18);',
          '}',
        ]),
      },
    ],
  },

  // ── FE-2：RunPanel 计算每 tab 状态并传入 ─────────────────────────────────
  {
    path: 'src/components/workbench/RunPanel.vue',
    edits: [
      {
        id: 'runpanel-pass-status',
        done: ':status-by-session="sessionStatusById"',
        find: J([
          '      <TerminalTabBar',
          '        class="run-panel-tabbar"',
          '        :tabs="tabs"',
          '        :active-session-id="activeSessionId"',
          '        :running-session-ids="runningSessionIds"',
          '        @select="handleSelectTab"',
        ]),
        replace: J([
          '      <TerminalTabBar',
          '        class="run-panel-tabbar"',
          '        :tabs="tabs"',
          '        :active-session-id="activeSessionId"',
          '        :running-session-ids="runningSessionIds"',
          '        :status-by-session="sessionStatusById"',
          '        @select="handleSelectTab"',
        ]),
      },
      {
        id: 'runpanel-status-computed',
        done: 'const sessionStatusById = computed',
        find: J([
          'const runningSessionIds = computed<string[]>(() =>',
          '  tabs.value',
          "    .filter((tab) => sessionStates.value.get(tab.sessionId) === 'running')",
          '    .map((tab) => tab.sessionId),',
          ');',
        ]),
        replace: J([
          'const runningSessionIds = computed<string[]>(() =>',
          '  tabs.value',
          "    .filter((tab) => sessionStates.value.get(tab.sessionId) === 'running')",
          '    .map((tab) => tab.sessionId),',
          ');',
          '',
          '// 每 tab 的连接状态镜像：来源是 registry 持有的 per-session 共享 status ref（会话创建前后同源）。',
          '// 供 tab 栏在后台 tab 掉线 / 出错时给出可见提示，实现「每 tab 独立状态显示」。',
          'const sessionStatusById = computed<Record<string, string>>(() => {',
          '  const map: Record<string, string> = {};',
          '  for (const tab of tabs.value) {',
          '    map[tab.sessionId] = registry.getStatusRefs(tab.sessionId).status.value;',
          '  }',
          '  return map;',
          '});',
        ]),
      },
    ],
  },
];

let hadError = false;
const fileLogs = [];
for (const spec of SPECS) {
  const abs = resolve(ROOT, spec.path);
  let raw;
  try {
    raw = readFileSync(abs, 'utf8');
  } catch (e) {
    console.error(`❌ 读取失败 ${spec.path}: ${e.message}`);
    hadError = true;
    continue;
  }
  const usesCrlf = raw.includes('\r\n');
  let content = usesCrlf ? raw.replace(/\r\n/g, '\n') : raw;

  // 先校验全部 edit（已应用或锚点唯一命中），全部通过才写入该文件。
  const plan = [];
  let fileOk = true;
  for (const edit of spec.edits) {
    if (edit.done && content.includes(edit.done)) {
      plan.push({ id: edit.id, action: 'skip' });
      continue;
    }
    const occ = content.split(edit.find).length - 1;
    if (occ !== 1) {
      console.error(`❌ ${spec.path}: 锚点命中 ${occ} 次（应为 1）：${edit.id}`);
      fileOk = false;
    } else {
      plan.push({ id: edit.id, action: 'apply', edit });
    }
  }
  if (!fileOk) {
    hadError = true;
    continue;
  }
  for (const step of plan) {
    if (step.action === 'apply') content = content.replace(step.edit.find, step.edit.replace);
  }
  const out = usesCrlf ? content.replace(/\n/g, '\r\n') : content;
  const changed = out !== raw;
  if (changed) writeFileSync(abs, out, 'utf8');
  fileLogs.push(
    `${changed ? '✅ 写入' : '➖ 无变更'} ${spec.path}${usesCrlf ? ' (CRLF)' : ''}\n      ` +
      plan.map((s) => `${s.action === 'skip' ? '已存在' : '应用'}:${s.id}`).join('  '),
  );
}
for (const l of fileLogs) console.log(l);
if (hadError) {
  console.error('\n⚠️ 有文件因锚点不匹配被跳过（未写入），请贴回报错，勿手动改。');
  process.exit(1);
}
console.log('\n完成。FE-2 每 tab 标题+状态点 / P4 冷启动状态 已就绪。');