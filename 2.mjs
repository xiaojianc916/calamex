// d1s1.mjs — D1 切片 1:删除 legacy 三件套的「服务方法 + run/plan 子系统文件」
// 仅本片:ai.service.ts 删 3 方法 + 3 类型导入;整删 useAiAgentRun.ts / useAiAgentPlan.ts
// 跑完请执行 pnpm typecheck,把残留报给我(预期 useAiAssistant.ts / AiAssistantPanel.vue 报错,由切片2/3 收口)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const L = (...lines) => lines.join('\n');

function read(rel) {
  const p = path.join(ROOT, rel);
  const raw = fs.readFileSync(p, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { p, eol, text: raw.split('\r\n').join('\n') };
}
function write(p, text, eol) {
  fs.writeFileSync(p, eol === '\r\n' ? text.split('\n').join('\r\n') : text, 'utf8');
}
function replaceOnce(text, anchor, replacement, label) {
  const i = text.indexOf(anchor);
  if (i === -1) throw new Error('[D1-S1] 锚点未命中: ' + label);
  if (text.indexOf(anchor, i + anchor.length) !== -1)
    throw new Error('[D1-S1] 锚点多次命中(预期唯一): ' + label);
  return text.slice(0, i) + replacement + text.slice(i + anchor.length);
}
function delFile(rel) {
  const p = path.join(ROOT, rel);
  if (!fs.existsSync(p)) {
    console.log('· 已不存在(跳过): ' + rel);
    return;
  }
  fs.rmSync(p);
  console.log('✓ 删除文件: ' + rel);
}

// ── 1) src/services/ipc/ai.service.ts ──────────────────────────────
{
  const rel = 'src/services/ipc/ai.service.ts';
  const f = read(rel);
  let t = f.text;

  // 1a. 3 个 legacy 类型导入
  t = replaceOnce(t, '  IAgentSidecarApprovalResolveRequest,\n', '', 'import IAgentSidecarApprovalResolveRequest');
  t = replaceOnce(t, '  IAgentSidecarAskUserResumeRequest,\n', '', 'import IAgentSidecarAskUserResumeRequest');
  t = replaceOnce(t, '  IAgentSidecarChatRequest,\n', '', 'import IAgentSidecarChatRequest');

  // 1b. sidecarChat
  t = replaceOnce(
    t,
    L(
      '  sidecarChat(payload: IAgentSidecarChatRequest): Promise<IAgentSidecarResponsePayload> {',
      '    return tauriService.agentSidecarChat(payload);',
      '  },',
      '',
    ),
    '',
    'method sidecarChat',
  );

  // 1c. sidecarResolveApproval
  t = replaceOnce(
    t,
    L(
      '  sidecarResolveApproval(',
      '    payload: IAgentSidecarApprovalResolveRequest,',
      '  ): Promise<IAgentSidecarResponsePayload> {',
      '    return tauriService.agentSidecarResolveApproval(payload);',
      '  },',
      '',
    ),
    '',
    'method sidecarResolveApproval',
  );

  // 1d. sidecarResolveAskUser
  t = replaceOnce(
    t,
    L(
      '  sidecarResolveAskUser(',
      '    payload: IAgentSidecarAskUserResumeRequest,',
      '  ): Promise<IAgentSidecarResponsePayload> {',
      '    return tauriService.agentSidecarResolveAskUser(payload);',
      '  },',
      '',
    ),
    '',
    'method sidecarResolveAskUser',
  );

  write(f.p, t, f.eol);
  console.log('✓ 改写: ' + rel + '  (EOL=' + (f.eol === '\r\n' ? 'CRLF' : 'LF') + ')');
}

// ── 2) 整删 legacy plan/run 子系统文件 ─────────────────────────────
delFile('src/composables/ai/useAiAgentRun.ts');
delFile('src/composables/ai/useAiAgentPlan.ts');

console.log('\n[D1-S1] 完成。下一步:pnpm typecheck —— 把残留贴给我,我出切片 2。');