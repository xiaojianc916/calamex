// 1.mjs — 附件发送完全重构：raw text + 真实 mimeType，drop name（ACP TextResourceContents 无该槽位）
import { readFileSync, writeFileSync } from 'node:fs';

const patch = (rel, label, find, replace) => {
  const raw = readFileSync(rel, 'utf8');
  const crlf = raw.includes('\r\n');
  const s = crlf ? raw.replaceAll('\r\n', '\n') : raw;
  if (!s.includes(find)) throw new Error('❌ 匹配失败 [' + rel + ']: ' + label);
  const n = s.split(find).length - 1;
  if (n > 1) throw new Error('❌ 锚点不唯一(' + n + ') [' + rel + ']: ' + label);
  const out = s.replace(find, () => replace);
  writeFileSync(rel, crlf ? out.replaceAll('\n', '\r\n') : out, 'utf8');
  console.log('✅ ' + rel + ' :: ' + label);
};

const ATT = 'src/composables/ai/useAiAssistant.attachments.ts';
const USE = 'src/composables/ai/useAiAssistant.ts';
const AIIDX = 'src/types/ai/index.ts';
const SIDE = 'src/types/ai/sidecar.ts';
const RS = 'src-tauri/src/commands/contracts/builtin_agent.rs';
const TRI = 'builtin-agent/src/acp/to-runtime-input.ts';
const TRISPEC = 'builtin-agent/src/acp/to-runtime-input.spec.ts';
const USESPEC = 'src/composables/ai/useAiAssistant.spec.ts';

// ── A. attachments.ts：扩展名→规范 MIME 解析器 ─────────────────────────────
patch(
  ATT,
  'A 新增 resolveTextAttachmentMimeType',
  `export const isImageAttachment = (file: File): boolean =>
  IMAGE_ATTACHMENT_PATTERN.test(file.type) || IMAGE_ATTACHMENT_EXTENSION_PATTERN.test(file.name);`,
  `export const isImageAttachment = (file: File): boolean =>
  IMAGE_ATTACHMENT_PATTERN.test(file.type) || IMAGE_ATTACHMENT_EXTENSION_PATTERN.test(file.name);

// 文本类附件的规范 MIME（扩展名优先）：浏览器 File.type 对 .ts/.vue/.rs 等常给空或错值，故以
// 扩展名为准，未命中再回退到形似文本的 File.type，最后兜底 text/plain。用作 ACP embedded resource
// 的 mimeType 槽位，供 agent 侧识别语言类型（见 acp/to-runtime-input.ts 渲染抬头）。
const TEXT_ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ts: 'text/x-typescript',
  tsx: 'text/x-typescript',
  mts: 'text/x-typescript',
  cts: 'text/x-typescript',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/javascript',
  py: 'text/x-python',
  rs: 'text/x-rust',
  vue: 'text/x-vue',
  json: 'application/json',
  md: 'text/markdown',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  sql: 'application/sql',
  toml: 'application/toml',
  css: 'text/css',
  csv: 'text/csv',
  xml: 'application/xml',
  html: 'text/html',
  sh: 'text/x-sh',
  bash: 'text/x-sh',
  zsh: 'text/x-sh',
  txt: 'text/plain',
  log: 'text/plain',
  env: 'text/plain',
  conf: 'text/plain',
  ps1: 'text/plain',
};

export const resolveTextAttachmentMimeType = (file: File): string => {
  const match = /\\.([^.]+)$/.exec(file.name.trim().toLowerCase());
  const byExtension = match ? TEXT_ATTACHMENT_MIME_BY_EXTENSION[match[1]] : undefined;

  if (byExtension) {
    return byExtension;
  }

  const declared = file.type.trim().toLowerCase();

  if (declared && TEXT_ATTACHMENT_PATTERN.test(declared)) {
    return declared;
  }

  return 'text/plain';
};`,
);

// ── B. useAiAssistant.ts：导入解析器 ───────────────────────────────────────
patch(
  USE,
  'B import resolveTextAttachmentMimeType',
  `  normalizeAttachmentName,
  readImageDimensions,
} from './useAiAssistant.attachments';`,
  `  normalizeAttachmentName,
  readImageDimensions,
  resolveTextAttachmentMimeType,
} from './useAiAssistant.attachments';`,
);

// ── C. attachFile 文本分支：随附件带上 raw textContent + mimeType ───────────
patch(
  USE,
  'C attachFile 文本分支携带 textContent/mimeType',
  `        sizeLabel: formatBytes(file.size),
        kind: 'text',
        reference,
      });`,
  `        sizeLabel: formatBytes(file.size),
        kind: 'text',
        textContent: content,
        mimeType: resolveTextAttachmentMimeType(file),
        reference,
      });`,
);

// ── D. sendMessage：直接从 attachedFiles 构造 resource（raw text + 真实 mime，无 name）─
patch(
  USE,
  'D promptAttachments 完全重构',
  `    // 正规范式（替代旧的 <附件> 字符串折叠）：把文本类附件作为独立的 ACP embedded resource 内容块
    // 随标准 session/prompt 送达（见 Rust host.prompt_with_attachments / agent-client-protocol
    // ContentBlock::Resource——协议首选的上下文注入方式）。这样保留 name/uri/mimeType 语义、避免正文
    // 分隔符冲突与提示注入；图片附件仍只作 UI 预览、不并入（多模态注入待 promptCapabilities 协商）。
    const promptAttachments: IAgentPromptAttachment[] = references
      .filter((reference) => reference.kind !== 'image-attachment')
      .map((reference) => ({
        name: reference.label,
        uri: \`attachment:///\${reference.path ?? reference.id}\`,
        text: reference.contentPreview,
        mimeType: 'text/plain',
      }));`,
  `    // 正规范式：文本类附件作为独立的 ACP embedded resource 内容块随标准 session/prompt 送达
    // （见 Rust host.prompt_with_attachments / agent-client-protocol ContentBlock::Resource——协议
    // 首选的上下文注入方式）。resource 的 uri 即身份、mimeType 标注语言类型、text 直接承载附件原文；
    // 不再把内容折进「文件名/大小/内容」这类人读散文（旧字符串时代残留），也不臆造 ACP
    // TextResourceContents 没有的 name 槽位。图片附件仍只作 UI 预览、不并入（多模态注入待
    // promptCapabilities 协商）。直接读 attachedFiles（在 clearAttachedFiles 之前），不绕经 references。
    const promptAttachments: IAgentPromptAttachment[] = attachedFiles.value.flatMap((file) =>
      file.kind === 'text' && typeof file.textContent === 'string'
        ? [
            {
              uri: \`attachment:///\${file.name}\`,
              text: file.textContent,
              ...(file.mimeType ? { mimeType: file.mimeType } : {}),
            },
          ]
        : [],
    );`,
);

// ── E. IAiAttachedFile：承载 textContent + mimeType ────────────────────────
patch(
  AIIDX,
  'E IAiAttachedFile 增 textContent/mimeType',
  `  preview?: IAiImageAttachmentPreview;
  reference: IAiContextReference;
}`,
  `  preview?: IAiImageAttachmentPreview;
  /** 文本类附件（kind==='text'）的原始文件内容，作为 ACP embedded resource 的 text 槽位原样送达。 */
  textContent?: string;
  /** 文本类附件的规范 MIME（由扩展名解析），作为 ACP embedded resource 的 mimeType 槽位。 */
  mimeType?: string;
  reference: IAiContextReference;
}`,
);

// ── F. IAgentPromptAttachment：drop name ───────────────────────────────────
patch(
  SIDE,
  'F IAgentPromptAttachment 去掉 name',
  `export interface IAgentPromptAttachment {
  name: string;
  uri: string;
  text: string;
  mimeType?: string;
}`,
  `export interface IAgentPromptAttachment {
  uri: string;
  text: string;
  mimeType?: string;
}`,
);

// ── G. builtin_agent.rs：drop name（契约层 + 文档）────────────────────────
patch(
  RS,
  'G1 契约文档更新',
  `/// 而非拼进正文字符串——避免正文分隔符冲突/提示注入，并保留 name/uri/mimeType 语义。`,
  `/// 而非拼进正文字符串——避免正文分隔符冲突/提示注入；uri 即资源身份、mimeType 标注类型、text 承载原文（ACP TextResourceContents 无 name 槽位）。`,
);
patch(
  RS,
  'G2 AgentPromptAttachment 去掉 name',
  `pub struct AgentPromptAttachment {
    pub(crate) name: String,
    pub(crate) uri: String,`,
  `pub struct AgentPromptAttachment {
    pub(crate) uri: String,`,
);

// ── H. builtin_agent.rs 测试：导入 + 两条序列化断言 ────────────────────────
patch(
  RS,
  'H1 测试 use 增 AgentPromptAttachment',
  `    use super::{
        AgentBackendKind, AgentExternalChatRequest, AgentSidecarChatRequest,
        AgentSidecarCheckpointRestoreRequest, AgentSidecarMessagePayload,
        AgentSidecarRollbackStepPath,
    };`,
  `    use super::{
        AgentBackendKind, AgentExternalChatRequest, AgentPromptAttachment,
        AgentSidecarChatRequest, AgentSidecarCheckpointRestoreRequest,
        AgentSidecarMessagePayload, AgentSidecarRollbackStepPath,
    };`,
);
patch(
  RS,
  'H2 新增 AgentPromptAttachment 序列化测试',
  `        assert_eq!(
            present_object.get("threadId"),
            Some(&Value::String("thread-external-1".to_string()))
        );
    }
}`,
  `        assert_eq!(
            present_object.get("threadId"),
            Some(&Value::String("thread-external-1".to_string()))
        );
    }

    #[test]
    fn prompt_attachment_serializes_protocol_slots_without_name() {
        let attachment = AgentPromptAttachment {
            uri: "attachment:///answer.ts".to_string(),
            text: "export const answer = 42;".to_string(),
            mime_type: Some("text/x-typescript".to_string()),
        };

        let object = serialize_object(&attachment);

        assert_eq!(
            object.get("uri"),
            Some(&Value::String("attachment:///answer.ts".to_string()))
        );
        assert_eq!(
            object.get("text"),
            Some(&Value::String("export const answer = 42;".to_string()))
        );
        assert_eq!(
            object.get("mimeType"),
            Some(&Value::String("text/x-typescript".to_string()))
        );
        assert!(!object.contains_key("name"));
    }

    #[test]
    fn prompt_attachment_omits_blank_mime_type() {
        let attachment = AgentPromptAttachment {
            uri: "attachment:///notes.txt".to_string(),
            text: "hello".to_string(),
            mime_type: None,
        };

        let object = serialize_object(&attachment);

        assert!(!object.contains_key("mimeType"));
        assert_eq!(
            object.get("uri"),
            Some(&Value::String("attachment:///notes.txt".to_string()))
        );
    }
}`,
);

// ── I. to-runtime-input.ts（TAB 缩进）：抬头化渲染附件 resource ─────────────
patch(
  TRI,
  'I1 模块文档 resource 行',
  ` * - resource      → passthrough 若携带内联 text 则并入正文，否则按 uri 追加引用行；`,
  ` * - resource      → 携带内联 text 则投影为「附件 <名>（<mime>）：<原文>」并入正文，否则按 uri 追加引用行；`,
);
patch(
  TRI,
  'I2 新增 attachment 渲染辅助',
  `const EMPTY_PROMPT_GOAL = "继续当前任务"

/**
 * 把单个内容块投影为可并入 user 消息的纯文本片段；无文本可投影时返回 null。
 */`,
  `const EMPTY_PROMPT_GOAL = "继续当前任务"

/** 从 attachment:/// 资源 uri 取展示用文件名（末段）；无末段时回退整段 uri。 */
const attachmentDisplayName = (uri: string): string => {
	const withoutScheme = uri.replace(/^attachment:\\/\\/+/, "")
	const lastSegment = withoutScheme.split("/").pop()
	return lastSegment && lastSegment.length > 0 ? lastSegment : uri
}

/**
 * 把携带内联 text 的 embedded resource 投影为可读正文：以「附件 <名>（<mime>）：」抬头 + 换行 + 原文。
 * 抬头让模型明确这是随附文件及其类型，取代旧「裸 text 直拼」的无标注做法；mime 缺省时省略括号段。
 */
const attachmentResourceToText = (
	uri: string,
	text: string,
	mimeType?: string,
): string => {
	const name = attachmentDisplayName(uri)
	const header = mimeType ? \`附件 \${name}（\${mimeType}）\` : \`附件 \${name}\`
	return \`\${header}：\\n\${text}\`
}

/**
 * 把单个内容块投影为可并入 user 消息的纯文本片段；无文本可投影时返回 null。
 */`,
);
patch(
  TRI,
  'I3 resource case 抬头化 + 读 mimeType',
  `		case "resource": {
			const embedded = block.resource as { uri: string; text?: unknown }
			if (typeof embedded.text === "string" && embedded.text.length > 0) {
				return embedded.text
			}
			return \`引用：\${embedded.uri}\`
		}`,
  `		case "resource": {
			const embedded = block.resource as {
				uri: string
				text?: unknown
				mimeType?: unknown
			}
			if (typeof embedded.text === "string" && embedded.text.length > 0) {
				return attachmentResourceToText(
					embedded.uri,
					embedded.text,
					typeof embedded.mimeType === "string" ? embedded.mimeType : undefined,
				)
			}
			return \`引用：\${embedded.uri}\`
		}`,
);

// ── J. to-runtime-input.spec.ts（TAB 缩进）：更新 resource 期望 + mime 用例 ─
patch(
  TRISPEC,
  'J resource 渲染测试',
  `test("resource：有内联 text 用 text，无则用 uri", () => {
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "file:///b.ts", text: "内联内容" },
		} as ContentBlock),
		"内联内容",
	)
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "file:///c.ts" },
		} as ContentBlock),
		"引用：file:///c.ts",
	)
})`,
  `test("resource：内联 text 投影为带附件抬头的正文，无 text 用 uri", () => {
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "attachment:///b.ts", text: "内联内容" },
		} as ContentBlock),
		"附件 b.ts：\\n内联内容",
	)
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: {
				uri: "attachment:///b.ts",
				text: "内联内容",
				mimeType: "text/x-typescript",
			},
		} as ContentBlock),
		"附件 b.ts（text/x-typescript）：\\n内联内容",
	)
	assert.equal(
		contentBlockToText({
			type: "resource",
			resource: { uri: "file:///c.ts" },
		} as ContentBlock),
		"引用：file:///c.ts",
	)
})`,
);

// ── K. useAiAssistant.spec.ts：文本附件发送为 resource（raw + mime，无 name）─
patch(
  USESPEC,
  'K 文本附件发送测试',
  `    expect(assistant.attachedFiles.value).toHaveLength(0);
    expect(userReferences(activeEntries()[0])[0]?.kind).toBe('image-attachment');
  });`,
  `    expect(assistant.attachedFiles.value).toHaveLength(0);
    expect(userReferences(activeEntries()[0])[0]?.kind).toBe('image-attachment');
  });

  it('发送文本附件时以 ACP embedded resource 原文与真实 mimeType 送达且不带 name', async () => {
    const assistant = createAssistantHarness();
    const attachment = new File(['export const answer = 42;'], 'answer.ts', {
      type: 'text/plain',
    });

    await assistant.attachFile(attachment);

    expect(assistant.attachedFiles.value).toHaveLength(1);
    expect(assistant.attachedFiles.value[0]?.kind).toBe('text');

    assistant.activeMode.value = 'chat';
    assistant.draft.value = '看看这个文件';
    await assistant.sendMessage();

    const lastCall = aiServiceMock.sidecarExternalChat.mock.calls.at(-1)?.[0] as unknown as {
      attachments?: Array<Record<string, unknown>>;
    };
    expect(lastCall.attachments).toEqual([
      {
        uri: 'attachment:///answer.ts',
        text: 'export const answer = 42;',
        mimeType: 'text/x-typescript',
      },
    ]);
    expect(lastCall.attachments?.[0]).not.toHaveProperty('name');
    expect(assistant.attachedFiles.value).toHaveLength(0);
  });`,
);

console.log('\\n🎉 全部 15 处补丁已应用。');