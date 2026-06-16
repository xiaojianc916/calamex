import { formatFileSystemPathForDisplay } from '@/utils/file/path';

export const writeClipboardText = async (value: string): Promise<void> => {
  await navigator.clipboard.writeText(value);
};

export const writeFileSystemPathToClipboard = async (
  value: string | null | undefined,
): Promise<void> => {
  await writeClipboardText(formatFileSystemPathForDisplay(value));
};

export const readClipboardText = async (): Promise<string> => {
  return navigator.clipboard.readText();
};

export const tryWriteClipboardText = async (value: string): Promise<boolean> => {
  try {
    await writeClipboardText(value);
    return true;
  } catch {
    return false;
  }
};

export const tryReadClipboardText = async (): Promise<string | null> => {
  try {
    return await readClipboardText();
  } catch {
    return null;
  }
};
