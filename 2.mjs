#!/usr/bin/env node
// 2.mjs —— 放仓库根、在仓库根运行：node 2.mjs
// 删除已死的直接 rxjs 依赖及其 workspace 锁定。
// rxjs 仍会经 posthog-node ← @mastra/core 传递安装，这里只删“我们自己”的声明。
import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();

// 防呆：确认是在仓库根跑的
try {
  await access(resolve(root, "pnpm-workspace.yaml"));
} catch {
  console.error(`✗ 当前目录不是仓库根（找不到 pnpm-workspace.yaml）：${root}\n  请 cd 到 my_desktop_app 根目录后再运行 node 2.mjs`);
  process.exit(1);
}

async function edit(rel, transform) {
  const path = resolve(root, rel);
  const original = await readFile(path, "utf8");
  const next = transform(original);
  if (next === null) {
    console.log(`• ${rel}: 已是干净状态，跳过`);
    return;
  }
  await writeFile(path, next, "utf8");
  console.log(`✓ ${rel}: 已更新`);
}

// 1) package.json —— 删掉 dependencies 里的直接依赖行
await edit("package.json", (src) => {
  const re = /\r?\n[ \t]*"rxjs":[ \t]*"catalog:",/;
  if (!re.test(src)) return null;
  const out = src.replace(re, "");
  if (/"rxjs"[ \t]*:[ \t]*"catalog:"/.test(out)) {
    throw new Error("package.json: rxjs 删除后仍存在，已中止");
  }
  return out;
});

// 2) pnpm-workspace.yaml —— 整段删除 overrides 与 catalog（两者各自只有 rxjs 一个键）
await edit("pnpm-workspace.yaml", (src) => {
  const re =
    /\r?\noverrides:\r?\n[ \t]*rxjs:[ \t]*"catalog:"\r?\ncatalog:\r?\n[ \t]*rxjs:[ \t]*\^7\.8\.2/;
  if (!re.test(src)) return null;
  const out = src.replace(re, "");
  if (/\brxjs\b/.test(out)) {
    throw new Error("pnpm-workspace.yaml: rxjs 删除后仍存在，已中止");
  }
  return out;
});

console.log(
  "\n完成。接下来：\n" +
    "  pnpm install      # 重写 pnpm-lock.yaml\n" +
    "  pnpm why rxjs     # 应只剩 posthog-node ← @mastra 这一支\n" +
    "  pnpm typecheck && pnpm test\n",
);