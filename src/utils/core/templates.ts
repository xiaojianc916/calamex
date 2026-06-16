import type { ICommandTemplate, TExecutorKind } from '@/types/editor';

export const DEFAULT_SCRIPT = `#!/bin/bash

set -euo pipefail

main() {
  echo "Hello SH Editor"
}

main "$@"
`;

export const DEFAULT_EXECUTOR: TExecutorKind = 'wsl';

export const getExecutorLabel = (executor: TExecutorKind): string => {
  switch (executor) {
    default:
      return 'WSL2';
  }
};

export const COMMAND_TEMPLATES: ICommandTemplate[] = [
  {
    id: 'safe-header',
    title: '安全头',
    category: '基础模板',
    description: '快速插入 bash 安全执行头和主函数骨架。',
    snippet: DEFAULT_SCRIPT,
  },
  {
    id: 'for-loop',
    title: '循环',
    category: '流程控制',
    description: '批量遍历参数或目录时的常用循环结构。',
    snippet: `for item in "$@"; do
  echo "processing: \${item}"
done
`,
  },
  {
    id: 'if-check',
    title: '判断',
    category: '流程控制',
    description: '文件存在校验和错误退出模板。',
    snippet: `if [[ ! -f "$1" ]]; then
  echo "文件不存在: $1" >&2
  exit 1
fi
`,
  },
  {
    id: 'scp-upload',
    title: '上传',
    category: '远程操作',
    description: '常用部署上传脚本片段。',
    snippet: `REMOTE_HOST="user@example.com"
LOCAL_FILE="./dist/package.tar.gz"
REMOTE_DIR="/opt/deploy"

scp "$LOCAL_FILE" "$REMOTE_HOST:$REMOTE_DIR/"
`,
  },
  {
    id: 'journal-tail',
    title: '日志',
    category: '运维排查',
    description: '跟踪 systemd 服务日志并过滤关键字。',
    snippet: `SERVICE_NAME="nginx"
journalctl -u "$SERVICE_NAME" -f | grep --line-buffered -i "error"
`,
  },
  {
    id: 'backup-dir',
    title: '备份',
    category: '文件处理',
    description: '按时间戳打包目录并保留输出记录。',
    snippet: `SOURCE_DIR="/data/app"
BACKUP_DIR="/data/backup"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/app_\${STAMP}.tar.gz" "$SOURCE_DIR"
echo "backup done: $BACKUP_DIR/app_\${STAMP}.tar.gz"
`,
  },
];

export const COMMENT_TEMPLATES: ICommandTemplate[] = [
  {
    id: 'script-comment',
    title: '脚本说明',
    category: '注释模板',
    description: '用于说明脚本用途、作者、输入与输出。',
    snippet: `# ==========================================
# 脚本名称：
# 用途说明：
# 运行环境：
# 输入参数：
# 输出结果：
# 维护人：
# ==========================================
`,
  },
  {
    id: 'function-comment',
    title: '函数说明',
    category: '注释模板',
    description: '说明函数用途、参数和返回值。',
    snippet: `# 函数名：
# 用途：
# 参数：
# 返回：`,
  },
  {
    id: 'step-comment',
    title: '步骤分隔',
    category: '注释模板',
    description: '给复杂脚本添加阶段性分隔注释。',
    snippet: `# ---------- 第一步：环境校验 ----------
`,
  },
];
