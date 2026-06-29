// scripts/refactor/b4-s1-builtin-model-config-option.mjs
// S1：builtin agent 侧官方模型选择器（session config option）。仅 TS 侧、自洽可测。
import fs from "node:fs"
import path from "node:path"

const ROOT = process.cwd()

const spacesToTabs = (text) =>
  text
    .split("\n")
    .map((line) => {
      const m = line.match(/^( +)/)
      if (!m) return line
      const n = m[1].length
      return "\t".repeat(Math.floor(n / 2)) + (n % 2 ? " " : "") + line.slice(n)
    })
    .join("\n")

const replaceOnce = (content, oldStr, newStr) => {
  const i = content.indexOf(oldStr)
  if (i === -1) throw new Error("锚点未找到:\n" + oldStr)
  if (content.indexOf(oldStr, i + oldStr.length) !== -1)
    throw new Error("锚点不唯一:\n" + oldStr)
  return content.slice(0, i) + newStr + content.slice(i + oldStr.length)
}

const writeNew = (rel, body) => {
  const abs = path.join(ROOT, rel)
  if (fs.existsSync(abs)) throw new Error("拒绝覆盖已存在文件: " + rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, spacesToTabs(body.replace(/^\n/, "")), "utf8")
  console.log("＋ 新增 " + rel)
}

const applyEdits = (rel, edits) => {
  const abs = path.join(ROOT, rel)
  const raw = fs.readFileSync(abs, "utf8")
  const eol = raw.includes("\r\n") ? "\r\n" : "\n"
  let c = raw.split(/\r?\n/).join("\n")
  for (const [oldA, newA] of edits)
    c = replaceOnce(c, spacesToTabs(oldA), spacesToTabs(newA))
  fs.writeFileSync(abs, c.split("\n").join(eol), "utf8")
  console.log("✎ 编辑 " + rel + "（" + edits.length + " 处）")
}

// ─────────────────────────────────────────────────────────────
// 1) 新增纯模块
// ─────────────────────────────────────────────────────────────
const MODULE = `
/**
 * builtin agent 会话级「模型选择器」——官方 session config option（ADR-20260617，唯一标准管线）。
 *
 * 背景：builtin 走标准 session/prompt 时，模型配置取自会话状态 state.modelConfig；而其凭据在
 * 宿主侧、launch 有意不向子进程注入模型 env。故宿主在 session/new 经 NewSessionRequest._meta
 * （命名空间键 calamex.dev/modelCatalog）一次性注入「可选模型 + 凭据」目录，本模块据此：
 *   1) newSession 时构造官方模型选择器（SessionConfigOption，category=model）公示给前端；
 *   2) setSessionConfigOption 时把所选 modelId 解析回完整模型配置（含凭据）回写会话。
 * Kimi 等外部 agent 自管凭据、不经此通道（其 config_options 由其自身公示），互不耦合。
 *
 * 纯函数、无状态、无 IO；类型对齐 SDK SessionConfigOption（select 变体）与运行时模型配置输入。
 */
import type { SessionConfigOption } from "@agentclientprotocol/sdk"

import type { IAgentRuntimeModelConfigInput } from "../engines/contracts/runtime-input.js"

/** 模型选择器的 config option id（前端按 id 路由 set_config_option）。 */
export const MODEL_CONFIG_OPTION_ID = "model"

/** 宿主经 NewSessionRequest._meta 注入模型目录所用的命名空间键。 */
export const MODEL_CATALOG_META_KEY = "calamex.dev/modelCatalog"

/** 单个可选模型及其凭据（宿主从已保存 AI 配置组装，best-effort 仅含有 Key 者）。 */
export interface IAcpModelCatalogEntry {
  modelId: string
  apiKey: string
  baseUrl?: string
}

/** 模型目录：可选模型清单 + 当前选中项（缺省回退首项）。 */
export interface IAcpModelCatalog {
  models: IAcpModelCatalogEntry[]
  currentModelId?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

/** 解析单个目录项；modelId / apiKey 任一缺失即无效（返回 null）。 */
const parseEntry = (raw: unknown): IAcpModelCatalogEntry | null => {
  if (!isRecord(raw)) return null
  const modelId = readString(raw.modelId)
  const apiKey = readString(raw.apiKey)
  if (modelId === undefined || apiKey === undefined) return null
  const entry: IAcpModelCatalogEntry = { modelId, apiKey }
  const baseUrl = readString(raw.baseUrl)
  if (baseUrl !== undefined) entry.baseUrl = baseUrl
  return entry
}

/**
 * 从 NewSessionRequest._meta 解析模型目录（calamex.dev/modelCatalog）。
 * 缺失 / 非法 / 无有效条目 => null（dispatcher 据此不公示选择器、回退环境兜底）。
 * 保序去重（按 modelId）；currentModelId 仅在命中清单时保留。
 */
export const parseModelCatalogFromMeta = (
  meta: unknown,
): IAcpModelCatalog | null => {
  if (!isRecord(meta)) return null
  const raw = meta[MODEL_CATALOG_META_KEY]
  if (!isRecord(raw) || !Array.isArray(raw.models)) return null
  const models: IAcpModelCatalogEntry[] = []
  const seen = new Set<string>()
  for (const candidate of raw.models) {
    const entry = parseEntry(candidate)
    if (entry === null || seen.has(entry.modelId)) continue
    seen.add(entry.modelId)
    models.push(entry)
  }
  if (models.length === 0) return null
  const requested = readString(raw.currentModelId)
  const catalog: IAcpModelCatalog = { models }
  if (requested !== undefined && seen.has(requested))
    catalog.currentModelId = requested
  return catalog
}

/** 当前应选中的 modelId：currentModelId 命中则用之，否则回退首项。 */
export const resolveCurrentModelId = (catalog: IAcpModelCatalog): string =>
  catalog.currentModelId ?? catalog.models[0].modelId

/** 把某 modelId 解析为运行时模型配置输入；未命中清单返回 undefined。 */
export const resolveModelConfigInput = (
  catalog: IAcpModelCatalog,
  modelId: string,
): IAgentRuntimeModelConfigInput | undefined => {
  const entry = catalog.models.find((item) => item.modelId === modelId)
  if (entry === undefined) return undefined
  const input: IAgentRuntimeModelConfigInput = {
    modelId: entry.modelId,
    apiKey: entry.apiKey,
  }
  if (entry.baseUrl !== undefined) input.baseUrl = entry.baseUrl
  return input
}

/**
 * 构造会话级模型选择器（单选 select，category=model）。
 * 空目录 => []（不公示选择器，前端选择器恒空、回退环境兜底）。
 * value=modelId、name=modelId（β 期可接显示名）；currentValue 取 resolveCurrentModelId。
 */
export const buildModelConfigOptions = (
  catalog: IAcpModelCatalog | null,
): SessionConfigOption[] => {
  if (catalog === null || catalog.models.length === 0) return []
  return [
    {
      type: "select",
      id: MODEL_CONFIG_OPTION_ID,
      name: "模型",
      category: "model",
      currentValue: resolveCurrentModelId(catalog),
      options: catalog.models.map((entry) => ({
        value: entry.modelId,
        name: entry.modelId,
      })),
    },
  ]
}
`

// ─────────────────────────────────────────────────────────────
// 2) 新增单测
// ─────────────────────────────────────────────────────────────
const SPEC = `
import { describe, expect, it } from "vitest"

import {
  buildModelConfigOptions,
  MODEL_CATALOG_META_KEY,
  MODEL_CONFIG_OPTION_ID,
  parseModelCatalogFromMeta,
  resolveCurrentModelId,
  resolveModelConfigInput,
} from "./model-config-options.js"

const meta = (catalog: unknown): Record<string, unknown> => ({
  [MODEL_CATALOG_META_KEY]: catalog,
})

describe("parseModelCatalogFromMeta", () => {
  it("解析有效条目并按 modelId 保序去重", () => {
    const result = parseModelCatalogFromMeta(
      meta({
        models: [
          { modelId: "deepseek/deepseek-v4-pro", apiKey: "k1", baseUrl: "https://x" },
          { modelId: "zhipuai/glm-4.7-flash", apiKey: "k2" },
          { modelId: "deepseek/deepseek-v4-pro", apiKey: "dup" },
        ],
        currentModelId: "zhipuai/glm-4.7-flash",
      }),
    )
    expect(result?.models.map((m) => m.modelId)).toEqual([
      "deepseek/deepseek-v4-pro",
      "zhipuai/glm-4.7-flash",
    ])
    expect(result?.currentModelId).toBe("zhipuai/glm-4.7-flash")
  })

  it("丢弃缺 modelId / apiKey 的条目", () => {
    const result = parseModelCatalogFromMeta(
      meta({ models: [{ modelId: "a/b" }, { apiKey: "k" }, { modelId: "c/d", apiKey: "k" }] }),
    )
    expect(result?.models.map((m) => m.modelId)).toEqual(["c/d"])
  })

  it("缺失 / 非法 / 空清单 => null", () => {
    expect(parseModelCatalogFromMeta(null)).toBeNull()
    expect(parseModelCatalogFromMeta(undefined)).toBeNull()
    expect(parseModelCatalogFromMeta({})).toBeNull()
    expect(parseModelCatalogFromMeta(meta({ models: [] }))).toBeNull()
    expect(parseModelCatalogFromMeta(meta({ models: "nope" }))).toBeNull()
  })

  it("currentModelId 不在清单中则忽略", () => {
    const result = parseModelCatalogFromMeta(
      meta({ models: [{ modelId: "a/b", apiKey: "k" }], currentModelId: "x/y" }),
    )
    expect(result?.currentModelId).toBeUndefined()
  })
})

describe("resolveCurrentModelId", () => {
  it("优先 currentModelId，否则回退首项", () => {
    expect(
      resolveCurrentModelId({ models: [{ modelId: "a/b", apiKey: "k" }], currentModelId: "a/b" }),
    ).toBe("a/b")
    expect(
      resolveCurrentModelId({
        models: [{ modelId: "a/b", apiKey: "k" }, { modelId: "c/d", apiKey: "k" }],
      }),
    ).toBe("a/b")
  })
})

describe("resolveModelConfigInput", () => {
  it("命中返回完整凭据，否则 undefined", () => {
    const catalog = { models: [{ modelId: "a/b", apiKey: "k", baseUrl: "https://x" }] }
    expect(resolveModelConfigInput(catalog, "a/b")).toEqual({
      modelId: "a/b",
      apiKey: "k",
      baseUrl: "https://x",
    })
    expect(resolveModelConfigInput(catalog, "z/z")).toBeUndefined()
  })
})

describe("buildModelConfigOptions", () => {
  it("空目录 => []", () => {
    expect(buildModelConfigOptions(null)).toEqual([])
    expect(buildModelConfigOptions({ models: [] })).toEqual([])
  })

  it("构造单个模型选择器并带当前值", () => {
    const options = buildModelConfigOptions({
      models: [{ modelId: "a/b", apiKey: "k" }, { modelId: "c/d", apiKey: "k" }],
      currentModelId: "c/d",
    })
    expect(options).toHaveLength(1)
    expect(options[0]).toMatchObject({
      type: "select",
      id: MODEL_CONFIG_OPTION_ID,
      category: "model",
      currentValue: "c/d",
      options: [{ value: "a/b" }, { value: "c/d" }],
    })
  })
})
`

writeNew("builtin-agent/src/acp/model-config-options.ts", MODULE)
writeNew("builtin-agent/src/acp/model-config-options.spec.ts", SPEC)

// ─────────────────────────────────────────────────────────────
// 3) session-registry.ts
// ─────────────────────────────────────────────────────────────
applyEdits("builtin-agent/src/acp/session-registry.ts", [
  [
    `import type { McpServer } from "@agentclientprotocol/sdk"\n`,
    `import type { McpServer } from "@agentclientprotocol/sdk"\n\nimport type { IAcpModelCatalog } from "./model-config-options.js"\n`,
  ],
  [
    `  mode: TAgentMode\n  modelConfig?: IAgentRuntimeModelConfigInput\n  abortController: AbortController | null\n}`,
    `  mode: TAgentMode\n  modelConfig?: IAgentRuntimeModelConfigInput\n  /** 宿主经 newSession._meta 注入的模型目录；驱动模型选择器与 set 时的凭据解析。 */\n  modelCatalog?: IAcpModelCatalog\n  abortController: AbortController | null\n}`,
  ],
  [
    `  mode: TAgentMode\n  modelConfig?: IAgentRuntimeModelConfigInput\n}`,
    `  mode: TAgentMode\n  modelConfig?: IAgentRuntimeModelConfigInput\n  modelCatalog?: IAcpModelCatalog\n}`,
  ],
  [
    `      ...(params.modelConfig ? { modelConfig: params.modelConfig } : {}),\n    }`,
    `      ...(params.modelConfig ? { modelConfig: params.modelConfig } : {}),\n      ...(params.modelCatalog ? { modelCatalog: params.modelCatalog } : {}),\n    }`,
  ],
  [
    `  setMode(sessionId: string, mode: TAgentMode): IAcpSessionState | undefined {\n    const state = this.sessions.get(sessionId)\n    if (!state) return undefined\n    state.mode = mode\n    return state\n  }`,
    `  setMode(sessionId: string, mode: TAgentMode): IAcpSessionState | undefined {\n    const state = this.sessions.get(sessionId)\n    if (!state) return undefined\n    state.mode = mode\n    return state\n  }\n\n  /**\n   * 切换已登记会话的当前模型配置（来自模型选择器 set_config_option）。\n   * 返回更新后的状态，会话不存在返回 undefined；modelConfig 为 undefined 时清空（回退环境兜底）。\n   */\n  setModelConfig(\n    sessionId: string,\n    modelConfig: IAgentRuntimeModelConfigInput | undefined,\n  ): IAcpSessionState | undefined {\n    const state = this.sessions.get(sessionId)\n    if (!state) return undefined\n    if (modelConfig === undefined) {\n      delete state.modelConfig\n    } else {\n      state.modelConfig = modelConfig\n    }\n    return state\n  }`,
  ],
])

// ─────────────────────────────────────────────────────────────
// 4) agent.ts
// ─────────────────────────────────────────────────────────────
applyEdits("builtin-agent/src/acp/agent.ts", [
  [
    `  type SessionNotification,\n  type SetSessionModeRequest,\n  type SetSessionModeResponse,\n} from "@agentclientprotocol/sdk"`,
    `  type SessionNotification,\n  type SetSessionConfigOptionRequest,\n  type SetSessionConfigOptionResponse,\n  type SetSessionModeRequest,\n  type SetSessionModeResponse,\n} from "@agentclientprotocol/sdk"`,
  ],
  [
    `} from "./ask-user-bridge.js"\n`,
    `} from "./ask-user-bridge.js"\n\nimport {\n  buildModelConfigOptions,\n  type IAcpModelCatalog,\n  MODEL_CONFIG_OPTION_ID,\n  parseModelCatalogFromMeta,\n  resolveCurrentModelId,\n  resolveModelConfigInput,\n} from "./model-config-options.js"\n`,
  ],
  [
    `  async newSession(\n    params: NewSessionRequest,\n  ): Promise<NewSessionResponse> {\n    const state = this.registry.create({\n      workspaceRootPath: params.cwd,\n      mcpServers: params.mcpServers ?? [],\n      mode: this.defaultMode,\n    })\n    return { sessionId: state.sessionId }\n  }`,
    `  async newSession(\n    params: NewSessionRequest,\n  ): Promise<NewSessionResponse> {\n    // 模型目录由宿主经 NewSessionRequest._meta 注入（calamex.dev/modelCatalog，含凭据）：\n    // builtin 凭据在宿主侧、launch 不注入子进程，故经会话级 _meta 一次性下发，据此公示官方\n    // 模型选择器（session config option）并预置当前回合模型配置。缺省时回退环境兜底（行为不变）。\n    const modelCatalog = parseModelCatalogFromMeta(params._meta)\n    const modelConfig = modelCatalog\n      ? resolveModelConfigInput(modelCatalog, resolveCurrentModelId(modelCatalog))\n      : undefined\n    const state = this.registry.create({\n      workspaceRootPath: params.cwd,\n      mcpServers: params.mcpServers ?? [],\n      mode: this.defaultMode,\n      ...(modelCatalog ? { modelCatalog } : {}),\n      ...(modelConfig ? { modelConfig } : {}),\n    })\n    const configOptions = buildModelConfigOptions(modelCatalog)\n    return {\n      sessionId: state.sessionId,\n      ...(configOptions.length > 0 ? { configOptions } : {}),\n    }\n  }`,
  ],
  [
    `    const state = this.registry.setMode(params.sessionId, params.modeId)\n    if (!state) {\n      throw sessionNotFound(params.sessionId)\n    }\n    return {}\n  }`,
    `    const state = this.registry.setMode(params.sessionId, params.modeId)\n    if (!state) {\n      throw sessionNotFound(params.sessionId)\n    }\n    return {}\n  }\n\n  /**\n   * 设置会话级配置项（官方 session/set_config_option）。当前仅公示模型选择器\n   * （configId = "model"）：据所选 value（modelId）从会话登记的模型目录解析完整模型配置\n   * （含凭据）回写会话，下一回合 prompt 即生效。响应回传刷新后的全量 configOptions（含更新后\n   * 的 currentValue），与 ACP 约定一致（前端整体替换选择器状态）。非法 configId / 值映射为\n   * invalidParams（由 SDK 包装为 JSON-RPC error）。\n   */\n  async setSessionConfigOption(\n    params: SetSessionConfigOptionRequest,\n  ): Promise<SetSessionConfigOptionResponse> {\n    const state = this.registry.get(params.sessionId)\n    if (!state) {\n      throw sessionNotFound(params.sessionId)\n    }\n    if (params.configId !== MODEL_CONFIG_OPTION_ID) {\n      throw RequestError.invalidParams(\n        { configId: params.configId, allowed: [MODEL_CONFIG_OPTION_ID] },\n        "未知会话配置项：" + params.configId,\n      )\n    }\n    const catalog = state.modelCatalog\n    if (!catalog) {\n      throw RequestError.invalidParams(\n        { sessionId: params.sessionId },\n        "本会话未公示模型选择器（无模型目录）。",\n      )\n    }\n    // 模型选择器恒为单选 select，value 为 modelId 字符串；boolean 变体在此不适用。\n    const modelId = typeof params.value === "string" ? params.value : undefined\n    const modelConfig =\n      modelId !== undefined ? resolveModelConfigInput(catalog, modelId) : undefined\n    if (modelConfig === undefined) {\n      throw RequestError.invalidParams(\n        { configId: params.configId, value: params.value },\n        "非法的模型选择值（不在模型目录中）。",\n      )\n    }\n    this.registry.setModelConfig(params.sessionId, modelConfig)\n    const nextCatalog: IAcpModelCatalog = {\n      models: catalog.models,\n      currentModelId: modelConfig.modelId,\n    }\n    return { configOptions: buildModelConfigOptions(nextCatalog) }\n  }`,
  ],
])

console.log("\n✅ S1 完成：新增 2 文件 + 编辑 2 文件。")