import { execFileSync } from "child_process";
import { randomUUID } from "crypto";
import { createRequire } from "module";
import { readFileSync, statSync } from "fs";
import { copyFile, cp, mkdir, open, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { homedir } from "os";
import { posix, win32 } from "path";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

export type ResolvedProviderName = "claude-code" | "codex" | "iflow" | "opencode";
export type TitleGenerationCli = "codex" | "claude" | "opencode";
export type TitleGenerationCliSessionMode = "fixed" | "fresh";
type PathKind = "file" | "directory";
type EnvLike = Record<string, string | undefined>;
export type ProviderPathSource = "env" | "config" | "auto" | "default";

const TITLE_GENERATION_CLI_ORDER: TitleGenerationCli[] = ["codex", "claude", "opencode"];
const TITLE_GENERATION_CLI_SET = new Set<TitleGenerationCli>(TITLE_GENERATION_CLI_ORDER);
const TITLE_GENERATION_CLI_SESSION_MODE_SET = new Set<TitleGenerationCliSessionMode>(["fixed", "fresh"]);

export interface ProviderPathConfig {
  storagePath?: string;
  stateDbPath?: string;
}

export interface AiConfig {
  titleGenerationCliPriority?: TitleGenerationCli[];
  titleGenerationCliSessionModes?: Partial<Record<TitleGenerationCli, TitleGenerationCliSessionMode>>;
  titleGenerationCliDisabled?: TitleGenerationCli[];
}

export interface AppConfig {
  providers?: Partial<Record<ResolvedProviderName, ProviderPathConfig>>;
  ai?: AiConfig;
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

export interface ProviderPathMigrationSelection {
  storagePath?: boolean;
  stateDbPath?: boolean;
}

export interface ProviderPathMigrationResult {
  providerName: ResolvedProviderName;
  pathType: "storagePath" | "stateDbPath";
  fromPath: string;
  toPath: string;
  mode: "moved" | "merged";
  message: string;
  cleanupWarning?: string;
}

export interface UpdatedProviderConfigResult extends LoadedConfig {
  migrationResults: ProviderPathMigrationResult[];
}

interface ResolveProviderPathsOptions {
  env?: EnvLike;
  homeDir?: string;
  config?: AppConfig;
  configDir?: string;
  pathExists?: (path: string, kind: PathKind) => boolean;
  openCodeDbPath?: string | null;
}

interface UpdateProviderConfigsOptions {
  migrations?: Partial<Record<ResolvedProviderName, ProviderPathMigrationSelection>>;
  ai?: AiConfig;
}

interface ResolvedPathResult {
  path: string;
  exists: boolean;
  source: ProviderPathSource;
}

interface PreparedProviderPathMigration {
  result: ProviderPathMigrationResult;
  commit(): Promise<void>;
  rollback(): Promise<void>;
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

export function normalizeTitleGenerationCliPriority(
  priority?: readonly string[],
  disabled?: readonly string[]
): TitleGenerationCli[] {
  const disabledSet = new Set(disabled ?? []);
  const normalized: TitleGenerationCli[] = [];
  const seen = new Set<TitleGenerationCli>();

  for (const item of priority ?? []) {
    if (!TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli)) continue;
    const cli = item as TitleGenerationCli;
    if (disabledSet.has(cli)) continue;
    if (seen.has(cli)) continue;
    seen.add(cli);
    normalized.push(cli);
  }

  for (const cli of TITLE_GENERATION_CLI_ORDER) {
    if (disabledSet.has(cli)) continue;
    if (seen.has(cli)) continue;
    normalized.push(cli);
  }

  return normalized;
}

export function getTitleGenerationCliPriority(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const loaded = loadAppConfig(env, homeDir).config.ai;
  return normalizeTitleGenerationCliPriority(
    loaded?.titleGenerationCliPriority,
    loaded?.titleGenerationCliDisabled
  );
}

export function getRawTitleGenerationCliPriority(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const priority = loadAppConfig(env, homeDir).config.ai?.titleGenerationCliPriority;
  if (!Array.isArray(priority)) return [...TITLE_GENERATION_CLI_ORDER];
  return priority.filter((item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli));
}

export function getTitleGenerationCliDisabled(
  env: EnvLike = process.env,
  homeDir = homedir()
): TitleGenerationCli[] {
  const disabled = loadAppConfig(env, homeDir).config.ai?.titleGenerationCliDisabled;
  if (!Array.isArray(disabled)) return [];
  return disabled.filter((item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli));
}

export function normalizeTitleGenerationCliSessionModes(
  modes?: Partial<Record<string, unknown>>
): Record<TitleGenerationCli, TitleGenerationCliSessionMode> {
  const normalized = Object.fromEntries(
    TITLE_GENERATION_CLI_ORDER.map((cli) => [cli, "fresh"])
  ) as Record<TitleGenerationCli, TitleGenerationCliSessionMode>;

  if (!modes || typeof modes !== "object") return normalized;

  for (const cli of TITLE_GENERATION_CLI_ORDER) {
    const mode = modes[cli];
    if (TITLE_GENERATION_CLI_SESSION_MODE_SET.has(mode as TitleGenerationCliSessionMode)) {
      normalized[cli] = mode as TitleGenerationCliSessionMode;
    }
  }

  return normalized;
}

export function getTitleGenerationCliSessionModes(
  env: EnvLike = process.env,
  homeDir = homedir()
): Record<TitleGenerationCli, TitleGenerationCliSessionMode> {
  return normalizeTitleGenerationCliSessionModes(
    loadAppConfig(env, homeDir).config.ai?.titleGenerationCliSessionModes
  );
}

export function getTitleGenerationCliSessionReuse(
  env: EnvLike = process.env,
  homeDir = homedir()
): Record<TitleGenerationCli, boolean> {
  const modes = getTitleGenerationCliSessionModes(env, homeDir);
  return Object.fromEntries(
    TITLE_GENERATION_CLI_ORDER.map((cli) => [cli, modes[cli] === "fixed"])
  ) as Record<TitleGenerationCli, boolean>;
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

  if (providerName === "opencode") {
    const hasStorageOverride = !!env.CHATLOG_VIEWER_OPENCODE_PATH?.trim() || !!providerConfig?.storagePath?.trim();
    const hasStateDbOverride = !!env.CHATLOG_VIEWER_OPENCODE_DB_PATH?.trim() || !!providerConfig?.stateDbPath?.trim();
    const openCodeDbPath = options.openCodeDbPath === undefined && (!hasStorageOverride || !hasStateDbOverride)
      ? resolveOpenCodeCliDbPath(env, homeDir)
      : options.openCodeDbPath ?? null;
    const storage = resolvePathWithFallback({
      envKeys: ["CHATLOG_VIEWER_OPENCODE_PATH"],
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
      envKeys: ["CHATLOG_VIEWER_OPENCODE_DB_PATH"],
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
  homeDir = homedir(),
  options: UpdateProviderConfigsOptions = {}
): Promise<UpdatedProviderConfigResult> {
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

  if (options.ai) {
    const nextAiConfig: AiConfig = { ...(nextConfig.ai ?? {}) };

    if ("titleGenerationCliPriority" in options.ai) {
      nextAiConfig.titleGenerationCliPriority = normalizeTitleGenerationCliPriority(
        options.ai.titleGenerationCliPriority
      );
    }

    if ("titleGenerationCliSessionModes" in options.ai) {
      nextAiConfig.titleGenerationCliSessionModes = normalizeTitleGenerationCliSessionModes(
        options.ai.titleGenerationCliSessionModes
      );
    }

    if ("titleGenerationCliDisabled" in options.ai) {
      const disabled = options.ai.titleGenerationCliDisabled;
      if (Array.isArray(disabled)) {
        nextAiConfig.titleGenerationCliDisabled = disabled.filter(
          (item): item is TitleGenerationCli => TITLE_GENERATION_CLI_SET.has(item as TitleGenerationCli)
        );
      } else {
        delete nextAiConfig.titleGenerationCliDisabled;
      }
    }

    nextConfig.ai = nextAiConfig;
  }

  const preparedMigrations = await prepareProviderPathMigrations(
    options.migrations ?? {},
    loadedConfig,
    nextConfig,
    env,
    homeDir
  );

  try {
    await writeJsonFileAtomically(configPath, nextConfig);
  } catch (error) {
    for (const migration of [...preparedMigrations].reverse()) {
      await migration.rollback().catch(() => undefined);
    }
    throw error;
  }

  for (const migration of preparedMigrations) {
    try {
      await migration.commit();
    } catch (error) {
      migration.result.cleanupWarning = `迁移已生效，但旧路径 staging 清理失败: ${getErrorMessage(error)}`;
      console.error(`[provider-paths] ${migration.result.cleanupWarning}`);
    }
  }
  clearProviderPathCache();
  return {
    ...loadAppConfig(env, homeDir),
    migrationResults: preparedMigrations.map((migration) => migration.result),
  };
}

async function writeJsonFileAtomically(configPath: string, config: AppConfig): Promise<void> {
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirnameStyledPath(configPath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    await rename(temporaryPath, configPath);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function prepareProviderPathMigrations(
  migrations: Partial<Record<ResolvedProviderName, ProviderPathMigrationSelection>>,
  currentConfig: LoadedConfig,
  nextConfig: AppConfig,
  env: EnvLike,
  homeDir: string
): Promise<PreparedProviderPathMigration[]> {
  const prepared: PreparedProviderPathMigration[] = [];

  try {
    for (const providerName of Object.keys(migrations) as ResolvedProviderName[]) {
      const selection = migrations[providerName];
      if (!selection) continue;

      const currentResolved = resolveProviderPaths(providerName, {
        env,
        homeDir,
        config: currentConfig.config,
        configDir: currentConfig.configDir,
      });
      const nextResolved = resolveProviderPaths(providerName, {
        env,
        homeDir,
        config: nextConfig,
        configDir: currentConfig.configDir,
      });

      const stateDbMovesWithStorage = !!(
        selection.storagePath
        && currentResolved.stateDbPath
        && nextResolved.stateDbPath
        && isPathInside(currentResolved.stateDbPath, currentResolved.storagePath)
        && isPathInside(nextResolved.stateDbPath, nextResolved.storagePath)
      );
      const storageExclusions = stateDbMovesWithStorage && currentResolved.stateDbPath
        ? [
            currentResolved.stateDbPath,
            `${currentResolved.stateDbPath}-wal`,
            `${currentResolved.stateDbPath}-shm`,
          ]
        : [];

      if ((selection.stateDbPath || stateDbMovesWithStorage) && currentResolved.stateDbPath && nextResolved.stateDbPath) {
        const stateDbMigration = await maybePrepareResolvedPathMigration(
          providerName,
          "stateDbPath",
          currentResolved.stateDbPath,
          nextResolved.stateDbPath,
          "file",
          homeDir,
          { stageSource: !stateDbMovesWithStorage }
        );
        if (stateDbMigration) prepared.push(stateDbMigration);
      }

      if (selection.storagePath) {
        const storageMigration = await maybePrepareResolvedPathMigration(
          providerName,
          "storagePath",
          currentResolved.storagePath,
          nextResolved.storagePath,
          "directory",
          homeDir,
          { excludedSourcePaths: storageExclusions }
        );
        if (storageMigration) prepared.push(storageMigration);
      }
    }
  } catch (error) {
    for (const migration of [...prepared].reverse()) {
      await migration.rollback().catch(() => undefined);
    }
    throw error;
  }

  return prepared;
}

async function maybePrepareResolvedPathMigration(
  providerName: ResolvedProviderName,
  pathType: "storagePath" | "stateDbPath",
  fromPath: string,
  toPath: string,
  kind: PathKind,
  homeDir: string,
  options: { excludedSourcePaths?: string[]; stageSource?: boolean } = {}
): Promise<PreparedProviderPathMigration | null> {
  if (!fromPath || !toPath) return null;
  if (getPathKey(fromPath) === getPathKey(toPath)) return null;
  assertSafeMigrationPath(providerName, pathType, fromPath, toPath, kind, homeDir);

  const sourceExists = await pathExistsAsync(fromPath, kind);
  if (!sourceExists) return null;

  const prepared = kind === "directory"
    ? await prepareDirectoryMigration(fromPath, toPath, options.excludedSourcePaths ?? [])
    : await prepareFileMigration(
        fromPath,
        toPath,
        pathType === "stateDbPath",
        options.stageSource ?? true
      );

  const label = pathType === "storagePath" ? "Storage Path" : "State DB";
  const action = prepared.mode === "merged" ? "已合并迁移" : "已迁移";

  return {
    result: {
      providerName,
      pathType,
      fromPath,
      toPath,
      mode: prepared.mode,
      message: `${providerName} ${label} ${action}到新路径`,
    },
    commit: prepared.commit,
    rollback: prepared.rollback,
  };
}

async function prepareDirectoryMigration(
  sourceDir: string,
  targetDir: string,
  excludedSourcePaths: string[]
): Promise<{ mode: "moved" | "merged"; commit(): Promise<void>; rollback(): Promise<void> }> {
  const targetStats = await statPath(targetDir);
  if (targetStats && !targetStats.isDirectory()) {
    throw new Error(`自动迁移失败：目标路径不是目录 ${targetDir}`);
  }

  const excludedKeys = new Set(excludedSourcePaths.map((path) => getPathKey(path)));
  const sourceEntries = await readdir(sourceDir, { withFileTypes: true });
  const entriesToCopy = sourceEntries.filter((entry) => {
    const sourceEntry = joinStyledPath(sourceDir, entry.name);
    return !excludedKeys.has(getPathKey(sourceEntry));
  });

  for (const entry of entriesToCopy) {
    const targetEntry = joinStyledPath(targetDir, entry.name);
    if (await statPath(targetEntry)) {
      throw new Error(`自动迁移失败：目标路径已存在同名内容 ${targetEntry}`);
    }
  }

  const targetCreated = !targetStats;
  const copiedTargets: string[] = [];
  const stagedSource = `${sourceDir}.chatlog-viewer-migration-${process.pid}-${randomUUID()}`;
  await mkdir(targetDir, { recursive: true });
  try {
    for (const entry of entriesToCopy) {
      const sourceEntry = joinStyledPath(sourceDir, entry.name);
      const targetEntry = joinStyledPath(targetDir, entry.name);
      await cp(sourceEntry, targetEntry, {
        recursive: entry.isDirectory(),
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      });
      copiedTargets.push(targetEntry);
    }
    await rename(sourceDir, stagedSource);
  } catch (error) {
    for (const target of [...copiedTargets].reverse()) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
    if (targetCreated) {
      await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }

  return {
    mode: targetStats ? "merged" : "moved",
    async commit() {
      await rm(stagedSource, { recursive: true, force: true });
    },
    async rollback() {
      if (await statPath(stagedSource)) {
        await rename(stagedSource, sourceDir);
      }
      if (targetCreated) {
        await rm(targetDir, { recursive: true, force: true });
        return;
      }
      for (const target of [...copiedTargets].reverse()) {
        await rm(target, { recursive: true, force: true });
      }
    },
  };
}

async function prepareFileMigration(
  sourceFile: string,
  targetFile: string,
  sqlite: boolean,
  stageSource: boolean
): Promise<{ mode: "moved"; commit(): Promise<void>; rollback(): Promise<void> }> {
  if (await statPath(targetFile)) {
    throw new Error(`自动迁移失败：目标文件已存在 ${targetFile}`);
  }

  const temporaryPath = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  const sourcePaths = sqlite
    ? [sourceFile, `${sourceFile}-wal`, `${sourceFile}-shm`]
    : [sourceFile];
  const stagedSources: Array<{ sourcePath: string; stagedPath: string }> = [];
  await mkdir(dirnameStyledPath(targetFile), { recursive: true });
  try {
    if (sqlite) {
      const sourceDb = new Database(sourceFile, { readonly: true, fileMustExist: true });
      try {
        await sourceDb.backup(temporaryPath);
      } finally {
        sourceDb.close();
      }

      const targetDb = new Database(temporaryPath, { readonly: true, fileMustExist: true });
      try {
        const check = targetDb.pragma("quick_check", { simple: true });
        if (check !== "ok") {
          throw new Error(`SQLite backup 校验失败: ${String(check)}`);
        }
      } finally {
        targetDb.close();
      }
    } else {
      await copyFile(sourceFile, temporaryPath);
      const handle = await open(temporaryPath, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await rename(temporaryPath, targetFile);

    if (stageSource) {
      for (const sourcePath of sourcePaths) {
        if (!(await statPath(sourcePath))) continue;
        const stagedPath = joinStyledPath(
          dirnameStyledPath(sourceFile),
          `.chatlog-viewer-migration-${process.pid}-${randomUUID()}-${sourcePath.split(/[/\\]/).pop()}`
        );
        await rename(sourcePath, stagedPath);
        stagedSources.push({ sourcePath, stagedPath });
      }
    }
  } catch (error) {
    for (const staged of [...stagedSources].reverse()) {
      await rename(staged.stagedPath, staged.sourcePath).catch(() => undefined);
    }
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    await rm(targetFile, { force: true }).catch(() => undefined);
    throw error;
  }

  return {
    mode: "moved",
    async commit() {
      for (const staged of stagedSources) {
        await rm(staged.stagedPath, { force: true });
      }
    },
    async rollback() {
      await rm(targetFile, { force: true });
      await rm(temporaryPath, { force: true });
      for (const staged of [...stagedSources].reverse()) {
        await rename(staged.stagedPath, staged.sourcePath);
      }
    },
  };
}

function assertSafeMigrationPath(
  providerName: ResolvedProviderName,
  pathType: "storagePath" | "stateDbPath",
  fromPath: string,
  toPath: string,
  kind: PathKind,
  homeDir: string
): void {
  const fromContainer = kind === "file" ? fromPath : fromPath;
  const toContainer = kind === "file" ? toPath : toPath;

  if (isDangerousMigrationRoot(fromContainer, homeDir)) {
    throw new Error(`自动迁移失败：源路径过于宽泛或敏感 ${fromPath}`);
  }
  if (isDangerousMigrationRoot(toContainer, homeDir)) {
    throw new Error(`自动迁移失败：目标路径过于宽泛或敏感 ${toPath}`);
  }
  if (kind === "directory" && isPathInside(toPath, fromPath)) {
    throw new Error(`自动迁移失败：目标路径不能位于源目录内部 ${toPath}`);
  }
  if (kind === "directory" && isPathInside(fromPath, toPath)) {
    throw new Error(`自动迁移失败：源路径不能位于目标目录内部 ${fromPath}`);
  }

  if (pathType === "stateDbPath" && !/\.(sqlite|sqlite3|db)$/i.test(toPath)) {
    throw new Error(`自动迁移失败：${providerName} State DB 目标路径必须是 sqlite/db 文件`);
  }
}

function isDangerousMigrationRoot(path: string, homeDir: string): boolean {
  const normalized = getPathKey(path);
  const normalizedHome = getPathKey(homeDir);
  const normalizedParent = getPathKey(dirnameStyledPath(path));
  if (!normalized || normalized === "." || normalized === normalizedParent) return true;
  if (normalized === normalizedHome) return true;

  if (usesWindowsPathStyle(path, homeDir)) {
    const windowsPath = win32.normalize(normalizeWindowsLikePath(path)).toLowerCase();
    if (/^[a-z]:\\?$/.test(windowsPath)) return true;
    return [
      "c:\\windows",
      "c:\\program files",
      "c:\\program files (x86)",
      "c:\\programdata",
    ].some((root) => windowsPath === root || windowsPath.startsWith(`${root}\\`));
  }

  return ["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/root", "/sbin", "/sys", "/usr", "/var"]
    .some((root) => normalized === root || normalized.startsWith(`${root}/`));
}

function isPathInside(path: string, possibleParent: string): boolean {
  const normalizedPath = getPathKey(path);
  const normalizedParent = getPathKey(possibleParent);
  if (normalizedPath === normalizedParent) return false;
  const separator = usesWindowsPathStyle(path, possibleParent) ? "\\" : "/";
  return normalizedPath.startsWith(`${normalizedParent}${separator}`);
}

async function statPath(path: string) {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

async function pathExistsAsync(path: string, kind: PathKind): Promise<boolean> {
  const stats = await statPath(path);
  if (!stats) return false;
  return kind === "file" ? stats.isFile() : stats.isDirectory();
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
  const command = env.CHATLOG_VIEWER_OPENCODE_BIN?.trim() || "opencode";
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
