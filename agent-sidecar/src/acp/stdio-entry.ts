#!/usr/bin/env node
/**
 * ACP stdio 入口 —— sidecar 作为原生 ACP Agent 的可执行启动点。
 *
 * 代替旧的 HTTP/NDJSON server.ts:不再监听端口,而是按 ACP 约定用 stdio 与 client
 * (calamex Rust 宿主)双向通信——Agent 从 stdin 读 client 消息、向 stdout 写回。
 *
 * 关键约束:stdout 是协议线路,**一切日志必须写 stderr**,否则会污染 JSON-RPC 帧。
 */
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk"
import { Readable, Writable } from "node:stream"

import { createConfiguredRuntime } from "../engines/runtime.js"
import { CalamexAcpAgent } from "./agent.js"

/** 结构化错误日志 → stderr(绝不往 stdout 写,那是协议线路)。 */
const logError = (event: string, error: unknown): void => {
	process.stderr.write(
		`${JSON.stringify({
			level: "error",
			scope: "agent-sidecar-acp",
			event,
			message: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})}\n`,
	)
}

const runtime = createConfiguredRuntime()

// ACP stdio:input(我们写出去的可写端)=stdout;output(我们读进来的可读端)=stdin。
const input = Writable.toWeb(process.stdout)
const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
const stream = ndJsonStream(input, output)

const connection = new AgentSideConnection(
	(conn) => new CalamexAcpAgent(conn, runtime),
	stream,
)

// 进程生命周期:连接关闭(stdin EOF / 传输错误)或收到终止信号时,优雅释放 runtime 资源。
let shuttingDown = false
const shutdown = async (code: number): Promise<void> => {
	if (shuttingDown) {
		return
	}
	shuttingDown = true
	try {
		await runtime.dispose?.()
	} catch (error) {
		logError("runtime.dispose.failed", error)
	}
	process.exit(code)
}

void connection.closed
	.then(() => shutdown(0))
	.catch((error) => {
		logError("connection.closed.rejected", error)
		return shutdown(1)
	})

process.on("unhandledRejection", (reason) => {
	logError("process.unhandledRejection", reason)
})
process.on("uncaughtException", (error) => {
	logError("process.uncaughtException", error)
	void shutdown(1)
})
for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.once(signal, () => {
		void shutdown(0)
	})
}
