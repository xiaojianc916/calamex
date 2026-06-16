import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/types/app-error';
import {
  registerRuntimeDiagnostics,
  reportRuntimeError,
  runtimeErrorState,
  setRuntimeError,
} from '@/utils/platform/runtime-diagnostics';

const cleanupDiagnostics = (): void => {
  window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__?.();
  window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__ = undefined;
};

describe('runtime-diagnostics', () => {
  beforeEach(() => {
    runtimeErrorState.value = null;
  });

  afterEach(() => {
    cleanupDiagnostics();
    runtimeErrorState.value = null;
  });

  describe('setRuntimeError', () => {
    it('普通 Error 写入标题、消息与堆栈，不含 code/traceId', () => {
      setRuntimeError('保存失败', new Error('磁盘已满'));
      expect(runtimeErrorState.value).toMatchObject({
        title: '保存失败',
        message: '磁盘已满',
      });
      expect(runtimeErrorState.value?.detail).toContain('磁盘已满');
      expect(runtimeErrorState.value?.code).toBeUndefined();
      expect(runtimeErrorState.value?.traceId).toBeUndefined();
    });

    it('AppError 额外保留 code 与 traceId', () => {
      const appError = new AppError({
        code: 'ipc.timeout',
        message: '调用超时',
        scope: 'ipc',
        traceId: 'trace-42',
      });
      setRuntimeError('调用失败', appError);
      expect(runtimeErrorState.value).toMatchObject({
        code: 'ipc.timeout',
        traceId: 'trace-42',
        message: '调用超时',
      });
    });

    it('非 Error 对象序列化为 JSON detail', () => {
      setRuntimeError('未知', { reason: 'boom' });
      expect(runtimeErrorState.value?.detail).toContain('"reason": "boom"');
    });
  });

  describe('reportRuntimeError', () => {
    it('忽略可恢复的递归更新告警，不写入诊断态', () => {
      reportRuntimeError(
        'Vue render failed',
        new Error('Maximum recursive updates exceeded in component <TooltipProvider>.'),
      );
      expect(runtimeErrorState.value).toBeNull();
    });

    it('忽略只有字符串消息的递归更新告警', () => {
      reportRuntimeError('Vue render failed', 'Maximum recursive updates exceeded.');
      expect(runtimeErrorState.value).toBeNull();
    });

    it('普通错误仍写入诊断态', () => {
      reportRuntimeError('Vue render failed', new Error('真实渲染错误'));
      expect(runtimeErrorState.value).toMatchObject({
        title: 'Vue render failed',
        message: '真实渲染错误',
      });
    });
  });

  describe('registerRuntimeDiagnostics', () => {
    it('注册后在 window 上保存清理函数', () => {
      registerRuntimeDiagnostics();
      expect(typeof window.__SH_RUNTIME_DIAGNOSTICS_CLEANUP__).toBe('function');
    });

    it('捕获普通运行时错误并写入诊断状态', () => {
      registerRuntimeDiagnostics();
      const event = Object.assign(new Event('error'), {
        error: new Error('渲染崩溃'),
        message: '渲染崩溃',
      });
      window.dispatchEvent(event);
      expect(runtimeErrorState.value).toMatchObject({
        title: '应用运行时错误',
        message: '渲染崩溃',
      });
    });

    it('忽略 ResizeObserver 抖动错误', () => {
      registerRuntimeDiagnostics();
      const event = Object.assign(new Event('error'), {
        error: undefined,
        message: 'ResizeObserver loop completed with undelivered notifications.',
      });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(runtimeErrorState.value).toBeNull();
    });

    it('忽略可恢复的递归更新告警错误事件', () => {
      registerRuntimeDiagnostics();
      const event = Object.assign(new Event('error'), {
        error: new Error('Maximum recursive updates exceeded in component <TooltipProvider>.'),
        message: 'Maximum recursive updates exceeded.',
      });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(runtimeErrorState.value).toBeNull();
    });

    it('忽略取消类未处理拒绝', () => {
      registerRuntimeDiagnostics();
      const event = Object.assign(new Event('unhandledrejection'), {
        reason: { name: 'AbortError', message: 'aborted' },
      });
      const preventDefault = vi.spyOn(event, 'preventDefault');
      window.dispatchEvent(event);
      expect(preventDefault).toHaveBeenCalledTimes(1);
      expect(runtimeErrorState.value).toBeNull();
    });

    it('捕获普通未处理拒绝并写入诊断状态', () => {
      registerRuntimeDiagnostics();
      const event = Object.assign(new Event('unhandledrejection'), {
        reason: new Error('异步炸了'),
      });
      window.dispatchEvent(event);
      expect(runtimeErrorState.value).toMatchObject({
        title: '未处理的异步错误',
        message: '异步炸了',
      });
    });
  });
});
