import { commands } from '@/bindings/tauri';
import type {
  IDeleteSkillPayload,
  IDeleteSkillRequest,
  ISaveSkillRequest,
  ISkillDetail,
  ISkillList,
} from '@/types/ai/skill';
import {
  deleteSkillPayloadSchema,
  saveSkillRequestSchema,
  skillDetailSchema,
  skillListSchema,
} from '@/types/ai/skill.schema';
import { callSpectaCommand } from './tauri.ipc-runtime';

/**
 * 技能库 IPC 服务。
 *
 * 遵循前端 I/O 唯一出口约定:所有读写都经由生成的 specta `commands`,
 * 并在返回值处用 Zod 复核,避免后端契约漂移悄悄进入 UI。
 *
 * 注意:`commands.{listSkills,readSkill,saveSkill,deleteSkill}` 由 specta 导出生成,
 * 需在后端新增命令后重新生成 `src/bindings/tauri.ts`。
 */
export interface ISkillsTauriService {
  listSkills(): Promise<ISkillList>;
  readSkill(slug: string): Promise<ISkillDetail>;
  saveSkill(payload: ISaveSkillRequest): Promise<ISkillDetail>;
  deleteSkill(payload: IDeleteSkillRequest): Promise<IDeleteSkillPayload>;
}

export const skillsTauriService: ISkillsTauriService = {
  listSkills() {
    return callSpectaCommand(
      {
        command: 'list_skills',
        guardHint: '读取技能库',
        idempotent: true,
        input: undefined,
      },
      async () => skillListSchema.parse(await commands.listSkills()),
    );
  },

  readSkill(slug) {
    return callSpectaCommand(
      {
        command: 'read_skill',
        guardHint: '读取技能内容',
        idempotent: true,
        input: { slug },
      },
      async () => skillDetailSchema.parse(await commands.readSkill(slug)),
    );
  },

  saveSkill(payload) {
    const request = saveSkillRequestSchema.parse(payload);
    return callSpectaCommand(
      {
        command: 'save_skill',
        guardHint: '保存技能',
        audit: 'sensitive',
        input: request,
      },
      async () => skillDetailSchema.parse(await commands.saveSkill(request)),
    );
  },

  deleteSkill(payload) {
    const request = { slug: payload.slug };
    return callSpectaCommand(
      {
        command: 'delete_skill',
        guardHint: '删除技能',
        audit: 'sensitive',
        input: request,
      },
      async () => deleteSkillPayloadSchema.parse(await commands.deleteSkill(request)),
    );
  },
};
