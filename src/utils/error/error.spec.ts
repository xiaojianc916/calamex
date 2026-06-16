import { describe, expect, it } from 'vitest';
import { toErrorMessage } from '@/utils/error/error';

describe('toErrorMessage', () => {
  const fallback = '默认错误';

  it('提取 Error 实例的 message', () => {
    expect(toErrorMessage(new Error('boom'), fallback)).toBe('boom');
  });

  it('Error 的 message 为空白时回退', () => {
    expect(toErrorMessage(new Error('   '), fallback)).toBe(fallback);
  });

  it('非空字符串直接返回', () => {
    expect(toErrorMessage('网络异常', fallback)).toBe('网络异常');
  });

  it('空白字符串回退', () => {
    expect(toErrorMessage('   ', fallback)).toBe(fallback);
  });

  it('null / undefined / 数字均回退', () => {
    expect(toErrorMessage(null, fallback)).toBe(fallback);
    expect(toErrorMessage(undefined, fallback)).toBe(fallback);
    expect(toErrorMessage(500, fallback)).toBe(fallback);
  });

  it('从序列化 JSON 错误中提取 message 字段', () => {
    expect(toErrorMessage(new Error('{"message":"真正的错误"}'), fallback)).toBe('真正的错误');
  });

  it('从 JSON 字符串中提取并 trim message', () => {
    expect(toErrorMessage('{"message":"  带空格  "}', fallback)).toBe('带空格');
  });

  it('JSON 缺少 message 字段时返回原始字符串', () => {
    expect(toErrorMessage('{"code":42}', fallback)).toBe('{"code":42}');
  });

  it('JSON 数组不视为对象，返回原始字符串', () => {
    expect(toErrorMessage('[1,2,3]', fallback)).toBe('[1,2,3]');
  });

  it('看似对象但非法的 JSON 返回原始字符串', () => {
    expect(toErrorMessage('{bad json}', fallback)).toBe('{bad json}');
  });

  it('message 非字符串时返回原始字符串', () => {
    expect(toErrorMessage('{"message":123}', fallback)).toBe('{"message":123}');
  });
});
