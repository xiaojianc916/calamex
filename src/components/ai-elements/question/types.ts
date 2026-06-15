/**
 * AI 反向提问（ask_user / Human-in-the-Loop）组件层契约。
 *
 * 单一来源（single source of truth）位于 `@/types/ai/sidecar`，那里镜像
 * agent-sidecar `schemas/events.ts` 的 askUser* wire schema，与 `TAgentUiEvent`
 * 的 `ask_user_required` 事件及恢复请求类型同居一处。
 *
 * 本文件仅作为组件层的 re-export barrel，让 QuestionPrompt.vue 与
 * question/index.ts 保持 `./types` 导入路径不变，同时避免重复定义（无新旧杂糅）。
 *
 * 设计取长补短（详细注记见 sidecar.ts 的 Ask-user 小节）：
 * - 结果形态 outcome: 'selected' | 'cancelled' + 稳定 optionId 取自 ACP
 *   `session/request_permission`；
 * - 问题结构 header / question / type / options / multiSelect / placeholder 取自
 *   Gemini CLI `ask_user`。
 */

export type {
  IAskUserQuestion,
  IAskUserRequest,
  IAskUserResult,
  IQuestionAnswer,
  IQuestionOption,
  TAskUserOutcome,
  TQuestionType,
} from '@/types/ai/sidecar';
