import { execFileSync } from "child_process";
import { homedir } from "os";
import type {
  EnvLike,
  PathKind,
  ResolvedPathResult,
  ResolveProviderPathsOptions,
  ResolvedProviderName,
  ResolvedProviderPaths,
} from "./types.js";
import { loadAppConfig, clearConfigLoadCache } from "./config.js";
import { dedupePaths, defaultPathExists, dirnameStyledPath, joinStyledPath, resolvePathValue } from "./path-style.js";

const providerPathCache = new Map<ResolvedProviderName, ResolvedProviderPaths>();

export function clearProviderPathCache(): void {
  providerPathCache.clear();
  clearConfigLoadCache();
}

export function getProviderPaths(providerName: ResolvedProviderName): ResolvedProviderPaths {
  const cached = providerPathCache.get(providerName);
  if (cached) return cached;

  const resolved = resolveProviderPaths(providerName);
  providerPathCache.set(providerName, resolved);
  return resolved;
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
        configDir: options.configDir ?? joinStyledPath(homeDir, ".chatview"),
      }
    : loadAppConfig(env, homeDir);
  const providerConfig = loadedConfig.config.providers?.[providerName];

  if (providerName === "claude-code") {
    const storage = resolvePathWithFallback({
      envKeys: ["CHATVIEW_CLAUDE_CODE_PATH", "CHATLOG_VIEWER_CLAUDE_CODE_PATH"],
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
      envKeys: ["CHATVIEW_IFLOW_PATH", "CHATLOG_VIEWER_IFLOW_PATH"],
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

  if (providerName === "opencode") {
    const hasStorageOverride = !!(env.CHATVIEW_OPENCODE_PATH?.trim() || env.CHATLOG_VIEWER_OPENCODE_PATH?.trim()) || !!providerConfig?.storagePath?.trim();
    const hasStateDbOverride = !!(env.CHATVIEW_OPENCODE_DB_PATH?.trim() || env.CHATLOG_VIEWER_OPENCODE_DB_PATH?.trim()) || !!providerConfig?.stateDbPath?.trim();
    const openCodeDbPath = options.openCodeDbPath === undefined && (!hasStorageOverride || !hasStateDbOverride)
      ? resolveOpenCodeCliDbPath(env, homeDir)
      : options.openCodeDbPath ?? null;
    const storage = resolvePathWithFallback({
      envKeys: ["CHATVIEW_OPENCODE_PATH", "CHATLOG_VIEWER_OPENCODE_PATH"],
      configValue: providerConfig?.storagePath,
      configDir: loadedConfig.configDir,
      autoCandidates: buildOpenCodeStorageCandidates(homeDir, env, openCodeDbPath),
      defaultPath: joinStyledPath(homeDir, ".local", "share", "opencode"),
      kind: "directory",
      env,
      homeDir,
      pathExists,
    });

    const stateDb = resolvePathWithFallback({
      envKeys: ["CHATVIEW_OPENCODE_DB_PATH", "CHATLOG_VIEWER_OPENCODE_DB_PATH"],
      configValue: providerConfig?.stateDbPath,
      configDir: loadedConfig.configDir,
      autoCandidates: buildOpenCodeStateDbCandidates(homeDir, env, storage.path, openCodeDbPath),
      defaultPath: joinStyledPath(homeDir, ".local", "share", "opencode", "opencode.db"),
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

  if (providerName === "pi" || providerName === "codebuddy" || providerName === "workbuddy") {
    const rules: Record<string, { envKeys: string[]; leaves: string[]; nouns: string[] }> = {
      pi: { envKeys: ["CHATVIEW_PI_PATH", "CHATLOG_VIEWER_PI_PATH"], leaves: ["agent", "sessions"], nouns: [".pi", "pi", "Pi"] },
      codebuddy: { envKeys: ["CHATVIEW_CODEBUDDY_PATH", "CHATLOG_VIEWER_CODEBUDDY_PATH"], leaves: ["projects"], nouns: [".codebuddy", "codebuddy", "CodeBuddy"] },
      workbuddy: { envKeys: ["CHATVIEW_WORKBUDDY_PATH", "CHATLOG_VIEWER_WORKBUDDY_PATH"], leaves: [], nouns: [".workbuddy", "workbuddy", "WorkBuddy"] },
    };
    const rule = rules[providerName]!;
    const sharedCliRoots = getSharedConfigRoots(homeDir, env);
    const storage = resolvePathWithFallback({
      envKeys: rule.envKeys,
      configValue: providerConfig?.storagePath,
      configDir: loadedConfig.configDir,
      autoCandidates: [
        joinStyledPath(homeDir, rule.nouns[0]!, ...rule.leaves),
        ...namedCandidates(sharedCliRoots, rule.nouns, rule.leaves),
      ],
      defaultPath: joinStyledPath(homeDir, rule.nouns[0]!, ...rule.leaves),
      kind: "directory",
      env,
      homeDir,
      pathExists,
    });

    if (providerName === "workbuddy") {
      const stateDb = resolvePathWithFallback({
        envKeys: ["CHATVIEW_WORKBUDDY_DB_PATH", "CHATLOG_VIEWER_WORKBUDDY_DB_PATH"],
        configValue: providerConfig?.stateDbPath,
        configDir: loadedConfig.configDir,
        autoCandidates: [
          joinStyledPath(storage.path, "workbuddy.db"),
          joinStyledPath(homeDir, ".workbuddy", "workbuddy.db"),
          ...namedCandidates(sharedCliRoots, [".workbuddy", "workbuddy", "WorkBuddy"], ["workbuddy.db"]),
        ],
        defaultPath: joinStyledPath(homeDir, ".workbuddy", "workbuddy.db"),
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

    return {
      storagePath: storage.path,
      storageExists: storage.exists,
      storageSource: storage.source,
    };
  }

  const storage = resolvePathWithFallback({
    envKeys: ["CHATVIEW_CODEX_SESSIONS_PATH", "CHATLOG_VIEWER_CODEX_SESSIONS_PATH"],
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
    envKeys: ["CHATVIEW_CODEX_STATE_DB_PATH", "CHATLOG_VIEWER_CODEX_STATE_DB_PATH"],
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

function buildOpenCodeStorageCandidates(homeDir: string, env: EnvLike, openCodeDbPath?: string | null): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  return [
    openCodeDbPath ? dirnameStyledPath(openCodeDbPath) : undefined,
    joinStyledPath(homeDir, ".local", "share", "opencode"),
    joinStyledPath(homeDir, ".opencode"),
    ...namedCandidates(sharedRoots, ["opencode", "OpenCode", ".opencode"], []),
  ].filter((value): value is string => !!value);
}

function buildOpenCodeStateDbCandidates(
  homeDir: string,
  env: EnvLike,
  storagePath: string,
  openCodeDbPath?: string | null
): string[] {
  const sharedRoots = getSharedConfigRoots(homeDir, env);
  return [
    joinStyledPath(storagePath, "opencode.db"),
    openCodeDbPath ?? undefined,
    joinStyledPath(homeDir, ".local", "share", "opencode", "opencode.db"),
    joinStyledPath(homeDir, ".opencode", "opencode.db"),
    ...namedCandidates(sharedRoots, ["opencode", "OpenCode", ".opencode"], ["opencode.db"]),
  ].filter((value): value is string => !!value);
}

function resolveOpenCodeCliDbPath(env: EnvLike, homeDir: string): string | null {
  const command = env.CHATVIEW_OPENCODE_BIN?.trim() || env.CHATLOG_VIEWER_OPENCODE_BIN?.trim() || "opencode";
  try {
    const output = execFileSync(command, ["db", "path"], {
      encoding: "utf-8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
      windowsHide: true,
    }).trim();
    const lastLine = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
    return lastLine ? resolvePathValue(lastLine, homeDir, env, homeDir) : null;
  } catch {
    return null;
  }
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
