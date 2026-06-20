const BOX_COMMANDS = ['\\boxed', '\\fbox'] as const;

const containsBoxCommand = (source: string): boolean => {
  for (const command of BOX_COMMANDS) {
    if (source.includes(command)) return true;
  }
  return false;
};

const readBalancedGroup = (
  source: string,
  openBraceIndex: number,
): { content: string; endIndex: number } | null => {
  if (source[openBraceIndex] !== '{') return null;
  let depth = 0;
  for (let index = openBraceIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      // 跳过 LaTeX 转义：\{ \} \\ 等
      index += 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char !== '}') continue;
    depth -= 1;
    if (depth === 0) {
      return {
        content: source.slice(openBraceIndex + 1, index),
        endIndex: index,
      };
    }
  }
  return null;
};

const unwrapCommandAt = (
  source: string,
  startIndex: number,
  command: string,
): { value: string; endIndex: number } | null => {
  if (!source.startsWith(command, startIndex)) return null;
  const after = startIndex + command.length;
  // 词边界：紧跟字母说明是别的命令名
  const nextCode = source.charCodeAt(after);
  const isLetter = (nextCode >= 65 && nextCode <= 90) || (nextCode >= 97 && nextCode <= 122);
  if (isLetter) return null;

  const group = readBalancedGroup(source, after);
  if (!group) return null;
  return {
    value: normalizeAiMath(group.content),
    endIndex: group.endIndex,
  };
};

/** 移除 AI 输出里用于强调结果的盒子公式命令，避免 KaTeX 渲染出额外边框。 */
export const normalizeAiMath = (source: string): string => {
  // 快路径：不含 \boxed / \fbox 时，输出与输入完全一致。
  // 流式渲染每帧都会带着不断增长的整段内容调用本函数；旧实现无论是否命中盒子
  // 命令都逐字符重建字符串，使整段流式过程退化为 O(n^2) 并频繁分配字符串。
  // 先用原生 includes 快速排除绝大多数无盒子命令的分片，避免重建与多余分配。
  if (!containsBoxCommand(source)) return source;

  let normalized = '';
  for (let index = 0; index < source.length; index += 1) {
    let unwrapped: { value: string; endIndex: number } | null = null;
    for (const command of BOX_COMMANDS) {
      unwrapped = unwrapCommandAt(source, index, command);
      if (unwrapped) break;
    }
    if (unwrapped) {
      normalized += unwrapped.value;
      index = unwrapped.endIndex;
      continue;
    }
    normalized += source[index];
  }
  return normalized;
};
