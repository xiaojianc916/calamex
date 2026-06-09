import fs from 'node:fs';

const FILE = 'src/components/business/ai/chat/AiPromptInput.vue';

const OLD = `.ai-prompt-shell {
  width: 100%;
  background: var(--panel-bg);
  border: 1px solid #efeeec;
  border-radius: 18px;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent),
    0 14px 30px color-mix(in srgb, var(--text-primary) 6%, transparent);
  overflow: hidden;
}

.ai-prompt-shell:focus-within {
  border-color: #efeeec;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent),
    0 14px 30px color-mix(in srgb, var(--text-primary) 6%, transparent);
}`;

const NEW = `.ai-prompt-shell {
  --ai-prompt-layered-shadow:
    0 -1px 0 0 #f6f6f5,
    0 1px 0 0 #f0f0ef,
    -1px 0 0 0 #f4f4f3,
    1px 0 0 0 #f4f4f3,
    0 2px 0 0 #f9f9f9,
    -2px 0 0 0 #fdfdfd,
    2px 0 0 0 #fdfdfd,
    0 1px 2px color-mix(in srgb, var(--text-primary) 8%, transparent),
    0 14px 30px color-mix(in srgb, var(--text-primary) 6%, transparent);
  width: 100%;
  background: var(--panel-bg);
  border-width: 1px;
  border-style: solid;
  border-top-color: #efeeec;
  border-bottom-color: #e9e8e6;
  border-left-color: #ecebe9;
  border-right-color: #ecebe9;
  border-radius: 18px;
  box-shadow: var(--ai-prompt-layered-shadow);
  overflow: hidden;
}

.ai-prompt-shell:focus-within {
  border-top-color: #efeeec;
  border-bottom-color: #e9e8e6;
  border-left-color: #ecebe9;
  border-right-color: #ecebe9;
  box-shadow: var(--ai-prompt-layered-shadow);
}`;

const raw = fs.readFileSync(FILE, 'utf8');
const hadCRLF = raw.includes('\r\n');
const text = raw.replace(/\r\n/g, '\n');

const count = text.split(OLD).length - 1;
if (count !== 1) {
  console.error(`✗ 预期匹配 1 处，实际 ${count} 处，未写入。文件可能已改动或换行符不一致。`);
  process.exit(1);
}

let out = text.replace(OLD, NEW);
if (hadCRLF) out = out.replace(/\n/g, '\r\n');
fs.writeFileSync(FILE, out);
console.log('✓ 已更新 Ai 输入框分层描边');