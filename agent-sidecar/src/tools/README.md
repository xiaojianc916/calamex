# tools —— Agent 工具中心（按域）

按「域」组织，目标：一个 AI 工具一个文件、可独立扩展、后续重构不外溢。

## 目录
- \`index.ts\` —— 总装配器 \`loadMastraMcpTools\`，组装 A/B/C 三类工具。
- \`circuit-breaker.ts\` —— 工具错误熔断（跨域）。
- \`time/\` —— get_current_time, convert_time（+ shared）。
- \`log/\` —— mastra_list_logs（+ file-logger）。
- \`editor/\` —— read_current_file。
- \`interaction/\` —— ask_user。
- \`plan/\` —— update_plan, exit_plan。
- \`mcp/\` —— MCP 网关：\`client.ts\`（连接基建）、\`index.ts\`（barrel）、
  \`gateway/\`（warm-pool / helpers / capability / metrics / types）、
  \`gateway/tools/\`（mcp_list_tools, mcp_call_tool）。
- \`generated.ts\` —— 脚本生成的工具清单（勿手改）。

## 三类工具来源
- **A 自研**：本目录，可拆、可一工具一文件。
- **B 官方/SDK**：workspace、browser，定义在 \`@mastra/*\` 包内，无源文件可拆；
  装配点在 \`engines/workspace.ts\`，本次不搬，仅在此登记。
- **C 外部 MCP**：9 个 server 运行时拉取，经 \`mcp/\` 网关聚合，不落地为单文件。
