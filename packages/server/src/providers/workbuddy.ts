import BetterSqlite3 from "better-sqlite3";
import { join } from "path";
import { stat, unlink, rename, mkdir, readdir } from "fs/promises";
import { glob } from "glob";
import {
  parseJsonlWithMeta,
  parseJsonlTailWithMeta,
  type JsonlLine,
} from "../utils/jsonl.js";
import { getIndexedListCache, setCache, setIndexedListCache, invalidateCache, invalidateListCache, type IndexedCacheItem } from "../utils/cache/index.js";
import { logProviderError } from "../utils/logger.js";
import { getProviderPaths } from "../utils/provider-paths/index.js";
import {
  createProviderDataError,
  isFileSystemNotFoundError,
} from "../utils/errors.js";
import {
  collectGlobFileStates,
  createIndexedListSourceSignature,
  type IndexedSourceFile,
} from "../utils/provider-indexing.js";
import {
  createConversationSearchIndexBuilder,
  type ConversationSearchIndexBuilder,
} from "../utils/search-index.js";
import {
  assignStableMessageIds,
  createMessageSourceKey,
  createStableMessageSourceKey,
  invalidateMessageActionIndex,
  normalizeUpdatedMessageContent,
  primeMessageActionIndex,
  resolveMessageLineNumbers,
  rewriteJsonlFileLine,
  rewriteJsonlFileLines,
  type MessageRecord,
} from "../utils/message-actions.js";
import { runKeyedMutation } from "../utils/mutation-queue.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  ConversationBadge,
  ConversationReadOptions,
  ConversationListOptions,
} from "./types.js";
import {
  normalizePath,
  canonicalizeProjectPath,
  getProjectSpecificity,
  getListCacheKey,
  sliceWindow,
  applyProjectDisplayPathHints,
  removeEmptyParentDirs,
} from "./shared/provider-utils.js";

interface WorkBuddyContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

interface WorkBuddyEntry {
  id?: string;
  parentId?: string | null;
  timestamp?: number;
  type: string;
  role?: string;
  status?: string;
  content?: WorkBuddyContentBlock[];
  providerData?: Record<string, unknown>;
  sessionId?: string;
  cwd?: string;
  aiTitle?: string;
  name?: string;
  callId?: string;
  output?: unknown;
  summary?: string;
}

interface WorkBuddySessionRow {
  id: string;
  cwd: string;
  title: string | null;
  custom_title: string | null;
  status: string | null;
  created_at: number;
  updated_at: number;
  last_activity_at: number | null;
  deleted_at: number | null;
  source_mode: string | null;
  model: string | null;
  permission_mode: string | null;
  is_playground: number | null;
}

const WORKBUDDY_DB_TABLES = new Set([
  "sessions",
  "workspaces",
  "automations",
  "automation_runs",
  "automation_runtime_state",
  "automation_delivery_outbox",
  "migration_meta",
  "session_usage",
  "buddy_snapshots",
]);

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function extractTextContent(content: WorkBuddyContentBlock[] | undefined): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && (block.type === "input_text" || block.type === "output_text") && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function extractOutputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output && typeof output === "object") {
    const record = output as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if (record.content !== undefined) return extractOutputText(record.content);
  }
  return "";
}

function buildMessageRecords(entries: JsonlLine<WorkBuddyEntry>[]): MessageRecord<WorkBuddyEntry>[] {
  const records: MessageRecord<WorkBuddyEntry>[] = [];
  for (const entry of entries) {
    const value = entry.value;
    if (value.type === "message" && (value.role === "user" || value.role === "assistant")) {
      const text = extractTextContent(value.content);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "workbuddy",
          [value.id, value.parentId, value.timestamp, value.role, value.sessionId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "workbuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: value.role,
          content: text,
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
        },
      });
      continue;
    }

    if (value.type === "function_call") {
      const args = typeof value.providerData?.arguments === "string"
        ? value.providerData.arguments
        : JSON.stringify(value.providerData?.arguments ?? value.content ?? "");
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "workbuddy",
          [value.id, value.parentId, value.timestamp, "function_call", value.name, value.callId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "workbuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: "tool",
          content: args.slice(0, 2000),
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
          toolName: typeof value.name === "string" && value.name ? value.name : "unknown",
          toolInput: args,
        },
      });
      continue;
    }

    if (value.type === "function_call_result") {
      const text = extractOutputText(value.output);
      if (!text.trim()) continue;
      records.push({
        entry: value,
        sourceKey: createStableMessageSourceKey(
          "workbuddy",
          [value.id, value.parentId, value.timestamp, "function_call_result", value.name, value.callId],
          entry.rawLine
        ) ?? createMessageSourceKey(entry.rawLine, "workbuddy"),
        lineIndex: entry.lineNumber,
        message: {
          role: "tool",
          content: text,
          timestamp: typeof value.timestamp === "number" ? value.timestamp : undefined,
          toolName: typeof value.name === "string" && value.name ? value.name : "unknown",
          toolResult: text,
        },
      });
    }
  }

  return assignStableMessageIds(records);
}

function appendSearchIndexEntry(
  builder: ConversationSearchIndexBuilder,
  entry: WorkBuddyEntry
): void {
  if (entry.type === "message" && (entry.role === "user" || entry.role === "assistant")) {
    const text = extractTextContent(entry.content);
    if (!text.trim()) return;
    builder.addMessage({
      role: entry.role,
      content: text,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
    return;
  }
  if (entry.type === "function_call_result") {
    const text = extractOutputText(entry.output);
    if (!text.trim()) return;
    builder.addMessage({
      role: "assistant",
      content: text,
      timestamp: typeof entry.timestamp === "number" ? entry.timestamp : undefined,
    });
  }
}

function buildSessionFilePath(dbPath: string, sessionId: string): string {
  return `${normalizePath(dbPath)}#session/${sessionId}`;
}

function buildBadges(row: Pick<WorkBuddySessionRow, "status" | "deleted_at" | "source_mode" | "is_playground" | "model">): ConversationBadge[] | undefined {
  const badges: ConversationBadge[] = [];
  if (row.deleted_at !== null && row.deleted_at !== undefined) {
    badges.push({
      label: "已删除",
      tone: "rose",
      title: "WorkBuddy 已删除的 session，仅 DB 残留记录",
    });
  }
  if (row.is_playground) {
    badges.push({
      label: "playground",
      tone: "amber",
      title: "WorkBuddy playground 会话",
    });
  }
  if (row.source_mode && row.source_mode !== row.status) {
    badges.push({
      label: row.source_mode,
      tone: "gray",
      title: `WorkBuddy 来源模式：${row.source_mode}`,
    });
  }
  if (row.status && row.status !== "completed") {
    badges.push({
      label: row.status,
      tone: "blue",
      title: `WorkBuddy 会话状态：${row.status}`,
    });
  }
  return badges.length > 0 ? badges : undefined;
}

// projects 子目录名编码：按 / 与 \ 分段，盘符段去冒号转小写，段间以 - 连接。
// 与 WorkBuddy 产品的存储布局一致（如 D:/a/b → d-a-b）。
function encodeWorkBuddyProjectDir(cwd: string): string {
  const segments = cwd.split(/[\\/]+/).filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error("目标文件夹不合法");
  }
  const [first, ...rest] = segments;
  const head = first && /^[A-Za-z]:$/.test(first) ? first.slice(0, 1).toLowerCase() : first!;
  return [head, ...rest].join("-");
}

export class WorkBuddyProvider implements ConversationProvider {
  name = "workbuddy";
  displayName = "WorkBuddy";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
    canEditMessage: true,
    canDeleteMessage: true,
    canMoveConversation: true,
    canDeleteConversation: true,
    supportsMetadataOnly: true,
  } as const;

  private readDb: BetterSqlite3.Database | null = null;
  private readDbPath: string | null = null;
  private backgroundRefreshes = new Map<string, Promise<void>>();

  getStoragePath(): string {
    return getProviderPaths("workbuddy").storagePath;
  }

  private getDbPath(): string {
    const paths = getProviderPaths("workbuddy");
    return paths.stateDbPath ?? `${paths.storagePath}/workbuddy.db`;
  }

  async detect(): Promise<boolean> {
    try {
      const dbStat = await stat(this.getDbPath());
      return dbStat.isFile();
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return false;
      throw createProviderDataError(this.name, "WorkBuddy 数据库检测失败", error);
    }
  }

  async getListSourceSignature(): Promise<string | null> {
    try {
      const dbPath = this.getDbPath();
      const dbStat = await stat(dbPath);
      const dbSourceFiles: IndexedSourceFile[] = [
        {
          path: normalizePath(dbPath),
          mtimeMs: dbStat.mtimeMs,
          size: dbStat.size,
        },
      ];
      // 关联 transcript 文件变化（DB 只存索引）
      const transcriptStates = await this.collectTranscriptFileStates().catch(() => []);
      return createIndexedListSourceSignature([...dbSourceFiles, ...transcriptStates]);
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return null;
      throw createProviderDataError(this.name, "WorkBuddy 数据源 signature 读取失败", error);
    }
  }

  private async collectTranscriptFileStates(): Promise<IndexedSourceFile[]> {
    const pattern = join(this.getStoragePath(), "projects", "*", "*.jsonl").replace(/\\/g, "/");
    try {
      return await collectGlobFileStates(pattern);
    } catch (error) {
      throw createProviderDataError(this.name, "WorkBuddy 会话文件索引读取失败", error);
    }
  }

  closeDb(): void {
    if (this.readDb) {
      try {
        this.readDb.close();
      } catch {
        // 忽略关闭失败
      }
    }
    this.readDb = null;
    this.readDbPath = null;
  }

  private getReadDb(): BetterSqlite3.Database {
    const dbPath = this.getDbPath();
    if (this.readDb && this.readDbPath === dbPath) {
      return this.readDb;
    }

    this.closeDb();
    try {
      this.readDb = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
      this.readDbPath = dbPath;
      return this.readDb;
    } catch (error) {
      this.readDb = null;
      this.readDbPath = null;
      throw createProviderDataError(
        this.name,
        `WorkBuddy 数据库无法读取: ${this.getDbPath()}`,
        error,
      );
    }
  }

  private getWriteDb(): BetterSqlite3.Database {
    this.closeDb();
    return new BetterSqlite3(this.getDbPath(), { fileMustExist: true });
  }

  private getTableNames(db: BetterSqlite3.Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private hasColumn(db: BetterSqlite3.Database, tableName: string, columnName: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private getListCacheKey(): string {
    return getListCacheKey(this.name, this.getStoragePath());
  }

  private async listInternal(options: {
    eagerSearchIndex: boolean;
    allowBackground: boolean;
    onWarning?: ConversationListOptions["onWarning"];
  }): Promise<ConversationMeta[]> {
    const sourceSignature = await this.getListSourceSignature();
    if (!sourceSignature) {
      throw createProviderDataError(
        this.name,
        `WorkBuddy 数据库不存在或无法读取: ${this.getDbPath()}`,
        new Error("missing source signature"),
      );
    }

    const cacheKey = this.getListCacheKey();
    const cachedItems = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex,
      sourceSignature,
    });
    if (cachedItems) {
      return [...cachedItems].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const rows = this.listSessionRows();
    // DB 无 transcript 的会话直接过滤（projects 下无对应文件）
    const metas = new Map<string, IndexedCacheItem>();
    for (const row of rows) {
      const item = await this.buildIndexedCacheItem(row, options.eagerSearchIndex);
      if (item) metas.set(item.meta.id, item);
    }
    const normalizedResults = applyProjectDisplayPathHints([...metas.values()]);

    const searchReady = options.eagerSearchIndex;
    setIndexedListCache(cacheKey, normalizedResults, {
      searchReady,
      sourceSignature,
      writeSearchData: options.eagerSearchIndex,
    });

    if (!searchReady && options.allowBackground) {
      this.scheduleBackgroundIndexRefresh();
    }

    return normalizedResults.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private scheduleBackgroundIndexRefresh(): void {
    const cacheKey = this.getListCacheKey();
    if (this.backgroundRefreshes.has(cacheKey)) {
      return;
    }

    const task = new Promise<void>((resolve) => {
      setTimeout(() => {
        this.listInternal({
          eagerSearchIndex: true,
          allowBackground: false,
        })
          .then(() => undefined)
          .catch((error) => {
            logProviderError("conversations.index.background", this.name, error);
          })
          .finally(() => {
            this.backgroundRefreshes.delete(cacheKey);
            resolve();
          });
      }, 250);
    });

    this.backgroundRefreshes.set(cacheKey, task);
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationMeta[]> {
    return this.listInternal({
      eagerSearchIndex: options.eagerSearchIndex ?? false,
      allowBackground: true,
      onWarning: options.onWarning,
    });
  }

  private listSessionRows(): WorkBuddySessionRow[] {
    const db = this.getReadDb();
    try {
      const tables = this.getTableNames(db);
      if (!tables.has("sessions")) {
        throw new Error("缺少 sessions 表");
      }
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${quoteIdentifier("sessions")})`).all() as Array<{ name: string }>)
          .map((row) => row.name)
      );
      const wanted = [
        "id", "cwd", "title", "custom_title", "status",
        "created_at", "updated_at", "last_activity_at", "deleted_at",
        "source_mode", "model", "permission_mode", "is_playground",
      ].filter((column) => columns.has(column));
      return db.prepare(`
        SELECT ${wanted.map(quoteIdentifier).join(", ")}
        FROM sessions
        ORDER BY updated_at DESC
      `).all() as WorkBuddySessionRow[];
    } catch (error) {
      throw createProviderDataError(this.name, "WorkBuddy 会话索引读取失败", error);
    }
  }

  private async locateTranscriptFile(sessionId: string): Promise<string | null> {
    const pattern = join(this.getStoragePath(), "projects", "*", `${sessionId}.jsonl`).replace(/\\/g, "/");
    const files = [...new Set((await glob(pattern)).map((item) => item.replace(/\\/g, "/")))];
    if (files.length === 0) return null;
    if (files.length > 1) {
      throw new Error(`定位到多个同名对话文件: workbuddy:${sessionId}`);
    }
    return files[0]!;
  }

  private async buildIndexedCacheItem(row: WorkBuddySessionRow, eagerSearchIndex: boolean): Promise<IndexedCacheItem | null> {
    const transcriptPath = await this.locateTranscriptFile(row.id);
    if (!transcriptPath) {
      // DB 有记录但无 transcript 文件：以 metadata-only 收录
      return { meta: this.buildMeta(row, null) };
    }
    const fileStat = await stat(transcriptPath);
    if (!eagerSearchIndex) {
      return { meta: this.buildMeta(row, transcriptPath, fileStat) };
    }
    const entries = await parseJsonlWithMeta<WorkBuddyEntry>(transcriptPath);
    const records = buildMessageRecords(entries);
    const messages = records.map((record) => record.message);
    const meta = this.buildMeta(row, transcriptPath, fileStat, messages.filter((m) => m.role !== "tool").length);
    const builder = createConversationSearchIndexBuilder();
    for (const entry of entries) {
      appendSearchIndexEntry(builder, entry.value);
    }
    return { meta, ...builder.build() };
  }

  private buildMeta(
    row: WorkBuddySessionRow,
    transcriptPath: string | null,
    fileStat?: { mtimeMs: number; size: number },
    messageCount?: number
  ): ConversationMeta {
    const dbPath = this.getDbPath();
    const createdAt = typeof row.created_at === "number" ? row.created_at : Date.now();
    const updatedAt = typeof row.updated_at === "number" ? row.updated_at : createdAt;
    const project = row.cwd ? normalizePath(row.cwd) : "unknown-project";
    const projectKey = canonicalizeProjectPath(project) || project;
    const title = (row.custom_title ?? row.title ?? "").trim() || "未知对话";
    const filePath = transcriptPath ?? buildSessionFilePath(dbPath, row.id);
    const meta: ConversationMeta = {
      id: `workbuddy:${row.id}`,
      provider: this.name,
      title,
      project,
      projectKey,
      projectId: projectKey,
      createdAt,
      updatedAt: transcriptPath && fileStat ? Math.max(updatedAt, fileStat.mtimeMs) : updatedAt,
      messageCount: messageCount ?? 0,
      fileSize: fileStat?.size ?? 0,
      filePath,
      contentStatus: transcriptPath ? "full" : "metadata-only",
      badges: buildBadges(row),
    };
    setCache(filePath, meta.updatedAt, meta);
    return meta;
  }

  private findSessionRow(sessionId: string): WorkBuddySessionRow | null {
    const db = this.getReadDb();
    try {
      const tables = this.getTableNames(db);
      if (!tables.has("sessions")) return null;
      return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(sessionId) as WorkBuddySessionRow | undefined ?? null;
    } catch (error) {
      throw createProviderDataError(this.name, "WorkBuddy 会话读取失败", error);
    }
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("workbuddy:", "");
    const row = this.findSessionRow(sessionId);
    if (!row) {
      throw new Error(`对话不存在: ${id}`);
    }
    const transcriptPath = await this.locateTranscriptFile(sessionId);
    if (!transcriptPath) {
      const meta = this.buildMeta(row, null);
      return { ...meta, messages: [], hasMore: false };
    }
    const fileStat = await stat(transcriptPath);
    const limit = options?.limit;
    const before = options?.before ?? 0;
    const shouldWindowRead = !!limit && limit > 0;
    const requiredMessages = shouldWindowRead ? before + limit + 1 : 0;

    const entries = shouldWindowRead
      ? await parseJsonlTailWithMeta<WorkBuddyEntry>(transcriptPath, {
          bytesHint: Math.max(256 * 1024, fileStat.size > 0 ? Math.min(fileStat.size, (before + limit) * 4096) : 256 * 1024),
          maxBytes: fileStat.size,
          isEnough: (tailEntries) => buildMessageRecords(tailEntries).length >= requiredMessages,
        })
      : await parseJsonlWithMeta<WorkBuddyEntry>(transcriptPath);
    const records = buildMessageRecords(entries);
    primeMessageActionIndex(transcriptPath, fileStat.mtimeMs, records);
    const messages = records.map((record) => record.message);
    const meta = this.buildMeta(
      row,
      transcriptPath,
      fileStat,
      messages.filter((m) => m.role !== "tool").length
    );

    const finalMeta = getProjectSpecificity(meta.project, meta.projectKey) > 1
      ? meta
      : (await this.list()).find((item) => item.id === meta.id) ?? meta;

    const { items: windowedMessages, hasMore } = sliceWindow(messages, options);
    return { ...finalMeta, messages: windowedMessages, hasMore };
  }

  private invalidateSessionCaches(sessionId: string): void {
    invalidateCache(buildSessionFilePath(this.getDbPath(), sessionId));
    invalidateListCache(this.getListCacheKey());
  }

  private mutationKey(sessionId: string): string {
    return `workbuddy:session:${sessionId}`;
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("workbuddy:", "");
    if (!this.findSessionRow(sessionId)) {
      throw new Error(`对话不存在: ${id}`);
    }

    await runKeyedMutation(this.mutationKey(sessionId), async () => {
      const db = this.getWriteDb();
      try {
        db.transaction(() => {
          const tables = this.getTableNames(db);
          for (const table of WORKBUDDY_DB_TABLES) {
            if (!tables.has(table)) continue;
            if (table === "sessions") continue;
            const columns = new Set(
              (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name: string }>)
                .map((row) => row.name)
            );
            const candidates = ["session_id", "thread_id", "conversation_id"];
            for (const column of candidates) {
              if (!columns.has(column)) continue;
              db.prepare(`DELETE FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column)} = ?`).run(sessionId);
            }
          }
          if (tables.has("sessions")) {
            db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
          }
        })();
      } finally {
        db.close();
      }
    });

    // 同步删除 transcript 文件（DB 与文件双写保持一致；多同名文件必须报错避免漏删）
    const transcriptPath = await this.locateTranscriptFile(sessionId);
    if (transcriptPath) {
      try {
        await unlink(transcriptPath);
        invalidateCache(transcriptPath);
        invalidateMessageActionIndex(transcriptPath);
      } catch (error) {
        if (!isFileSystemNotFoundError(error)) throw error;
      }
      await removeEmptyParentDirs(transcriptPath, join(this.getStoragePath(), "projects"));
    }

    this.invalidateSessionCaches(sessionId);
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("workbuddy:", "");
    const targetCwd = normalizePath(targetProjectKey);
    if (!targetCwd) {
      throw new Error("目标文件夹不能为空");
    }
    if (!this.findSessionRow(sessionId)) {
      throw new Error(`对话不存在: ${id}`);
    }
    const targetDirName = encodeWorkBuddyProjectDir(targetCwd);

    // 先搬移 transcript 文件，成功后再更新 DB cwd；文件搬移失败时 DB 保持原状。
    // 多副本等定位异常直接向上传播，不允许静默降级为仅更新 DB。
    const transcriptPath = await this.locateTranscriptFile(sessionId);
    let movedTranscript: { from: string; to: string } | null = null;
    if (transcriptPath) {
      const targetProjectDir = join(this.getStoragePath(), "projects", targetDirName);
      await mkdir(targetProjectDir, { recursive: true });
      const destFile = join(targetProjectDir, `${sessionId}.jsonl`);
      if (await stat(destFile).then(() => true, () => false)) {
        throw new Error(`目标目录已存在同名 transcript: ${destFile}`);
      }
      if (transcriptPath.replace(/\\/g, "/") !== destFile.replace(/\\/g, "/")) {
        await rename(transcriptPath, destFile);
        movedTranscript = { from: transcriptPath, to: destFile };
      }
    }

    try {
      await runKeyedMutation(this.mutationKey(sessionId), async () => {
        const db = this.getWriteDb();
        try {
          const result = db.prepare("UPDATE sessions SET cwd = ?, updated_at = ? WHERE id = ?")
            .run(targetCwd, Date.now(), sessionId);
          if (result.changes === 0) {
            throw new Error(`对话不存在: ${id}`);
          }
        } finally {
          db.close();
        }
      });
    } catch (error) {
      if (movedTranscript) {
        await rename(movedTranscript.to, movedTranscript.from).catch((rollbackError) => {
          logProviderError("conversations.move", this.name, rollbackError);
        });
      }
      throw error;
    }

    if (movedTranscript) {
      invalidateCache(movedTranscript.from);
      invalidateMessageActionIndex(movedTranscript.from);
    }
    this.invalidateSessionCaches(sessionId);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const sessionId = id.replace("workbuddy:", "");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    await runKeyedMutation(this.mutationKey(sessionId), async () => {
      const db = this.getWriteDb();
      try {
        const tables = this.getTableNames(db);
        if (!tables.has("sessions") || !this.hasColumn(db, "sessions", "custom_title")) {
          throw new Error("WorkBuddy 数据库不支持标题字段");
        }
        const result = db.prepare("UPDATE sessions SET custom_title = ?, updated_at = ? WHERE id = ?")
          .run(normalizedTitle, Date.now(), sessionId);
        if (result.changes === 0) {
          throw new Error(`对话不存在: ${id}`);
        }
      } finally {
        db.close();
      }
    });

    this.invalidateSessionCaches(sessionId);
  }

  async updateMessage(id: string, messageId: string, content: string): Promise<void> {
    const sessionId = id.replace("workbuddy:", "");
    const normalizedContent = normalizeUpdatedMessageContent(content);
    const transcriptPath = await this.locateTranscriptFile(sessionId);
    if (!transcriptPath) {
      throw new Error(`该对话仅有元数据，无可编辑的消息: ${id}`);
    }
    const fileStat = await stat(transcriptPath);
    const [lineNumber] = await resolveMessageLineNumbers<WorkBuddyEntry>(transcriptPath, fileStat.mtimeMs, [messageId], buildMessageRecords);
    await rewriteJsonlFileLine(
      transcriptPath,
      lineNumber,
      (line) => {
        const entry = JSON.parse(line) as WorkBuddyEntry;
        if (entry.type !== "message" || (entry.role !== "user" && entry.role !== "assistant")) {
          throw new Error(`消息不存在: ${messageId}`);
        }
        const blockType = entry.role === "user" ? "input_text" : "output_text";
        return JSON.stringify({ ...entry, content: [{ type: blockType, text: normalizedContent }] });
      },
      { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    );
    invalidateCache(transcriptPath);
    invalidateMessageActionIndex(transcriptPath);
    this.invalidateSessionCaches(sessionId);
  }

  async deleteMessage(id: string, messageId: string): Promise<void> {
    await this.deleteMessages(id, [messageId]);
  }

  async deleteMessages(id: string, messageIds: string[]): Promise<void> {
    const sessionId = id.replace("workbuddy:", "");
    const uniqueMessageIds = [...new Set(messageIds.map((item) => item.trim()).filter(Boolean))];
    if (uniqueMessageIds.length === 0) {
      throw new Error("待删除消息不能为空");
    }
    const transcriptPath = await this.locateTranscriptFile(sessionId);
    if (!transcriptPath) {
      throw new Error(`该对话仅有元数据，无可删除的消息: ${id}`);
    }
    const fileStat = await stat(transcriptPath);
    const lineNumbers = await resolveMessageLineNumbers<WorkBuddyEntry>(transcriptPath, fileStat.mtimeMs, uniqueMessageIds, buildMessageRecords);
    await rewriteJsonlFileLines(
      transcriptPath,
      lineNumbers,
      { mtimeMs: fileStat.mtimeMs, size: fileStat.size }
    );
    invalidateCache(transcriptPath);
    invalidateMessageActionIndex(transcriptPath);
    this.invalidateSessionCaches(sessionId);
  }

  async listProjects(): Promise<string[]> {
    const basePath = join(this.getStoragePath(), "projects");
    try {
      const entries = await readdir(basePath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
      if (isFileSystemNotFoundError(error)) return [];
      throw createProviderDataError(this.name, `WorkBuddy 项目目录无法读取: ${basePath}`, error);
    }
  }
}
