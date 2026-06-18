import { describe, expect, it } from 'vitest';
import {
  getAcpToolCallId,
  reduceAcpToolCall,
} from '@/components/business/ai/thread/projection/from-acp-tool-call';
import type { TAcpTo