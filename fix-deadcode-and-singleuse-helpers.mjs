import fs from 'node:fs';
import path from 'node:path';

// ============================================================================
// 目的：清理经子 agent 全量扫描 + 人工 grep 二次验证确认的「死代码」与
//       「单次使用的薄包装」，降低屎山。每条改动都有「零调用」或「单调用」的
//       grep 证据，不做任何带判断的重构。
//
// 已验证证据（ripgrep 全项目，排除 node_modules）：
//   A. lsp-bridge.ts 的 5 个 @deprecated 导出：定义外 0 引用。
//   B. tauri.ipc-factory.ts 的 defineContractIpc / definePayloadIpc：
//      definePayloadIpc 0 引用；defineContractIpc 仅被 definePayloadIpc 引用
//      → 构成死链。删除后连带清理仅被它们使用的 IIpcContract / TIpcFactoryOptions
//      两个 import（IDefineIpcOptions / IIpcCallOptions 仍被 defineIpc 使用，保留）。
//   C. tauri.ssh.ts 的 measureSshPasswordOutput / measureSshFileReadOutput：
//      各仅被调用 1 次（line 109 / 194），且各自重复了
//      `value && typeof value === 'object' && !Array.isArray(value)` 这段判定。
//      按 AGENTS.md「仅单次使用的代码不做抽象封装」反向原则，内联回调用点。
//      （measureSshSensitiveInput 被 17 处调用，保留。）
//
// 不在本次脚本范围内（需单独决策/重构，避免一次性改面过大）：
//   - useAiAssistant.ts 的 8 个超长函数（上帝文件重构）
//   - tauri.contracts.ts 整文件删除（需同步改 tauri.spec.ts）
//   - local_partial_path/local_backup_path 合并、snapshot.rs 四兄弟合并
//   - row-helpers.ts 与 engines/utils.ts 的 toRecord/toNonEmptyString 重复
// ============================================================================

const root = process.cwd();

const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const writeIfChanged = (rel, before, after) => {
  if (before === after) {
    console.log(`- 无变化 ${rel}`);
    return;
  }
  fs.writeFileSync(path.join(root, rel), after);
  console.log(`✓ 已更新 ${rel}`);
};

// ---------------------------------------------------------------------------
// A. lsp-bridge.ts：删除 5 个零调用的 @deprecated 导出
// ---------------------------------------------------------------------------
{
  const rel = 'src/services/editor/lsp-bridge.ts';
  const before = read(rel);
  const block = `// --- 兼容旧的命名导出 -------------------------------------------------------
/** @deprecated 用 \`lspBridge.start(...)\` */
export const lspStartBridge = (workspaceRoot: string) => lspBridge.start(workspaceRoot);
/** @deprecated 用 \`lspBridge.stop()\` */
export const lspStopBridge = () => lspBridge.stop();
/** @deprecated 用 \`lspBridge.didOpen(...)\` */
export const lspDidOpenBridge = (f: string, c: string, l: string) => lspBridge.didOpen(f, c, l);
/** @deprecated 用 \`lspBridge.didChange(...)\` */
export const lspDidChangeBridge = (f: string, c: string, v: number) =>
  lspBridge.didChange(f, c, v).then(() => undefined);
/** @deprecated 用 \`lspBridge.didClose(...)\` */
export const lspDidCloseBridge = (f: string) => lspBridge.didClose(f);

`;

  if (!before.includes(block)) {
    throw new Error(`${rel}: 未找到 deprecated 导出块，已中止`);
  }
  writeIfChanged(rel, before, before.replace(block, ''));
  console.log('  → 删除 5 个零调用 deprecated 导出 (lspStart/Stop/DidOpen/DidChange/DidClose Bridge)');
}

// ---------------------------------------------------------------------------
// B. tauri.ipc-factory.ts：删除 defineContractIpc / definePayloadIpc 死链
//    + 连带清理仅被它们使用的 IIpcContract / TIpcFactoryOptions import
// ---------------------------------------------------------------------------
{
  const rel = 'src/services/tauri.ipc-factory.ts';
  let before = read(rel);

  // B1. 删除两个死函数（行 127-150 整段）
  const deadFnBlock = `export const defineContractIpc = <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  name: string,
  guardHint: string,
  contract: IIpcContract<TInSchema, TOutSchema>,
  options: TIpcFactoryOptions<TInSchema, TOutSchema> = {},
) =>
  defineIpc({
    name,
    guardHint,
    inSchema: contract.inSchema,
    outSchema: contract.outSchema,
    ...options,
  });

export const definePayloadIpc = <TInSchema extends z.ZodTypeAny, TOutSchema extends z.ZodTypeAny>(
  name: string,
  guardHint: string,
  contract: IIpcContract<TInSchema, TOutSchema>,
  options: TIpcFactoryOptions<TInSchema, TOutSchema> = {},
) =>
  defineContractIpc(name, guardHint, contract, {
    ...options,
    mapArgs: (payload) => ({ payload }),
  });
`;

  if (!before.includes(deadFnBlock)) {
    throw new Error(`${rel}: 未找到 defineContractIpc/definePayloadIpc 死链，已中止`);
  }
  let after = before.replace(deadFnBlock, '');

  // B2. 清理仅被死链使用的两个 import（IIpcContract、TIpcFactoryOptions）。
  //     IDefineIpcOptions / IIpcCallOptions 仍被 defineIpc 使用，保留。
  after = after
    .replace('  IIpcContract,\n', '')
    .replace('  TIpcFactoryOptions,\n', '');

  writeIfChanged(rel, before, after);
  console.log('  → 删除 defineContractIpc / definePayloadIpc 死链');
  console.log('  → 清理连带的 IIpcContract / TIpcFactoryOptions import');
}

// ---------------------------------------------------------------------------
// C. tauri.ssh.ts：内联两个单次使用的 measure helper（含重复的 isRecord 判定）
// ---------------------------------------------------------------------------
{
  const rel = 'src/services/tauri.ssh.ts';
  let before = read(rel);

  // C1. 删除两个单次使用的 helper 定义
  const helperDefs = `const measureSshPasswordOutput = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, ['password'])
    : { bytes: 0 };

const measureSshFileReadOutput = (value: unknown) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, [
        'content',
        'remotePath',
      ])
    : { bytes: 0 };

`;

  if (!before.includes(helperDefs)) {
    throw new Error(`${rel}: 未找到 measureSshPasswordOutput/measureSshFileReadOutput 定义，已中止`);
  }
  let after = before.replace(helperDefs, '');

  // C2. 内联回各自唯一调用点
  if (!after.includes('measureOutput: measureSshPasswordOutput,')) {
    throw new Error(`${rel}: 未找到 measureSshPasswordOutput 调用点，已中止`);
  }
  after = after.replace(
    'measureOutput: measureSshPasswordOutput,',
    [
      "measureOutput: (value) =>",
      "        value && typeof value === 'object' && !Array.isArray(value)",
      "          ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, ['password'])",
      "          : { bytes: 0 },",
    ].join('\n      '),
  );

  if (!after.includes('measureOutput: measureSshFileReadOutput,')) {
    throw new Error(`${rel}: 未找到 measureSshFileReadOutput 调用点，已中止`);
  }
  after = after.replace(
    'measureOutput: measureSshFileReadOutput,',
    [
      "measureOutput: (value) =>",
      "        value && typeof value === 'object' && !Array.isArray(value)",
      "          ? buildPayloadMetricsOmittingTextFields(value as Record<string, unknown>, [",
      "              'content',",
      "              'remotePath',",
      "            ])",
      "          : { bytes: 0 },",
    ].join('\n      '),
  );

  writeIfChanged(rel, before, after);
  console.log('  → 内联 measureSshPasswordOutput / measureSshFileReadOutput（各仅 1 次调用）');
}

console.log('\n完成。建议执行：');
console.log('  pnpm typecheck');
console.log('  pnpm lint');
console.log('  pnpm test');
