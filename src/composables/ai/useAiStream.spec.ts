import { describe, expect, it } from 'vitest';
import { type EffectScope, effectScope } from 'vue';
import { useAiStream } from '@/composables/ai/useAiStream';

interface IStreamHarness {
  stream: ReturnType<typeof useAiStream>;
  scope: EffectScope;
}

const createStreamHarness = (options: Parameters<typeof useAiStream>[0] = {}): IStreamHarness => {
  const scope = effectScope();
  let stream: ReturnType<typeof useAiStream> | null = null;

  scope.run(() => {
    stream = useAiStream(options);
  });

  if (!stream) {
    throw new Error('useAiStream 初始化失败');
  }

  return {
    stream,
    scope,
  };
};

describe('useAiStream', () => {
  it('原始增量内容立即累加，平滑呈现交由渲染层处理', () => {
    const { stream, scope } = createStreamHarness();

    stream.start();
    stream.append('abcdef'.repeat(8));

    expect(stream.content.value).toBe('abcdef'.repeat(8));
    expect(stream.isStreaming.value).toBe(true);
    expect(stream.bufferedGraphemeCount.value).toBe(0);
    expect(stream.maxBufferedGraphemeCount.value).toBe(0);

    stream.append('追加');
    expect(stream.content.value).toBe(`${'abcdef'.repeat(8)}追加`);

    stream.complete();
    expect(stream.content.value).toBe(`${'abcdef'.repeat(8)}追加`);
    expect(stream.status.value).toBe('completed');

    scope.stop();
  });

  it('完成时保留完整内容', () => {
    const { stream, scope } = createStreamHarness();

    stream.start();
    stream.append('你好🙂');
    stream.complete();

    expect(stream.content.value).toBe('你好🙂');
    expect(stream.status.value).toBe('completed');

    scope.stop();
  });

  it('开始新流时清空已有内容', () => {
    const { stream, scope } = createStreamHarness();

    stream.start();
    stream.append('上一段');
    stream.complete();

    stream.start();
    expect(stream.content.value).toBe('');
    expect(stream.status.value).toBe('streaming');

    scope.stop();
  });

  it('取消时保留已经到达的内容，并忽略后续迟到 delta', () => {
    const { stream, scope } = createStreamHarness();

    stream.start();
    stream.append('已经到达');
    stream.stop();
    stream.append('不应进入');

    expect(stream.content.value).toBe('已经到达');
    expect(stream.status.value).toBe('cancelled');

    scope.stop();
  });

  it('保留跨 delta 的 emoji ZWJ 字符簇', () => {
    const { stream, scope } = createStreamHarness();
    const family = '👨‍👩‍👧‍👦';

    stream.start();
    stream.append('👨');
    stream.append('‍👩‍👧‍👦完成');

    expect(stream.content.value).toBe(`${family}完成`);
    expect(stream.content.value).not.toContain('�');

    stream.complete();
    expect(stream.content.value).toBe(`${family}完成`);

    scope.stop();
  });
});
