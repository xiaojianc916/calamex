#!/usr/bin/env node
// 校验 tauri build 的安装包产物是否生成，并打印绝对路径，便于直接分发。
// Cargo workspace 的 target 在仓库根目录（见根 Cargo.toml 的 [workspace]）。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const nsisDir = resolve(process.cwd(), "target", "release", "bundle", "nsis");
const fail = (m) => {
  console.error("[verify-bundle] x " + m);
  process.exit(1);
};

if (!existsSync(nsisDir))
  fail("未找到 NSIS 产物目录（tauri build 可能未进入打包阶段）：" + nsisDir);

const setups = readdirSync(nsisDir).filter((f) => f.toLowerCase().endsWith("-setup.exe"));
if (setups.length === 0) fail("NSIS 目录下没有 -setup.exe：" + nsisDir);

for (const f of setups) {
  const p = join(nsisDir, f);
  const sizeMB = (statSync(p).size / 1048576).toFixed(1);
  console.log("[verify-bundle] ok 安装包已生成：" + p + " (" + sizeMB + " MB)");
}
console.log("[verify-bundle] 提示：安装该 -setup.exe 后再运行；切勿直接双击 target/debug 下的调试 exe。");
