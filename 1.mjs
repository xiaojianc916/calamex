// 2.mjs (增量:开关改小 / 修复切换闪烁 / 导航项点击后关闭)
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';
let s = readFileSync(FILE, 'utf8');
console.log('换行符:', s.includes('\r\n') ? 'CRLF' : 'LF');

function sliceBlock(src, marker) {
  const a = src.indexOf(marker);
  if (a < 0) return null;
  const o = src.indexOf('{', a);
  const c = src.indexOf('}', o);
  if (o < 0 || c < 0) return null;
  return { head: src.slice(0, o + 1), body: src.slice(o + 1, c), tail: src.slice(c) };
}
function editBlock(marker, label, fn) {
  const b = sliceBlock(s, marker);
  if (!b) throw new Error(`找不到块: ${label} (${marker})`);
  s = b.head + fn(b.body) + b.tail;
}
function sub(body, re, to, label) {
  if (re.test(body)) return body.replace(re, to);
  if (body.includes(to)) { console.log('已是目标,跳过:', label); return body; }
  throw new Error(`块内未匹配: ${label}\n—— 块内容(贴给我) ——\n${body}\n————`);
}
function ensureReplace(oldStr, newStr, label) {
  if (s.includes(oldStr)) {
    if (s.split(oldStr).length - 1 > 1) throw new Error(`不唯一: ${label}`);
    s = s.replace(oldStr, newStr);
    console.log('改:', label);
  } else if (s.includes(newStr)) {
    console.log('已是目标,跳过:', label);
  } else {
    throw new Error(`未找到: ${label}`);
  }
}

// 1) 开关尺寸
editBlock('.ai-network-switch {', '.ai-network-switch', (b) => {
  b = sub(b, /width:\s*36px;/, 'width: 30px;', 'switch width');
  b = sub(b, /height:\s*20px;/, 'height: 18px;', 'switch height');
  return b;
});
editBlock('.ai-network-switch__thumb {', '.ai-network-switch__thumb', (b) => {
  b = sub(b, /width:\s*16px;/, 'width: 14px;', 'thumb width');
  b = sub(b, /height:\s*16px;/, 'height: 14px;', 'thumb height');
  return b;
});
editBlock(
  '.ai-network-switch.is-on .ai-network-switch__thumb {',
  '.ai-network-switch.is-on thumb',
  (b) => sub(b, /translateX\(16px\)/, 'translateX(12px)', 'thumb travel'),
);

// 2) 切换闪烁:给两个开关按钮加 @pointerdown.prevent(阻止抢焦点)
if ((s.match(/@pointerdown\.prevent/g) || []).length >= 2) {
  console.log('已有 @pointerdown.prevent,跳过');
} else {
  const re = /(class="ai-network-switch")(\r?\n)([ \t]*)/g;
  const n = (s.match(re) || []).length;
  if (n !== 2) throw new Error(`ai-network-switch 按钮数=${n},期望2`);
  s = s.replace(re, `$1$2$3@pointerdown.prevent$2$3`);
  console.log('改: 两个开关按钮 +@pointerdown.prevent');
}

// 3) 导航项点击后关闭弹窗:去掉 .prevent(开关项保留)
ensureReplace(
  '@select.prevent="handleOpenInformationSources"',
  '@select="handleOpenInformationSources"',
  '我的信息源 关闭',
);
ensureReplace('@select.prevent="openSkillsManager"', '@select="openSkillsManager"', '添加skill 关闭');
ensureReplace(
  '@select.prevent="handleOpenPersonalization"',
  '@select="handleOpenPersonalization"',
  '个性化 关闭',
);

writeFileSync(FILE, s, 'utf8');
console.log('✅ 完成:开关 30×18 / 滑块 14·位移12 / 修复切换闪烁 / 三个导航项点击后关闭');