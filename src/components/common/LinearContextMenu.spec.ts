import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import LinearContextMenu from './LinearContextMenu.vue';

describe('LinearContextMenu', () => {
  it('selects items on pointerdown before editor blur can unmount the menu', async () => {
    const wrapper = mount(LinearContextMenu, {
      props: {
        open: true,
        x: 12,
        y: 16,
        theme: 'dark',
        submenuDirection: 'right',
        groups: [
          {
            key: 'clipboard',
            title: 'CLIPBOARD',
            items: [
              {
                key: 'copy',
                label: 'Copy',
                icon: 'copy',
              },
            ],
          },
        ],
      },
      attachTo: document.body,
    });

    await wrapper.vm.$nextTick();

    const button = document.body.querySelector('[data-slot="dropdown-menu-item"]');
    if (!(button instanceof HTMLElement)) {
      throw new Error('menu button was not rendered');
    }
    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    await wrapper.vm.$nextTick();

    expect(wrapper.emitted('select')?.[0]?.[0]).toMatchObject({ key: 'copy' });
    wrapper.unmount();
  });
});
