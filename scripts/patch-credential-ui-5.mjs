import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDER = 'src/components/business/ai/provider/AiProviderSettings.vue';

function readNormalized(path) {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { src: raw.replace(/\r\n/g, '\n'), eol };
}
function writeWithEol(path, src, eol) {
  writeFileSync(path, eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
}

function applyEdit(src, { find, replace, skip, label }) {
  if (skip && skip(src)) {
    console.log(`⏭  跳过(已应用):${label}`);
    return src;
  }
  const count = src.split(find).length - 1;
  if (count === 0) throw new Error(`❌ 未找到锚点:${label}(请确认本地已 git pull 最新 main)`);
  if (count > 1) throw new Error(`❌ 锚点不唯一(${count} 处):${label}`);
  console.log(`✅ ${label}`);
  return src.replace(find, replace);
}

let { src, eol } = readNormalized(PROVIDER);

const edits = [
  {
    label: '#14 <style> → <style scoped>',
    skip: (s) => s.includes('<style scoped>'),
    find: `<style>\n.ai-credential-shell {`,
    replace: `<style scoped>\n.ai-credential-shell {`,
  },
  {
    label: '#14 :deep(button:active)',
    skip: (s) => s.includes(':deep(button:active)'),
    find: `.ai-credential-dialog button:active {`,
    replace: `.ai-credential-dialog :deep(button:active) {`,
  },
  {
    label: '#14 :deep(svg) 图标尺寸组',
    skip: (s) => s.includes('.ai-credential-head-action :deep(svg)'),
    find: `.ai-credential-head-action svg,\n.ai-credential-icon-button svg,\n.ai-credential-test svg,\n.ai-credential-status svg,\n.ai-credential-list-status svg {`,
    replace: `.ai-credential-head-action :deep(svg),\n.ai-credential-icon-button :deep(svg),\n.ai-credential-test :deep(svg),\n.ai-credential-status :deep(svg),\n.ai-credential-list-status :deep(svg) {`,
  },
  {
    label: '#14 :deep(svg:last-child) 选项勾选',
    skip: (s) => s.includes('.ai-credential-combobox-option :deep(svg:last-child)'),
    find: `.ai-credential-combobox-option svg:last-child {`,
    replace: `.ai-credential-combobox-option :deep(svg:last-child) {`,
  },
  {
    label: '#14 :deep(svg:last-child) 选中态勾选',
    skip: (s) => s.includes('.is-selected :deep(svg:last-child)'),
    find: `.ai-credential-combobox-option.is-selected svg:last-child {`,
    replace: `.ai-credential-combobox-option.is-selected :deep(svg:last-child) {`,
  },
  {
    label: '#14 :deep(svg) 默认小模型徙章',
    skip: (s) => s.includes('.ai-credential-default-mark__icon :deep(svg)'),
    find: `.ai-credential-default-mark__icon svg {`,
    replace: `.ai-credential-default-mark__icon :deep(svg) {`,
  },
  {
    label: '#14 :deep(svg) Key 显隐按钮',
    skip: (s) => s.includes('.ai-credential-key-toggle :deep(svg)'),
    find: `.ai-credential-key-toggle svg {`,
    replace: `.ai-credential-key-toggle :deep(svg) {`,
  },
  {
    label: '#14 footer :deep(button) 基础',
    skip: (s) => s.includes(':deep(button:not(.ai-credential-test)) {'),
    find: `.ai-credential-foot>button:not(.ai-credential-test) {`,
    replace: `.ai-credential-foot > :deep(button:not(.ai-credential-test)) {`,
  },
  {
    label: '#14 footer :deep(button) hover',
    skip: (s) => s.includes(':deep(button:not(.ai-credential-test):hover:not(:disabled)) {'),
    find: `.ai-credential-foot>button:not(.ai-credential-test):hover:not(:disabled) {`,
    replace: `.ai-credential-foot > :deep(button:not(.ai-credential-test):hover:not(:disabled)) {`,
  },
  {
    label: '#14 footer :deep(button) last-child',
    skip: (s) => s.includes(':deep(button:not(.ai-credential-test):last-child) {'),
    find: `.ai-credential-foot>button:not(.ai-credential-test):last-child {`,
    replace: `.ai-credential-foot > :deep(button:not(.ai-credential-test):last-child) {`,
  },
  {
    label: '#14 footer :deep(button) last-child:not(disabled)',
    skip: (s) => s.includes(':deep(button:not(.ai-credential-test):last-child:not(:disabled)) {'),
    find: `.ai-credential-foot>button:not(.ai-credential-test):last-child:not(:disabled) {`,
    replace: `.ai-credential-foot > :deep(button:not(.ai-credential-test):last-child:not(:disabled)) {`,
  },
  {
    label: '#14 footer :deep(button.save) accent',
    skip: (s) => s.includes(':deep(button.ai-credential-save:last-child:not(:disabled)) {'),
    find: `.ai-credential-foot>button.ai-credential-save:last-child:not(:disabled) {`,
    replace: `.ai-credential-foot > :deep(button.ai-credential-save:last-child:not(:disabled)) {`,
  },
  {
    label: '#14 footer :deep(button.save) accent hover',
    skip: (s) => s.includes(':deep(button.ai-credential-save:last-child:not(:disabled):hover) {'),
    find: `.ai-credential-foot>button.ai-credential-save:last-child:not(:disabled):hover {`,
    replace: `.ai-credential-foot > :deep(button.ai-credential-save:last-child:not(:disabled):hover) {`,
  },
];

for (const edit of edits) {
  src = applyEdit(src, edit);
}

writeWithEol(PROVIDER, src, eol);
console.log('\n🎉 #14 完成:样式已 scoped,子组件/原生元素选择器已用 :deep() 保留。');
