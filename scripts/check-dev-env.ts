#!/usr/bin/env node
/**
 * 开发环境自检脚本
 * 在 pnpm tauri:dev 启动前执行，快速发现常见环境问题：
 *   1. pnpm 是否可用
 *   2. .cargo/config.toml 是否配置了镜像源
 *   3. cargo 是否可用
 */

import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

let hasError = false

function ok(msg: string): void {
  console.log(`  \u2713 ${msg}`)
}

function warn(msg: string): void {
  console.warn(`  \u26a0 ${msg}`)
}

function fail(msg: string): void {
  console.error(`  \u2717 ${msg}`)
  hasError = true
}

function run(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()
  } catch {
    return null
  }
}

// 在 PATH 中查找 cargo；找不到再回退到 rustup 默认安装位置 ~/.cargo/bin。
// 这与 scripts/run-tauri.ts 解析 cargo 的方式保持一致：rustup 安装的 cargo
// 位于 %USERPROFILE%\.cargo\bin，但该目录未必出现在当前进程的 PATH 中，
// 仅靠 `cargo --version`（依赖 PATH）会误报“找不到 cargo”。
function resolveCargoExecutable(): string | null {
  const isWindows = process.platform === 'win32'
  const exeName = isWindows ? 'cargo.exe' : 'cargo'

  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    const candidate = join(directory, exeName)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  if (home) {
    const fallback = join(home, '.cargo', 'bin', exeName)
    if (existsSync(fallback)) {
      return fallback
    }
  }

  return null
}

console.log('\n[check-dev-env] \u5f00\u59cb\u73af\u5883\u81ea\u68c0...\n')

// 1. pnpm 可用性
const pnpmVer = run('pnpm --version') ?? run('corepack pnpm --version')
if (pnpmVer) {
  ok(`pnpm ${pnpmVer}`)
} else {
  fail('\u627e\u4e0d\u5230 pnpm\uff0c\u8bf7\u8fd0\u884c: corepack enable && corepack prepare pnpm@latest --activate')
}

// 2. .cargo/config.toml 是否存在且配置了镜像源
const cargoConfig = join(ROOT, '.cargo', 'config.toml')
if (!existsSync(cargoConfig)) {
  fail(`.cargo/config.toml \u4e0d\u5b58\u5728\uff0cRust \u4f9d\u8d56\u5c06\u4f7f\u7528\u5b98\u65b9\u6e90\uff0c\u5728\u56fd\u5185\u7f51\u7edc\u4e0b\u53ef\u80fd\u5931\u8d25\u3002
    \u4fee\u590d\uff1a\u521b\u5efa .cargo/config.toml \u5e76\u914d\u7f6e rsproxy-sparse \u955c\u50cf\u3002`)
} else {
  const content = readFileSync(cargoConfig, 'utf-8')
  if (content.includes('replace-with') && content.includes('rsproxy')) {
    ok('.cargo/config.toml \u5df2\u914d\u7f6e\u955c\u50cf\u6e90\uff08rsproxy\uff09')
  } else {
    warn('.cargo/config.toml \u5b58\u5728\uff0c\u4f46\u672a\u68c0\u6d4b\u5230 rsproxy \u955c\u50cf\u914d\u7f6e\uff0c\u9047\u5230\u4e0b\u8f7d\u95ee\u9898\u65f6\u8bf7\u68c0\u67e5\u8be5\u6587\u4ef6\u3002')
  }
  if (content.includes('git-fetch-with-cli = true')) {
    ok('git-fetch-with-cli = true\uff08\u53ef\u907f\u514d Windows schannel \u63e1\u624b\u95ee\u9898\uff09')
  } else {
    warn('\u672a\u8bbe\u7f6e git-fetch-with-cli = true\uff0c\u5728 Windows \u4e0b\u53ef\u80fd\u9047\u5230 TLS \u63e1\u624b\u9519\u8bef\u3002')
  }
}

// 3. cargo 可用性
// 优先用解析到的绝对路径执行，避免 PATH 不含 ~/.cargo/bin 时误报。
const cargoExecutable = resolveCargoExecutable()
const cargoVer = cargoExecutable
  ? run(`"${cargoExecutable}" --version`)
  : run('cargo --version')
if (cargoVer) {
  ok(cargoVer)
} else {
  fail('\u627e\u4e0d\u5230 cargo\uff0c\u8bf7\u5b89\u88c5 Rust toolchain: https://rustup.rs')
}

console.log()

if (hasError) {
  console.error('[check-dev-env] \u73af\u5883\u68c0\u67e5\u53d1\u73b0\u9519\u8bef\uff0c\u8bf7\u5148\u4fee\u590d\u540e\u518d\u542f\u52a8\u3002\n')
  process.exit(1)
} else {
  console.log('[check-dev-env] \u73af\u5883\u68c0\u67e5\u901a\u8fc7\u3002\n')
}
