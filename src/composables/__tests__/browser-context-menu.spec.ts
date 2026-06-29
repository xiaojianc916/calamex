import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type ComponentPublicInstance, defineComponent } from 'vue';
import type { ILinearContextMenuItem } from '@/components/common/linear-context-menu.types';
import { useBrowserContextMenu } from '../useBrowserContextMenu';

type TBrowserContextMenuApi = ReturnType<typeof useBrowserContextMenu>;

const mockTerminalControls = vi.hoisted(() => ({
  getSelectionText: vi.fn<[], string>(() => ''),
  copySelection: vi.fn<[], Promise<void>>(async () => {}),
  pasteFromClipboard: vi.fn<[], Promise<void>>(async () => {}),
  selectAll: vi.fn<[], void>(() => {}),
}));

const mockClipboard = vi.hoisted(() => ({
  tryReadClipboardText: vi.fn<[], Promise<string | null>>(async () => null),
  tryWriteClipboardText: vi.fn<[string], Promise<boolean>>(async () => true),
  writeClipboardText: vi.fn<[string], Promise<void>>(async () => {}),
}));

vi.mock('@/domains/terminal/composables/useIntegratedTerminal', () => ({
  useIntegratedTerminalControls: () => mockTerminalControls,
}));

vi.mock('@/utils/platform/clipboard', () => mockClipboard);
vi.mock('@/utils/platform/browser', () => ({
  openExternalUrl: vi.fn(),
}));

interface IMountedContextMenu {
  api: TBrowserContextMenuApi;
  wrapper: VueWrapper<ComponentPublicInstance>;
}

const mountContextMenu = (): IMountedContextMenu => {
  let api: TBrowserContextMenuApi | null = null;
  const wrapper = mount(
    defineComponent({
      setup() {
        api = useBrowserContextMenu();
        return () => null;
      },
    }),
  );

  if (api === null) {
    throw new Error('context menu host failed to initialize');
  }

  return { api, wrapper };
};

const createTerminalSurface = (): HTMLElement => {
  const host = document.createElement('div');
  host.className = 'embedded-terminal-host';
  document.body.appendChild(host);
  return host;
};

const dispatchContextMenu = (target: HTMLElement): MouseEvent => {
  const event = new MouseEvent('contextmenu', {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 32,
  });
  target.dispatchEvent(event);
  return event;
};

const findMenuItem = (api: TBrowserContextMenuApi, key: string): ILinearContextMenuItem => {
  const item = api.contextMenuGroups.value
    .flatMap((group) => group.items)
    .find((candidate) => candidate.key === key);
  if (!item) {
    throw new Error(`missing menu item: ${key}`);
  }
  return item;
};

describe('useBrowserContextMenu', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mockTerminalControls.getSelectionText.mockReturnValue('');
    mockClipboard.tryReadClipboardText.mockResolvedValue(null);
    mockClipboard.tryWriteClipboardText.mockResolvedValue(true);
  });

  it('空白区域不会再弹出全局剪贴板菜单', () => {
    const surface = document.createElement('div');
    document.body.appendChild(surface);
    const { api, wrapper } = mountContextMenu();

    const event = dispatchContextMenu(surface);

    expect(event.defaultPrevented).toBe(true);
    expect(api.contextMenuState.open).toBe(false);
    expect(api.contextMenuGroups.value).toEqual([]);

    wrapper.unmount();
  });

  it('terminal context menu opens menu instead of direct paste', async () => {
    mockTerminalControls.getSelectionText.mockReturnValue('selected text');
    const surface = createTerminalSurface();
    const { api, wrapper } = mountContextMenu();

    const event = dispatchContextMenu(surface);
    await flushPromises();

    expect(event.defaultPrevented).toBe(true);
    expect(api.contextMenuState.open).toBe(true);
    expect(mockTerminalControls.getSelectionText).toHaveBeenCalled();
    expect(mockTerminalControls.pasteFromClipboard).not.toHaveBeenCalled();

    const terminalGroup = api.contextMenuGroups.value.find(
      (group) => group.key === 'terminal-clipboard',
    );
    expect(terminalGroup?.items.map((item) => item.key)).toEqual(['copy', 'paste', 'select-all']);
    expect(terminalGroup?.items[0]?.disabled).toBe(false);

    wrapper.unmount();
  });

  it('terminal menu items execute copy paste and select all', async () => {
    mockTerminalControls.getSelectionText.mockReturnValue('selected text');
    const surface = createTerminalSurface();
    const { api, wrapper } = mountContextMenu();

    dispatchContextMenu(surface);
    await flushPromises();
    await api.executeContextMenuItem(findMenuItem(api, 'copy'));
    expect(mockTerminalControls.copySelection).toHaveBeenCalledTimes(1);

    dispatchContextMenu(surface);
    await flushPromises();
    await api.executeContextMenuItem(findMenuItem(api, 'paste'));
    expect(mockTerminalControls.pasteFromClipboard).toHaveBeenCalledTimes(1);

    dispatchContextMenu(surface);
    await flushPromises();
    await api.executeContextMenuItem(findMenuItem(api, 'select-all'));
    await flushPromises();
    expect(mockTerminalControls.selectAll).toHaveBeenCalledTimes(1);

    wrapper.unmount();
  });

  it('global input menu uses the selection captured when the menu opened', async () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = 'abcdef';
    document.body.appendChild(input);
    const { api, wrapper } = mountContextMenu();

    input.setSelectionRange(1, 4);
    dispatchContextMenu(input);
    await api.executeContextMenuItem(findMenuItem(api, 'copy'));
    expect(mockClipboard.tryWriteClipboardText).toHaveBeenLastCalledWith('bcd');

    input.value = 'abcdef';
    input.setSelectionRange(1, 4);
    dispatchContextMenu(input);
    await api.executeContextMenuItem(findMenuItem(api, 'cut'));
    expect(mockClipboard.tryWriteClipboardText).toHaveBeenLastCalledWith('bcd');
    expect(input.value).toBe('aef');

    input.value = 'abcdef';
    input.setSelectionRange(2, 4);
    mockClipboard.tryReadClipboardText.mockResolvedValue('ZZ');
    dispatchContextMenu(input);
    await api.executeContextMenuItem(findMenuItem(api, 'paste'));
    expect(input.value).toBe('abZZef');

    wrapper.unmount();
  });
});
