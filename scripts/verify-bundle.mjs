#!/usr/bin/env node
// 校验 tauri build 的安装包产物是否生成，并打印绝对路径，便于直接分发。
// Cargo workspace 的 target 在仓库根目录（见根 Cargo.toml 的 [workspace]）。
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

// tauri build 的产物可能在默认 target/release，也可能因 .cargo/config.toml 的
// build.target 落到 target/<triple>/release。两种布局都探测，保证校验可复现。
const targetRoot = resolve(process.cwd(), "target");
const candidateNsisDirs = [join(targetRoot, "release", "bundle", "nsis")];
if (existsSync(targetRoot)) {
  for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== "release") {
      candidateNsisDirs.push(join(targetRoot, entry.name, "release", "bundle", "nsis"));
    }
  }
}
const nsisDir = candidateNsisDirs.find((dir) => existsSync(dir));

const fail = (m) => {
  console.error("[verify-bundle] x " + m);
  process.exit(1);
};

if (!nsisDir)
  fail("未找到 NSIS 产物目录（tauri build 可能未进入打包阶段）。已探测：\n  " + candidateNsisDirs.join("\n  "));
const setups = readdirSync(nsisDir).filter((f) => f.toLowerCase().endsWith("-setup.exe"));
if (setups.length === 0) fail("NSIS 目录下没有 -setup.exe：" + nsisDir);

for (const f of setups) {
  const p = join(nsisDir, f);
  const sizeMB = (statSync(p).size / 1048576).toFixed(1);
  console.log("[verify-bundle] ok 安装包已生成：" + p + " (" + sizeMB + " MB)");
}
console.log("[verify-bundle] 提示：安装该 -setup.exe 后再运行；切勿直接双击 target/debug 下的调试 exe。");
