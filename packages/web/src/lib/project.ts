export function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

export function canonicalizeProjectPath(value: string): string {
  const normalized = normalizeProjectPath(value);
  if (!normalized) return "";

  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("~/")) {
    return normalized.toLowerCase();
  }

  return normalized;
}

function isReadablePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith("/") || value.startsWith("~/");
}

export function getReadableProjectSegments(project: string, projectKey?: string): string[] {
  const preferred = normalizeProjectPath(project || "");
  if (preferred && isReadablePath(preferred)) {
    return preferred.split("/").filter(Boolean);
  }

  const fallback = normalizeProjectPath(projectKey || "");
  if (!fallback || !isReadablePath(fallback)) return [];
  return fallback.split("/").filter(Boolean);
}

function isUserHomeSegments(parts: string[]): boolean {
  return parts.length === 3 && /^[A-Za-z]:$/.test(parts[0]) && /^users$/i.test(parts[1]);
}

function isUserChildPath(parts: string[]): boolean {
  return parts.length > 3 && /^[A-Za-z]:$/.test(parts[0]) && /^users$/i.test(parts[1]);
}

function toUserFacingPath(parts: string[]): string {
  if (isUserHomeSegments(parts)) {
    return "~";
  }
  if (isUserChildPath(parts)) {
    return `~/${parts.slice(3).map((part) => part.toLowerCase()).join("/")}`;
  }
  return parts.join("/");
}

export function isSameProjectPath(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = canonicalizeProjectPath(left || "");
  const normalizedRight = canonicalizeProjectPath(right || "");

  if (!normalizedLeft || !normalizedRight) {
    return normalizeProjectPath(left || "") === normalizeProjectPath(right || "");
  }

  return normalizedLeft === normalizedRight;
}

export function getProjectName(project: string, projectKey?: string): string {
  const parts = getReadableProjectSegments(project, projectKey);
  if (parts.length === 0) return projectKey || project || "未知目录";
  return toUserFacingPath(parts);
}

export function getProjectPathHint(project: string, projectKey?: string): string {
  const parts = getReadableProjectSegments(project, projectKey);
  if (parts.length === 0) return projectKey || project || "未知目录";
  return toUserFacingPath(parts);
}

export function getDisambiguatedProjectName(
  project: string,
  projectKey: string | undefined,
  _siblings: Array<{ project: string; projectKey?: string }>
): string {
  const parts = getReadableProjectSegments(project, projectKey);
  if (parts.length === 0) return projectKey || project || "未知目录";
  return toUserFacingPath(parts);
}
