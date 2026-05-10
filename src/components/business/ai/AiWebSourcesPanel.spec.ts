import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';

import AiWebSourcesPanel from '@/components/business/ai/AiWebSourcesPanel.vue';
import type { IAiWebSourceEntry } from '@/types/ai';

const createSource = (overrides: Partial<IAiWebSourceEntry> = {}): IAiWebSourceEntry => ({
  id: 'web-source-1',
  query: 'Tauri docs',
  status: 'search-result',
  result: {
    title: 'Tauri Docs',
    url: 'https://tauri.app/start/',
    snippet: 'Tauri official docs',
    sourceType: 'docs',
    fetchedAt: '2026-04-29T10:00:00.000Z',
  },
  ...overrides,
});

const mountPanel = (overrides: Partial<InstanceType<typeof AiWebSourcesPanel>['$props']> = {}) =>
  mount(AiWebSourcesPanel, {
    props: {
      sources: [],
      activity: null,
      errorMessage: '',
      isSearching: false,
      networkPermission: 'allowed-this-run',
      ...overrides,
    },
  });

describe('AiWebSourcesPanel', () => {
  it('提交搜索 query 时向外抛出 search 事件', async () => {
    const wrapper = mountPanel();

    await wrapper.find('input[type="search"]').setValue('Tauri capability docs');
    await wrapper.find('form').trigger('submit');

    expect(wrapper.emitted('search')).toEqual([
      ['Tauri capability docs'],
    ]);
  });

  it('展示搜索来源并支持读取网页', async () => {
    const wrapper = mountPanel({
      sources: [createSource({ stepTitle: '检索官方文档' })],
    });

    expect(wrapper.text()).toContain('Tauri Docs');
    expect(wrapper.text()).toContain('tauri.app');
    expect(wrapper.text()).toContain('检索官方文档');

    await wrapper.find('.ai-web-source-action').trigger('click');

    expect(wrapper.emitted('fetchSource')).toEqual([
      ['web-source-1'],
    ]);
  });

  it('单个网页读取失败时在来源卡片内展示局部错误', () => {
    const wrapper = mountPanel({
      sources: [
        createSource({
          status: 'failed',
          errorMessage: '网页读取超时。',
        }),
      ],
    });

    expect(wrapper.text()).toContain('网页读取失败');
    expect(wrapper.text()).toContain('网页读取超时。');
  });

  it('网络未授权时展示提示并渲染活动状态', () => {
    const wrapper = mountPanel({
      networkPermission: 'ask',
      activity: {
        id: 'activity-1',
        state: 'searching',
        label: '正在搜索…',
        queryPreview: 'Tauri docs',
      },
    });

    expect(wrapper.text()).toContain('Network');
    expect(wrapper.text()).toContain('正在搜索');
    expect(wrapper.find('.ai-web-activity-spinner').exists()).toBe(true);
  });
});
