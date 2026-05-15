export type TRunOpsTemplateCategoryId =
  | 'foundation'
  | 'probe'
  | 'service'
  | 'config'
  | 'deploy'
  | 'backup'
  | 'security'
  | 'fleet';

export type TRunOpsTemplateRisk = 'readonly' | 'write' | 'destructive';
export type TRunOpsTemplateScope = 'local' | 'remote' | 'fleet';
export type TRunOpsTemplateStatus = 'planned' | 'ready';
export type TRunOpsReadinessId =
  | 'safety'
  | 'idempotency'
  | 'reversibility'
  | 'observability'
  | 'controllability'
  | 'portability';

export interface IRunOpsTemplateCategory {
  id: TRunOpsTemplateCategoryId;
  title: string;
  shortTitle: string;
  summary: string;
}

export interface IRunOpsTemplateLayer {
  id: string;
  title: string;
  summary: string;
}

export interface IRunOpsReadinessItem {
  id: TRunOpsReadinessId;
  title: string;
}

export interface IRunOpsTemplateBlueprint {
  id: string;
  title: string;
  categoryId: TRunOpsTemplateCategoryId;
  summary: string;
  fit: string;
  risk: TRunOpsTemplateRisk;
  scope: TRunOpsTemplateScope;
  trigger: string;
  status: TRunOpsTemplateStatus;
  dependencies: string[];
  readiness: TRunOpsReadinessId[];
  layers: IRunOpsTemplateLayer[];
  commentGuide: string;
}

export const RUN_OPS_TEMPLATE_CATEGORIES: readonly IRunOpsTemplateCategory[] = [
  {
    id: 'foundation',
    title: '基础骨架',
    shortTitle: '骨架',
    summary: '统一 strict mode、参数、日志、dry-run、锁与 trap。',
  },
  {
    id: 'probe',
    title: '巡检探活',
    shortTitle: '巡检',
    summary: '主机、HTTP、端口与指标导出，默认只读。',
  },
  {
    id: 'service',
    title: '服务自愈',
    shortTitle: '自愈',
    summary: 'systemd 探活、重启、回滚与告警闭环。',
  },
  {
    id: 'config',
    title: '配置变更',
    shortTitle: '配置',
    summary: '配置渲染、漂移检测、reload 与可撤销备份。',
  },
  {
    id: 'deploy',
    title: '发布部署',
    shortTitle: '部署',
    summary: '制品拉取、健康门禁、滚动批次与自动回滚。',
  },
  {
    id: 'backup',
    title: '数据备份',
    shortTitle: '备份',
    summary: '压缩、校验、保留策略与恢复演练。',
  },
  {
    id: 'security',
    title: '安全审计',
    shortTitle: '安全',
    summary: '证书、端口、权限、SSH key 与基线巡检。',
  },
  {
    id: 'fleet',
    title: '批量调度',
    shortTitle: '批量',
    summary: '多机 SSH、cron/timer、滚动执行与失败收敛。',
  },
] as const;


const BASE_LAYERS: readonly IRunOpsTemplateLayer[] = [
  { id: 'L0', title: 'Meta / Safety', summary: '先收紧运行边界，失败必须可见。' },
  { id: 'L1', title: 'Bootstrap', summary: '解析路径、加载配置、建立默认值。' },
  { id: 'L2', title: 'Validate', summary: '校验依赖、权限、参数与输入形态。' },
  { id: 'L3', title: 'Domain', summary: '只放真实业务动作，避免混入流程控制。' },
  { id: 'L4', title: 'Control', summary: 'main、子命令、锁、重试与 dry-run。' },
  { id: 'L5', title: 'Observe', summary: '日志、退出码、通知与清理统一收口。' },
] as const;

const readonlyReadiness: TRunOpsReadinessId[] = [
  'safety',
  'idempotency',
  'observability',
  'controllability',
  'portability',
];

const writeReadiness: TRunOpsReadinessId[] = [
  'safety',
  'idempotency',
  'reversibility',
  'observability',
  'controllability',
  'portability',
];

const blueprint = (
  value: Omit<IRunOpsTemplateBlueprint, 'layers' | 'status'> & {
    layers?: readonly IRunOpsTemplateLayer[];
    status?: TRunOpsTemplateStatus;
  },
): IRunOpsTemplateBlueprint => ({
  ...value,
  status: value.status ?? 'planned',
  layers: [...(value.layers ?? BASE_LAYERS)],
});

export const RUN_OPS_TEMPLATE_BLUEPRINTS: readonly IRunOpsTemplateBlueprint[] = [
  blueprint({
    id: 'bash-production-skeleton',
    title: '生产级 Bash 骨架',
    categoryId: 'foundation',
    summary: '给所有运维脚本统一入口、日志、退出码和错误兜底。',
    fit: '新脚本起步、脚本库治理、团队规范统一。',
    risk: 'readonly',
    scope: 'local',
    trigger: '手动 / CI',
    dependencies: ['bash', 'coreutils'],
    readiness: readonlyReadiness,
    commentGuide: '每段注释只解释边界、失败策略和为什么统一收口。',
  }),
  blueprint({
    id: 'common-library',
    title: 'common.sh 函数库',
    categoryId: 'foundation',
    summary: '沉淀 log、die、run、retry、with_lock、notify 等通用能力。',
    fit: '多脚本复用、减少复制粘贴、统一可观测格式。',
    risk: 'readonly',
    scope: 'local',
    trigger: '被 source',
    dependencies: ['bash', 'flock', 'curl'],
    readiness: readonlyReadiness,
    commentGuide: '注释强调函数契约：输入、输出、失败是否中断主流程。',
  }),
  blueprint({
    id: 'host-inspection',
    title: '主机巡检报告',
    categoryId: 'probe',
    summary: '采集 CPU、内存、磁盘、inode、load、进程和句柄状态。',
    fit: '日常巡检、故障前置发现、值班交接摘要。',
    risk: 'readonly',
    scope: 'local',
    trigger: 'Cron / 手动',
    dependencies: ['df', 'free', 'ps', 'awk'],
    readiness: readonlyReadiness,
    commentGuide: '注释说明每个阈值代表的故障信号，避免魔法数字。',
  }),
  blueprint({
    id: 'http-synthetic-probe',
    title: 'HTTP 业务拨测',
    categoryId: 'probe',
    summary: '从用户视角探测端点延迟、状态码和关键响应内容。',
    fit: '业务探活、监控 UserParameter、Prometheus textfile。',
    risk: 'readonly',
    scope: 'remote',
    trigger: 'Cron / 监控',
    dependencies: ['curl', 'awk'],
    readiness: readonlyReadiness,
    commentGuide: '注释交代超时、重试和状态码如何映射告警。',
  }),
  blueprint({
    id: 'systemd-service-guard',
    title: 'systemd 服务守护',
    categoryId: 'service',
    summary: '探活失败后重启服务；仍失败则回滚配置并通知值班。',
    fit: 'nginx、api-server、worker 等长驻服务自愈。',
    risk: 'write',
    scope: 'local',
    trigger: 'Cron / Timer',
    dependencies: ['systemctl', 'curl', 'flock'],
    readiness: writeReadiness,
    commentGuide: '注释围绕探活、重启、回滚三段，说明每次改变系统状态的理由。',
  }),
  blueprint({
    id: 'config-render-reload',
    title: '配置渲染与热加载',
    categoryId: 'config',
    summary: '渲染配置到临时文件，校验通过后原子替换并 reload。',
    fit: 'nginx、systemd unit、应用 env 文件下发。',
    risk: 'write',
    scope: 'local',
    trigger: '手动 / CI',
    dependencies: ['mktemp', 'cmp', 'systemctl'],
    readiness: writeReadiness,
    commentGuide: '注释突出“先写临时文件再替换”，解释如何降低半写入风险。',
  }),
  blueprint({
    id: 'artifact-rollout',
    title: '制品滚动发布',
    categoryId: 'deploy',
    summary: '拉取制品、校验版本、分批切换、健康门禁失败回滚。',
    fit: '单机多实例、小集群滚动部署、CI 触发发布。',
    risk: 'write',
    scope: 'fleet',
    trigger: 'CI / 手动',
    dependencies: ['curl', 'tar', 'systemctl', 'ssh'],
    readiness: writeReadiness,
    commentGuide: '注释每个门禁条件，尤其说明什么时候停止后续批次。',
  }),
  blueprint({
    id: 'directory-backup-retention',
    title: '目录备份与保留策略',
    categoryId: 'backup',
    summary: '打包目录、生成校验和、按保留天数清理旧备份。',
    fit: '小型文件备份、配置仓库快照、上线前留证。',
    risk: 'write',
    scope: 'local',
    trigger: 'Cron / 手动',
    dependencies: ['tar', 'sha256sum', 'find'],
    readiness: writeReadiness,
    commentGuide: '注释备份边界、校验原因和清理策略，避免误删。',
  }),
  blueprint({
    id: 'restore-drill',
    title: '恢复演练校验',
    categoryId: 'backup',
    summary: '把备份恢复到沙箱目录，校验文件数量、校验和和关键样本。',
    fit: '定期恢复演练、RTO/RPO 记录、备份有效性审计。',
    risk: 'write',
    scope: 'local',
    trigger: 'Timer / 手动',
    dependencies: ['tar', 'sha256sum', 'mktemp'],
    readiness: writeReadiness,
    commentGuide: '注释说明为什么恢复到隔离目录，避免演练污染生产路径。',
  }),
  blueprint({
    id: 'certificate-expiry-audit',
    title: '证书到期巡检',
    categoryId: 'security',
    summary: '扫描证书剩余天数，按阈值输出告警并可发送通知。',
    fit: 'TLS 证书轮换前预警、网关和内部服务证书审计。',
    risk: 'readonly',
    scope: 'remote',
    trigger: 'Cron / 监控',
    dependencies: ['openssl', 'date'],
    readiness: readonlyReadiness,
    commentGuide: '注释阈值来源和时间计算方式，避免时区误判。',
  }),
  blueprint({
    id: 'ssh-permission-audit',
    title: 'SSH 权限审计',
    categoryId: 'security',
    summary: '检查用户、authorized_keys、sudoers 和敏感文件权限。',
    fit: '基线巡检、离职账号清理、异常登录排查。',
    risk: 'readonly',
    scope: 'local',
    trigger: 'Cron / 手动',
    dependencies: ['stat', 'awk', 'find'],
    readiness: readonlyReadiness,
    commentGuide: '注释每条检查对应的安全风险，不只写检查命令。',
  }),
  blueprint({
    id: 'fleet-rolling-ssh',
    title: '多机滚动执行',
    categoryId: 'fleet',
    summary: '按批次通过 SSH 执行命令，限制并发，收敛失败结果。',
    fit: '批量巡检、灰度变更、跨机器执行一次性任务。',
    risk: 'write',
    scope: 'fleet',
    trigger: '手动 / 编排',
    dependencies: ['ssh', 'xargs', 'flock'],
    readiness: writeReadiness,
    commentGuide: '注释批次、超时、失败继续或中止策略，避免误伤整组机器。',
  }),
] as const;

