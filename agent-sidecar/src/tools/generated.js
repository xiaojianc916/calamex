/* eslint-disable */
// 本文件由 scripts/gen-tools.mjs 生成，请勿手改。
export const AI_TOOLS_MANIFEST_SCHEMA_VERSION = 1;
export const AI_RUNTIME_TOOLS_MANIFEST = [
    {
        id: "mcp_list_tools",
        title: "列出 MCP 工具",
        layer: "sidecar",
        capability: "ai-mcp",
        approval: "none",
        argsSchema: {
            "type": "object",
            "additionalProperties": false
        },
        resultSchema: {
            "type": "object"
        }
    },
    {
        id: "mcp_call_tool",
        title: "调用 MCP 工具",
        layer: "sidecar",
        capability: "ai-mcp",
        approval: "required",
        argsSchema: {
            "type": "object",
            "required": [
                "serverName",
                "toolName"
            ],
            "properties": {
                "serverName": {
                    "type": "string"
                },
                "toolName": {
                    "type": "string"
                },
                "arguments": {
                    "type": "object"
                }
            },
            "additionalProperties": false
        },
        resultSchema: {
            "type": "object"
        }
    },
    {
        id: "web_search",
        title: "联网搜索",
        layer: "rust",
        capability: "ai-mcp",
        approval: "required",
        argsSchema: {
            "type": "object"
        },
        resultSchema: {
            "type": "object"
        }
    },
    {
        id: "web_fetch",
        title: "读取网页",
        layer: "rust",
        capability: "ai-mcp",
        approval: "required",
        argsSchema: {
            "type": "object"
        },
        resultSchema: {
            "type": "object"
        }
    }
];
