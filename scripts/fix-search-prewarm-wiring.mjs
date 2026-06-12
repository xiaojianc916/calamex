import fs from "node:fs";
import path from "node:path";

const packageJsonPath = path.join(process.cwd(), "agent-sidecar/package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));

packageJson.scripts ??= {};
packageJson.scripts.test =
  'pnpm --dir .. exec vitest run --environment node "agent-sidecar/src/**/*.spec.ts"';
packageJson.scripts["test:node"] =
  'node --import tsx --test "src/**/*.spec.ts"';

fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

console.log("✅ 已将 agent-sidecar 的 pnpm test 改为 Vitest");
console.log("保留原 Node test runner 为：pnpm run test:node");