import { describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useWorkspaceExplorerContextMenu } from '../useWorkspaceExplorerContextMenu';

const noop = (): void => undefined;

const createMenu = () => {
  const scope = effectScope();
  const api = scope.run(() =>
    useWorkspaceExplorerContextMenu({
      resolveRootPath: () => 'D:/repo',
      resolveEmptyAreaTarget: () => ({
        path: 'D:/repo',
        name: 'repo',
        kind: 'directory',
        isRoot: true,
      }),
      onCreate: noop,
      onRename: noop,
      onDelete: noop,
      onCopyPath: noop,
      onOpenFolder: noop,
    }),
  );
  if (!api) {
    throw new Error('failed to create context menu composable');
  }
  return { api, scope };
};

type TMenuApi = ReturnType<typeof createMenu>['api'];

const findItem = (api: TMenuApi, key: string) =>
  api.explorerContextMenuGroups.value.flatMap((group) => group.items).find((item) => item.key === key);

describe('useWorkspaceExplorerContextMenu', () => {
  it('右键文件时允许新建文件 / 文件夹，也允许重命名 / 删除', () => {
    const { api, scope } = createMenu();
    api.handleEntryContextMenu({
      event: new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }),
      entry: { path: 'D:/repo/demo.c', name: 'demo.c', kind: 'file', hasChildren: false },
    });
    expect(findItem(api, 'new-file')?.disabled).toBe(false);
    expect(findItem(api, 'new-directory')?.disabled).toBe(false);
    expect(findItem(api, 'rename')?.disabled).toBe(false);
    expect(findItem(api, 'delete')?.disabled).toBe(false);
    scope.stop();
  });

  it('右键根目录时允许新建但禁止重命名 / 删除', () => {
    const { api, scope } = createMenu();
    api.handleEmptyAreaContextMenu(new MouseEvent('contextmenu', { clientX: 20, clientY: 20 }));
    expect(findItem(api, 'new-file')?.disabled).toBe(false);
    expect(findItem(api, 'new-directory')?.disabled).toBe(false);
    expect(findItem(api, 'rename')?.disabled).toBe(true);
    expect(findItem(api, 'delete')?.disabled).toBe(true);
    scope.stop();
  });
});
