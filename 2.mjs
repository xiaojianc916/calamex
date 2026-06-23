import { readFileSync, writeFileSync } from 'node:fs';

const path = 'src-tauri/src/acp/host.rs';
const raw = readFileSync(path, 'utf8');

// 本地可能是 CRLF：规整成 LF 做匹配，写回时还原原始行尾，避免整文件 diff。
const hadCRLF = raw.includes('\r\n');
let src = raw.split('\r\n').join('\n');

function replaceOnce(anchor, next) {
  const i = src.indexOf(anchor);
  if (i === -1) throw new Error('anchor not found: ' + anchor.slice(0, 48));
  if (src.indexOf(anchor, i + anchor.length) !== -1)
    throw new Error('anchor not unique: ' + anchor.slice(0, 48));
  src = src.slice(0, i) + next + src.slice(i + anchor.length);
}

// 1) struct 字段：新增会话级命令缓存 + emit 克隆
replaceOnce(
  '    stream_key_overrides: Arc<Mutex<HashMap<String, String>>>,\n}',
  '    stream_key_overrides: Arc<Mutex<HashMap<String, String>>>,\n' +
    '    /// ACP 会话 id ↔ 该会话最近一次 available_commands_update 的 availableCommands 原始数组。\n' +
    '    /// Kimi 等外部 agent 在 session/new 后经 setTimeout(0) 一次性下发可用斜杠命令（见 kimi-code\n' +
    '    /// packages/acp-adapter/src/server.ts scheduleAvailableCommandsUpdate），该 one-shot 早于/竞争\n' +
    '    /// 本回合 stream_key 重写登记、且会话复用后不再重发，仅靠回合内自然转发会被前端按键过滤丢弃 →\n' +
    '    /// 命令面板恒空。sink 无条件按 ACP 会话 id 缓存，回合发起时以前端键重放，使面板稳定填充（与\n' +
    '    /// modes_by_thread / config_options_by_thread 的会话级缓存同构）。\n' +
    '    available_commands_by_session: Arc<Mutex<HashMap<String, serde_json::Value>>>,\n' +
    '    /// 流式帧下沉口克隆：供回合发起时主动以前端键重放缓存的可用命令（sink 内重写表只在帧自然到达\n' +
    '    /// 时生效，重放是宿主侧主动构造帧，故宿主直接持 emit）。\n' +
    '    emit: StreamEmitter,\n}',
);

// 2) spawn：建缓存 + emit 克隆
replaceOnce(
  '        let stream_key_overrides = Arc::new(Mutex::new(HashMap::new()));\n' +
    '        let overrides_for_sink = stream_key_overrides.clone();',
  '        let stream_key_overrides = Arc::new(Mutex::new(HashMap::new()));\n' +
    '        let overrides_for_sink = stream_key_overrides.clone();\n\n' +
    '        // 外部 agent 一次性下发的可用斜杠命令缓存（按 ACP 会话 id）：sink 无条件捕获，回合发起时重放。\n' +
    '        let available_commands_by_session: Arc<Mutex<HashMap<String, serde_json::Value>>> =\n' +
    '            Arc::new(Mutex::new(HashMap::new()));\n' +
    '        let commands_cache_for_sink = available_commands_by_session.clone();\n\n' +
    '        // emit 克隆留给宿主侧主动重放（sink 内的重写表只在帧自然到达时生效）。\n' +
    '        let emit_for_host = emit.clone();',
);

// 3) sink：在重写 session_id 之前按原始 ACP id 捕获 available_commands
replaceOnce(
  '        let sink: EventSink = Arc::new(move |mut frame: AcpStreamFrame| {\n' +
    '            let remapped_stream_key = frame',
  '        let sink: EventSink = Arc::new(move |mut frame: AcpStreamFrame| {\n' +
    '            // 先按「原始 ACP 会话 id」捕获 available_commands_update 的 availableCommands 原始数组，\n' +
    '            // 缓存供回合发起时以前端键重放（取键须在重写 session_id 之前，键须为 ACP 会话 UUID）。\n' +
    '            if let Some(acp_session_id) = frame.session_id.clone() {\n' +
    '                if let Some(commands) = extract_available_commands_update(&frame.event) {\n' +
    '                    commands_cache_for_sink\n' +
    '                        .lock()\n' +
    '                        .insert(acp_session_id, commands);\n' +
    '                }\n' +
    '            }\n\n' +
    '            let remapped_stream_key = frame',
);

// 4) Ok(Self{ .. })：补两个字段
replaceOnce(
  '            stream_key_overrides,\n        })\n    }',
  '            stream_key_overrides,\n' +
    '            available_commands_by_session,\n' +
    '            emit: emit_for_host,\n        })\n    }',
);

// 5) 新增 replay 方法（impl 内，prompt_with_stream_key 之后）
replaceOnce(
  '        outcome\n    }\n\n    /// 用纯文本驱动一轮',
  '        outcome\n    }\n\n' +
    '    /// 把某 ACP 会话已缓存的 available_commands 以前端流式键重放一帧 available_commands_update。\n' +
    '    ///\n' +
    '    /// 回合发起时调用：Kimi 等外部 agent 的可用斜杠命令是 session/new 后经 setTimeout(0) 的一次性\n' +
    '    /// 下发，会话复用后不再重发，且其到达时序早于/竞争本回合 stream_key 重写登记，仅靠自然转发会被\n' +
    '    /// 前端按键过滤丢弃 → 命令面板恒空。此处登记重写后主动以前端键补发一帧，使面板在每个回合订阅\n' +
    '    /// 建立后稳定填充。无缓存则空操作。\n' +
    '    fn replay_available_commands(&self, acp_session_id: &str, stream_key: &str) {\n' +
    '        let commands = self\n' +
    '            .available_commands_by_session\n' +
    '            .lock()\n' +
    '            .get(acp_session_id)\n' +
    '            .cloned();\n' +
    '        let Some(commands) = commands else {\n' +
    '            return;\n' +
    '        };\n' +
    '        (self.emit)(AcpStreamFrame {\n' +
    '            session_id: Some(stream_key.to_string()),\n' +
    '            seq: 0,\n' +
    '            event: build_available_commands_event(stream_key, &commands),\n' +
    '        });\n' +
    '    }\n\n' +
    '    /// 用纯文本驱动一轮',
);

// 6) prompt_with_stream_key：登记后重放
replaceOnce(
  '            self.stream_key_overrides\n' +
    '                .lock()\n' +
    '                .insert(acp_session_id.clone(), key.to_string());\n' +
    '            true',
  '            self.stream_key_overrides\n' +
    '                .lock()\n' +
    '                .insert(acp_session_id.clone(), key.to_string());\n' +
    '            // 重写已登记 + 前端回合订阅已建立：以前端键重放缓存的可用命令，命令面板即时填充。\n' +
    '            self.replay_available_commands(&acp_session_id, key);\n' +
    '            true',
);

// 7) agent_chat_with_stream_key：登记后重放
replaceOnce(
  '            self.stream_key_overrides\n' +
    '                .lock()\n' +
    '                .insert(acp_session_id.to_string(), key.to_string());\n' +
    '            true',
  '            self.stream_key_overrides\n' +
    '                .lock()\n' +
    '                .insert(acp_session_id.to_string(), key.to_string());\n' +
    '            // 同 prompt_with_stream_key：登记重写后立即以前端键重放缓存的可用命令。\n' +
    '            self.replay_available_commands(acp_session_id, key);\n' +
    '            true',
);

// 8) 两个纯函数（模块级，non_empty 之前）
replaceOnce(
  '/// 修剪并过滤空白可选字符串：',
  '/// 从一帧 session/update 事件 JSON 中提取 available_commands_update 的 availableCommands 数组。\n' +
    '/// 仅当 update.sessionUpdate 为 "available_commands_update" 且存在 availableCommands 时返回其克隆，\n' +
    '/// 否则返回 None（其余变体或字段缺失）。纯函数，便于单测。\n' +
    'fn extract_available_commands_update(event: &serde_json::Value) -> Option<serde_json::Value> {\n' +
    '    let update = event.get("update")?;\n' +
    '    if update\n' +
    '        .get("sessionUpdate")\n' +
    '        .and_then(serde_json::Value::as_str)\n' +
    '        != Some("available_commands_update")\n' +
    '    {\n' +
    '        return None;\n' +
    '    }\n' +
    '    update.get("availableCommands").cloned()\n' +
    '}\n\n' +
    '/// 构造一帧以前端流式键标记的 available_commands_update 事件 JSON（与 ui_event 投影同形：\n' +
    '/// sessionId + update.sessionUpdate + update.availableCommands）。纯函数，便于单测。\n' +
    'fn build_available_commands_event(\n' +
    '    stream_key: &str,\n' +
    '    commands: &serde_json::Value,\n' +
    ') -> serde_json::Value {\n' +
    '    serde_json::json!({\n' +
    '        "sessionId": stream_key,\n' +
    '        "update": {\n' +
    '            "sessionUpdate": "available_commands_update",\n' +
    '            "availableCommands": commands.clone(),\n' +
    '        }\n' +
    '    })\n' +
    '}\n\n' +
    '/// 修剪并过滤空白可选字符串：',
);

// 9) 单测（mod tests 内，non_empty 测试之前）
replaceOnce(
  '    #[test]\n    fn non_empty_trims_and_filters_blank() {',
  '    #[test]\n' +
    '    fn extract_available_commands_update_returns_commands_for_matching_frame() {\n' +
    '        let event = serde_json::json!({\n' +
    '            "sessionId": "acp-uuid",\n' +
    '            "update": {\n' +
    '                "sessionUpdate": "available_commands_update",\n' +
    '                "availableCommands": [\n' +
    '                    { "name": "compact", "description": "压缩上下文" },\n' +
    '                    { "name": "help", "description": "帮助" }\n' +
    '                ]\n' +
    '            }\n' +
    '        });\n' +
    '        let commands = extract_available_commands_update(&event).unwrap();\n' +
    '        assert_eq!(commands.as_array().unwrap().len(), 2);\n' +
    '        assert_eq!(commands[0]["name"], "compact");\n' +
    '    }\n\n' +
    '    #[test]\n' +
    '    fn extract_available_commands_update_ignores_other_session_updates() {\n' +
    '        let event = serde_json::json!({\n' +
    '            "sessionId": "acp-uuid",\n' +
    '            "update": {\n' +
    '                "sessionUpdate": "agent_message_chunk",\n' +
    '                "content": { "type": "text", "text": "hi" }\n' +
    '            }\n' +
    '        });\n' +
    '        assert!(extract_available_commands_update(&event).is_none());\n' +
    '    }\n\n' +
    '    #[test]\n' +
    '    fn extract_available_commands_update_none_when_field_absent() {\n' +
    '        let event = serde_json::json!({\n' +
    '            "update": { "sessionUpdate": "available_commands_update" }\n' +
    '        });\n' +
    '        assert!(extract_available_commands_update(&event).is_none());\n' +
    '    }\n\n' +
    '    #[test]\n' +
    '    fn build_available_commands_event_targets_stream_key() {\n' +
    '        let commands = serde_json::json!([{ "name": "status", "description": "状态" }]);\n' +
    '        let event = build_available_commands_event("sidecar:assistant-1", &commands);\n' +
    '        assert_eq!(event["sessionId"], "sidecar:assistant-1");\n' +
    '        assert_eq!(event["update"]["sessionUpdate"], "available_commands_update");\n' +
    '        assert_eq!(event["update"]["availableCommands"][0]["name"], "status");\n' +
    '    }\n\n' +
    '    #[test]\n    fn non_empty_trims_and_filters_blank() {',
);

const out = hadCRLF ? src.split('\n').join('\r\n') : src;
writeFileSync(path, out);
console.log('host.rs patched (eol=' + (hadCRLF ? 'CRLF' : 'LF') + ')');