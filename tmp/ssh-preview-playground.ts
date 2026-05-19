import '@/assets/fonts/inter/inter.css';
import '@/assets/css/tailwind.css';
import { getThemeManager } from '@/themes';
import SshFilePreviewDialog from '@/components/workbench/SshFilePreviewDialog.vue';
import type { ISshFileItem } from '@/types/ssh';
import type { ISshFileReadPayload } from '@/types/tauri';
import { Toaster } from 'vue-sonner';
import { createApp, defineComponent, h, ref } from 'vue';

getThemeManager().init();

const initialPayload: ISshFileReadPayload = {
  remotePath: '/root/test.sh',
  content: [
    '#!/bin/bash',
    'set -o pipefail',
    '# === Bash 精华演示（50行）===',
    'echo "=== $0 参数:$# 首参:${1:-无} ==="',
    'fruits=(苹果 香蕉 桃子)',
    'echo "数组:${fruits[*]}(${#fruits[@]})"',
    'str="Hello World"',
    'echo "大写:${str^^} 替换:${str/World/Bash}"',
    'for i in 1 2 3; do',
    '  echo "for:$i"',
    'done',
    'declare -A map=([name]=Tom [city]=北京)',
    'echo "map:${map[name]}"',
    "cat <<'EOF' >/dev/null",
    '多行文本 不展开$变量',
    'EOF',
  ].join('\n'),
  byteSize: 336,
  encoding: 'utf-8',
  lineCount: 15,
  lineEnding: 'lf',
  permission: '-rwxr-xr-x',
  owner: 'root:root',
  modifiedAt: '2026-05-18T04:48:00Z',
};

const previewFileItem: ISshFileItem = {
  id: '/root/test.sh',
  name: 'test.sh',
  kind: 'file',
  metaLabel: '336 B',
  path: '/root/test.sh',
  isDirectory: false,
};

const App = defineComponent({
  setup() {
    const visible = ref(true);
    const loading = ref(false);
    const saving = ref(false);
    const payload = ref<ISshFileReadPayload | null>(initialPayload);

    const handleReload = async () => {
      loading.value = true;
      await new Promise((resolve) => window.setTimeout(resolve, 320));
      payload.value = {
        ...(payload.value ?? initialPayload),
        modifiedAt: new Date().toISOString(),
      };
      loading.value = false;
    };

    const handleSave = async (content: string) => {
      saving.value = true;
      await new Promise((resolve) => window.setTimeout(resolve, 420));
      payload.value = {
        ...(payload.value ?? initialPayload),
        content,
        byteSize: new TextEncoder().encode(content).length,
        lineCount: content.split('\n').length,
        modifiedAt: new Date().toISOString(),
      };
      saving.value = false;
    };

    const handleDownload = () => {
      const content = payload.value?.content ?? '';
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = previewFileItem.name;
      anchor.click();
      window.URL.revokeObjectURL(url);
    };

    return () =>
      h('div', { class: 'min-h-screen bg-[var(--background)] text-[var(--text-primary)]' }, [
        h('div', {
          class: 'fixed inset-0 bg-[radial-gradient(circle_at_top_left,_color-mix(in_srgb,var(--accent-strong)_10%,transparent),transparent_32%),radial-gradient(circle_at_bottom_right,_color-mix(in_srgb,var(--success)_8%,transparent),transparent_28%)]',
        }),
        h(Toaster, {
          closeButton: true,
          richColors: true,
          position: 'bottom-center',
        }),
        visible.value
          ? h(SshFilePreviewDialog, {
              fileItem: previewFileItem,
              payload: payload.value,
              isLoading: loading.value,
              isSaving: saving.value,
              onClose: () => {
                visible.value = false;
              },
              onReload: handleReload,
              onDownload: handleDownload,
              onSave: handleSave,
            })
          : null,
      ]);
  },
});

createApp(App).mount('#app');
