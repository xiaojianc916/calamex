/**
 * AI 反向提问（ask_user / Human-in-the-Loop）前端契约。
 *
 * 与 agent-sidecar 侧的 suspend/resume 负载对齐：
 * - 挂起时下发 IAskUserRequest（1-5 个问题，每题 3-4 个选项，最后一项为自由填写）。
 * - 恢复时上抛 IAskUserResult（每题的选项 id 与可选自由文本）。
 */

export type TQuestionOptionKind = 'choice' | 'free-text';

/**
 * 单个选项。`kind: 'free-text'` 表示「给用户自由发挥」的填写项，
 * 它直接渲染在该选项长条上，不额外新增输入框。
 */
export interface IQuestionOption {
  id: string;
  label: string;
  description?: string;
  kind?: TQuestionOptionKind;
}

export interface IAskUserQuestion {
  id: string;
  prompt: string;
  /** true => 多选(checkbox)；false => 单选(radio)。 */
  multiple: boolean;
  /** 3-4 个选项，约定最后一项 kind 为 'free-text'。 */
  options: IQuestionOption[];
}

export interface IAskUserRequest {
  kind: 'user_question';
  /** 1-5 个问题。 */
  questions: IAskUserQuestion[];
}

export interface IQuestionAnswer {
  questionId: string;
  /** 已选择的选项 id（单选时长度为 0 或 1）。 */
  optionIds: string[];
  /** 自由填写文本（若有）。 */
  text?: string;
}

export interface IAskUserResult {
  answers: IQuestionAnswer[];
  /** 用户主动取消（Esc）时为 true。 */
  cancelled?: boolean;
}
