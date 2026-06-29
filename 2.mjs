// 10.mjs —— Finding F(更正版):RunPanel 工具栏 tooltip 迁移到官方 AppTooltip + 删除死系统 app-tooltip.ts
// 在仓库根目录执行：node 10.mjs
import { readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';

const ROOT = process.cwd();
const RUN_PANEL = 'src/domains/terminal/ui/RunPanel.vue';
const DEAD = 'src/utils/window/app-tooltip.ts';
const DEAD_SPEC = 'src/utils/window/app-tooltip.spec.ts';

function die(msg) {
  console.error('✘ ' + msg + ' 已中止,未写入/删除任何文件。');
  process.exit(1);
}
function readText(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) die('找不到文件 ' + rel + '。');
  return readFileSync(abs, 'utf8');
}
// CRLF 安全
function detectCRLF(s) { return s.includes('\r\n'); }
function toLF(s) { return s.replace(/\r\n/g, '\n'); }
function restore(s, crlf) { return crlf ? s.replace(/\n/g, '\r\n') : s; }
function replaceOnce(src, oldStr, newStr, label) {
  const n = src.split(oldStr).length - 1;
  if (n !== 1) die('[' + label + '] 预期精确命中 1 次,实际 ' + n + ' 次。');
  return src.split(oldStr).join(newStr);
}

// ---------- 1) 迁移 RunPanel.vue ----------
const crlf = detectCRLF(readText(RUN_PANEL));
let rp = toLF(readText(RUN_PANEL));

// 1a. 插入 AppTooltip import(放在 @/composables 之前,符合 biome 导入排序)
const importAnchor = `import { useMessage } from '@/composables/useMessage';`;
const importNew = `import AppTooltip from '@/components/ui/tooltip/AppTooltip.vue';\n` + importAnchor;
rp = replaceOnce(rp, importAnchor, importNew, 'import AppTooltip');

// 1b. 四个按钮 → 用官方 AppTooltip 包裹,去掉 data-tooltip* 与 app-tooltip-target
const stopOld = [
`        <button v-if="canStopRun" type="button"`,
`          class="icon-button app-tooltip-target run-panel-action-button run-panel-action-button--stop"`,
`          data-tooltip="停止 / 重置运行" data-tooltip-placement="top" aria-label="停止 / 重置运行"`,
`          @click="void handleStopRun()">`,
`          <Square aria-hidden="true" />`,
`        </button>`,
].join('\n');
const stopNew = [
`        <AppTooltip v-if="canStopRun" content="停止 / 重置运行">`,
`          <button type="button"`,
`            class="icon-button run-panel-action-button run-panel-action-button--stop"`,
`            aria-label="停止 / 重置运行"`,
`            @click="void handleStopRun()">`,
`            <Square aria-hidden="true" />`,
`          </button>`,
`        </AppTooltip>`,
].join('\n');
rp = replaceOnce(rp, stopOld, stopNew, '停止按钮');

const reconnectOld = [
`        <button type="button" class="icon-button app-tooltip-target run-panel-action-button" data-tooltip="重连终端"`,
`          data-tooltip-placement="top" aria-label="重连终端" @click="void handleRestartTerminal()">`,
`          <RefreshCcw aria-hidden="true" />`,
`        </button>`,
].join('\n');
const reconnectNew = [
`        <AppTooltip content="重连终端">`,
`          <button type="button" class="icon-button run-panel-action-button" aria-label="重连终端"`,
`            @click="void handleRestartTerminal()">`,
`            <RefreshCcw aria-hidden="true" />`,
`          </button>`,
`        </AppTooltip>`,
].join('\n');
rp = replaceOnce(rp, reconnectOld, reconnectNew, '重连按钮');

const clearOld = [
`        <button type="button" class="icon-button app-tooltip-target run-panel-action-button" data-tooltip="清屏"`,
`          data-tooltip-placement="top" aria-label="清屏" :disabled="!isTerminalReady" @click="void handleClearTerminal()">`,
`          <Eraser aria-hidden="true" />`,
`        </button>`,
].join('\n');
const clearNew = [
`        <AppTooltip content="清屏">`,
`          <button type="button" class="icon-button run-panel-action-button" aria-label="清屏"`,
`            :disabled="!isTerminalReady" @click="void handleClearTerminal()">`,
`            <Eraser aria-hidden="true" />`,
`          </button>`,
`        </AppTooltip>`,
].join('\n');
rp = replaceOnce(rp, clearOld, clearNew, '清屏按钮');

const maxOld = [
`        <button type="button" class="icon-button app-tooltip-target run-panel-action-button"`,
`          :data-tooltip="props.isMaximized ? '还原终端高度' : '最大化终端'" data-tooltip-placement="top"`,
`          :aria-label="props.isMaximized ? '还原终端高度' : '最大化终端'" :aria-pressed="props.isMaximized"`,
`          @click="$emit('toggle-maximize')">`,
`          <Maximize2 v-if="!props.isMaximized" aria-hidden="true" />`,
`          <Minimize2 v-else aria-hidden="true" />`,
`        </button>`,
].join('\n');
const maxNew = [
`        <AppTooltip :content="props.isMaximized ? '还原终端高度' : '最大化终端'">`,
`          <button type="button" class="icon-button run-panel-action-button"`,
`            :aria-label="props.isMaximized ? '还原终端高度' : '最大化终端'" :aria-pressed="props.isMaximized"`,
`            @click="$emit('toggle-maximize')">`,
`            <Maximize2 v-if="!props.isMaximized" aria-hidden="true" />`,
`            <Minimize2 v-else aria-hidden="true" />`,
`          </button>`,
`        </AppTooltip>`,
].join('\n');
rp = replaceOnce(rp, maxOld, maxNew, '最大化按钮');

// 1c. 后置守卫
if (rp.includes('app-tooltip-target')) die('RunPanel 仍残留 app-tooltip-target。');
if (rp.includes('data-tooltip')) die('RunPanel 仍残留 data-tooltip。');
const appTooltipTags = rp.split('<AppTooltip').length - 1;
if (appTooltipTags !== 4) die('RunPanel 中 <AppTooltip 数量异常:' + appTooltipTags + '(应为 4)。');
if (!rp.includes(`import AppTooltip from '@/components/ui/tooltip/AppTooltip.vue';`)) die('RunPanel 缺少 AppTooltip 导入。');

writeFileSync(join(ROOT, RUN_PANEL), restore(rp, crlf), 'utf8');
console.log('✔ 已迁移 ' + RUN_PANEL + ':4 个按钮改用官方 <AppTooltip>,清除孤儿 data-tooltip / app-tooltip-target。');

// ---------- 2) 精确反向引用扫描,确认死系统无人引用 ----------
const TOKENS = ['window/app-tooltip', 'initAppTooltipSystem', 'IAppTooltipSystem'];
const skip = new Set([posix.normalize(DEAD), posix.normalize(DEAD_SPEC)]);
function walk(dirRel, out) {
  for (const name of readdirSync(join(ROOT, dirRel))) {
    const rel = posix.join(dirRel, name);
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) { walk(rel, out); continue; }
    if (!/\.(ts|vue)$/.test(name)) continue;
    if (skip.has(posix.normalize(rel))) continue;
    out.push(rel);
  }
}
const files = [];
walk('src', files);
const refs = [];
for (const rel of files) {
  const txt = readFileSync(join(ROOT, rel), 'utf8');
  if (TOKENS.some((t) => txt.includes(t))) refs.push(rel);
}
if (refs.length > 0) {
  console.error('⚠ 仍发现死系统的真实引用,已保留 RunPanel 改动但不删除死文件:');
  for (const r of refs) console.error('  ' + r);
  console.error('请人工复核后再决定是否删除 ' + DEAD + ' / ' + DEAD_SPEC + '。');
  process.exit(0);
}

// ---------- 3) 删除死系统文件 ----------
rmSync(join(ROOT, DEAD), { force: true });
rmSync(join(ROOT, DEAD_SPEC), { force: true });
console.log('✔ 已删除死文件:' + DEAD);
console.log('✔ 已删除死文件:' + DEAD_SPEC);

console.log('\n下一步验证(全绿才算通过):');
console.log('  pnpm typecheck && pnpm lint && pnpm test && pnpm build');