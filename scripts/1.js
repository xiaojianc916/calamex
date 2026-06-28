import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const REL = 'src/tools/mcp/client.spec.ts';
const BASE = existsSync(REL) ? '' : (existsSync('builtin-agent/' + REL) ? 'builtin-agent/' : '');

function patch(rel, edits) {
  const path = BASE + rel;
  const raw = readFileSync(path, 'utf8');
  const hadCRLF = raw.includes('\r\n');
  let text = raw.replace(/\r\n/g, '\n');
  for (const { oldStr, newStr, label } of edits) {
    const count = text.split(oldStr).length - 1;
    if (count !== 1) {
      console.log(`- skip [${label}]（${count} 匹配，期望 1）`);
      continue;
    }
    text = text.replace(oldStr, newStr);
    console.log(`+ 应用 [${label}]`);
  }
  writeFileSync(path, hadCRLF ? text.replace(/\n/g, '\r\n') : text, 'utf8');
}

patch(REL, [
  {
    label: 'narrow-integration-server-set',
    oldStr:
      "    const bundle = await createMastraMcpClientBundle({\n" +
      "      workspaceRootPath: WORKSPACE_ROOT,\n" +
      "      env: defaultEnv,\n" +
      "      platform: 'win32',\n" +
      "    });",
    newStr:
      "    const bundle = await createMastraMcpClientBundle({\n" +
      "      workspaceRootPath: WORKSPACE_ROOT,\n" +
      "      env: defaultEnv,\n" +
      "      platform: 'win32',\n" +
      "      // 仅启动一个本地健康 server（sequential-thinking）+ 一个注定失败的 server（git，空 fixture → EFTYPE）。\n" +
      "      // 关键：移除 github(HTTP)——其 getaddrinfo DNS 走 libuv 线程池，进程 teardown 时回调可能命中\n" +
      "      // uv_async_send 对“正在关闭句柄”的断言（libuv async.c:94），导致原生 abort。收窄后仍满足本用例\n" +
      "      // 意图：一个 server 不可用时健康工具仍保留，且 git 失败语义不变。\n" +
      "      serverNames: ['git', 'sequential-thinking'],\n" +
      "    });",
  },
]);