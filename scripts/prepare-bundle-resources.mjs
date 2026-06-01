#!/usr/bin/env node
// scripts/prepare-bundle-resources.mjs
//
// 打包前置脚本：把「生产环境运行时」所需的资源 staged 到
// src-tauri/resources-bundle/，再由 tauri.conf.json 的 bundle.resources
// 一并打进安装包。由 build.beforeBundleCommand 调用（vite build 之后、
// NSIS 打包之前）。
//
// 与 Rust 端 (agent_sidecar/mod.rs、commands/lsp.rs、commands/shell_tools.rs)
// 的解析策略保持一致：随包优先 → 系统兜底。本脚本负责「随包」那一份。
//
// 产物布局（必须与 Rust 的 bundled_resource_roots() 拼接路径对齐）：
//   resources-bundle/node/node.exe
//   resources-bundle/agent-sidecar/{package.json,src,node_modules}
//   resources-bundle/lsp/node_modules/bash-language-server/out/cli.js
//   resources-bundle/shellcheck.exe
//   resources-bundle/shfmt.exe  (可选，失败不阻断打包)

import { execFileSync } from "node:child_process"
import {
	cpSync,
	existsSync,
	mkdirSync,
	rmSync,
	copyFileSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"
import { Buffer } from "node:buffer"

const SHFMT_VERSION = "v3.10.0"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const srcTauri = join(repoRoot, "src-tauri")
const stageRoot = join(srcTauri, "resources-bundle")
const rootNodeModules = join(repoRoot, "node_modules")

const isWindows = process.platform === "win32"
const nodeExeName = isWindows ? "node.exe" : "node"
const shellcheckExeName = isWindows ? "shellcheck.exe" : "shellcheck"
const shfmtExeName = isWindows ? "shfmt.exe" : "shfmt"

function log(message) {
	console.log(`[prepare-bundle-resources] ${message}`)
}

function fail(message) {
	console.error(`[prepare-bundle-resources] FAILED: ${message}`)
	process.exit(1)
}

function run(command, args, options = {}) {
	log(`$ ${command} ${args.join(" ")}`)
	execFileSync(command, args, { stdio: "inherit", ...options })
}

function npmBin() {
	return isWindows ? "npm.cmd" : "npm"
}

function readInstalledVersion(packageName) {
	const pkgJson = join(rootNodeModules, packageName, "package.json")
	if (!existsSync(pkgJson)) {
		return null
	}
	try {
		return JSON.parse(readFileSync(pkgJson, "utf8")).version ?? null
	} catch (error) {
		log(`读取 ${packageName} 版本失败：${error}`)
		return null
	}
}

// 1) 清理并重建 staging 根目录
function resetStage() {
	rmSync(stageRoot, { recursive: true, force: true })
	mkdirSync(stageRoot, { recursive: true })
	// 让 git 忽略该生成目录（保留目录本身）。
	writeFileSync(join(stageRoot, ".gitignore"), "*\n!.gitignore\n")
}

// 2) 内置 Node 运行时（pin 到执行本脚本的 node，即 engines.node>=26）
function stageNode() {
	const dest = join(stageRoot, "node", nodeExeName)
	mkdirSync(dirname(dest), { recursive: true })
	copyFileSync(process.execPath, dest)
	log(`已内置 Node 运行时：${process.execPath} -> ${dest}`)
}

// 3) sidecar：复制 package.json + src，然后在 staging 目录内做一份自包含安装。
//    tsx 在 agent-sidecar 中是 devDependency，但运行时需要它
//    (node node_modules/tsx/dist/cli.mjs)，因此安装时不能 --omit=dev。
function stageSidecar() {
	const srcDir = join(repoRoot, "agent-sidecar")
	const destDir = join(stageRoot, "agent-sidecar")
	if (!existsSync(srcDir)) {
		fail(`未找到 agent-sidecar 源目录：${srcDir}`)
	}
	mkdirSync(destDir, { recursive: true })
	copyFileSync(join(srcDir, "package.json"), join(destDir, "package.json"))
	const srcSrc = join(srcDir, "src")
	if (!existsSync(srcSrc)) {
		fail(`未找到 agent-sidecar/src：${srcSrc}`)
	}
	cpSync(srcSrc, join(destDir, "src"), { recursive: true })
	// 用 npm 在 staging 目录做自包含安装（含原生模块的正确平台版本）。
	run(npmBin(), ["install", "--no-audit", "--no-fund", "--prefix", destDir], {
		cwd: destDir,
	})
	const tsxCli = join(destDir, "node_modules", "tsx", "dist", "cli.mjs")
	if (!existsSync(tsxCli)) {
		fail(`sidecar 安装后未找到 tsx 启动器：${tsxCli}`)
	}
	const serverEntry = join(destDir, "src", "server.ts")
	if (!existsSync(serverEntry)) {
		fail(`sidecar 入口缺失：${serverEntry}`)
	}
	log("已内置 agent-sidecar（含生产依赖与 tsx）")
}

// 4) bash-language-server：用 npm 在 lsp/ 下做自包含安装（解决 pnpm 提升导致的
//    传递依赖缺失问题）。版本优先沿用根 node_modules 已安装的版本。
function stageBashLanguageServer() {
	const lspPrefix = join(stageRoot, "lsp")
	mkdirSync(lspPrefix, { recursive: true })
	const installed = readInstalledVersion("bash-language-server")
	const spec = installed
		? `bash-language-server@${installed}`
		: "bash-language-server"
	run(npmBin(), [
		"install",
		"--no-save",
		"--no-audit",
		"--no-fund",
		"--prefix",
		lspPrefix,
		spec,
	])
	const cliJs = join(
		lspPrefix,
		"node_modules",
		"bash-language-server",
		"out",
		"cli.js",
	)
	if (!existsSync(cliJs)) {
		fail(`bash-language-server 安装后未找到 CLI：${cliJs}`)
	}
	log(`已内置 bash-language-server（${spec}）`)
}

// 5) shellcheck：优先从根 node_modules 复制已下载的二进制，缺失时退回 npm 安装。
function stageShellcheck() {
	const dest = join(stageRoot, shellcheckExeName)
	const fromRoot = join(rootNodeModules, "shellcheck", "bin", shellcheckExeName)
	if (existsSync(fromRoot)) {
		copyFileSync(fromRoot, dest)
		log(`已内置 shellcheck：${fromRoot} -> ${dest}`)
		return
	}
	const scPrefix = join(stageRoot, "_shellcheck-install")
	mkdirSync(scPrefix, { recursive: true })
	const installed = readInstalledVersion("shellcheck")
	const spec = installed ? `shellcheck@${installed}` : "shellcheck"
	run(npmBin(), [
		"install",
		"--no-save",
		"--no-audit",
		"--no-fund",
		"--prefix",
		scPrefix,
		spec,
	])
	const fromInstall = join(
		scPrefix,
		"node_modules",
		"shellcheck",
		"bin",
		shellcheckExeName,
	)
	if (!existsSync(fromInstall)) {
		fail(`shellcheck 安装后未找到二进制：${fromInstall}`)
	}
	copyFileSync(fromInstall, dest)
	rmSync(scPrefix, { recursive: true, force: true })
	log(`已内置 shellcheck（${spec}）`)
}

// 6) shfmt：从 mvdan/sh 官方 release 下载独立二进制。失败不阻断打包
//    （Rust 端仍可退回系统 / WSL 的 shfmt）。
async function stageShfmt() {
	if (!isWindows) {
		log("非 Windows 平台，跳过 shfmt 内置")
		return
	}
	const dest = join(stageRoot, shfmtExeName)
	const base = "https://github.com/mvdan/sh/releases/download"
	const url = `${base}/${SHFMT_VERSION}/shfmt_${SHFMT_VERSION}_windows_amd64.exe`
	try {
		const response = await fetch(url)
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`)
		}
		const buffer = Buffer.from(await response.arrayBuffer())
		writeFileSync(dest, buffer)
		log(`已内置 shfmt（${SHFMT_VERSION}）`)
	} catch (error) {
		log(`WARN 下载 shfmt 失败（非致命，运行时将退回系统/WSL）：${error}`)
	}
}

async function main() {
	if (!isWindows) {
		log(
			"WARN 当前非 Windows 平台；本项目打包目标为 Windows/NSIS，继续但仅做兼容处理。",
		)
	}
	log(`staging 根目录：${stageRoot}`)
	resetStage()
	stageNode()
	stageSidecar()
	stageBashLanguageServer()
	stageShellcheck()
	await stageShfmt()
	log("OK 资源 staging 完成")
}

main().catch((error) => {
	fail(`未捕获异常：${error?.stack ?? error}`)
})
