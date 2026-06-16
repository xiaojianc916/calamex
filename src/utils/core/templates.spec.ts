import { describe, expect, it } from 'vitest';
import {
  COMMAND_TEMPLATES,
  COMMENT_TEMPLATES,
  DEFAULT_EXECUTOR,
  DEFAULT_SCRIPT,
  getExecutorLabel,
} from '@/utils/core/templates';

describe('templates', () => {
  it('默认执行器为 wsl，标签为 WSL2', () => {
    expect(DEFAULT_EXECUTOR).toBe('wsl');
    expect(getExecutorLabel('wsl')).toBe('WSL2');
  });

  it('未知执行器回退到 WSL2', () => {
    expect(getExecutorLabel('unknown' as never)).toBe('WSL2');
  });

  it('默认脚本包含安全执行头', () => {
    expect(DEFAULT_SCRIPT).toContain('#!/bin/bash');
    expect(DEFAULT_SCRIPT).toContain('set -euo pipefail');
  });

  it('所有模板都具备完整字段', () => {
    for (const template of [...COMMAND_TEMPLATES, ...COMMENT_TEMPLATES]) {
      expect(template.id).toBeTruthy();
      expect(template.title).toBeTruthy();
      expect(template.category).toBeTruthy();
      expect(template.description).toBeTruthy();
      expect(template.snippet).toBeTruthy();
    }
  });

  it('模板 id 全局唯一', () => {
    const ids = [...COMMAND_TEMPLATES, ...COMMENT_TEMPLATES].map((template) => template.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('safe-header 模板复用默认脚本', () => {
    const safeHeader = COMMAND_TEMPLATES.find((template) => template.id === 'safe-header');
    expect(safeHeader?.snippet).toBe(DEFAULT_SCRIPT);
  });
});
