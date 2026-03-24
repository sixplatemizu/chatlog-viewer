import { readFileSync, statSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { posix, win32 } from "path";

export type ResolvedProviderName = "claude-code" | "codex" | "iflow";
type PathKind = "file" | "directory";
type EnvLike = Record<string, string | undefined>;
export type ProviderPathSource = "env" | "config" | "auto" | "default";

export interface ProviderPathConfig {
  storagePath?: string;
  stateDbPath?: string;
}

export interface AppConfig {
  providers?: Partial<Record<ResolvedProviderName, ProviderPathConfig>>;
}

export interface LoadedConfig {
  config: AppConfig;
  configDir: string;
}

export interface ResolvedProviderPaths {
  storagePath: string;
  storageExists: boolean;
  storageSource: ProviderPathSource;
  stateDbPath?: string;
  stateDbExists?: boolean;
  stateDbSource?: ProviderPathSource;
}

interface ResolveProviderPathsOptions {
  env?: EnvLike;
  homeDir?: string;
  config?: AppConfig;
  configDir?: string;
  pathExists?: (path: string, kind: PathKind) => boolean;
}

interface ResolvedPathResult {
  path: string;
  exists: boolean;
  source: ProviderPathSource;
}

const providerPathCache = new Map<ResolvedProviderName, ResolvedProviderPaths>();
const configLoadCache = new Map<string, LoadedConfig>();

export function clearProviderPathCache(): void {
  providerPathCache.clear();
  configLoadCache.clear();
}

export function getProviderPaths(providerName: ResolvedProviderName): ResolvedProviderPaths {
  const cached = providerPathCache.get(providerName);
  if (cached) return cached;

  const resolved = resolveProviderPaths(providerName);
  providerPathCache.set(providerName, resolved);
  return resolved;
}

export function getProviderConfigPath(env: EnvLike = process.env, homeDir = homedir()): string {
  const configuredPath = env.CHATLOG_VIEWER_CONFIG_PATH?.trim();
  if (!configuredPath) return joinStyledPath(homeDir, ".chatlog-viewer", "config.json");
  return resolvePathValue(configuredPath, homeDir, env);
}

export function getAppConfig(env: EnvLike = process.env, homeDir = homedir()): LoadedConfig {
  return loadAppConfig(env, homeDir);
}

export function resolveProviderPaths(
  providerName: ResolvedProviderName,
  options: ResolveProviderPathsOptions = {}
): ResolvedProviderPaths {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const pathExists = options.pathExists ?? defaultPathExists;
  const loadedConfig = options.config
    ? {
        config: options.config,
        configDir: options.configDir ?? joinStyledPath(homeDir, ".chatlog-viewer"),
      }
    : loadAppConfig(env, homeDir);
  const providerConfig = loadedConfig.config.providers?.[providerName];

  if (providerName === "claude-code") {
    const storage = resolvePathWithFallback({
      envKeys: ["CHATLOG_VIEWER_CLAUDE_CODE_PATH"],
      configValue: providerConfig?.storagePath,
      configDir: loadedConfig.configDir,
      autoCandidates: buildClaudeStorageCandidates(homeDir, env),
      defaultPath: joinStyledPath(homeDir, ".claude", "projects"),
      kind: "directory",
      env,
      homeDir,
      pathExists,
    });

    return {
      storagePath: storage.path,
      storageExists: storage.exists,
      storageSource: storage.source,
    };
  }

  if (providerName === "iflow") {
    const storage = resolvePathWithFallback({
      envKeys: ["CHATLOG_VIEWER_IFLOW_PATH"],
      configValue: providerConfig?.storagePath,
      configDir: loadedConfig.configDir,
      autoCandidates: buildIFlowStorageCandidates(homeDir, env),
      defaultPath: joinStyledPath(homeDir, ".iflow", "projects"),
      kind: "directory",
      env,
      homeDir,
      pathExists,
    });

    return {
      storagePath: storage.path,
      storageExists: storage.exists,
      storageSource: storage.source,
    };
  }

  const storage = resolvePathWithFallback({
    envKeys: ["CHATLOG_VIEWER_CODEX_SESSIONS_PATH"],
    configValue: providerConfig?.storagePath,
    configDir: loadedConfig.configDir,
    autoCandidates: buildCodexStorageCandidates(homeDir, env),
    defaultPath: joinStyledPath(homeDir, ".codex", "sessions"),
    kind: "directory",
    env,
    homeDir,
    pathExists,
  });

  const stateDb = resolvePathWithFallback({
    envKeys: ["CHATLOG_VIEWER_CODEX_STATE_DB_PATH"],
    configValue: providerConfig?.stateDbPath,
    configDir: loadedConfig.configDir,
    autoCandidates: buildCodexStateDbCandidates(homeDir, env, storage.path),
    defaultPath: joinStyledPath(homeDir, ".codex", "state_5.sqlite"),
    kind: "file",
    env,
    homeDir,
    pathExists,
  });

  return {
    storagePath: storage.path,
    storageExists: storage.exists,
    storageSource: storage.source,
    stateDbPath: stateDb.path,
    stateDbExists: stateDb.exists,
    stateDbSource: stateDb.source,
  };
}

function loadAppConfig(env: EnvLike, homeDir: string): LoadedConfig {
  const configPath = getProviderConfigPath(env, homeDir);
  const cacheKey = getPathKey(configPath);
  const cached = configLoadCache.get(cacheKey);
  if (cached) return cached;

  const result: LoadedConfig = {
    config: {},
    configDir: dirnameStyledPath(configPath),
  };

  try {
    const content = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(content) as AppConfig;
    result.config = parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if (getErrorCode(error) !== "ENOENT") {
      console.error(`[provider-paths] 配置文件解析失败: ${configPath} ${getErrorMessage(error)}`);
    }
  }

  configLoadCache.set(cacheKey, result);
  return result;
}

export async function updateProviderConfigs(
  updates: Partial<Record<ResolvedProviderName, ProviderPathConfig>>,
  env: EnvLike = process.env,
  homeDir = homedir()
): Promise<LoadedConfig> {
  const configPath = getProviderConfigPath(env, homeDir);
  const loadedConfig = loadAppConfig(env, homeDir);
  const nextConfig: AppConfig = {
    ...loadedConfig.config,
    providers: {
      ...(loadedConfig.config.providers ?? {}),
    },
  };

  for (const providerName of Object.keys(updates) as ResolvedProviderName[]) {
    const incoming = updates[providerName];
    if (!incoming) continue;

    const previous = nextConfig.providers?.[providerName] ?? {};
    const nextProviderConfig: ProviderPathConfig = { ...previous };

    if ("storagePath" in incoming) {
      const storagePath = incoming.storagePath?.trim();
      if (storagePath) nextProviderConfig.storagePath = storagePath;
      else delete nextProviderConfig.storagePath;
    }

    if ("stateDbPath" in incoming) {
      const stateDbPath = incoming.stateDbPath?.trim();
      if (stateDbPath) nextProviderConfig.stateDbPath = stateDbPath;
      else delete nextProviderConfig.stateDbPath;
    }

    if (!nextProviderConfig.storagePath && !nextProviderConfig.stateDbPath) {
      delete nextConfig.providers?.[providerName];
    } else {
      nextConfig.providers ??= {};
      nextConfig.providers[providerName] = nextProviderConfig;
    }
  }

  if (nextConfig.providers && Object.keys(nextConfig.providers).length === 0) {
    delete nextConfig.providers;
  }

  await mkdir(dirnameStyledPath(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, "utf-8");
  clearProviderPathCache();
  return loadAppConfig(env, homeDir);
}

function resolvePathWithFallback(options: {
  envKeys: string[];
  configValue?: string;
  configDir: string;
  autoCandidates: string[];
  defaultPath: string;
  kind: PathKind;
  env: EnvLike;
  homeDir: string;
  pathExists: (path: string, kind: PathKind) => boolean;
}): ResolvedPathResult {
  for (const key of options.envKeys) {
    const rawValue = options.env[key]?.trim();
    if (!rawValue) continue;
    const resolved = resolvePathValue(rawValue, options.homeDir, options.env, options.homeDir);
    return {
      path: resolved,
      exists: options.pathExists(resolved, options.kind),
      source: "env",
    };
  }

  const configValue = options.configValue?.trim();
  if (configValue) {
    const resolved = resolvePathValue(configValue, options.homeDir, options.env, options.configDir);
    return {
      path: resolved,
      exists: options.pathExists(resolved, options.kind),
      source: "config",
    };
  }

  for (const candidate of dedupePaths(options.autoCandidates)) {
    if (!candidate) continue;
    if (!options.pathExists(candidate, options.kind)) continue;
    return {
      path: candidate,
      exists: true,
      source: "auto",
    };
  }

  const fallbackPath = resolvePathValue(options.defaultPath, options.homeDir, options.env, options.homeDir);
  return {
    path: fallbackPath,
    exists: options.pathExists(fallbackPath, options.kind),
    source: "default",
  };
}

function buildClaudeStorageCandidates(homeDir: string, env: EnvLike): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  return [
    joinStyledPath(homeDir, ".claude", "projects"),
    ...namedCandidates(sharedRoots, [".claude", "claude", "Claude"], ["projects"]),
  ];
}

function buildCodexStorageCandidates(homeDir: string, env: EnvLike): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  return [
    joinStyledPath(homeDir, ".codex", "sessions"),
    ...namedCandidates(sharedRoots, [".codex", "codex", "Codex"], ["sessions"]),
  ];
}

function buildCodexStateDbCandidates(homeDir: string, env: EnvLike, storagePath: string): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  const storageBaseDir = dirnameStyledPath(storagePath);
  return [
    joinStyledPath(storageBaseDir, "state_5.sqlite"),
    joinStyledPath(storageBaseDir, "state.sqlite"),
    joinStyledPath(homeDir, ".codex", "state_5.sqlite"),
    joinStyledPath(homeDir, ".codex", "state.sqlite"),
    ...namedCandidates(sharedRoots, [".codex", "codex", "Codex"], ["state_5.sqlite"]),
    ...namedCandidates(sharedRoots, [".codex", "codex", "Codex"], ["state.sqlite"]),
  ];
}

function buildIFlowStorageCandidates(homeDir: string, env: EnvLike): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  return [
    joinStyledPath(homeDir, ".iflow", "projects"),
    ...namedCandidates(sharedRoots, [".iflow", "iflow", "iFlow", "IFlow"], ["projects"]),
  ];
}

function getSharedConfigRoots(homeDir: string, env: EnvLike): string[] {
  const roots = [
    homeDir,
    joinStyledPath(homeDir, ".config"),
    joinStyledPath(homeDir, "Library", "Application Support"),
    joinStyledPath(homeDir, "AppData", "Roaming"),
    joinStyledPath(homeDir, "AppData", "Local"),
    env.XDG_CONFIG_HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => resolvePathValue(value, homeDir, env));

  return dedupePaths(roots);
}

function namedCandidates(roots: string[], names: string[], suffixSegments: string[]): string[] {
  const candidates: string[] = [];
  for (const root of roots) {
    for (const name of names) {
      candidates.push(joinStyledPath(root, name, ...suffixSegments));
    }
  }
  return candidates;
}

function dedupePaths(paths: string[]): string[] {
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

function getPathKey(path: string): string {
  if (usesWindowsPathStyle(path)) {
    return win32.normalize(normalizeWindowsLikePath(path)).toLowerCase();
  }
  return posix.normalize(normalizePosixLikePath(path));
}

function resolvePathValue(rawPath: string, homeDir: string, env: EnvLike, baseDir = homeDir): string {
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

function resolveStyledPath(pathValue: string, baseDir: string): string {
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

function joinStyledPath(base: string, ...segments: string[]): string {
  if (usesWindowsPathStyle(base)) {
    return win32.join(normalizeWindowsLikePath(base), ...segments.map(normalizeWindowsLikePath));
  }
  return posix.join(normalizePosixLikePath(base), ...segments.map(normalizePosixLikePath));
}

function dirnameStyledPath(path: string): string {
  if (usesWindowsPathStyle(path)) {
    return win32.dirname(normalizeWindowsLikePath(path));
  }
  return posix.dirname(normalizePosixLikePath(path));
}

function usesWindowsPathStyle(...paths: string[]): boolean {
  return paths.some((path) => isWindowsAbsolutePath(path));
}

function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

function normalizeWindowsLikePath(path: string): string {
  const gitBashMatch = path.match(/^\/([A-Za-z])(?=\/|$)(.*)$/);
  if (gitBashMatch) {
    const rest = (gitBashMatch[2] || "").replace(/\//g, "\\");
    return `${gitBashMatch[1].toUpperCase()}:${rest || "\\"}`;
  }
  return path.replace(/\//g, "\\");
}

function normalizePosixLikePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function defaultPathExists(path: string, kind: PathKind): boolean {
  try {
    const stats = statSync(path);
    return kind === "file" ? stats.isFile() : stats.isDirectory();
  } catch {
    return false;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String((error as { code?: unknown }).code);
  }
  return undefined;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
