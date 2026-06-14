/**
 * AI 反向提问（ask_user / Human-in-the-Loop）前端契约。
 *
 * 取长补短，同时参照两套成熟实现：
 * - ACP `session/request_permission`（agentclientprotocol.com/protocol/tool-calls）：
 *   贡献协议级握手与「结果」形态 —— 判别式联合 outcome: 'selected' | 'cancelled'，
 *   且每个选项带稳定 optionId（与本仓库 acp/approval-bridge.ts 的
 *   allow-once / reject-once 同源），便于复用既有 ACP 链路语义。
 * - Gemini CLI `ask_user`（google-gemini/gemini-cli,
 *   packages/core/src/tools/ask-user.ts）：贡献问题结构 —— 1-4 题，每题
 *   header(≤16 字符 chip) + question + type；choice 型带 2-4 个
 *   {label, description} 选项、可 multiSelect；自由填写不是数组里的假选项，
 *   而是每题内置的「Other」输入框（由 placeholder 提示）。
 *
 * 与 agent-sidecar 侧 suspend/resume 负载严格对齐：
 * - 挂起(suspend) 下发 IAskUserRequest。
 * - 恢复(resume) 上抛 IAskUserResult。
 */

/** Gemini ask_user 的问题类型（QuestionType）。 */
export type TQuestionType = 'choice' | 'text' | 'yesno';

/** ACP RequestPermissionOutcome 的判别值。 */
export type TAskUserOutcome = 'selected' | 'cancelled';

/**
 * 单个候选项。
 * - `optionId` 取自 ACP PermissionOption.optionId：稳定标识，原样回传到答案。
 * - `label` / `description` 取自 Gemini QuestionOption：label 为 1-5 词短标签，
 *   description 为简短补充说明。
 */
export interface IQuestionOption {
  optionId: string;
  label: string;
  description?: string;
}

export interface IAskUserQuestion {
  /** 稳定标识，原样回传到对应答案的 questionId。 */
  questionId: string;
  /** 完整问题文本（Gemini: question）。 */
  question: string;
  /** ≤16 字符的 chip 短标签（Gemini: header）。 */
  header: string;
  /** choice（默认）| text | yesno（Gemini: type）。 */
  type: TQuestionType;
  /** choice 型必填，2-4 项；text / yesno 型忽略（Gemini: options）。 */
  options?: IQuestionOption[];
  /** 仅 choice 型有效：true => 多选(checkbox)；否则单选(radio)（Gemini: multiSelect）。 */
  multiSelect?: boolean;
  /**
   * 自由填写输入框的占位提示（Gemini: placeholder）。
   * - text 型：作为唯一输入框的提示。
   * - choice / yesno 型：作为选项列表底部「Other」输入框的提示。
   */
  placeholder?: string;
}

export interface IAskUserRequest {
  kind: 'user_question';
  /** 1-4 个问题（对齐 Gemini ask_user 上限）。 */
  questions: IAskUserQuestion[];
}

/** 单题作答。 */
export interface IQuestionAnswer {
  questionId: string;
  /** 已选 optionId（单选时 0-1 个；text 型恒为空）。 */
  optionIds: string[];
  /** 自由填写文本：text 型答案，或 choice/yesno 的「Other」输入（无则省略）。 */
  text?: string;
}

/**
 * 恢复(resume) 时上抛的结果，形态对齐 ACP RequestPermissionOutcome：
 * - outcome: 'cancelled'（用户 Esc / 当前回合被取消）=> answers 省略。
 * - outcome: 'selected' => answers 为每题作答。
 */
export interface IAskUserResult {
  outcome: TAskUserOutcome;
  answers?: IQuestionAnswer[];
}
