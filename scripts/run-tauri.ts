import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2];
const extraArgs = process.argv.slice(3);
const DEV_SERVER_PORT = 1420;
const WINDOWS_VS_CUSTOM_ROOTS = ['D:\\Apps\\VisualStudio', 'D:\\Dev\\VisualStudio'];
const WINDOWS_VS_STANDARD_LAYOUTS = [
  '',
  'Community',
  '2022\\Community',
  'Microsoft Visual Studio\\2022\\Community',
];
const WINDOWS_VS_FALLBACK_PATHS = [
  ...WINDOWS_VS_CUSTOM_ROOTS.flatMap((rootPath) =>
    WINDOWS_VS_STANDARD_LAYOUTS.map((suffix) =>
      suffix ? path.win32.join(rootPath, suffix) : rootPath,
    ),
  ),
  'D:\\WindowsApp\\Microsoft Visual Studio\\2022\\Community',
  'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community',
];

interface VsInstallation {
  installationPath: string;
  displayName: string;
}

interface VsWhereInstance {
  installationPath?: string;
  displayName?: string;
}

interface MsvcToolset {
  version: string;
  root: string;
  bin: string;
  include: string;
  lib: string;
}

interface WindowsSdk {
  version: string;
  root: string;
  includeUcrt: string;
  includeShared: string;
  includeUm: string;
  includeWinrt: string;
  includeCppWinrt: string;
  libUcrt: string;
  libUm: string;
  binVersioned: string;
  binFallback: string;
}

interface WindowsProcessSummary {
  id: number;
  name: string;
  path: string;
}

type ToolchainResult =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; reason: string; installationPath?: string };

if (!mode) {
  console.error('缺少 tauri 子命令，例如 dev 或 build。');
  process.exit(1);
}

const compareVersion = (left: string, right: string): number => {
  const leftParts = left.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = right.split('.').map((value) => Number.parseInt(value, 10) || 0);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
};

const listDirectories = (targetPath: string): string[] => {
  if (!existsSync(targetPath)) {
    return [];
  }

  return readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
};

const joinEnvValues = (values: Array<string>): string =>
  values.filter(Boolean).join(path.delimiter);

const escapePowerShellString = (value: string): string => value.replace(/'/g, "''");

const runPowerShell = (script: string) =>
  spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });

const parseJsonOutput = (stdout: string | null): unknown[] => {
  if (!stdout) {
    return [];
  }

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }

    return parsed === null || typeof parsed === 'undefined' ? [] : [parsed];
  } catch {
    return [];
  }
};

const parseListeningProcessIdsFromNetstat = (stdout: string, port: number): number[] => {
  const processIds = new Set<number>();
  const pattern = new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, 'i');

  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(pattern);
    if (!match) {
      continue;
    }

    const processId = Number.parseInt(match[1], 10);
    if (Number.isInteger(processId) && processId > 0) {
      processIds.add(processId);
    }
  }

  return [...processIds];
};

const collectWindowsListeningProcessIds = (port: number): number[] => {
  const result = spawnSync('netstat.exe', ['-ano', '-p', 'tcp'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
    timeout: 10_000,
  });

  if (result.status !== 0 || !result.stdout) {
    return [];
  }

  return parseListeningProcessIdsFromNetstat(result.stdout, port);
};

const getWindowsProcessSummary = (processId: number): WindowsProcessSummary | null => {
  const script = `
$process = Get-Process -Id ${processId} -ErrorAction SilentlyContinue
if (-not $process) {
    exit 0
}

[PSCustomObject]@{
    Id = [int]$process.Id
    Name = [string]$process.ProcessName
    Path = [string]$process.Path
} | ConvertTo-Json -Compress
`;

  const result = runPowerShell(script);
  if (result.status !== 0) {
    return null;
  }

  const [summary] = parseJsonOutput(result.stdout) as Array<{
    Id?: unknown;
    Name?: unknown;
    Path?: unknown;
  }>;
  if (!summary) {
    return null;
  }

  return {
    id: Number.parseInt(String(summary.Id ?? processId), 10),
    name: String(summary.Name ?? ''),
    path: String(summary.Path ?? ''),
  };
};

const collectWindowsCalamexProcessIds = (): number[] => {
  const escapedTargetDir = escapePowerShellString(path.join(rootDir, 'target').toLowerCase());
  const script = `
$targetDir = '${escapedTargetDir}'

Get-Process -Name calamex -ErrorAction SilentlyContinue |
    ForEach-Object {
        $processPath = ([string]$_.Path).ToLowerInvariant()
        if ($processPath.StartsWith($targetDir)) {
            [PSCustomObject]@{ Id = [int]$_.Id }
        }
    } | ConvertTo-Json -Compress
`;

  const result = runPowerShell(script);
  if (result.status !== 0) {
    return [];
  }

  return (parseJsonOutput(result.stdout) as Array<{ Id?: unknown }>)
    .map((value) => Number.parseInt(String(value?.Id ?? value), 10))
    .filter((value) => Number.isInteger(value) && value > 0);
};

const collectWindowsStaleDevProcessIds = (): number[] => {
  const processIds = new Set<number>();

  for (const processId of collectWindowsListeningProcessIds(DEV_SERVER_PORT)) {
    const summary = getWindowsProcessSummary(processId);
    if (summary?.name.toLowerCase() === 'node') {
      processIds.add(processId);
    }
  }

  for (const processId of collectWindowsCalamexProcessIds()) {
    processIds.add(processId);
  }

  return [...processIds];
};

const terminateWindowsProcesses = (processIds: number[]): void => {
  if (processIds.length === 0) {
    return;
  }

  const ids = processIds.filter((processId) => Number.isInteger(processId) && processId > 0);
  if (ids.length === 0) {
    return;
  }

  const joinedIds = ids.join(',');
  const script = `
$ids = @(${joinedIds})
foreach ($id in $ids) {
    Stop-Process -Id $id -Force -ErrorAction SilentlyContinue
}
`;

  const result = runPowerShell(script);
  if (result.status === 0) {
    return;
  }

  for (const processId of ids) {
    try {
      process.kill(processId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[run-tauri] 结束残留进程 ${processId} 失败。${message}`);
    }
  }
};

const cleanupWindowsStaleDevProcesses = (): void => {
  if (process.platform !== 'win32' || mode !== 'dev') {
    return;
  }

  const staleProcessIds = collectWindowsStaleDevProcessIds();
  if (staleProcessIds.length === 0) {
    return;
  }

  console.warn(`[run-tauri] 检测到 ${staleProcessIds.length} 个本仓库残留开发进程，正在清理...`);
  terminateWindowsProcesses(staleProcessIds);
};

const findCommandPath = (fileName: string, extraCandidates: string[] = []): string | null => {
  const pathValue = process.env.PATH ?? '';
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const candidate of extraCandidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
};

const hasCommand = (command: string): boolean => {
  if (process.platform !== 'win32') {
    return true;
  }

  const result = spawnSync('where.exe', [command], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
};

const normalizeInstallationPath = (value: string | undefined): string =>
  value ? value.replace(/[\\/]+$/, '') : '';

const isVisualStudioInstallation = (installationPath: string): boolean =>
  existsSync(path.join(installationPath, 'VC', 'Tools', 'MSVC')) &&
  existsSync(path.join(installationPath, 'Common7', 'IDE'));

const collectVisualStudioInstallations = (): VsInstallation[] => {
  const candidates: VsInstallation[] = [];
  const seen = new Set<string>();

  const register = (
    installationPath: string | undefined,
    displayName = 'Visual Studio 2022',
  ): void => {
    const normalizedPath = normalizeInstallationPath(installationPath);
    if (
      !normalizedPath ||
      seen.has(normalizedPath) ||
      !isVisualStudioInstallation(normalizedPath)
    ) {
      return;
    }

    seen.add(normalizedPath);
    candidates.push({
      installationPath: normalizedPath,
      displayName,
    });
  };

  const instance = loadVsInstance();
  if (instance?.installationPath) {
    register(instance.installationPath, instance.displayName ?? 'Visual Studio 2022');
  }

  for (const installationPath of WINDOWS_VS_FALLBACK_PATHS) {
    register(installationPath, 'Visual Studio Community 2022');
  }

  return candidates;
};

const findLatestMsvc = (installationPath: string): MsvcToolset | null => {
  const toolsRoot = path.join(installationPath, 'VC', 'Tools', 'MSVC');
  const versions = listDirectories(toolsRoot).sort(compareVersion).reverse();

  for (const version of versions) {
    const versionRoot = path.join(toolsRoot, version);
    const include = path.join(versionRoot, 'include');
    const lib = path.join(versionRoot, 'lib', 'x64');
    const hostBins = [
      path.join(versionRoot, 'bin', 'Hostx64', 'x64'),
      path.join(versionRoot, 'bin', 'Hostx86', 'x64'),
    ];

    for (const bin of hostBins) {
      if (existsSync(path.join(bin, 'cl.exe')) && existsSync(include) && existsSync(lib)) {
        return {
          version,
          root: versionRoot,
          bin,
          include,
          lib,
        };
      }
    }
  }

  return null;
};

const findLatestWindowsSdk = (): WindowsSdk | null => {
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (!programFilesX86) {
    return null;
  }

  const sdkRoot = path.join(programFilesX86, 'Windows Kits', '10');
  const includeRoot = path.join(sdkRoot, 'Include');
  const versions = listDirectories(includeRoot)
    .filter((value) => /^\d+\.\d+\.\d+\.\d+$/.test(value))
    .sort(compareVersion)
    .reverse();

  for (const version of versions) {
    const candidate: WindowsSdk = {
      version,
      root: sdkRoot,
      includeUcrt: path.join(includeRoot, version, 'ucrt'),
      includeShared: path.join(includeRoot, version, 'shared'),
      includeUm: path.join(includeRoot, version, 'um'),
      includeWinrt: path.join(includeRoot, version, 'winrt'),
      includeCppWinrt: path.join(includeRoot, version, 'cppwinrt'),
      libUcrt: path.join(sdkRoot, 'Lib', version, 'ucrt', 'x64'),
      libUm: path.join(sdkRoot, 'Lib', version, 'um', 'x64'),
      binVersioned: path.join(sdkRoot, 'bin', version, 'x64'),
      binFallback: path.join(sdkRoot, 'bin', 'x64'),
    };

    if (
      existsSync(candidate.includeUcrt) &&
      existsSync(candidate.includeShared) &&
      existsSync(candidate.includeUm) &&
      existsSync(candidate.libUcrt) &&
      existsSync(candidate.libUm)
    ) {
      return candidate;
    }
  }

  return null;
};

const loadVsInstance = (): VsWhereInstance | null => {
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  if (!programFilesX86) {
    return null;
  }

  const vswherePath = path.join(
    programFilesX86,
    'Microsoft Visual Studio',
    'Installer',
    'vswhere.exe',
  );
  if (!existsSync(vswherePath)) {
    return null;
  }

  const result = spawnSync(vswherePath, ['-latest', '-products', '*', '-format', 'json'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: false,
  });

  if (result.status !== 0 || !result.stdout) {
    return null;
  }

  try {
    const instances = JSON.parse(result.stdout) as VsWhereInstance[];
    return Array.isArray(instances) && instances.length > 0 ? instances[0] : null;
  } catch {
    return null;
  }
};

const buildWindowsToolchainEnv = (): ToolchainResult => {
  const installations = collectVisualStudioInstallations();
  if (installations.length === 0) {
    return {
      ok: false,
      reason: '未找到 Visual Studio 2022 实例。',
    };
  }

  for (const instance of installations) {
    const msvc = findLatestMsvc(instance.installationPath);
    if (!msvc) {
      continue;
    }

    const sdk = findLatestWindowsSdk();
    if (!sdk) {
      return {
        ok: false,
        reason: '未检测到可用的 Windows 10/11 SDK。',
        installationPath: instance.installationPath,
      };
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    const cargoExecutable = findCommandPath('cargo.exe', [
      path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'cargo.exe'),
    ]);
    const cargoBinDirectory = cargoExecutable ? path.dirname(cargoExecutable) : '';
    const nodeBinDirectory = path.dirname(process.execPath);

    // 关键修复：先按大小写兼容方式取出原始 PATH，再删除所有大小写的旧键，
    // 最后统一写回单一的 Path 键，避免 Windows 上 Path/PATH 重复键导致子进程丢失 PATH。
    const existingPath = env.PATH ?? env.Path ?? '';
    delete env.Path;
    delete env.PATH;
    env.Path = joinEnvValues([
      msvc.bin,
      existsSync(sdk.binVersioned) ? sdk.binVersioned : sdk.binFallback,
      existsSync(sdk.binFallback) ? sdk.binFallback : '',
      cargoBinDirectory,
      nodeBinDirectory,
      existingPath,
    ]);
    env.INCLUDE = joinEnvValues([
      msvc.include,
      sdk.includeUcrt,
      sdk.includeShared,
      sdk.includeUm,
      sdk.includeWinrt,
      sdk.includeCppWinrt,
      env.INCLUDE ?? '',
    ]);
    env.LIB = joinEnvValues([msvc.lib, sdk.libUcrt, sdk.libUm, env.LIB ?? '']);
    env.LIBPATH = joinEnvValues([msvc.lib, sdk.libUm, env.LIBPATH ?? '']);
    env.VSINSTALLDIR = `${instance.installationPath}${path.sep}`;
    env.VCINSTALLDIR = `${path.join(instance.installationPath, 'VC')}${path.sep}`;
    env.VCToolsInstallDir = `${msvc.root}${path.sep}`;
    env.VCToolsVersion = msvc.version;
    env.WindowsSdkDir = `${sdk.root}${path.sep}`;
    env.WindowsSdkVersion = `${sdk.version}${path.sep}`;
    env.UniversalCRTSdkDir = `${sdk.root}${path.sep}`;
    env.UCRTVersion = sdk.version;
    env.DevEnvDir = `${path.join(instance.installationPath, 'Common7', 'IDE')}${path.sep}`;
    env.Platform = 'x64';
    env.CC = env.CC || 'cl.exe';
    env.CXX = env.CXX || 'cl.exe';
    if (cargoExecutable) {
      env.CARGO = cargoExecutable;
    }

    return {
      ok: true,
      env,
    };
  }

  return {
    ok: false,
    reason: '已检测到 Visual Studio，但未找到可用的 x64 MSVC 编译工具链。',
    installationPath: installations[0]?.installationPath,
  };
};

const sidecarDir = path.join(rootDir, 'builtin-agent');
const bundledNodeExeName = process.platform === 'win32' ? 'node.exe' : 'node';
const bundledNodePath = path.join(
  rootDir,
  'src-tauri',
  'resources-bundle',
  'node',
  bundledNodeExeName,
);

const sidecarBuildScript = path.join(sidecarDir, 'build.mjs');

// dev 下预编译 builtin-agent -> dist/server.js，运行时直接 node dist/server.js，
// 不再依赖 tsx（tsx 在 Node 26 下解析入口会塌成盘符 D: 而崩溃）。
const ensureSidecarBuilt = (): void => {
  if (mode !== 'dev' || !existsSync(sidecarDir)) {
    return;
  }

  if (!existsSync(sidecarBuildScript)) {
    console.warn(
      '[run-tauri] 未找到 builtin-agent/build.mjs，跳过 sidecar 预编译；请先执行 pnpm install。',
    );
    return;
  }

  console.log('[run-tauri] 预编译 builtin-agent -> dist/server.js ...');
  const result = spawnSync(process.execPath, [sidecarBuildScript], {
    cwd: sidecarDir,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.warn(`[run-tauri] sidecar 预编译失败：${result.error.message}`);
  }

  if (!existsSync(path.join(sidecarDir, 'dist', 'server.js'))) {
    console.warn('[run-tauri] 预编译后仍未生成 dist/server.js，sidecar 可能回退到 tsx。');
  }
};

// 把执行本脚本的 Node 复制进 resources-bundle/node 作为开发态“内置 Node”。
const ensureBundledNode = (): string | null => {
  if (existsSync(bundledNodePath)) {
    return bundledNodePath;
  }

  try {
    mkdirSync(path.dirname(bundledNodePath), { recursive: true });
    copyFileSync(process.execPath, bundledNodePath);
    console.log(`[run-tauri] 已暂存内置 Node 运行时 -> ${bundledNodePath}`);
    return bundledNodePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[run-tauri] 暂存内置 Node 失败，sidecar 可能回退到系统 Node：${message}`);
    return null;
  }
};

// 通过环境变量强制 app 用内置 Node + 仓库内 builtin-agent，不覆盖用户已设变量。
const withBundledSidecarRuntime = (baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  if (mode !== 'dev') {
    return baseEnv;
  }

  const env = { ...baseEnv };
  if (!env.XIAOJIANC_BUILTIN_AGENT_ROOT && existsSync(sidecarDir)) {
    env.XIAOJIANC_BUILTIN_AGENT_ROOT = sidecarDir;
  }

  if (!env.XIAOJIANC_NODE_EXE) {
    const bundledNode = ensureBundledNode();
    if (bundledNode) {
      env.XIAOJIANC_NODE_EXE = bundledNode;
    }
  }

  return env;
};

const runTauri = (env: NodeJS.ProcessEnv): void => {
  cleanupWindowsStaleDevProcesses();
  ensureSidecarBuilt();

  const runtimeEnv = withBundledSidecarRuntime(env);

  const cliScriptPath = path.join(rootDir, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');

  if (!existsSync(cliScriptPath)) {
    console.error('未找到本地 Tauri CLI，请先执行 pnpm install。');
    process.exit(1);
  }

  const result = spawnSync(process.execPath, [cliScriptPath, mode, ...extraArgs], {
    cwd: rootDir,
    env: runtimeEnv,
    stdio: 'inherit',
    shell: false,
  });

  if (result.error) {
    console.error(result.error.message);
  }

  process.exit(result.status ?? 1);
};

if (process.platform !== 'win32') {
  runTauri(process.env);
}

if (hasCommand('cl.exe') && process.env.VCINSTALLDIR && process.env.WindowsSdkDir) {
  runTauri(process.env);
}

const toolchain = buildWindowsToolchainEnv();
if (!toolchain.ok) {
  console.error('Tauri 启动前检查失败。');
  console.error(toolchain.reason);
  if (toolchain.installationPath) {
    console.error(`Visual Studio 安装路径: ${toolchain.installationPath}`);
  }
  console.error(
    `请通过仓库根目录的 .vsconfig 或 Visual Studio Installer 补装“使用 C++ 的桌面开发”。`,
  );
  process.exit(1);
}

runTauri(toolchain.env);
