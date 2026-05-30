<script setup lang="ts">
import { type Component, computed, ref } from 'vue';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtSearchResult,
  ChainOfThoughtSearchResults,
  ChainOfThoughtStep,
} from '@/components/ai-elements/chain-of-thought';
import { Shimmer } from '@/components/ai-elements/shimmer';
import { Task, TaskContent, TaskItem } from '@/components/ai-elements/task';
import {
  Terminal as AiTerminal,
  TerminalActions,
  TerminalClearButton,
  TerminalContent,
  TerminalCopyButton,
  TerminalHeader,
  TerminalStatus,
  TerminalTitle,
} from '@/components/ai-elements/terminal';
import AiReasoningCodeBlock from '@/components/business/ai/chat/AiReasoningCodeBlock.vue';
import {
  classifyRuntimeToolKind,
  normalizeRuntimeToolName,
  type TAiRuntimeToolKind,
} from '@/constants/ai/runtime-tools';
import type { TAgentRuntimeEvent } from '@/types/ai/sidecar';
import Activity from '~icons/lucide/activity';
import BadgeCheck from '~icons/lucide/badge-check';
import BookOpen from '~icons/lucide/book-open';
import Brain from '~icons/lucide/brain';
import Bug from '~icons/lucide/bug';
import ChartColumn from '~icons/lucide/chart-column';
import ChevronRight from '~icons/lucide/chevron-right';
import CircleAlert from '~icons/lucide/circle-alert';
import Clock3 from '~icons/lucide/clock3';
import Coffee from '~icons/lucide/coffee';
import Dot from '~icons/lucide/dot';
import FileCode from '~icons/lucide/file-code';
import FileText from '~icons/lucide/file-text';
import Files from '~icons/lucide/files';
import FolderTree from '~icons/lucide/folder-tree';
import GitBranch from '~icons/lucide/git-branch';
import Globe from '~icons/lucide/globe';
import HardDrive from '~icons/lucide/hard-drive';
import ImageIcon from '~icons/lucide/image';
import ListTodo from '~icons/lucide/list-todo';
import ListTree from '~icons/lucide/list-tree';
import NotebookPen from '~icons/lucide/notebook-pen';
import