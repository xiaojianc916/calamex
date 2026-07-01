#!/usr/bin/env node
// scripts/fix-window-drag-region.mjs
//
// 目的：把 AppShellLayout.vue 里手写的 mousedown -> IPC startDragging() 拖拽路径，
// 换成 Tauri 官方声明式 data-tauri-drag-region 属性，消除拖拽发起阶段本可避免的
// JS 事件循环 + IPC 往返延迟（这是"拖拽跟手性/漏底"变差的可复现因素之一）。
//
// 用法：
//   node scripts/fix-window-drag-region.mjs            # 预览 diff，不写文件
//   node scripts/fix-window-drag-region.mjs --write    # 实际写入文件
//
// 安全性：
// - 纯字符串级替换，不做语义改写。
// - 找不到期望的旧写法就直接报错退出，绝不静默跳过或猜测性修改。
// - 幂等：已经是新写法时会提示"无需改动"并正常退出。

import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const TARGET = resolve(process.cwd(), "src/layouts/AppShellLayout.vue")
const WRITE = process.argv.includes("--write")

const source = readFileSync(TARGET, "utf8")

const ALREADY_FIXED_RE =
	/<div\s+class="app-window-drag-region"\s+data-tauri-drag-region\s*\/>/

if (ALREADY_FIXED_RE.test(source)) {
	console.log("[skip] 拖拽区域已经是 data-tauri-drag-region，无需改动。")
	process.exit(0)
}

const DRAG_DIV_RE =
	/<div\s+class="app-window-drag-region"\s+@mousedown\.prevent="startWindowDrag"\s*\/>/

if (!DRAG_DIV_RE.test(source)) {
	console.error(
		"[abort] 没有找到预期的 " +
			'<div class="app-window-drag-region" @mousedown.prevent="startWindowDrag" />。\n' +
			"文件可能已被改动，为避免误改，脚本已停止，请人工确认后再运行。",
	)
	process.exit(1)
}

let next = source.replace(
	DRAG_DIV_RE,
	'<div class="app-window-drag-region" data-tauri-drag-region />',
)

// 删除现在已经死掉的 startWindowDrag 函数定义。
const START_DRAG_FN_RE =
	/\n[ \t]*const startWindowDrag = async \(event: MouseEvent\): Promise<void> => \{[\s\S]*?\n[ \t]*\};\n/

if (!START_DRAG_FN_RE.test(next)) {
	console.error(
		"[abort] 拖拽区域属性已替换，但没找到预期的 startWindowDrag 函数体，\n" +
			"为避免误删其它代码，脚本已停止且未写盘。请人工删除已经死掉的 startWindowDrag 函数后再确认。",
	)
	process.exit(1)
}

next = next.replace(START_DRAG_FN_RE, "\n")

if (WRITE) {
	writeFileSync(TARGET, next, "utf8")
	console.log(`[write] 已更新 ${TARGET}`)
	console.log("请本地跑一遍拖拽窗口，确认标题栏拖动/双击最大化行为正常。")
} else {
	console.log("--- 预览：未写入文件，确认无误后加 --write 重跑 ---")
	const idx = next.indexOf("data-tauri-drag-region")
	console.log(next.slice(Math.max(0, idx - 200), idx + 200))
}