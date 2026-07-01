// fix-runtime-dead-session-config-options.mjs
// 删除 AcpRuntime::session_config_options 冗余死包装 + 其单测。
// host.session_config_options 仍被 ai_ensure_acp_session 使用,不受影响。
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "src-tauri/src/acp/runtime.rs";
const raw = readFileSync(FILE, "utf8");
const hadCRLF = raw.includes("\r\n");
let s = hadCRLF ? raw.split("\r\n").join("\n") : raw;

const method =
`\n\n    /// 取某线程会话建立时 agent 公示的可用配置项清单（ACP NewSessionResponse.config_options
    /// 原样 JSON）。线程绑定的会话可能落在任一后端宿主，故向全部已建立宿主查询并返回首个命中。
    /// 无任何宿主 / 无匹配线程 / agent 未公示配置项时返回 None。最小透传。
    pub fn session_config_options(&self, thread_id: &str) -> Option<serde_json::Value> {
        // 先取出 Arc 列表并释放锁，避免在逐宿主查询期间持有 runtime 锁。
        let hosts = self.hosts.lock().all();
        hosts
            .into_iter()
            .find_map(|host| host.session_config_options(thread_id))
    }`;

const test =
`\n\n    #[test]
    fn session_config_options_on_unestablished_runtime_is_none() {
        let runtime = AcpRuntime::default();
        // 无任何宿主时，配置项查询为安全空操作：返回 None 且绝不派生子进程。
        assert!(runtime.session_config_options("thread-1").is_none());
        assert!(runtime.hosts.lock().all().is_empty());
    }`;

for (const [name, block] of [["method", method], ["test", test]]) {
  const n = s.split(block).length - 1;
  if (n === 0 && !s.includes("fn session_config_options")) {
    console.log(`已是目标状态(${name} 不存在),跳过。`);
    continue;
  }
  if (n !== 1) throw new Error(`锚点 ${name} 命中 ${n} 次(期望 1),中止。`);
  s = s.split(block).join("");
}

if (s.includes("fn session_config_options"))
  throw new Error("删除后仍残留 session_config_options,中止。");

const out = hadCRLF ? s.split("\n").join("\r\n") : s;
writeFileSync(FILE, out);
console.log("✅ 已删除 AcpRuntime::session_config_options 死包装 + 单测。");