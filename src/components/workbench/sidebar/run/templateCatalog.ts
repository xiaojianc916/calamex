// ═══════════════════════════════════════════════════════════════
// Shell 片段库 — 模板数据目录
// ═══════════════════════════════════════════════════════════════

import type { IPhase } from './run-sidebar.types';

export * from './run-sidebar.types';

const PHASE_COLORS = {
  mine: '#f59e0b',
  pre: '#06b6d4',
  dat: '#8b5cf6',
  int: '#84cc16',
  exe: '#f97316',
  out: '#ec4899',
  end: '#ef4444',
  cro: '#3b82f6',
} as const;

export const TEMPLATE_PHASES: readonly IPhase[] = [
  {
    id: 'mine',
    label: '我的 · Personal',
    color: PHASE_COLORS.mine,
    open: true,
    categories: [
      {
        icon: 'star',
        name: '收藏',
        items: [
          { icon: 'info', trigger: 'logi', description: 'INFO 日志输出' },
          { icon: 'rotate-cw', trigger: 'retry', description: '指数退避重试' },
          { icon: 'alert-triangle', trigger: 'die', description: '报错并退出' },
          { icon: 'refresh-cw', trigger: 'curlr', description: 'curl 重试 + 状态' },
          { icon: 'trash-2', trigger: 'trapc', description: 'trap EXIT 清理' },
        ],
      },
      {
        icon: 'clock',
        name: '最近',
        items: [
          { icon: 'rocket', trigger: 'initf', description: '完整起手式带 trap' },
          { icon: 'shield-check', trigger: 'cdep', description: '检查依赖命令' },
          { icon: 'braces', trigger: 'jqe', description: 'jq 抽字段' },
          { icon: 'list', trigger: 'menu', description: '数字菜单' },
          { icon: 'regex', trigger: 'sedr', description: 'sed 替换跨平台' },
          { icon: 'grid-3x3', trigger: 'xparl', description: 'xargs -P 限流' },
          { icon: 'file-text', trigger: 'mdr', description: 'Markdown 报告' },
          { icon: 'shield-alert', trigger: 'errh', description: 'trap ERR 处理' },
        ],
      },
    ],
  },
  {
    id: 'pre',
    label: '前置 · Preflight',
    color: PHASE_COLORS.pre,
    categories: [
      {
        icon: 'rocket',
        name: '起手式',
        items: [
          { icon: 'hash', trigger: 'init', description: 'shebang + strict' },
          { icon: 'rocket', trigger: 'initf', description: '完整起手式带 trap' },
          { icon: 'folder', trigger: 'sdir', description: '定位脚本所在目录' },
          { icon: 'tag', trigger: 'ver', description: '版本号常量' },
        ],
      },
      {
        icon: 'book-open',
        name: '帮助文档',
        isNew: true,
        items: [
          { icon: 'help-circle', trigger: 'usage', description: 'usage 函数' },
          { icon: 'info', trigger: 'help', description: '--help 解析分发' },
          { icon: 'book-open', trigger: 'man', description: 'man 风格多段帮助' },
        ],
      },
      {
        icon: 'terminal',
        name: '参数解析',
        items: [
          { icon: 'flag', trigger: 'opts', description: 'getopts 短选项' },
          { icon: 'flag', trigger: 'optsl', description: 'getopt 长选项' },
          { icon: 'arrow-right', trigger: 'posarg', description: '位置参数校验' },
        ],
      },
      {
        icon: 'settings',
        name: '配置加载',
        isNew: true,
        items: [
          { icon: 'key', trigger: 'denv', description: 'source .env 文件' },
          { icon: 'layers', trigger: 'defv', description: '默认值优先链' },
          { icon: 'file', trigger: 'ini', description: '解析 ini 文件' },
          { icon: 'search', trigger: 'conf', description: '多路径查找配置' },
        ],
      },
      {
        icon: 'shield-check',
        name: '环境检查',
        items: [
          { icon: 'package', trigger: 'cdep', description: '检查依赖命令存在' },
          { icon: 'monitor', trigger: 'cplat', description: '检测平台 macOS/Linux' },
          { icon: 'user-check', trigger: 'csudo', description: '检查 sudo 权限' },
          { icon: 'key', trigger: 'ctok', description: '检查必要 Token' },
          { icon: 'hard-drive', trigger: 'cdisk', description: '检查磁盘空间' },
        ],
      },
      {
        icon: 'lock',
        name: '单实例锁',
        isNew: true,
        items: [
          { icon: 'lock', trigger: 'flock', description: 'flock 文件锁互斥' },
          { icon: 'folder', trigger: 'mklock', description: 'mkdir 原子锁' },
          { icon: 'file', trigger: 'pidf', description: 'PID 文件守护' },
        ],
      },
    ],
  },
  {
    id: 'dat',
    label: '数据 · Data',
    color: PHASE_COLORS.dat,
    categories: [
      {
        icon: 'type',
        name: '字符串',
        items: [
          { icon: 'scissors', trigger: 'trim', description: '去除前后空白' },
          { icon: 'arrow-down-az', trigger: 'low', description: '转小写' },
          { icon: 'arrow-up-az', trigger: 'upp', description: '转大写' },
          { icon: 'replace', trigger: 'srep', description: '全局替换' },
          { icon: 'text-cursor-input', trigger: 'subs', description: '截取子串' },
          { icon: 'at-sign', trigger: 'var', description: '变量默认值兜底' },
        ],
      },
      {
        icon: 'braces',
        name: '数组映射',
        isNew: true,
        items: [
          { icon: 'brackets', trigger: 'arr', description: '声明数组' },
          { icon: 'repeat', trigger: 'arrf', description: '遍历数组' },
          { icon: 'scissors', trigger: 'arrs', description: '数组切片' },
          { icon: 'git-branch-plus', trigger: 'amap', description: '关联数组键值对' },
          { icon: 'combine', trigger: 'arrj', description: 'join 为分隔串' },
        ],
      },
      {
        icon: 'calendar',
        name: '日期时间',
        isNew: true,
        items: [
          { icon: 'clock', trigger: 'tsiso', description: 'ISO 8601 时间戳' },
          { icon: 'clock', trigger: 'tsc', description: '紧凑时间戳' },
          { icon: 'calendar-minus', trigger: 'yday', description: '昨天 / N 天前' },
          { icon: 'calendar-clock', trigger: 'ddiff', description: '两日期差' },
          { icon: 'calendar', trigger: 'dfmt', description: '格式转换' },
        ],
      },
      {
        icon: 'database',
        name: '结构化数据',
        isNew: true,
        items: [
          { icon: 'braces', trigger: 'jqe', description: 'jq 抽字段' },
          { icon: 'filter', trigger: 'jqf', description: 'jq 条件过滤' },
          { icon: 'file', trigger: 'yqq', description: 'yq 查 YAML' },
          { icon: 'wrench', trigger: 'jbld', description: 'jq 构造 JSON' },
          { icon: 'arrow-left-right', trigger: 'c2j', description: 'CSV 转 JSON' },
        ],
      },
    ],
  },
  {
    id: 'int',
    label: '交互 · Interaction',
    color: PHASE_COLORS.int,
    categories: [
      {
        icon: 'message-square',
        name: '用户输入',
        items: [
          { icon: 'hash', trigger: 'rdn', description: '读数字带校验' },
          { icon: 'key', trigger: 'rdp', description: '读密码不回显' },
          { icon: 'check', trigger: 'rdc', description: '输入特定词确认' },
          { icon: 'text-cursor-input', trigger: 'rdd', description: '带默认值的输入' },
          { icon: 'clock', trigger: 'rdt', description: '超时自动取默认' },
        ],
      },
      {
        icon: 'list',
        name: '菜单循环',
        items: [
          { icon: 'list', trigger: 'menu', description: '数字菜单' },
          { icon: 'rotate-cw', trigger: 'menul', description: '循环菜单 q 退' },
          { icon: 'chevron-right', trigger: 'menus', description: 'bash select 块' },
          { icon: 'mouse-pointer', trigger: 'menud', description: 'whiptail 对话框' },
        ],
      },
      {
        icon: 'loader',
        name: '进度反馈',
        items: [
          { icon: 'bar-chart-2', trigger: 'pbar', description: '百分比进度条' },
          { icon: 'loader', trigger: 'pspin', description: '旋转 Spinner' },
          { icon: 'list-ordered', trigger: 'pstep', description: '[1/N] 步骤提示' },
        ],
      },
      {
        icon: 'file-text',
        name: '日志输出',
        items: [
          { icon: 'info', trigger: 'logi', description: 'INFO 青色' },
          { icon: 'alert-triangle', trigger: 'logw', description: 'WARN 黄色' },
          { icon: 'octagon-alert', trigger: 'loge', description: 'ERROR 红色' },
          { icon: 'bug', trigger: 'logd', description: 'DEBUG 仅 debug 模式' },
          { icon: 'layers', trigger: 'logl', description: '分级日志全套' },
          { icon: 'save', trigger: 'logf', description: 'tee 到文件' },
        ],
      },
    ],
  },
  {
    id: 'exe',
    label: '执行 · Execution',
    color: PHASE_COLORS.exe,
    categories: [
      {
        icon: 'git-branch',
        name: '控制流',
        items: [
          { icon: 'rotate-cw', trigger: 'retry', description: '指数退避重试' },
          { icon: 'timer-off', trigger: 'tout', description: '超时包装命令' },
          { icon: 'loader', trigger: 'waitr', description: '轮询直到就绪' },
          { icon: 'git-fork', trigger: 'case', description: 'case 状态机' },
          { icon: 'git-branch-plus', trigger: 'ifte', description: 'if/elif/else' },
        ],
      },
      {
        icon: 'folder',
        name: '文件操作',
        items: [
          { icon: 'file-check', trigger: 'atomw', description: '原子写入' },
          { icon: 'file-plus', trigger: 'mkt', description: '安全临时文件' },
          { icon: 'file-clock', trigger: 'fnew', description: '查找近 N 天' },
          { icon: 'file-x', trigger: 'srm', description: '带确认删除' },
          { icon: 'copy', trigger: 'cpm', description: '复制自动建目录' },
          { icon: 'ruler', trigger: 'wcl', description: '统计文件行数' },
        ],
      },
      {
        icon: 'file-search',
        name: '文本处理',
        isNew: true,
        items: [
          { icon: 'regex', trigger: 'sedr', description: 'sed 替换跨平台' },
          { icon: 'table', trigger: 'awkc', description: 'awk 按列过滤' },
          { icon: 'search', trigger: 'grepc', description: 'grep 上下文行' },
          { icon: 'scissors', trigger: 'cutf', description: 'cut 分隔取列' },
          { icon: 'arrow-up-down', trigger: 'sortu', description: '排序去重' },
        ],
      },
      {
        icon: 'cpu',
        name: '进程并发',
        isNew: true,
        items: [
          { icon: 'cpu', trigger: 'bgw', description: '后台执行 + wait' },
          { icon: 'grid-3x3', trigger: 'xparl', description: 'xargs -P 限流' },
          { icon: 'cone', trigger: 'sema', description: 'FIFO 信号量' },
          { icon: 'ban', trigger: 'kilt', description: '杀进程树' },
        ],
      },
      {
        icon: 'globe',
        name: '网络远程',
        isNew: true,
        items: [
          { icon: 'refresh-cw', trigger: 'curlr', description: 'curl 重试 + 状态' },
          { icon: 'send', trigger: 'curlj', description: 'curl 发 JSON' },
          { icon: 'terminal', trigger: 'sshb', description: 'SSH 批量' },
          { icon: 'arrow-left-right', trigger: 'rsync', description: 'rsync 安全同步' },
          { icon: 'plug', trigger: 'port', description: '端口连通性' },
        ],
      },
    ],
  },
  {
    id: 'out',
    label: '输出 · Output',
    color: PHASE_COLORS.out,
    categories: [
      {
        icon: 'bar-chart-2',
        name: '报告生成',
        isNew: true,
        items: [
          { icon: 'table', trigger: 'tbl', description: 'printf 对齐表格' },
          { icon: 'file-text', trigger: 'mdr', description: 'Markdown 报告' },
          { icon: 'code', trigger: 'jout', description: '机器可读 JSON' },
        ],
      },
      {
        icon: 'bell',
        name: '通知发送',
        isNew: true,
        items: [
          { icon: 'mail', trigger: 'nmail', description: '邮件通知' },
          { icon: 'webhook', trigger: 'nwh', description: '通用 Webhook' },
          { icon: 'message-circle', trigger: 'nqw', description: '企业微信机器人' },
          { icon: 'bell-ring', trigger: 'ndt', description: '桌面通知' },
        ],
      },
    ],
  },
  {
    id: 'end',
    label: '收尾 · Teardown',
    color: PHASE_COLORS.end,
    categories: [
      {
        icon: 'alert-triangle',
        name: '错误处理',
        items: [
          { icon: 'skull', trigger: 'die', description: '报错并退出' },
          { icon: 'pipeline', trigger: 'pipes', description: 'PIPESTATUS 检查' },
          { icon: 'shield', trigger: 'errh', description: 'trap ERR 处理' },
          { icon: 'asterisk', trigger: 'reqv', description: '变量必填校验' },
        ],
      },
      {
        icon: 'trash-2',
        name: '资源清理',
        items: [
          { icon: 'broom', trigger: 'trapc', description: 'trap EXIT 清理' },
          { icon: 'folder-x', trigger: 'tmpd', description: '临时目录自销毁' },
          { icon: 'undo-2', trigger: 'coe', description: '仅失败时清理' },
        ],
      },
      {
        icon: 'log-out',
        name: '退出码',
        isNew: true,
        items: [
          { icon: 'hash', trigger: 'excd', description: '退出码常量定义' },
          { icon: 'code', trigger: 'sysex', description: 'sysexits.h 风格' },
          { icon: 'log-out', trigger: 'exm', description: '带消息退出' },
        ],
      },
    ],
  },
  {
    id: 'cro',
    label: '横切 · Cross-cutting',
    color: PHASE_COLORS.cro,
    categories: [
      {
        icon: 'bug',
        name: '调试诊断',
        isNew: true,
        items: [
          { icon: 'bug', trigger: 'dbg', description: '--debug 开 set -x' },
          { icon: 'terminal-square', trigger: 'ps4', description: '彩色 PS4 trace' },
          { icon: 'layers', trigger: 'stk', description: 'caller 函数栈' },
          { icon: 'file-text', trigger: 'dump', description: 'dump 所有变量' },
        ],
      },
      {
        icon: 'shield',
        name: '安全敏感',
        isNew: true,
        items: [
          { icon: 'eye-off', trigger: 'srd', description: '不回显读密码' },
          { icon: 'asterisk', trigger: 'mask', description: '日志遮蔽密钥' },
          { icon: 'lock', trigger: 'stmp', description: '600 临时文件' },
          { icon: 'trash-2', trigger: 'chist', description: '清命令历史' },
        ],
      },
      {
        icon: 'test-tube',
        name: '测试断言',
        isNew: true,
        items: [
          { icon: 'equal', trigger: 'aseq', description: '断言相等' },
          { icon: 'copy', trigger: 'mock', description: 'mock 外部命令' },
          { icon: 'test-tube', trigger: 'bats', description: 'bats 测试骨架' },
        ],
      },
    ],
  },
] as const;

/** 统计所有片段数量（不含「我的」板块） */
export function countSnippets(): number {
  let total = 0;
  for (const phase of TEMPLATE_PHASES) {
    if (phase.id === 'mine') continue;
    for (const cat of phase.categories) {
      total += cat.items.length;
    }
  }
  return total;
}
