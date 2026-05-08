const STATUS_PREFIX_PATTERN =
  /^(?:正在|已|等待|调用失败|已拒绝|Agent\s*)\s*(?:读取|搜索|加载|使用|应用|生成|验证|执行|运行|检索|分析|暂存|提交|调用|完成)?\s*[:：]?\s*/u;

const GENERIC_TARGET_PREFIX_PATTERN =
  /^(?:当前文件|当前选区|项目内容|文件名|符号|诊断|Git\s*变更|终端日志|网页|Patch|测试|命令|Git\s*暂存|Git\s*提交|文件|打开文件|package scripts|测试目标|工作区)\s*[:：]?\s*/iu;

export const normalizeText = (value: string): string =>
  value
    .replace(/…$/u, '')
    .replace(/\s+/gu, ' ')
    .trim();

export const stripTargetNoise = (value: string): string => {
  const withoutStatus = normalizeText(value).replace(STATUS_PREFIX_PATTERN, '').trim();
  const withoutGenericPrefix = withoutStatus.replace(GENERIC_TARGET_PREFIX_PATTERN, '').trim();

  return withoutGenericPrefix || withoutStatus;
};

export const isUrlLike = (value: string): boolean => /^https?:\/\//iu.test(value);

export const isFileLikeTarget = (value: string): boolean =>
  /[\\/]/u.test(value) || /\.[a-z0-9]{1,12}(?::|#L|\s*$)/iu.test(value);

const formatLineRange = (start: string, end: string | undefined): string =>
  end && end !== start ? `L${start}-${end}` : `L${start}`;

export const parseTarget = (value: string): { target: string; lineRange: string | null } => {
  const target = normalizeText(value);

  if (!target || isUrlLike(target)) {
    return {
      target,
      lineRange: null,
    };
  }

  const hashLineMatch = target.match(/^(.+?)#L(\d+)(?:-L?(\d+))?$/u);
  if (hashLineMatch?.[1] && hashLineMatch[2] && isFileLikeTarget(hashLineMatch[1])) {
    return {
      target: hashLineMatch[1].trim(),
      lineRange: formatLineRange(hashLineMatch[2], hashLineMatch[3]),
    };
  }

  const colonLineMatch = target.match(/^(.+):(\d+)(?:-(\d+))?$/u);
  if (colonLineMatch?.[1] && colonLineMatch[2] && isFileLikeTarget(colonLineMatch[1])) {
    return {
      target: colonLineMatch[1].trim(),
      lineRange: formatLineRange(colonLineMatch[2], colonLineMatch[3]),
    };
  }

  return {
    target,
    lineRange: null,
  };
};

export const formatElapsed = (elapsedMs: number | undefined): string | null => {
  if (elapsedMs === undefined || !Number.isFinite(elapsedMs)) {
    return null;
  }

  const safeElapsedMs = Math.max(0, Math.round(elapsedMs));

  if (safeElapsedMs < 1000) {
    return `${safeElapsedMs}ms`;
  }

  if (safeElapsedMs < 60_000) {
    const seconds = safeElapsedMs / 1000;
    if (seconds < 10) {
      return `${Number(seconds.toFixed(1))}s`;
    }

    return `${Math.round(seconds)}s`;
  }

  let minutes = Math.floor(safeElapsedMs / 60_000);
  let seconds = Math.round((safeElapsedMs % 60_000) / 1000);

  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }

  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};
