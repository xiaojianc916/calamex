// 1.mjs —— 删除已被架空的 host.prompt_text，统一到 prompt_with_attachments（单一入口）
// 纯 Rust 内部方法删除，不动契约/绑定；CRLF 安全，单文件原子（锚点须唯一命中，否则整体不写并非零退出）
import { readFileSync, writeFileSync } from 'node:fs';

/** @type {{file:string, edits:{name:string, oldStr:string, newStr:string}[]}[]} */
const PLAN = [
  {
    file: 'src-tauri/src/acp/host.rs',
    edits: [
      {
        name: 'delete-prompt_text-method',
        oldStr:
`    /// 用纯文本驱动一轮**标准 ACP 回合**（\`session/prompt\`）：把单段文本包成一个 \`text\`
    /// \`ContentBlock\` 后委托 \`prompt_with_stream_key\`，返回回合终止原因 \`StopReason\`。这是
    /// **外部 ACP 编码 agent**（Kimi Code / Codex 等，见 ADR-0015）主聊天回合的唯一入口——
    /// 它们只实现标准 \`session/prompt\`，不认识 \`calamex.dev/*\` 扩展方法；过程增量经
    /// \`session/update\` 帧由 \`EventSink\` 转发（投影见 \`ui_event\`），本方法仅返回终态原因。
    ///
    /// \`stream_key\` 为前端预生成的流式关联键（形如 sidecar:assistantMessageId）：外部 agent
    /// 发出的 session/update 帧以 ACP 会话 UUID 标记，透传给 \`prompt_with_stream_key\` 在回合
    /// 期间登记重写，使前端按预生成键即可实时收帧（详见 \`prompt_with_stream_key\`）；\`None\`/
    /// 空白时 sink 原样透传。
    ///
    /// \`ContentBlock\` 经其线上 wire 形态（\`{ "type": "text", "text": ... }\`，与
    /// \`session/update\` 下发的 content 同形，见 \`ui_event::text_from_content_block\`）反序列化
    /// 构造，避免在宿主侧硬编码 SDK 具体构造路径；序列化我们自己的文本几乎不会失败，失败时
    /// 归为 \`Protocol\` 错误上抛。
    pub async fn prompt_text(
        &self,
        thread_id: &str,
        workspace_root_path: Option<&str>,
        text: &str,
        stream_key: Option<&str>,
    ) -> Result<StopReason, AcpClientError> {
        self.prompt_with_stream_key(
            thread_id,
            workspace_root_path,
            vec![text_content_block(text)?],
            stream_key,
        )
        .await
    }

`,
        newStr: '',
      },
      {
        name: 'fix-dangling-doc-ref',
        oldStr: '其线上 wire 形态 JSON 反序列化构造（与 `prompt_text` 同源），不在宿主侧硬编码 SDK 构造路径。',
        newStr: '其线上 wire 形态 JSON 反序列化构造（见 `text_content_block` / `resource_content_block`），不在宿主侧硬编码 SDK 构造路径。',
      },
    ],
  },
];

let failed = false;
for (const { file, edits } of PLAN) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`✗ 读不到文件：${file} —— ${e.message}`);
    failed = true;
    continue;
  }
  const hadCRLF = raw.includes('\r\n');
  let text = hadCRLF ? raw.replace(/\r\n/g, '\n') : raw;

  let next = text;
  let ok = true;
  for (const { name, oldStr, newStr } of edits) {
    const first = next.indexOf(oldStr);
    const last = next.lastIndexOf(oldStr);
    if (first === -1) {
      console.error(`✗ [${file}] 锚点未命中：${name}`);
      ok = false;
      break;
    }
    if (first !== last) {
      console.error(`✗ [${file}] 锚点命中多次（须唯一）：${name}`);
      ok = false;
      break;
    }
    next = next.slice(0, first) + newStr + next.slice(first + oldStr.length);
  }

  if (!ok) {
    failed = true;
    continue;
  }
  const out = hadCRLF ? next.replace(/\n/g, '\r\n') : next;
  writeFileSync(file, out);
  console.log(`✓ ${file} 已更新（${edits.length} 处）`);
}

if (failed) {
  console.error('\n有文件因锚点失配未写入。请把上面的失配项贴给我，我按当前 main 重取锚点。');
  process.exit(1);
}
console.log('\n完成。接着跑：cd src-tauri && cargo build && cargo test（本次不动契约，无需 specta 重生成）。');