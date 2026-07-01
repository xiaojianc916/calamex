// scripts/03-inject-static-skeleton.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'index.html';
let s = readFileSync(FILE, 'utf8');

if (s.includes('data-skeleton-root')) {
  console.log('ℹ️ 03: 骨架已存在，跳过（幂等）');
} else {
  const anchor = `  <div id="app"></div>`;
  if (!s.includes(anchor)) {
    throw new Error('anchor 未命中：index.html 结构已变动，请人工核对');
  }
  const skeleton = `  <div id="app">\n    <div data-skeleton-root style="position:fixed;inset:0;display:flex;background:#fafafa">\n      <div style="width:260px;height:100%;border-right:1px solid #ececec;background:#f6f6f6"></div>\n      <div style="flex:1;height:100%;background:#fafafa"></div>\n    </div>\n  </div>`;
  s = s.replace(anchor, skeleton);
  writeFileSync(FILE, s);
  console.log('✅ 03: 已注入零依赖静态骨架（Vue 挂载后自动替换）');
}