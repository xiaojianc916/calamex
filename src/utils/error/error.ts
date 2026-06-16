const extractSerializedErrorMessage = (value: string): string | null => {
  const trimmed = value.trim();

  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const message = 'message' in parsed ? parsed.message : null;

    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  } catch {
    return null;
  }

  return null;
};

export const toErrorMessage = (error: unknown, fallback: string): string => {
  if (error instanceof Error && error.message.trim()) {
    return extractSerializedErrorMessage(error.message) ?? error.message;
  }

  if (typeof error === 'string' && error.trim()) {
    return extractSerializedErrorMessage(error) ?? error;
  }

  return fallback;
};
