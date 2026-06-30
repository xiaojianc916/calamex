#!/usr/bin/env node
// 校验 vite 产物完整性：dist/index.html 与至少一个 JS 资源必须存在。
// 由 package.json 的 build 在 vite build 之后调用，防止空 dist 被打进安装包。
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const distDir = resolve(process.cwd(), "dist");
const fail = (m) => {
  console.error("[verify-dist] x " + m);
  process.exit(1);
};

if (!existsSync(distDir)) fail("dist 目录不存在（vite build 未产出）：" + distDir);
const indexHtml = join(distDir, "index.html");
if (!existsSync(indexHtml)) fail("缺少 dist/index.html（前端入口未生成）");

const hasJs = (dir) =>
  readdirSync(dir, { withFileTypes: true }).some((e) =>
    e.isDirectory() ? hasJs(join(dir, e.name)) : e.name.endsWith(".js"),
  );

if (!hasJs(distDir)) fail("dist 下未找到任何 .js 产物（构建可能中断）");
console.log("[verify-dist] ok 前端产物完整：index.html + JS 资源已生成");
