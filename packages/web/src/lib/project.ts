export function normalizeProjectPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
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
  return parts.length === 3 && /^[A-Za-z]:$/.test(parts[0]) && parts[1] === "Users";
}

function isUserChildPath(parts: string[]): boolean {
  return parts.length > 3 && /^[A-Za-z]:$/.test(parts[0]) && parts[1] === "Users";
}

function toUserFacingPath(parts: string[]): string {
  if (isUserHomeSegments(parts)) {
    return "~";
  }
  if (isUserChildPath(parts)) {
    return `~/${parts.slice(3).join("/")}`;
  }
  return parts.join("/");
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
