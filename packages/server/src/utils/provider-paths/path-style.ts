import { posix, win32 } from "path";
import { statSync } from "fs";
import type { EnvLike, PathKind } from "./types.js";

export function dedupePaths(paths: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const path of paths) {
    const key = getPathKey(path);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(path);
  }

  return result;
}

export function getPathKey(path: string): string {
  if (usesWindowsPathStyle(path)) {
    return win32.normalize(normalizeWindowsLikePath(path)).toLowerCase();
  }
  return posix.normalize(normalizePosixLikePath(path));
}

export function resolvePathValue(rawPath: string, homeDir: string, env: EnvLike, baseDir = homeDir): string {
  let resolvedPath = rawPath.trim();
  if (!resolvedPath) return resolveStyledPath(baseDir, baseDir);

  resolvedPath = resolvedPath.replace(/^~(?=$|[\\/])/, homeDir);
  resolvedPath = resolvedPath.replace(/%([^%]+)%/g, (_match, name: string) => env[name] ?? "");
  resolvedPath = resolvedPath.replace(/\$\{([^}]+)\}/g, (_match, name: string) => env[name] ?? "");
  resolvedPath = resolvedPath.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, name: string) => env[name] ?? "");

  if (usesWindowsPathStyle(homeDir, baseDir, resolvedPath)) {
    return resolveStyledPath(normalizeWindowsLikePath(resolvedPath), normalizeWindowsLikePath(baseDir));
  }

  return resolveStyledPath(normalizePosixLikePath(resolvedPath), normalizePosixLikePath(baseDir));
}

export function resolveStyledPath(pathValue: string, baseDir: string): string {
  if (usesWindowsPathStyle(pathValue, baseDir)) {
    const normalizedPath = normalizeWindowsLikePath(pathValue);
    const normalizedBaseDir = normalizeWindowsLikePath(baseDir);
    return win32.isAbsolute(normalizedPath)
      ? win32.resolve(normalizedPath)
      : win32.resolve(normalizedBaseDir, normalizedPath);
  }

  const normalizedPath = normalizePosixLikePath(pathValue);
  const normalizedBaseDir = normalizePosixLikePath(baseDir);
  return posix.isAbsolute(normalizedPath)
    ? posix.resolve(normalizedPath)
    : posix.resolve(normalizedBaseDir, normalizedPath);
}

export function joinStyledPath(base: string, ...segments: string[]): string {
  if (usesWindowsPathStyle(base)) {
    return win32.join(normalizeWindowsLikePath(base), ...segments.map(normalizeWindowsLikePath));
  }
  return posix.join(normalizePosixLikePath(base), ...segments.map(normalizePosixLikePath));
}

export function dirnameStyledPath(path: string): string {
  if (usesWindowsPathStyle(path)) {
    return win32.dirname(normalizeWindowsLikePath(path));
  }
  return posix.dirname(normalizePosixLikePath(path));
}

export function usesWindowsPathStyle(...paths: string[]): boolean {
  return paths.some((path) => isWindowsAbsolutePath(path));
}

export function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

export function normalizeWindowsLikePath(path: string): string {
  const gitBashMatch = path.match(/^\/([A-Za-z])(?=\/|$)(.*)$/);
  if (gitBashMatch) {
    const rest = (gitBashMatch[2] || "").replace(/\//g, "\\");
    return `${gitBashMatch[1].toUpperCase()}:${rest || "\\"}`;
  }
  return path.replace(/\//g, "\\");
}

export function normalizePosixLikePath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function defaultPathExists(path: string, kind: PathKind): boolean {
  try {
    const stats = statSync(path);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

export function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
