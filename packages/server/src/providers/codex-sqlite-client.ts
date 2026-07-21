import { createRequire } from "module";
import { createHash } from "crypto";
import { statSync } from "fs";
import type BetterSqlite3 from "better-sqlite3";
import {
  ProviderDataError,
  createProviderDataError,
  isFileSystemNotFoundError,
} from "../utils/errors.js";
import { normalizePath } from "./shared/provider-utils.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

export interface CodexThreadRow {
  id: string;
  rolloutPath: string;
  createdAt: number;
  updatedAt: number;
  source: string;
  modelProvider?: string;
  cwd: string;
  title?: string;
  firstUserMessage?: string;
}

export interface CodexThreadMetadata {
  modelProvider?: string;
  title?: string;
  firstUserMessage?: string;
  preview?: string;
}

export interface ThreadLocationUpdates {
  cwd?: string;
  rolloutPath?: string | null;
}

function normalizeCodexTimestamp(value: number | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
}

export function formatCodexStoredPath(value?: string): string | undefined {
  if (!value) return undefined;
  const normalized = normalizePath(value);
  if (/^[A-Za-z]:\//.test(normalized)) {
    return normalized.replace(/\//g, "\\");
  }
  return normalized;
}

// 封装 Codex state_5.sqlite 的只读 + 写入连接生命周期与高层查询。
// 读写分离：readonly handle 用于查询（共享），writable handle 在写入场景复用。
// 同一进程生命周期内复用连接，切换 dbPath 时自动关闭重建。
export class CodexSqliteClient {
  private readDb: BetterSqlite3.Database | null = null;
  private readDbPath: string | null = null;
  private writeDb: BetterSqlite3.Database | null = null;
  private writeDbPath: string | null = null;
  private tableColumnsByDb = new WeakMap<BetterSqlite3.Database, Map<string, Set<string>>>();

  constructor(private readonly dbPathProvider: () => string) {}

  close(): void {
    this.closeRead();
    this.closeWrite();
  }

  private closeRead(): void {
    if (this.readDb) {
      this.tableColumnsByDb.delete(this.readDb);
      this.readDb.close();
      this.readDb = null;
    }
    this.readDbPath = null;
  }

  private closeWrite(): void {
    if (this.writeDb) {
      this.tableColumnsByDb.delete(this.writeDb);
      this.writeDb.close();
      this.writeDb = null;
    }
    this.writeDbPath = null;
  }

  getReadDb(): BetterSqlite3.Database | null {
    const dbPath = this.dbPathProvider();
    if (this.readDb && this.readDbPath === dbPath) return this.readDb;

    this.closeRead();

    try {
      statSync(dbPath);
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return null;
      throw createProviderDataError("codex", `Codex State DB 无法访问: ${dbPath}`, error);
    }

    try {
      this.readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.readDbPath = dbPath;
      return this.readDb;
    } catch (error) {
      this.readDb = null;
      this.readDbPath = null;
      throw createProviderDataError("codex", `Codex State DB 无法读取: ${dbPath}`, error);
    }
  }

  // 打开 writable 前关闭 readonly 避免锁冲突。
  getWriteDb(options: { fileMustExist?: boolean } = {}): BetterSqlite3.Database {
    const dbPath = this.dbPathProvider();
    if (this.writeDb && this.writeDbPath === dbPath) return this.writeDb;

    this.closeWrite();
    this.closeRead();

    try {
      this.writeDb = new Database(dbPath, options.fileMustExist === false ? undefined : { fileMustExist: true });
      this.writeDbPath = dbPath;
      return this.writeDb;
    } catch (error) {
      this.writeDb = null;
      this.writeDbPath = null;
      throw createProviderDataError("codex", `Codex State DB 无法写入: ${dbPath}`, error);
    }
  }

  getTableColumns(db: BetterSqlite3.Database, tableName: string): Set<string> {
    const cachedTables = this.tableColumnsByDb.get(db);
    const cachedColumns = cachedTables?.get(tableName);
    if (cachedColumns) return cachedColumns;

    try {
      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      const columns = new Set(rows.map((row) => row.name));
      const nextTables = cachedTables ?? new Map<string, Set<string>>();
      nextTables.set(tableName, columns);
      this.tableColumnsByDb.set(db, nextTables);
      return columns;
    } catch (error) {
      throw createProviderDataError("codex", `Codex State DB 表结构读取失败: ${tableName}`, error);
    }
  }

  private getRequiredThreadColumns(db: BetterSqlite3.Database): Set<string> {
    const columns = this.getTableColumns(db, "threads");
    if (!columns.has("id")) {
      throw new ProviderDataError(
        "codex",
        "schema-incompatible",
        "Codex State DB schema 不兼容：缺少 threads.id"
      );
    }
    return columns;
  }

  getThreadColumns(): Set<string> {
    const db = this.getReadDb();
    if (!db) return new Set();
    return this.getRequiredThreadColumns(db);
  }

  getThreadMetadata(sessionId: string): CodexThreadMetadata {
    const db = this.getReadDb();
    if (!db) return {};
    try {
      const columns = this.getRequiredThreadColumns(db);

      const row = db
        .prepare(`
          SELECT
            ${columns.has("model_provider") ? "model_provider" : "NULL"} AS model_provider,
            ${columns.has("title") ? "title" : "NULL"} AS title,
            ${columns.has("first_user_message") ? "first_user_message" : "NULL"} AS first_user_message,
            ${columns.has("preview") ? "preview" : "NULL"} AS preview
          FROM threads
          WHERE id = ?
        `)
        .get(sessionId) as {
          model_provider: string | null;
          title: string | null;
          first_user_message: string | null;
          preview: string | null;
        } | undefined;
      return {
        modelProvider: row?.model_provider ?? undefined,
        title: row?.title ?? undefined,
        firstUserMessage: row?.first_user_message ?? undefined,
        preview: row?.preview ?? undefined,
      };
    } catch (error) {
      throw createProviderDataError("codex", "Codex State DB 对话 metadata 读取失败", error);
    }
  }

  listThreads(): CodexThreadRow[] {
    const db = this.getReadDb();
    if (!db) return [];

    try {
      const columns = this.getRequiredThreadColumns(db);

      const hasRolloutPath = columns.has("rollout_path");
      const hasCreatedAt = columns.has("created_at");
      const hasUpdatedAt = columns.has("updated_at");
      const hasSource = columns.has("source");
      const hasModelProvider = columns.has("model_provider");
      const hasCwd = columns.has("cwd");
      const hasTitle = columns.has("title");
      const hasFirstUserMessage = columns.has("first_user_message");

      const rows = db.prepare(`
        SELECT
          id,
          ${hasRolloutPath ? "rollout_path" : "''"} AS rollout_path,
          ${hasCreatedAt ? "created_at" : "0"} AS created_at,
          ${hasUpdatedAt ? "updated_at" : "0"} AS updated_at,
          ${hasSource ? "source" : "'cli'"} AS source,
          ${hasModelProvider ? "model_provider" : "NULL"} AS model_provider,
          ${hasCwd ? "cwd" : "''"} AS cwd,
          ${hasTitle ? "title" : "NULL"} AS title,
          ${hasFirstUserMessage ? "first_user_message" : "NULL"} AS first_user_message
        FROM threads
      `).all() as Array<{
        id: string;
        rollout_path: string;
        created_at: number | null;
        updated_at: number | null;
        source: string;
        model_provider: string | null;
        cwd: string;
        title: string | null;
        first_user_message: string | null;
      }>;

      return rows.map((row) => {
        const fallbackTimestamp = Date.now();
        const createdAt = normalizeCodexTimestamp(row.created_at, fallbackTimestamp);
        const updatedAt = normalizeCodexTimestamp(row.updated_at, createdAt);

        return {
          id: row.id,
          rolloutPath: normalizePath(row.rollout_path || ""),
          createdAt,
          updatedAt,
          source: row.source || "cli",
          modelProvider: row.model_provider ?? undefined,
          cwd: row.cwd || "",
          title: row.title ?? undefined,
          firstUserMessage: row.first_user_message ?? undefined,
        };
      });
    } catch (error) {
      throw createProviderDataError("codex", "Codex State DB 对话索引读取失败", error);
    }
  }

  findThread(sessionId: string): CodexThreadRow | null {
    return this.listThreads().find((thread) => thread.id === sessionId) ?? null;
  }

  getThreadsSignature(): string | null {
    const db = this.getReadDb();
    if (!db) return null;

    try {
      const columns = this.getRequiredThreadColumns(db);

      const selectedColumns = [
        "id",
        "rollout_path",
        "created_at",
        "updated_at",
        "source",
        "model_provider",
        "cwd",
        "title",
        "first_user_message",
        "preview",
        "archived",
        "thread_source",
      ].filter((column) => columns.has(column));

      const rows = db.prepare(`
        SELECT ${selectedColumns.join(", ")}
        FROM threads
        ORDER BY id
      `).all() as Array<Record<string, unknown>>;

      const hash = createHash("sha1");
      hash.update(selectedColumns.join("\0"));
      for (const row of rows) {
        hash.update("\0");
        hash.update(JSON.stringify(row));
      }
      return hash.digest("hex");
    } catch (error) {
      throw createProviderDataError("codex", "Codex State DB signature 读取失败", error);
    }
  }

  // 级联删除 thread 及其关联表行。仅删除已存在的表/列。
  deleteThread(sessionId: string): boolean {
    let db: BetterSqlite3.Database;
    try {
      db = this.getWriteDb({ fileMustExist: true });
    } catch {
      return false;
    }

    const tableNames = new Set(
      (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).
        map((row) => row.name)
    );
    const relatedDeletes = [
      { table: "thread_dynamic_tools", columns: ["thread_id"] },
      { table: "stage1_outputs", columns: ["thread_id"] },
      { table: "thread_spawn_edges", columns: ["child_thread_id", "parent_thread_id"] },
      { table: "agent_job_items", columns: ["assigned_thread_id"] },
      { table: "logs", columns: ["thread_id"] },
    ];

    const deleteTransaction = db.transaction((targetSessionId: string) => {
      let changes = 0;

      for (const item of relatedDeletes) {
        if (!tableNames.has(item.table)) continue;
        const columns = this.getTableColumns(db, item.table);
        for (const column of item.columns) {
          if (!columns.has(column)) continue;
          const result = db.prepare(`DELETE FROM ${item.table} WHERE ${column} = ?`).run(targetSessionId);
          changes += result.changes;
        }
      }

      if (tableNames.has("threads") && this.getTableColumns(db, "threads").has("id")) {
        const result = db.prepare("DELETE FROM threads WHERE id = ?").run(targetSessionId);
        changes += result.changes;
      }

      return changes;
    });

    return deleteTransaction(sessionId) > 0;
  }

  writeDisplayTitle(
    sessionId: string,
    title: string
  ): void {
    const db = this.getWriteDb({ fileMustExist: true });
    const columns = this.getTableColumns(db, "threads");
    if (!columns.has("id")) {
      throw new Error("Codex state db 缺少标题字段，无法写入标题");
    }

    const titleColumn = columns.has("title")
      ? "title"
      : (columns.has("first_user_message") ? "first_user_message" : null);
    if (!titleColumn) {
      throw new Error("Codex state db 缺少 title 字段，无法写入标题");
    }

    const result = db.prepare(`UPDATE threads SET ${titleColumn} = ? WHERE id = ?`).run(title, sessionId);
    if (result.changes === 0) {
      throw new Error(`SQLite 中未找到对话: ${sessionId}`);
    }

    const row = db.prepare(`
      SELECT ${titleColumn} AS persisted_title
      FROM threads
      WHERE id = ?
    `).get(sessionId) as { persisted_title: string | null } | undefined;
    if (row?.persisted_title !== title) {
      throw new Error(`Codex state db 标题写入校验失败: ${sessionId}`);
    }
  }

  updateThreadLocation(sessionId: string, updates: ThreadLocationUpdates): boolean {
    let db: BetterSqlite3.Database;
    try {
      db = this.getWriteDb({ fileMustExist: true });
    } catch {
      return false;
    }

    const columns = this.getTableColumns(db, "threads");
    if (columns.size === 0) return false;

    const assignments: string[] = [];
    const values: unknown[] = [];

    if (updates.cwd !== undefined && columns.has("cwd")) {
      assignments.push("cwd = ?");
      values.push(formatCodexStoredPath(updates.cwd) ?? updates.cwd);
    }

    if (updates.rolloutPath !== undefined && columns.has("rollout_path")) {
      assignments.push("rollout_path = ?");
      values.push(updates.rolloutPath ? formatCodexStoredPath(updates.rolloutPath) ?? updates.rolloutPath : "");
    }

    if (assignments.length === 0) return false;

    values.push(sessionId);
    const result = db.prepare(`UPDATE threads SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
    return result.changes > 0;
  }

  listModelProviders(): string[] {
    const db = this.getReadDb();
    if (!db) return [];
    try {
      const columns = this.getRequiredThreadColumns(db);
      if (!columns.has("model_provider")) return [];
      const rows = db
        .prepare("SELECT DISTINCT model_provider FROM threads ORDER BY model_provider")
        .all() as { model_provider: string }[];
      return rows.map((r) => r.model_provider);
    } catch (error) {
      throw createProviderDataError("codex", "Codex model provider 读取失败", error);
    }
  }

  // 事务内批量更新 model_provider。SQLite 层不处理缓存失效 —— 留给 Provider。
  changeModelProvidersForSessions(sessionIds: string[], newProvider: string): void {
    const db = this.getWriteDb();
    const updateStatement = db.prepare("UPDATE threads SET model_provider = ? WHERE id = ?");
    const updateMany = db.transaction((targets: string[]) => {
      for (const sessionId of targets) {
        const result = updateStatement.run(newProvider, sessionId);
        if (result.changes === 0) {
          throw new Error(`SQLite 中未找到对话: ${sessionId}`);
        }
      }
    });

    updateMany(sessionIds);
  }
}
