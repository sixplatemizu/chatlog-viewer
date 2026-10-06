import { randomUUID } from "crypto";
import { createRequire } from "module";
import { copyFile, cp, mkdir, open, readdir, rename, rm, stat } from "fs/promises";
import { win32 } from "path";
import type BetterSqlite3 from "better-sqlite3";
import type {
  AppConfig,
  EnvLike,
  LoadedConfig,
  PathKind,
  PreparedProviderPathMigration,
  ProviderPathMigrationSelection,
  ResolvedProviderName,
} from "./types.js";
import { resolveProviderPaths } from "./resolve.js";
import { dirnameStyledPath, getPathKey, joinStyledPath, normalizeWindowsLikePath, usesWindowsPathStyle } from "./path-style.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

export async function prepareProviderPathMigrations(
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
      // 先探测独占锁（不能在事务内 backup），避免活动 DB 上半迁移
      const probeDb = new Database(sourceFile, { fileMustExist: true, timeout: 50 });
      try {
        try {
          probeDb.exec("BEGIN EXCLUSIVE");
          probeDb.exec("ROLLBACK");
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`SQLite 数据库正被占用，无法迁移: ${message}`);
        }
      } finally {
        probeDb.close();
      }

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
