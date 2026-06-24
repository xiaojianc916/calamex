import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import AiPromptInput from '@/components/business/ai/chat/AiPromptInput.vue';
import { pickAttachmentFilesViaNativeDialog } from '@/components/business/ai/chat/attachment-file-picker';
import type { IAiTokenContextProps } from '@/composables/ai/useAiTokenContext';
import { createDefaultAiConfigPayload } from '@/services/ipc/ai-config.service';
import type { IAcpSessionConfigOptionsState } from '@/types/ai/sidecar';

vi.mock('@/components/business/ai/chat/attachment-file-picker', () => ({
  pickAttachmentFilesViaNativeDialog: vi.fn(() => Promise.resolve([])),
}));

interface IAiPromptInputTestAttachment {
  id: string;
  name: string;
  sizeLabel: string;
  kind: 'text' | 'image';
  status?: 'processing' | 'ready' | 'failed';
  errorMessage?: string;
  detailLabel?: string;
  preview?: {
    src: string;
    width: number | null;
    height: number | null;
    mimeType: string;
  };
}

interface IAiPromptInputTestProps {
  modelValue: string;
  disabled: boolean;
  errorMessage: string;
  submitLabel: string;
  activeMode: 'chat' | 'agent' | 'plan';
  attachments: IAiPromptInputTestAttachment[];
  hasAttachments: boolean;
  config: ReturnType<typeof createDefaultAiConfigPayload>;
  networkPermission: 'ask' | 'allowed-this-run' | 'denied';
  executionMode: 'interactive' | 'autonomous';
  tokenContext?: IAiTokenContextProps;
  agentBackend?: 'builtin' | 'kimi';
  sessionConfigOptions?: IAcpSessionConfigOptionsState | null;
  isSessionConfigOptionSwitching?: boolean;
  resolveAttachment: (file: File) => Promise<boolean>;
  'onUpdate:modelValue': (value: string) => void;
}

const mountPromptInput = (overrides: Partial<IAiPromptInputTestProps> = {}) =>
  mount(AiPromptInput, {
    props: {
      modelValue: '',
      disabled: false,
      errorMessage: '',
      submitLabel: '\u53d1\u9001',
      activeMode: 'agent',
      attachments: [],
      hasA