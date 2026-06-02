import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useShellWorkbenchAiBridge } from '@/composables/useShellWorkbenchAiBridge';
import { useShellWorkbenchViewportState } from '@/composables/useShellWorkbenchViewportState';
import { useWorkbench } from '@/composables/useWorkbench';
import { useGitStore } from '@/store/git';
import type { TWorkbenchPrimaryMode, TWorkbenchSidebarView } from '@/types/app';
import type {
  IAnalyzeScriptPayload,
  ICommandTemplate,
  IEditorSelectionSummary,
  IWorkspaceDirectoryPayload,
} from '@/types/editor';
import type { ITerminalRunCompletedPayload } from '@/types/terminal';
import { waitForDesktopRuntime } from '@/utils/desktop-runtime';
import { markStartup } from '@/utils/startup-profiler';
import { createStartupShellState } from '@/utils/startup-shell';
import { consumeProgrammaticWindowCloseAllowance } from '@/utils/