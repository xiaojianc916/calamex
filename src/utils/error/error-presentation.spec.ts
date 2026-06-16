import { describe, expect, it } from 'vitest';
import { AppError } from '@/types/app-error';
import { resolveErrorPresentation } from '@/utils/error/error-presentation';

describe('resolveErrorPresentation', () => {
  it('默认把校验错误映射到字段级展示', () => {
    const error = new AppError({
      code: 'ipc.input-validation',
      message: 'API Key 不能为空。',
      scope: 'validation',
      traceId: 'trace-validation',
    });

    expect(resolveErrorPresentation(error)).toMatchObject({
      code: 'ipc.input-validation',
      message: 'API Key 不能为空。',
      presentation: 'field',
      severity: 'warning',
      traceId: 'trace-validation',
    });
  });

  it('允许调用方按用户场景覆盖展示方式', () => {
    const error = new AppError({
      code: 'workspace.open-failed',
      message: '项目配置文件损坏。',
      scope: 'ipc',
      traceId: 'trace-project',
    });

    expect(
      resolveErrorPresentation(error, {
        title: '无法打开项目',
        presentation: 'page',
      }),
    ).toMatchObject({
      title: '无法打开项目',
      presentation: 'page',
      severity: 'error',
    });
  });

  it('为普通未知错误保留诊断详情', () => {
    const error = new Error('Cannot read properties of undefined');
    const model = resolveErrorPresentation(error, {
      presentation: 'fatal',
      fallbackMessage: '应用运行时错误。',
    });

    expect(model.presentation).toBe('fatal');
    expect(model.technicalDetails).toContain('Cannot read properties of undefined');
  });
});
