/**
 * check-versions.ts
 * 检查 package.json / src-tauri/tauri.conf.json / Cargo.toml 版本号是否严格一致（R-0.2.7）
 */
import fs from 'node:fs';
import path from 'node:path';
import { CheckResult, printResult, ROOT, summarize } from './guard-utils.js';

const results: CheckResult[] = [];

// 读取 package.json 版本
const pkgJson = path.join(ROOT, 'package.json');
let pkgVersion: string | null = null;
if (fs.existsSync(pkgJson)) {
  const data = JSON.parse(fs.readFileSync(pkgJson, 'utf-8'));
  pkgVersion = data.version ?? null;
}

// 读取 tauri.conf.json 版本
const tauriConf = path.join(ROOT, 'src-tauri/tauri.conf.json');
let tauriVersion: string | null = null;
if (fs.existsSync(tauriConf)) {
  const data = JSON.parse(fs.readFileSync(tauriConf, 'utf-8'));
  tauriVersion = data.version ?? null;
}

// 读取 Cargo.toml 版本（src-tauri）
const cargoToml = path.join(ROOT, 'src-tauri/Cargo.toml');
let cargoVersion: string | null = null;
if (fs.existsSync(cargoToml)) {
  const content = fs.readFileSync(cargoToml, 'utf-8');
  const match = content.match(/^version\s*=\s*"([^"]+)"/m);
  if (match) cargoVersion = match[1];
}

// 对比
if (!pkgVersion) {
  results.push({
    severity: 'ERROR',
    message: 'package.json 中未找到 version 字段',
    file: 'package.json',
  });
} else {
  results.push({
    severity: 'PASS',
    message: `package.json version = ${pkgVersion}`,
    file: 'package.json',
  });
}

if (!tauriVersion) {
  results.push({
    severity: 'WARN',
    message: 'src-tauri/tauri.conf.json 未找到 version 字段（可能正常）',
    file: 'src-tauri/tauri.conf.json',
  });
} else if (tauriVersion !== pkgVersion) {
  results.push({
    severity: 'ERROR',
    message: `版本不一致: package.json=${pkgVersion} vs tauri.conf.json=${tauriVersion}`,
    file: 'src-tauri/tauri.conf.json',
    detail: '请确保所有文件版本号严格一致（R-0.2.7）',
  });
} else {
  results.push({
    severity: 'PASS',
    message: `tauri.conf.json version = ${tauriVersion} ✓`,
    file: 'src-tauri/tauri.conf.json',
  });
}

if (!cargoVersion) {
  results.push({
    severity: 'WARN',
    message: 'src-tauri/Cargo.toml 未找到 version 字段',
    file: 'src-tauri/Cargo.toml',
  });
} else if (cargoVersion !== pkgVersion) {
  results.push({
    severity: 'ERROR',
    message: `版本不一致: package.json=${pkgVersion} vs Cargo.toml=${cargoVersion}`,
    file: 'src-tauri/Cargo.toml',
    detail: '请确保所有文件版本号严格一致（R-0.2.7）',
  });
} else {
  results.push({
    severity: 'PASS',
    message: `Cargo.toml version = ${cargoVersion} ✓`,
    file: 'src-tauri/Cargo.toml',
  });
}

results.forEach(printResult);
const hasError = summarize('check-versions', results);
process.exit(hasError ? 1 : 0);
