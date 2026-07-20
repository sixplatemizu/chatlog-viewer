type ErrorStatusCode = 400 | 404 | 409 | 500 | 503;

export type ProviderDataErrorKind = "unavailable" | "locked" | "corrupt" | "schema-incompatible";

export class ProviderDataError extends Error {
  readonly status = 503;

  constructor(
    readonly providerName: string,
    readonly kind: ProviderDataErrorKind,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ProviderDataError";
  }
}

export class MutationConflictError extends Error {
  readonly status = 409;

  constructor(message: string) {
    super(message);
    this.name = "MutationConflictError";
  }
}

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

export function isMutationConflictError(error: unknown): boolean {
  return error instanceof MutationConflictError
    || (
      !!error
      && typeof error === "object"
      && "status" in error
      && (error as { status?: unknown }).status === 409
    );
}

export function isProviderDataError(error: unknown): boolean {
  return error instanceof ProviderDataError
    || (
      !!error
      && typeof error === "object"
      && "status" in error
      && (error as { status?: unknown }).status === 503
    );
}

export function getErrorStatus(error: unknown, fallbackStatus: ErrorStatusCode = 500): ErrorStatusCode {
  if (isMutationConflictError(error)) return 409;
  if (isProviderDataError(error)) return 503;
  return isNotFoundError(error) ? 404 : fallbackStatus;
}
