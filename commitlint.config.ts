import type { UserConfig } from '@commitlint/types';

const config: UserConfig = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // scope 必填（R-12.2.1）
    'scope-empty': [2, 'never'],
    // subject 不以句号结尾，长度上限 72 字符（中英文混合）
    'subject-max-length': [2, 'always', 72],
    // 不以句号结尾
    'subject-full-stop': [2, 'never', '.'],
    // 允许的 type（R-12.2）
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
  },
};

export default config;
