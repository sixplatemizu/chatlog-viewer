type ErrorStatusCode = 400 | 404 | 500;

const NOT_FOUND_PATTERNS = [
  "对话不存在",
  "未找到对话",
  "消息不存在",
  "SQLite 中未找到对话",
  "未知的 provider",
  "provider 不可用",
  "not found",
];

export function getErrorMessage(error: unknown, fallback = "未知错误"): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export function isNotFoundError(error: unknown): boolean {
  const message = getErrorMessage(error, "").toLowerCase();
  return NOT_FOUND_PATTERNS.some((pattern) => message.includes(pattern.toLowerCase()));
}

export function getErrorStatus(error: unknown, fallbackStatus: ErrorStatusCode = 500): ErrorStatusCode {
  return isNotFoundError(error) ? 404 : fallbackStatus;
}
