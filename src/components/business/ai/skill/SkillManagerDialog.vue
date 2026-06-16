<script setup lang="ts">
import {
  ArrowLeft,
  BookOpen,
  Folder,
  LoaderCircle,
  Pencil,
  Plus,
  Save,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from '@lucide/vue';
import { computed, reactive, ref, watch } from 'vue';
import { skillsTauriService } from '@/services/tauri.skills';
import type { ISkillSummary } from '@/types/ai/skill';
import { toErrorMessage } from '@/utils/error/error';

type TDialogMode = 'list' | 'editor';

const props = defineProps<{
  open: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:open', value: boolean): void;
  (event: 'saved', slug: string): void;
}>();

const skills = ref<ISkillSummary[]>([]);
const rootPath = ref('');
const mode = ref<TDialogMode>('list');
const listLoading = ref(false);
const busy = ref(false);
const errorMessage = ref<string | null>(null);

// 当前编辑目标:null slug 表示新建。
const form = reactive<{ slug: string | null; name: string; description: string; content: string }>({
  slug: null,
  name: '',
  description: '',
  content: '',
});

const isCreating = computed(() => form.slug === null);

const editorTitle = computed(() => (isCreating.value ? '新建技能' : '编辑技能'));

const canSave = computed(
  () => form.name.trim().length > 0 && form.content.trim().length > 0 && !busy.value,
);

const requestClose = (): void => {
  if (busy.value) {
    return;
  }
  emit('update:open', false);
};

const loadSkills = async (): Promise<void> => {
  listLoading.value = true;
  errorMessage.value = null;
  try {
    const result = await skillsTauriService.listSkills();
    skills.value = result.skills;
    rootPath.value = result.rootPath;
  } catch (error) {
    errorMessage.value = toErrorMessage(error, '读取技能库失败');
  } finally {
    listLoading.value = false;
  }
};

const openCreate = (): void => {
  form.slug = null;
  form.name = '';
  form.description = '';
  form.content = '# 技能说明\n\n在此描述该技能的使用方式、触发条件与步骤。';
  errorMessage.value = null;
  mode.value = 'editor';
};

const openEditor = async (slug: string): Promise<void> => {
  busy.value = true;
  errorMessage.value = null;
  try {
    const detail = await skillsTauriService.readSkill(slug);
    form.slug = detail.slug;
    form.name = detail.name;
    form.description = detail.description;
    form.content = detail.content;
    mode.value = 'editor';
  } catch (error) {
    errorMessage.value = toErrorMessage(error, '读取技能内容失败');
  } finally {
    busy.value = false;
  }
};

const backToList = (): void => {
  if (busy.value) {
    return;
  }
  mode.value = 'list';
  errorMessage.value = null;
};

const saveSkill = async (): Promise<void> => {
  if (!canSave.value) {
    return;
  }
  busy.value = true;
  errorMessage.value = null;
  try {
    const saved = await skillsTauriService.saveSkill({
      slug: form.slug,
      name: form.name.trim(),
      description: form.description.trim(),
      content: form.content,
    });
    await loadSkills();
    emit('saved', saved.slug);
    mode.value = 'list';
  } catch (error) {
    errorMessage.value = toErrorMessage(error, '保存技能失败');
  } finally {
    busy.value = false;
  }
};

const deleteSkill = async (slug: string): Promise<void> => {
  busy.value = true;
  errorMessage.value = null;
  try {
    await skillsTauriService.deleteSkill({ slug });
    await loadSkills();
  } catch (error) {
    errorMessage.value = toErrorMessage(error, '删除技能失败');
  } finally {
    busy.value = false;
  }
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      mode.value = 'list';
      errorMessage.value = null;
      void loadSkills();
    }
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="skill-shell" @mousedown.self="requestClose">
      <div class="skill-dialog" role="dialog" aria-modal="true" aria-label="技能管理">
        <header class="skill-dialog__header">
          <div class="skill-dialog__heading">
            <BookOpen class="skill-dialog__heading-icon" aria-hidden="true" />
            <span>技能管理</span>
          </div>
          <button type="button" class="skill-icon-btn" aria-label="关闭" @click="requestClose">
            <X aria-hidden="true" />
          </button>
        </header>

        <p v-if="errorMessage" class="skill-error">
          <TriangleAlert aria-hidden="true" />
          <span v-text="errorMessage" />
        </p>

        <!-- 列表视图 -->
        <div v-if="mode === 'list'" class="skill-body">
          <div class="skill-toolbar">
            <p class="skill-root" :title="rootPath">
              <Folder aria-hidden="true" />
              全局技能库
            </p>
            <button type="button" class="skill-btn skill-btn--primary" @click="openCreate">
              <Plus aria-hidden="true" />
              新建技能
            </button>
          </div>

          <div class="skill-list">
            <p v-if="listLoading" class="skill-hint">
              <LoaderCircle class="skill-spin" aria-hidden="true" />
              加载中…
            </p>
            <p v-else-if="skills.length === 0" class="skill-hint">
              <Sparkles aria-hidden="true" />
              还没有技能,点击「新建技能」开始创建
            </p>
            <article
              v-for="skill in skills"
              v-else
              :key="skill.slug"
              class="skill-card"
              @click="openEditor(skill.slug)"
            >
              <div class="skill-card__main">
                <Sparkles class="skill-card__icon" aria-hidden="true" />
                <div class="skill-card__text">
                  <p class="skill-card__name" v-text="skill.name" />
                  <p class="skill-card__desc" v-text="skill.description" />
                </div>
              </div>
              <div class="skill-card__actions">
                <button
                  type="button"
                  class="skill-icon-btn"
                  aria-label="编辑"
                  @click.stop="openEditor(skill.slug)"
                >
                  <Pencil aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="skill-icon-btn skill-icon-btn--danger"
                  aria-label="删除"
                  :disabled="busy"
                  @click.stop="deleteSkill(skill.slug)"
                >
                  <Trash2 aria-hidden="true" />
                </button>
              </div>
            </article>
          </div>
        </div>

        <!-- 编辑 / 新建视图 -->
        <div v-else class="skill-body">
          <button type="button" class="skill-back" :disabled="busy" @click="backToList">
            <ArrowLeft aria-hidden="true" />
            返回列表
          </button>

          <div class="skill-form">
            <label class="skill-field">
              <span class="skill-field__label">名称</span>
              <input v-model="form.name" type="text" class="skill-input" placeholder="例如:邮件设计工程师" />
            </label>
            <label class="skill-field">
              <span class="skill-field__label">描述</span>
              <input
                v-model="form.description"
                type="text"
                class="skill-input"
                placeholder="一句话说明这个技能做什么"
              />
            </label>
            <label class="skill-field skill-field--grow">
              <span class="skill-field__label">内容(SKILL.md)</span>
              <textarea v-model="form.content" class="skill-textarea" spellcheck="false" />
            </label>
          </div>
        </div>

        <footer v-if="mode === 'editor'" class="skill-dialog__footer">
          <span class="skill-footer-title" v-text="editorTitle" />
          <div class="skill-footer-actions">
            <button type="button" class="skill-btn" :disabled="busy" @click="backToList">取消</button>
            <button type="button" class="skill-btn skill-btn--primary" :disabled="!canSave" @click="saveSkill">
              <LoaderCircle class="skill-spin" v-if="busy" aria-hidden="true" />
              <Save v-else aria-hidden="true" />
              保存
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.skill-shell {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal, 50);
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgb(15 23 42 / 38%);
}

.skill-dialog {
  --surface: #ffffff;
  --line: #ececec;
  --text: #18181b;
  --muted: #71717a;
  --accent: #18181b;
  --danger: #dc2626;

  display: flex;
  flex-direction: column;
  width: min(420px, calc(100vw - 32px));
  height: min(560px, calc(100vh - 32px));
  background: #fafafa;
  border: 1px solid var(--line);
  border-radius: 16px;
  overflow: hidden;
  color: var(--text);
  box-shadow: 0 24px 60px rgb(15 23 42 / 24%);
}

.skill-dialog__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  background: var(--surface);
}

.skill-dialog__heading {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
}

.skill-dialog__heading-icon {
  width: 18px;
  height: 18px;
  color: var(--muted);
}

.skill-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  padding: 10px 16px;
  font-size: 12px;
  color: var(--danger);
  background: #fef2f2;
  border-bottom: 1px solid #fee2e2;
}

.skill-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  overflow-y: auto;
}

.skill-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.skill-root {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}

.skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 24px 8px;
  margin: 0;
  font-size: 13px;
  color: var(--muted);
  justify-content: center;
}

.skill-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 12px;
  background: var(--surface);
  cursor: pointer;
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.skill-card:hover {
  border-color: #d4d4d8;
  box-shadow: 0 4px 14px rgb(15 23 42 / 8%);
}

.skill-card__main {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.skill-card__icon {
  flex: none;
  width: 18px;
  height: 18px;
  color: var(--muted);
}

.skill-card__text {
  min-width: 0;
}

.skill-card__name {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-card__desc {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.skill-card__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.skill-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background 0.12s ease, color 0.12s ease;
}

.skill-icon-btn:hover {
  background: #f4f4f5;
  color: var(--text);
}

.skill-icon-btn--danger:hover {
  background: #fef2f2;
  color: var(--danger);
}

.skill-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.skill-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}

.skill-back:hover {
  background: #f4f4f5;
  color: var(--text);
}

.skill-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1 1 auto;
  min-height: 0;
}

.skill-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.skill-field--grow {
  flex: 1 1 auto;
  min-height: 0;
}

.skill-field__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
}

.skill-input {
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  outline: none;
  transition: border-color 0.12s ease;
}

.skill-input:focus {
  border-color: #a1a1aa;
}

.skill-textarea {
  flex: 1 1 auto;
  min-height: 160px;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  resize: none;
  outline: none;
  transition: border-color 0.12s ease;
}

.skill-textarea:focus {
  border-color: #a1a1aa;
}

.skill-dialog__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--line);
  background: var(--surface);
}

.skill-footer-title {
  font-size: 12px;
  color: var(--muted);
}

.skill-footer-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 34px;
  padding: 0 14px;
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.skill-btn:hover {
  background: #f4f4f5;
}

.skill-btn--primary {
  background: var(--accent);
  border-color: var(--accent);
  color: #ffffff;
}

.skill-btn--primary:hover {
  background: #27272a;
}

.skill-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.skill-spin {
  animation: skill-spin 0.8s linear infinite;
}

@keyframes skill-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
