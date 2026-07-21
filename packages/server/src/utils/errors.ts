type ErrorStatusCode = 400 | 404 | 409 | 500 | 503;

export type ProviderDataErrorKind =
  | "unavailable"
  | "locked"
  | "corrupt"
  | "schema-incompatible"
  | "permission-denied";

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

export function classifyProviderDataError(error: unknown): ProviderDataErrorKind {
  const message = getErrorMessage(error, "").toLowerCase();
  const code = getErrorCode(error);

  if (
    code === "EACCES"
    || code === "EPERM"
    || code === "SQLITE_READONLY"
    || message.includes("permission denied")
    || message.includes("access is denied")
    || message.includes("operation not permitted")
    || message.includes("readonly database")
  ) {
    return "permission-denied";
  }
  if (
    code === "SQLITE_BUSY"
    || code === "SQLITE_LOCKED"
    || message.includes("locked")
    || message.includes("busy")
  ) {
    return "locked";
  }
  if (
    code === "SQLITE_CORRUPT"
    || code === "SQLITE_NOTADB"
    || message.includes("malformed")
    || message.includes("corrupt")
    || message.includes("not a database")
    || message.includes("disk image is malformed")
  ) {
    return "corrupt";
  }
  if (
    message.includes("no such table")
    || message.includes("no such column")
    || message.includes("schema")
  ) {
    return "schema-incompatible";
  }
  return "unavailable";
}

export function createProviderDataError(
  providerName: string,
  context: string,
  error: unknown
): ProviderDataError {
  if (error instanceof ProviderDataError) {
    return error;
  }
  return new ProviderDataError(
    providerName,
    classifyProviderDataError(error),
    `${context}: ${getErrorMessage(error)}`,
    error instanceof Error ? { cause: error } : undefined
  );
}

export function getErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code ?? "").toUpperCase()
    : "";
}

export function isFileSystemNotFoundError(error: unknown): boolean {
  return getErrorCode(error) === "ENOENT";
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
