import { createRequire } from "module";
import type BetterSqlite3 from "better-sqlite3";

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
}

export interface ThreadLocationUpdates {
  cwd?: string;
  rolloutPath?: string | null;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
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

  constructor(private readonly dbPathProvider: () => string) {}

  close(): void {
    this.closeRead();
    this.closeWrite();
  }

  private closeRead(): void {
    if (this.readDb) {
      this.readDb.close();
      this.readDb = null;
    }
    this.readDbPath = null;
  }

  private closeWrite(): void {
    if (this.writeDb) {
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
      this.readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.readDbPath = dbPath;
      return this.readDb;
    } catch {
      this.readDbPath = null;
      return null;
    }
  }

  // 打开 writable 前关闭 readonly 避免锁冲突。
  getWriteDb(options: { fileMustExist?: boolean } = {}): BetterSqlite3.Database {
    const dbPath = this.dbPathProvider();
    if (this.writeDb && this.writeDbPath === dbPath) return this.writeDb;

    this.closeWrite();
    this.closeRead();

    this.writeDb = new Database(dbPath, options.fileMustExist === false ? undefined : { fileMustExist: true });
    this.writeDbPath = dbPath;
    return this.writeDb;
  }

  getTableColumns(db: BetterSqlite3.Database, tableName: string): Set<string> {
    try {
      const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
      return new Set(rows.map((row) => row.name));
    } catch {
      return new Set();
    }
  }

  getThreadColumns(): Set<string> {
    const db = this.getReadDb();
    if (!db) return new Set();
    return this.getTableColumns(db, "threads");
  }

  getThreadMetadata(sessionId: string): CodexThreadMetadata {
    const db = this.getReadDb();
    if (!db) return {};
    try {
      const row = db
        .prepare("SELECT model_provider, title, first_user_message FROM threads WHERE id = ?")
        .get(sessionId) as { model_provider: string; title: string | null; first_user_message: string | null } | undefined;
      return {
        modelProvider: row?.model_provider,
        title: row?.title ?? undefined,
        firstUserMessage: row?.first_user_message ?? undefined,
      };
    } catch {
      return {};
    }
  }

  listThreads(): CodexThreadRow[] {
    const db = this.getReadDb();
    if (!db) return [];

    try {
      const columns = this.getTableColumns(db, "threads");
      if (!columns.has("id")) return [];

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
    } catch {
      return [];
    }
  }

  findThread(sessionId: string): CodexThreadRow | null {
    return this.listThreads().find((thread) => thread.id === sessionId) ?? null;
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
    title: string,
    options?: { updateTitleField?: boolean }
  ): void {
    const db = this.getWriteDb({ fileMustExist: true });
    const columns = this.getTableColumns(db, "threads");
    if (!columns.has("id") || !columns.has("first_user_message")) {
      throw new Error("Codex state db 缺少标题字段，无法写入标题");
    }
    if (options?.updateTitleField !== false && !columns.has("title")) {
      throw new Error("Codex state db 缺少 title 字段，无法写入标题");
    }

    const result = options?.updateTitleField === false
      ? db.prepare("UPDATE threads SET first_user_message = ? WHERE id = ?").run(title, sessionId)
      : db.prepare("UPDATE threads SET title = ?, first_user_message = ? WHERE id = ?").run(title, title, sessionId);
    if (result.changes === 0) {
      throw new Error(`SQLite 中未找到对话: ${sessionId}`);
    }

    const row = options?.updateTitleField === false
      ? db.prepare("SELECT first_user_message FROM threads WHERE id = ?").get(sessionId) as { title?: string | null; first_user_message: string | null } | undefined
      : db.prepare("SELECT title, first_user_message FROM threads WHERE id = ?").get(sessionId) as { title?: string | null; first_user_message: string | null } | undefined;
    const titleMatches = options?.updateTitleField === false || row?.title === title;
    if (!row || !titleMatches || row.first_user_message !== title) {
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
      const rows = db
        .prepare("SELECT DISTINCT model_provider FROM threads ORDER BY model_provider")
        .all() as { model_provider: string }[];
      return rows.map((r) => r.model_provider);
    } catch {
      return [];
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
