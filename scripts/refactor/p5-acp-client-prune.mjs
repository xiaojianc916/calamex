#!/usr/bin/env node
/*
 * P5 ACP client 收尾:删除 src-tauri/src/acp/client.rs 中 P5a 漏删的 legacy
 * orchestrate 残留——这些残留使 acp_client feature 无法编译:
 *   1) 命令循环里指向已删枚举变体的 Command::Orchestrate / OrchestrateResume 两个 match 臂;
 *   2) 引用已删类型 OrchestrateExtRequest 的 orchestrate_ext_request_* 单测。
 *
 * 设计:锥点逐字精确匹配;两个锥点必须同时存在才写回(全有才写),
 * 都不在 = 已清理(exit 0),部分缺失 = 中止不写(exit 1),绝不模糊替换。
 * 锥点由数组 join('\n') 构成,与脚本自身 EOL 无关;再据目标文件 EOL 适配。
 */
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'src-tauri/src/acp/client.rs';

// 两个 match 臂(含前导空行:首元 '' 产生一个 \n,接在上一个 } 之后)。
const ARMS = [
  '',
  '                        Command::Orchestrate { request, reply } => {',
  '                            let res = cx.send_request(request).block_task().await;',
  '                            let _ = reply.send(res.map_err(|e| e.to_string()));',
  '                        }',
  '                        Command::OrchestrateResume { request, reply } => {',
  '                            let res = cx.send_request(request).block_task().await;',
  '                            let _ = reply.send(res.map_err(|e| e.to_string()));',
  '                        }',
].join('\n');

// orchestrate 单测(含前导空行:两个 '' 产生 \n\n)。
const TEST = [
  '',
  '',
  '    #[test]',
  '    fn orchestrate_ext_request_serializes_to_camel_case_params() {',
  '        let request = OrchestrateExtRequest {',
  '            goal: "build feature".to_string(),',
  '            thread_id: Some("t1".to_string()),',
  '            execution_mode: None,',
  '            session_id: Some("s1".to_string()),',
  '            model_config: None,',
  '        };',
  '        let value = serde_json::to_value(&request).unwrap();',
  '        assert_eq!(value["goal"], "build feature");',
  '        assert_eq!(value["threadId"], "t1");',
  '        assert_eq!(value["sessionId"], "s1");',
  '        assert!(value.get("executionMode").is_none());',
  '    }',
].join('\n');

const raw = readFileSync(FILE, 'utf8');
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
const toEol = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol));

const removals = [
  { label: 'Command::Orchestrate / OrchestrateResume match 臂', anchor: toEol(ARMS) },
  { label: 'orchestrate_ext_request_* 单测', anchor: toEol(TEST) },
];

let next = raw;
const missing = [];
for (const { label, anchor } of removals) {
  const count = next.split(anchor).length - 1;
  if (count === 0) {
    missing.push(label);
    continue;
  }
  if (count > 1) {
    console.error(`【中止】锥点出现 ${count} 次,拒绝歧义替换:${label}`);
    process.exit(1);
  }
  next = next.replace(anchor, '');
  console.log(`已删除:${label}`);
}

if (missing.length === removals.length) {
  console.log('未发现任何 legacy orchestrate 残留,client.rs 已是干净状态。');
  process.exit(0);
}
if (missing.length > 0) {
  console.error(`【中止】部分锥点未找到(文件可能已被改动),为避免半途状态不写入:${missing.join('; ')}`);
  process.exit(1);
}

writeFileSync(FILE, next, 'utf8');
console.log(`✅ ${FILE} 已清理 legacy orchestrate 残留。接下来请跑:`);
console.log('   cargo clippy --features acp_client --manifest-path src-tauri/Cargo.toml');
