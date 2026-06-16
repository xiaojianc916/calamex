export { default as CopilotKitProvider } from './provider/CopilotKitProvider.vue';
export type { ISidecarEventAdapter, ISidecarUiEvent } from './events/event-adapter';
export {
  convertSidecarUiEvent,
  createEventId,
  createRunErrorEvent,
  createRunFinishedEvent,
  createRunStartedEvent,
  createSidecarEventAdapter,
  createTerminalEvents,
  createTextMessageContentEvent,
  createTextMessageEndEvent,
  createTextMessageStartEvent,
  createToolCallArgsEvent,
  createToolCallEndEvent,
  createToolCallResultEvent,
  createToolCallStartEvent,
  defaultIdGenerator,
  toAguiMessage,
  toAguiMessages,
  toSidecarChatRequest,
} from './events/event-adapter';
export { SidecarAgent } from './agent/sidecar-agent';
