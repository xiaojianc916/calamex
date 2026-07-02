// fix-p7-protocol-negotiation.mjs
// 用法(仓库根 D:\com.xiaojianc\my_desktop_app)：node 1.mjs
// 作用：agent.ts initialize 改为按 ACP 约定协商协议版本 min(客户端声明, PROTOCOL_VERSION)。
// 幂等、CRLF/Tab 容忍；硬锚点未命中即退出(1)，绝不盲改。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "builtin-agent/src/acp/agent.ts";

// —— 每文件独立探测行尾，保持与源文件一致（Windows 检出为 CRLF）——
const nlOf = (s) => (s.includes("\r\n") ? "\r\n" : "\n");

function patchFile(path, buildEdits) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (e) {
		console.error(`❌ 读不到文件：${path}（在仓库根运行）`, e.message);
		process.exit(1);
	}
	const NL = nlOf(text);
	const T = "\t";
	let changed = 0;
	for (const edit of buildEdits(NL, T)) {
		if (edit.marker && edit.marker.test(text)) {
			console.log(`↷ 已是目标态，跳过：${edit.label}`);
			continue;
		}
		if (!edit.regex.test(text)) {
			if (edit.soft) {
				console.warn(`⚠ 软锚点未命中(可手动核对)：${edit.label}`);
				continue;
			}
			console.error(`❌ 未找到原文（行文/缩进可能已变），请手动核对：${edit.label}\n   文件：${path}`);
			process.exit(1);
		}
		text = text.replace(edit.regex, edit.replace);
		changed++;
		console.log(`✓ ${edit.label}`);
	}
	if (changed > 0) {
		writeFileSync(path, text, "utf8");
		console.log(`\n💾 已写回 ${path}（${changed} 处）`);
	} else {
		console.log(`\n（无改动）${path}`);
	}
}

patchFile(FILE, (NL, T) => {
	// 重建 initialize 头部：从签名到 return 的 protocolVersion 行，一并替换；
	// agentCapabilities 块原样保留（不在匹配区内）。\s* 容忍 Tab/空格/CRLF。
	const head =
		`async initialize(${NL}` +
		`${T}${T}params: InitializeRequest,${NL}` +
		`${T}): Promise<InitializeResponse> {${NL}` +
		`${T}${T}// 协议版本协商(ACP initialize 约定)：客户端声明其支持的最高协议版本，${NL}` +
		`${T}${T}// Agent 必须回其所支持的、不高于客户端声明值的最高版本——即${NL}` +
		`${T}${T}// min(客户端声明值, 本 Agent 最高支持版本 PROTOCOL_VERSION)。恒回 PROTOCOL_VERSION${NL}` +
		`${T}${T}// 会在本 Agent 的 SDK 版本高于客户端时，向只识旧版的客户端谎报新版本(不合规)。${NL}` +
		`${T}${T}const negotiatedProtocolVersion = Math.min(${NL}` +
		`${T}${T}${T}params.protocolVersion,${NL}` +
		`${T}${T}${T}PROTOCOL_VERSION,${NL}` +
		`${T}${T})${NL}` +
		`${T}${T}return {${NL}` +
		`${T}${T}${T}protocolVersion: negotiatedProtocolVersion,`;

	return [
		{
			label: "initialize 协商协议版本(min(客户端, PROTOCOL_VERSION))",
			marker: /const negotiatedProtocolVersion = Math\.min\(/,
			regex:
				/async initialize\(\s*_params: InitializeRequest,\s*\): Promise<InitializeResponse> \{\s*return \{\s*protocolVersion: PROTOCOL_VERSION,/,
			replace: head,
		},
	];
});