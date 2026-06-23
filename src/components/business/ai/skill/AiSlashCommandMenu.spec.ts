import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AiSlashCommandMenu from '@/components/business/ai/skill/AiSlashCommandMenu.vue';
import type { IAcpAvailableCommand } from '@/types/ai/sidecar';
import type { ISkillSummary } from '@/types/ai/skill';

const anchorRect = { left: 0, top: 200, width: 320 };

const buildSkill = (slug: string, name: string): ISkillSummary => ({
  slug,
  name,
  description: name + ' 描述',
  updatedAtMs: 0,
});

const buildCommand = (name: string, description: string): IAcpAvailableCommand => ({
  name,
  description,
});

const mountMenu = (props: Record<string, unknown>) =>
  mount(AiSlashCommandMenu, {
    props: { open: true, query: '', skills: [], anchorRect, ...props },
    global: { stubs: { teleport: true } },
  });

describe('AiSlashCommandMenu', () => {
  it('acp 模式渲染会话命令且不显示「即将推出」徽标', () => {
    const wrapper = mountMenu({
      acp: true,
      commands: [buildCommand('compact', '压缩上下文'), buildCommand('status', '查看状态')],
    });

    expect(wrapper.findAll('.slash-item')).toHaveLength(2);
    expect(wrapper.text()).toContain('compact');
    expect(wrapper.text()).not.toContain('即将推出');
  });

  it('acp 模式点击命令派发 select-command', async () => {
    const wrapper = mountMenu({
      acp: true,
      commands: [buildCommand('compact', '压缩上下文')],
    });

    await wrapper.get('.slash-item').trigger('click');

    expect(wrapper.emitted('select-command')?.[0]).toEqual(['compact']);
  });

  it('acp 模式按查询过滤命令', () => {
    const wrapper = mountMenu({
      query: 'stat',
      acp: true,
      commands: [buildCommand('compact', '压缩上下文'), buildCommand('status', '查看状态')],
    });

    expect(wrapper.findAll('.slash-item')).toHaveLength(1);
    expect(wrapper.text()).toContain('status');
    expect(wrapper.text()).not.toContain('compact');
  });

  it('acp 模式无可用命令时显示空态提示', () => {
    const wrapper = mountMenu({ acp: true, commands: [] });

    expect(wrapper.find('.slash-empty').text()).toContain('会话开始后将出现可用命令');
  });

  it('builtin 模式点击技能派发 select-skill', async () => {
    const wrapper = mountMenu({
      skills: [buildSkill('demo', '演示技能')],
      acp: false,
    });

    const enabledItems = wrapper
      .findAll('.slash-item')
      .filter((item) => item.attributes('disabled') === undefined);
    await enabledItems[enabledItems.length - 1].trigger('click');

    expect(wrapper.emitted('select-skill')?.[0]).toEqual(['demo']);
  });
});
