import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

const targets = [
  {
    file: "src-tauri/src/agent_sidecar/mod.rs",
    fnName: "model_chat_once",
    reason:
      "reserved ACP/model bridge entrypoint; currently unused by the Rust call graph",
  },
  {
    file: "src-tauri/src/commands/search/mod.rs",
    fnName: "prewarm_workspace_search_index",
    reason:
      "reserved workspace search prewarm entrypoint; currently unused by the Rust call graph",
  },
];

function fail(message) {
  console.error(`\n❌ ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  console.log(`\n$ ${command} ${args.join(" ")}`);

  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });

  if (result.status !== 0) {
    fail(`命令执行失败：${command} ${args.join(" ")}`);
  }
}

function readText(relativePath) {
  const absolutePath = path.join(root, relativePath);

  if (!fs.existsSync(absolutePath)) {
    fail(`找不到文件：${relativePath}`);
  }

  return {
    absolutePath,
    text: fs.readFileSync(absolutePath, "utf8"),
  };
}

function writeTextIfChanged(absolutePath, before, after) {
  if (before === after) {
    return false;
  }

  fs.writeFileSync(absolutePath, after, "utf8");
  return true;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addAllowDeadCodeAttribute({ file, fnName, reason }) {
  const { absolutePath, text } = readText(file);

  const fnPattern = new RegExp(
    String.raw`(^[ \t]*)(pub(?:\s+async)?\s+fn\s+${escapeRegExp(fnName)}\s*\()`,
    "m",
  );

  const match = fnPattern.exec(text);

  if (!match || match.index === undefined) {
    fail(`没有找到函数：${file} :: ${fnName}`);
  }

  const functionStart = match.index;
  const nearbyBefore = text.slice(Math.max(0, functionStart - 400), functionStart);

  if (/#\[(?:allow|expect)\(\s*dead_code\b/.test(nearbyBefore)) {
    console.log(`已存在 dead_code 标注，跳过：${file} :: ${fnName}`);
    return false;
  }

  const indent = match[1] ?? "";
  const attribute = `${indent}#[allow(dead_code, reason = "${reason}")]\n`;

  const updated =
    text.slice(0, functionStart) + attribute + text.slice(functionStart);

  const changed = writeTextIfChanged(absolutePath, text, updated);

  if (changed) {
    console.log(`已添加 dead_code 标注：${file} :: ${fnName}`);
  }

  return changed;
}

console.log("==> 1/4 添加当前 clippy 阻塞的 dead_code 标注");

for (const target of targets) {
  addAllowDeadCodeAttribute(target);
}

console.log("\n==> 2/4 使用 cargo clippy --fix 修复 collapsible_if");

run("cargo", [
  "clippy",
  "--fix",
  "--features",
  "acp_client",
  "-p",
  "calamex",
  "--allow-dirty",
  "--allow-staged",
  "--",
  "-W",
  "clippy::collapsible-if",
]);

console.log("\n==> 3/4 cargo fmt");

run("cargo", ["fmt"]);

console.log("\n==> 4/4 重新执行严格验证");

run("cargo", [
  "clippy",
  "--features",
  "acp_client",
  "-p",
  "calamex",
  "--",
  "-D",
  "warnings",
]);

console.log("\n✅ 修复完成，clippy -D warnings 已通过。");