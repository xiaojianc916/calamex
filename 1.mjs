// fix-tauri-layering.mjs
// 目的：把 src/services/ 之外对 '@tauri-apps/*' 的直接 import 收口到 services 层（3 处分层违规）。
//   ① src/terminal/session.ts        listen        → 复用 loadTauriEvent()
//   ② src/utils/platform/browser.ts  openUrl       → src/services/ipc/opener.service.ts
//   ③ ImageAssetPreview.vue          convertFileSrc→ src/services/ipc/asset.service.ts
//
// 用法：
//   node fix-tauri-layering.mjs            # 应用改动
//   node fix-tauri-layering.mjs --check    # 仅检查、不写文件；有未完成项时退出码 1
//   REPO_ROOT=D:\com.xiaojianc\my_desktop_app node fix-tauri-layering.mjs
//
// 安全保证：幂等（重复跑不会重复改）；锚点必须唯一命中，否则中止该文件、绝不部分写入；
//          不创建 .bak 备份；不碰 git。改完用 `git diff` 审、`git checkout` 还原。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const REPO_ROOT = resolve(process.env.REPO_ROOT ?? process.cwd());
const CHECK_ONLY = process.argv.includes('--check');

const abs = (p) => join(REPO_ROOT, p);
const occ = (haystack, needle) => haystack.split(needle).length - 1;

let created = 0;
let edited = 0;
let already = 0;
let pending = 0;
let aborted = 0;

// ─────────────────────────────────────────────────────────────────────────────
// 1) 新增 services 封装文件
// ─────────────────────────────────────────────────────────────────────────────
const NEW_FILES = [
  {
    path: 'src/services/ipc/asset.service.ts',
    content: `import { convertFileSrc } from '@tauri-apps/api/core';

/**
 * 将本地文件系统路径转换为 webview 可直接加载的 asset:// URL。
 *
 * 纯同步 URL 改写（非 IPC），但仍归口 services 层，以统一收敛对
 * '@tauri-apps/*' 的直接依赖，保持“前端 I/O 只走 services”约束零例外。
 */
export const toAssetUrl = (path: string): string => convertFileSrc(path);
`,
  },
  {
    path: 'src/services/ipc/opener.service.ts',
    content: `import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * 通过系统默认应用打开外部 URL（封装 Tauri opener 插件）。
 *
 * 仅做透传，错误向上抛出；由调用方决定降级策略（如回退到 window.open）。
 */
export const openExternalUrlViaSystem = (url: string): Promise<void> => openUrl(url);
`,
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 2) 调用点改写（锚点唯一才动；marker = 已应用后的特征串，用于幂等检测）
// ─────────────────────────────────────────────────────────────────────────────
const EDITS = [
  {
    path: 'src/components/editor/ImageAssetPreview.vue',
    replacements: [
      {
        from: `import { convertFileSrc } from '@tauri-apps/api/core';\nimport { computed, onMounted, ref, watch } from 'vue';\nimport InlineError from '@/components/common/InlineError.vue';\nimport { tauriService } from '@/services/tauri';`,
        to: `import { computed, onMounted, ref, watch } from 'vue';\nimport InlineError from '@/components/common/InlineError.vue';\nimport { toAssetUrl } from '@/services/ipc/asset.service';\nimport { tauriService } from '@/services/tauri';`,
        marker: `import { toAssetUrl } from '@/services/ipc/asset.service';`,
      },
      {
        from: `assetMeta.value ? convertFileSrc(assetMeta.value.path) : ''`,
        to: `assetMeta.value ? toAssetUrl(assetMeta.value.path) : ''`,
        marker: `toAssetUrl(assetMeta.value.path)`,
      },
    ],
  },
  {
    path: 'src/utils/platform/browser.ts',
    replacements: [
      {
        from: `import { openUrl } from '@tauri-apps/plugin-opener';`,
        to: `import { openExternalUrlViaSystem } from '@/services/ipc/opener.service';`,
        marker: `import { openExternalUrlViaSystem } from '@/services/ipc/opener.service';`,
      },
      {
        from: `  void openUrl(url).catch(() => {`,
        to: `  void openExternalUrlViaSystem(url).catch(() => {`,
        marker: `void openExternalUrlViaSystem(url).catch(() => {`,
      },
    ],
  },
  {
    path: 'src/terminal/session.ts',
    replacements: [
      {
        from: `import { listen, type UnlistenFn } from '@tauri-apps/api/event';`,
        to: `import type { UnlistenFn } from '@tauri-apps/api/event';`,
        marker: `import type { UnlistenFn } from '@tauri-apps/api/event';`,
      },
      {
        // services 排在 types 之前，符合 biome 的路径字母序
        from: `import type { TThemeMode } from '@/types/app';`,
        to: `import { loadTauriEvent } from '@/services/tauri.ipc-runtime';\nimport type { TThemeMode } from '@/types/app';`,
        marker: `import { loadTauriEvent } from '@/services/tauri.ipc-runtime';`,
      },
      {
        // 唯一命中 registerEventListeners 内的 IIFE（ensureConnect 处缩进/分支不同）
        from: `      const runtimeReady = await waitForDesktopRuntime();\n      if (!runtimeReady) return;\n      const [dl, cl, el] = await Promise.all([`,
        to: `      const runtimeReady = await waitForDesktopRuntime();\n      if (!runtimeReady) return;\n      const { listen } = await loadTauriEvent();\n      const [dl, cl, el] = await Promise.all([`,
        marker: `const { listen } = await loadTauriEvent();`,
      },
    ],
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────────────────────
console.log(`REPO_ROOT = ${REPO_ROOT}`);
console.log(CHECK_ONLY ? '模式：--check（只读）\n' : '模式：应用改动\n');

// 新文件
for (const f of NEW_FILES) {
  const p = abs(f.path);
  if (existsSync(p)) {
    const cur = readFileSync(p, 'utf8');
    if (cur === f.content) {
      already++;
      console.log(`= 已存在且一致：${f.path}`);
    } else {
      aborted++;
      console.log(`✗ 已存在但内容不同，跳过以免覆盖：${f.path}（请手动核对）`);
    }
    continue;
  }
  if (CHECK_ONLY) {
    pending++;
    console.log(`+ [将创建] ${f.path}`);
    continue;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, f.content, 'utf8');
  created++;
  console.log(`+ 已创建：${f.path}`);
}

// 编辑
for (const file of EDITS) {
  const p = abs(file.path);
  if (!existsSync(p)) {
    aborted++;
    console.log(`✗ 文件不存在：${file.path}`);
    continue;
  }
  let content = readFileSync(p, 'utf8');
  const original = content;
  let fileAbort = false;
  let fileChanged = false;
  let fileAlready = 0;

  for (const r of file.replacements) {
    const n = occ(content, r.from);
    if (n === 1) {
      content = content.replace(r.from, r.to);
      fileChanged = true;
    } else if (n === 0) {
      if (content.includes(r.marker)) {
        fileAlready++;
      } else {
        fileAbort = true;
        console.log(`✗ 锚点未命中：${file.path}\n    缺少：${r.from.split('\n')[0]} …`);
      }
    } else {
      fileAbort = true;
      console.log(`✗ 锚点不唯一（${n} 处）：${file.path}\n    锚点：${r.from.split('\n')[0]} …`);
    }
  }

  if (fileAbort) {
    aborted++;
    console.log(`  → 已跳过 ${file.path}（不做部分写入）`);
    continue;
  }
  if (!fileChanged) {
    already++;
    console.log(`= 已是目标状态：${file.path}（${fileAlready} 处）`);
    continue;
  }
  if (CHECK_ONLY) {
    pending++;
    console.log(`~ [将修改] ${file.path}`);
    continue;
  }
  if (content !== original) {
    writeFileSync(p, content, 'utf8');
    edited++;
    console.log(`~ 已修改：${file.path}`);
  }
}

console.log(
  `\n汇总：新建 ${created}，修改 ${edited}，已是目标 ${already}，待处理 ${pending}，中止 ${aborted}`,
);
if (aborted > 0) {
  console.log('有文件因锚点异常被中止——可能仓库已与预期不一致，请贴出来我再核。');
  process.exit(1);
}
if (CHECK_ONLY && pending > 0) process.exit(1);