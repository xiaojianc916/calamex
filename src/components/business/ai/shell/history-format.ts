const HISTORY_TIME_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const HISTORY_DATE_FORMAT_SAME_YEAR = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit',
  day: '2-digit',
});
const HISTORY_DATE_FORMAT_FULL = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** 格式化为 HH:mm 时钟文本，无法解析时返回“刚刚”。 */
export const formatHistoryClockTime = (timestampText: string): string => {
  const timestamp = Date.parse(timestampText);

  if (!Number.isFinite(timestamp)) {
    return '刚刚';
  }

  return HISTORY_TIME_FORMAT.format(new Date(timestamp));
};

/**
 * 格式化历史时间戳：今天/昨天显示时钟，同年显示 MM/DD，跨年显示完整日期。
 * 无法解析时返回“刚刚”。
 */
export const formatHistoryTimestamp = (timestampText: string): string => {
  const timestamp = Date.parse(timestampText);

  if (!Number.isFinite(timestamp)) {
    return '刚刚';
  }

  const date = new Date(timestamp);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfDate) / (24 * 60 * 60 * 1000));

  if (dayDiff <= 0) {
    return `今天 ${HISTORY_TIME_FORMAT.format(date)}`;
  }

  if (dayDiff === 1) {
    return `昨天 ${HISTORY_TIME_FORMAT.format(date)}`;
  }

  const formatter =
    date.getFullYear() === now.getFullYear()
      ? HISTORY_DATE_FORMAT_SAME_YEAR
      : HISTORY_DATE_FORMAT_FULL;

  return formatter.format(date);
};
