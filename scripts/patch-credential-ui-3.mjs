import { readFileSync, writeFileSync } from 'node:fs';

const PROVIDER = 'src/components/business/ai/provider/AiProviderSettings.vue';

function applyEdit(src, { find, replace, skip, label }) {
  if (skip && skip(src)) {
    console.log(`⏭  跳过(已应用):${label}`);
    return src;
  }
  const count = src.split(find).length - 1;
  if (count === 0) throw new Error(`❌ 未找到锚点:${label}(请确认本地已 git pull 最新 main)`);
  if (count > 1) throw new Error(`❌ 锚点不唯一(${count} 处):${label}`);
  console.log(`✅ ${label}`);
  return src.replace(find, replace);
}

function readNormalized(path) {
  const raw = readFileSync(path, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  return { src: raw.replace(/\r\n/g, '\n'), eol };
}
function writeWithEol(path, src, eol) {
  writeFileSync(path, eol === '\r\n' ? src.replace(/\n/g, '\r\n') : src, 'utf8');
}

let { src, eol } = readNormalized(PROVIDER);

/* ── 1) 引入生命周期 / nextTick ── */
src = applyEdit(src, {
  label: '导入 onMounted / onBeforeUnmount / nextTick',
  skip: (s) => s.includes('onBeforeUnmount'),
  find: `import { computed, ref, watch } from 'vue';`,
  replace: `import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';`,
});

/* ── 2) #4 + #5 的逻辑:dialogRef + 关闭/聚焦/焦点陷阱 处理 ── */
src = applyEdit(src, {
  label: '#4/#5 外点关闭 + Esc 关闭 + 初始聚焦 + 焦点陷阱(脚本)',
  skip: (s) => s.includes('handleOutsidePointerDown'),
  find: `const handleClose = (): void => {
  emit('close');
};

watch(
  () => props.open,`,
  replace: `const handleClose = (): void => {
  emit('close');
};

const dialogRef = ref<HTMLElement | null>(null);

const closeMenus = (): void => {
  isProviderMenuOpen.value = false;
  isSmallModelMenuOpen.value = false;
};

const collectFocusable = (): HTMLElement[] => {
  if (!dialogRef.value) {
    return [];
  }
  const selector =
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return Array.from(dialogRef.value.querySelectorAll<HTMLElement>(selector)).filter(
    (element) => element.offsetParent !== null,
  );
};

const focusFirstElement = (): void => {
  const focusables = collectFocusable();
  (focusables[0] ?? dialogRef.value)?.focus();
};

// #4 点击 combobox 之外的任意位置时收起已展开的下拉;点在 combobox 内部交由其自身处理。
const handleOutsidePointerDown = (event: PointerEvent): void => {
  if (!props.open || (!isProviderMenuOpen.value && !isSmallModelMenuOpen.value)) {
    return;
  }
  const target = event.target as Element | null;
  if (target?.closest('.ai-credential-combobox')) {
    return;
  }
  closeMenus();
};

// #5 Esc 关闭(下拉优先于弹窗);Tab / Shift+Tab 在弹窗内循环,形成焦点陷阱。
const handleDialogKeydown = (event: KeyboardEvent): void => {
  if (!props.open) {
    return;
  }

  if (event.key === 'Escape') {
    if (isProviderMenuOpen.value || isSmallModelMenuOpen.value) {
      closeMenus();
    } else {
      handleClose();
    }
    event.stopPropagation();
    return;
  }

  if (event.key !== 'Tab') {
    return;
  }

  const focusables = collectFocusable();
  if (focusables.length === 0) {
    return;
  }

  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inDialog = dialogRef.value?.contains(active) ?? false;

  if (!inDialog) {
    event.preventDefault();
    first.focus();
    return;
  }
  if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      void nextTick(focusFirstElement);
    }
  },
);

onMounted(() => {
  document.addEventListener('pointerdown', handleOutsidePointerDown, true);
  document.addEventListener('keydown', handleDialogKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleOutsidePointerDown, true);
  document.removeEventListener('keydown', handleDialogKeydown);
});

watch(
  () => props.open,`,
});

/* ── 3) 模板:给弹窗 section 加 ref + tabindex(供初始聚焦/焦点陷阱兜底) ── */
src = applyEdit(src, {
  label: '弹窗 section 加 ref="dialogRef" + tabindex="-1"(模板)',
  skip: (s) => s.includes('ref="dialogRef"'),
  find: `      <section class="ai-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-credential-title">`,
  replace: `      <section ref="dialogRef" class="ai-credential-dialog" role="dialog" aria-modal="true" aria-labelledby="ai-credential-title" tabindex="-1">`,
});

writeWithEol(PROVIDER, src, eol);
console.log('\n🎉 完成。请运行 typecheck / lint 并自测。');
