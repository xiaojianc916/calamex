import { shallowRef } from 'vue';
import type { IAiContextReference } from '@/types/ai';
import type { ISkillSummary } from '@/types/ai/skill';

// ---------------------------------------------------------------------------
// Skill selection (extracted from useAiAssistant.ts)
//
// 用户在输入框用 / 选中的技能。每个技能转成一个 kind:'skill' 的上下文引用：
// - path 存 slug；
// - contentPreview 存一句"调用指令"(不含 SKILL.md 正文)，
//   由 sidecar 的 buildContextSection 渲染成让 agent 自己 skill_read 的指令。
// ---------------------------------------------------------------------------

export interface IAiSelectedSkill {
  slug: string;
  name: string;
}

const SKILL_REFERENCE_ID_PREFIX = 'skill:';

const normalizeSkillName = (skill: ISkillSummary): string => skill.name.trim() || skill.slug;

const buildSkillDirective = (skill: IAiSelectedSkill): string =>
  `用户显式调用技能「${skill.name}」（slug：${skill.slug}）。请先用 skill_read 按该 slug 读取技能正文，再据此执行；不要凭名称臆测内容。`;

export const useAiAssistantSkills = () => {
  const selectedSkills = shallowRef<IAiSelectedSkill[]>([]);

  const hasSkill = (slug: string): boolean =>
    selectedSkills.value.some((item) => item.slug === slug);

  const toggleSkill = (skill: ISkillSummary): void => {
    if (hasSkill(skill.slug)) {
      selectedSkills.value = selectedSkills.value.filter((item) => item.slug !== skill.slug);
      return;
    }

    selectedSkills.value = [
      ...selectedSkills.value,
      { slug: skill.slug, name: normalizeSkillName(skill) },
    ];
  };

  const removeSkill = (slug: string): void => {
    selectedSkills.value = selectedSkills.value.filter((item) => item.slug !== slug);
  };

  const clearSkills = (): void => {
    selectedSkills.value = [];
  };

  const buildSkillReferences = (): IAiContextReference[] =>
    selectedSkills.value.map((skill) => ({
      id: `${SKILL_REFERENCE_ID_PREFIX}${skill.slug}`,
      kind: 'skill',
      label: `技能 · ${skill.name}`,
      path: skill.slug,
      range: null,
      contentPreview: buildSkillDirective(skill),
      redacted: false,
    }));

  return {
    selectedSkills,
    hasSkill,
    toggleSkill,
    removeSkill,
    clearSkills,
    buildSkillReferences,
  };
};
