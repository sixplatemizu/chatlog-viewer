import { createRequire } from "module";
import { basename } from "path";
import { realpath, stat } from "fs/promises";
import type BetterSqlite3 from "better-sqlite3";
import {
  getIndexedListCache,
  getIndexedListCacheKey,
  invalidateCache,
  invalidateListCache,
  setCache,
  setIndexedListCache,
  type IndexedCacheItem,
} from "../utils/cache.js";
import { getProviderPaths } from "../utils/provider-paths.js";
import { ProviderDataError, type ProviderDataErrorKind } from "../utils/errors.js";
import {
  createIndexedListSourceSignature,
  type IndexedSourceFile,
} from "../utils/provider-indexing.js";
import {
  createConversationSearchIndexBuilder,
  type ConversationSearchIndex,
} from "../utils/search-index.js";
import type {
  Conversation,
  ConversationBadge,
  ConversationListOptions,
  ConversationMeta,
  ConversationProvider,
  ConversationReadOptions,
  Message,
} from "./types.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

const OPENCODE_RECENT_SESSION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const OPENCODE_INTERNAL_TITLE_PREFIX = "ChatLog Viewer AI Title";
const OPENCODE_ONE_SHOT_DENY_PERMISSIONS = new Set(["question", "plan_enter", "plan_exit"]);

function classifyOpenCodeDataError(error: unknown): ProviderDataErrorKind {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("locked") || message.includes("busy")) return "locked";
  if (message.includes("malformed") || message.includes("corrupt") || message.includes("not a database")) {
    return "corrupt";
  }
  if (message.includes("no such table") || message.includes("no such column")) {
    return "schema-incompatible";
  }
  return "unavailable";
}

interface OpenCodeSessionRow {
  id: string;
  project_id: string;
  parent_id: string | null;
  directory: string | null;
  title: string | null;
  permission: string | null;
  time_created: number;
  time_updated: number;
  time_archived: number | null;
  path: string | null;
  project_worktree: string | null;
  project_name: string | null;
  message_count: number;
  data_size: number;
}

interface OpenCodePermissionRule {
  permission?: unknown;
  pattern?: unknown;
  action?: unknown;
}

interface OpenCodeMessageRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodePartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  data: string;
}

interface OpenCodeSessionMessages {
  messages: Message[];
  dataSize: number;
}

interface OpenCodeMessageData {
  role?: string;
  time?: unknown;
  summary?: boolean;
}

interface OpenCodePartData {
  type?: string;
  text?: unknown;
  content?: unknown;
  tool?: string;
  state?: {
    input?: unknown;
    output?: unknown;
    error?: unknown;
    status?: string;
    title?: string;
  };
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

function canonicalizeProjectPath(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function parseJsonObject<T>(value: string): T | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? parsed as T : null;
  } catch {
    return null;
  }
}

function hasOnlyOneShotDenyPermissions(value: string | null | undefined): boolean {
  const parsed = parseJsonObject<OpenCodePermissionRule[]>(value ?? "");
  if (!Array.isArray(parsed) || parsed.length === 0) return false;

  const permissions = new Set<string>();
  for (const rule of parsed) {
    if (rule.action !== "deny" || rule.pattern !== "*" || typeof rule.permission !== "string") {
      return false;
    }
    if (!OPENCODE_ONE_SHOT_DENY_PERMISSIONS.has(rule.permission)) return false;
    permissions.add(rule.permission);
  }

  return permissions.size > 0;
}

function buildOpenCodeBadges(row: OpenCodeSessionRow, updatedAt: number): ConversationBadge[] | undefined {
  const title = row.title?.trim() ?? "";
  const badges: ConversationBadge[] = [];

  if (row.parent_id) {
    badges.push({
      label: "子会话",
      tone: "indigo",
      title: "OpenCode 子会话，TUI /sessions 默认不作为主会话显示",
    });
  }

  if (row.time_archived !== null && row.time_archived !== undefined) {
    badges.push({
      label: "已归档",
      tone: "gray",
      title: "OpenCode 已归档 session，TUI /sessions 默认不显示",
    });
  }

  if (updatedAt < Date.now() - OPENCODE_RECENT_SESSION_WINDOW_MS) {
    badges.push({
      label: "30天外",
      tone: "gray",
      title: "OpenCode TUI 默认只同步最近 30 天 session，但 DB 中仍存在该记录",
    });
  }

  if (hasOnlyOneShotDenyPermissions(row.permission)) {
    badges.push({
      label: "run/临时",
      tone: "amber",
      title: "opencode run 或自动化 one-shot session，TUI /sessions 可能不显示",
    });
  }

  if (title.startsWith(OPENCODE_INTERNAL_TITLE_PREFIX)) {
    badges.push({
      label: "标题生成",
      tone: "cyan",
      title: "ChatLog Viewer AI 标题生成产生的 OpenCode session",
    });
  }

  return badges.length > 0 ? badges : undefined;
}

function normalizeTimestamp(value: number | null | undefined, fallback: number): number {
  const numeric = typeof value === "number" ? value : Number(value ?? NaN);
  if (!Number.isFinite(numeric)) return fallback;
  return numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
}

function normalizeMessageRole(role: string | undefined): Message["role"] {
  if (role === "user" || role === "assistant" || role === "system" || role === "tool") {
    return role;
  }
  return "assistant";
}

function formatUnknown(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function extractPartText(data: OpenCodePartData): string {
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;
  return "";
}

function isToolPart(data: OpenCodePartData): boolean {
  return data.type === "tool"
    || !!data.tool
    || data.state?.input !== undefined
    || data.state?.output !== undefined
    || data.state?.error !== undefined;
}

function buildToolMessage(part: OpenCodePartRow, data: OpenCodePartData): Message {
  const toolInput = formatUnknown(data.state?.input);
  const toolResult = formatUnknown(data.state?.error ?? data.state?.output);
  const content = toolResult ?? toolInput ?? formatUnknown(data) ?? "";

  return {
    messageId: part.id,
    role: "tool",
    content,
    timestamp: normalizeTimestamp(part.time_updated ?? part.time_created, Date.now()),
    toolName: data.tool || data.state?.title || data.type || "tool",
    toolInput,
    toolResult,
  };
}

function buildMessagesFromRows(
  messageRows: OpenCodeMessageRow[],
  partRows: OpenCodePartRow[]
): Message[] {
  const partsByMessageId = new Map<string, OpenCodePartRow[]>();
  for (const part of partRows) {
    const parts = partsByMessageId.get(part.message_id) ?? [];
    parts.push(part);
    partsByMessageId.set(part.message_id, parts);
  }

  const messages: Message[] = [];
  for (const row of messageRows) {
    const messageData = parseJsonObject<OpenCodeMessageData>(row.data) ?? {};
    if (messageData.summary) continue;

    const role = normalizeMessageRole(messageData.role);
    const textParts: string[] = [];
    const toolMessages: Message[] = [];

    for (const part of partsByMessageId.get(row.id) ?? []) {
      const partData = parseJsonObject<OpenCodePartData>(part.data) ?? {};
      const text = extractPartText(partData);
      if (text.trim() && partData.type !== "reasoning") {
        textParts.push(text);
      }
      if (isToolPart(partData)) {
        toolMessages.push(buildToolMessage(part, partData));
      }
    }

    const content = textParts.join("\n").trim();
    if (content && role !== "tool") {
      messages.push({
        messageId: row.id,
        role,
        content,
        timestamp: normalizeTimestamp(row.time_updated ?? row.time_created, Date.now()),
      });
    } else if (content && role === "tool") {
      messages.push({
        messageId: row.id,
        role: "tool",
        content,
        timestamp: normalizeTimestamp(row.time_updated ?? row.time_created, Date.now()),
        toolName: "tool",
        toolResult: content,
      });
    }

    messages.push(...toolMessages);
  }

  return messages;
}

function isMeaningfulProjectPath(value: string): boolean {
  const normalized = normalizePath(value);
  return !!normalized && normalized !== "/" && normalized !== ".";
}

function resolveProjectPath(row: OpenCodeSessionRow): string {
  for (const candidate of [
    row.directory,
    row.path,
    row.project_worktree,
    row.project_name,
    row.project_id,
  ]) {
    const normalized = normalizePath(candidate ?? "");
    if (isMeaningfulProjectPath(normalized)) return normalized;
  }
  return "unknown-project";
}

function buildSessionFilePath(dbPath: string, sessionId: string): string {
  return `${normalizePath(dbPath)}#session/${sessionId}`;
}

function buildOpenCodePathValue(directory: string): string | null {
  const normalized = normalizePath(directory)
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^\/+/, "");
  return normalized || null;
}

async function resolveOpenCodeDirectoryValue(directory: string): Promise<string> {
  const trimmed = directory.trim();
  try {
    return await realpath(trimmed);
  } catch {
    const normalized = normalizePath(trimmed);
    if (/^[A-Za-z]:\//.test(normalized)) {
      return `${normalized[0]?.toUpperCase()}:${normalized.slice(2).replace(/\//g, "\\")}`;
    }
    return trimmed;
  }
}

function sliceWindow<T>(items: T[], options?: ConversationReadOptions): { items: T[]; hasMore: boolean } {
  const limit = options?.limit;
  const before = options?.before ?? 0;

  if (!limit || limit <= 0) {
    return { items, hasMore: false };
  }

  const end = Math.max(0, items.length - before);
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    hasMore: start > 0,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export class OpenCodeProvider implements ConversationProvider {
  name = "opencode";
  displayName = "OpenCode";
  capabilities = {
    titleSyncMode: "native",
    canUpdateTitle: true,
    canGenerateTitle: true,
    canEditMessage: false,
    canDeleteMessage: false,
    canMoveConversation: true,
    canDeleteConversation: true,
    supportsMetadataOnly: false,
    editMessageDisabledReason: "OpenCode 消息由 message/part 多表结构组成，当前未开放安全编辑",
    deleteMessageDisabledReason: "OpenCode 消息由 message/part 多表结构组成，当前未开放安全删除",
  } as const;

  private readDb: BetterSqlite3.Database | null = null;
  private readDbPath: string | null = null;

  getStoragePath(): string {
    return getProviderPaths("opencode").storagePath;
  }

  private getDbPath(): string {
    const paths = getProviderPaths("opencode");
    return paths.stateDbPath ?? `${paths.storagePath}/opencode.db`;
  }

  async detect(): Promise<boolean> {
    try {
      const dbStat = await stat(this.getDbPath());
      return dbStat.isFile();
    } catch {
      return false;
    }
  }

  async getListSourceSignature(): Promise<string | null> {
    try {
      const dbPath = this.getDbPath();
      const dbStat = await stat(dbPath);
      const sourceFiles: IndexedSourceFile[] = [
        {
          path: normalizePath(dbPath),
          mtimeMs: dbStat.mtimeMs,
          size: dbStat.size,
        },
        {
          path: "opencode:list-filter:v3-wal-bulk-index",
          mtimeMs: 0,
          size: 0,
        },
      ];
      for (const suffix of ["-wal", "-shm"]) {
        const sidecarPath = `${dbPath}${suffix}`;
        try {
          const sidecarStat = await stat(sidecarPath);
          sourceFiles.push({
            path: normalizePath(sidecarPath),
            mtimeMs: sidecarStat.mtimeMs,
            size: sidecarStat.size,
          });
        } catch {
          // sidecar 不存在时只使用主数据库 signature。
        }
      }
      return createIndexedListSourceSignature(sourceFiles);
    } catch {
      return null;
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
      this.readDb = new Database(dbPath, { readonly: true, fileMustExist: true });
      this.readDbPath = dbPath;
      return this.readDb;
    } catch (error) {
      this.readDb = null;
      this.readDbPath = null;
      throw new ProviderDataError(
        this.name,
        classifyOpenCodeDataError(error),
        `OpenCode 数据库无法读取: ${this.getDbPath()}`,
        { cause: error }
      );
    }
  }

  private getWriteDb(): BetterSqlite3.Database {
    this.closeDb();
    return new Database(this.getDbPath(), { fileMustExist: true });
  }

  private getListCacheKey(): string {
    return getIndexedListCacheKey(this.name, this.getStoragePath());
  }

  async list(options: ConversationListOptions = {}): Promise<ConversationMeta[]> {
    const sourceSignature = await this.getListSourceSignature();
    if (!sourceSignature) {
      throw new ProviderDataError(
        this.name,
        "unavailable",
        `OpenCode 数据库不存在或无法读取: ${this.getDbPath()}`
      );
    }

    const cacheKey = this.getListCacheKey();
    const cachedList = getIndexedListCache(cacheKey, undefined, {
      requireSearchReady: options.eagerSearchIndex ?? false,
      sourceSignature,
    });
    if (cachedList) {
      return [...cachedList].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const rows = this.listSessionRows();
    const eagerSearchIndex = options.eagerSearchIndex ?? false;
    const results = eagerSearchIndex
      ? this.buildSearchIndexedCacheItems(rows)
      : rows.map((row) => ({ meta: this.buildMeta(row) }));
    setIndexedListCache(cacheKey, results, {
      searchReady: eagerSearchIndex,
      sourceSignature,
      writeSearchData: eagerSearchIndex,
    });
    return results.map((item) => item.meta).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private listSessionRows(): OpenCodeSessionRow[] {
    const db = this.getReadDb();

    try {
      const rows = db.prepare(`
        SELECT
          s.id,
          s.project_id,
          s.parent_id,
          s.directory,
          s.title,
          s.permission,
          s.time_created,
          s.time_updated,
          s.time_archived,
          s.path,
          p.worktree AS project_worktree,
          p.name AS project_name,
          COALESCE(m.message_count, 0) AS message_count,
          0 AS data_size
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        LEFT JOIN (
          SELECT
            session_id,
            COUNT(*) AS message_count
          FROM message
          GROUP BY session_id
        ) m ON m.session_id = s.id
        ORDER BY s.time_updated DESC
      `).all() as OpenCodeSessionRow[];
      return rows;
    } catch (error) {
      throw new ProviderDataError(
        this.name,
        classifyOpenCodeDataError(error),
        `OpenCode 会话索引读取失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private findSessionRow(sessionId: string): OpenCodeSessionRow | null {
    const db = this.getReadDb();

    try {
      return db.prepare(`
        SELECT
          s.id,
          s.project_id,
          s.parent_id,
          s.directory,
          s.title,
          s.permission,
          s.time_created,
          s.time_updated,
          s.time_archived,
          s.path,
          p.worktree AS project_worktree,
          p.name AS project_name,
          COUNT(m.id) AS message_count,
          (
            SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0)
            FROM message
            WHERE session_id = s.id
          ) + (
            SELECT COALESCE(SUM(length(CAST(data AS BLOB))), 0)
            FROM part
            WHERE session_id = s.id
          ) AS data_size
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        LEFT JOIN message m ON m.session_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
      `).get(sessionId) as OpenCodeSessionRow | undefined ?? null;
    } catch (error) {
      throw new ProviderDataError(
        this.name,
        classifyOpenCodeDataError(error),
        `OpenCode 会话读取失败: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private buildMeta(row: OpenCodeSessionRow): ConversationMeta {
    const dbPath = this.getDbPath();
    const createdAt = normalizeTimestamp(row.time_created, Date.now());
    const updatedAt = normalizeTimestamp(row.time_updated, createdAt);
    const project = resolveProjectPath(row);
    const projectKey = canonicalizeProjectPath(project) || row.project_id;

    const meta: ConversationMeta = {
      id: `opencode:${row.id}`,
      provider: this.name,
      title: row.title?.trim() || "未知对话",
      project,
      projectKey,
      projectId: projectKey,
      createdAt,
      updatedAt,
      messageCount: Number(row.message_count) || 0,
      fileSize: Number(row.data_size) || 0,
      filePath: buildSessionFilePath(dbPath, row.id),
      contentStatus: "full",
      badges: buildOpenCodeBadges(row, updatedAt),
    };

    setCache(meta.filePath, meta.updatedAt, meta);
    return meta;
  }

  private buildIndexedCacheItem(row: OpenCodeSessionRow, messages: Message[]): IndexedCacheItem {
    const meta = this.buildMeta({
      ...row,
      message_count: messages.filter((message) => message.role !== "tool").length,
    });

    return {
      meta,
      ...this.extractSearchIndex(messages),
    };
  }

  private buildSearchIndexedCacheItems(rows: OpenCodeSessionRow[]): IndexedCacheItem[] {
    const messagesBySession = this.readAllMessagesBySession();
    return rows.map((row) => {
      const session = messagesBySession.get(row.id);
      return this.buildIndexedCacheItem(
        {
          ...row,
          data_size: session?.dataSize ?? row.data_size,
        },
        session?.messages ?? []
      );
    });
  }

  private readAllMessagesBySession(): Map<string, OpenCodeSessionMessages> {
    const db = this.getReadDb();

    const messageRows = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      ORDER BY session_id ASC, time_created ASC, id ASC
    `).all() as OpenCodeMessageRow[];
    const partRows = db.prepare(`
      SELECT id, message_id, session_id, time_created, time_updated, data
      FROM part
      ORDER BY session_id ASC, time_created ASC, id ASC
    `).all() as OpenCodePartRow[];
    const messageRowsBySession = new Map<string, OpenCodeMessageRow[]>();
    const partRowsBySession = new Map<string, OpenCodePartRow[]>();

    for (const row of messageRows) {
      const rows = messageRowsBySession.get(row.session_id) ?? [];
      rows.push(row);
      messageRowsBySession.set(row.session_id, rows);
    }
    for (const row of partRows) {
      const rows = partRowsBySession.get(row.session_id) ?? [];
      rows.push(row);
      partRowsBySession.set(row.session_id, rows);
    }

    const messagesBySession = new Map<string, OpenCodeSessionMessages>();
    for (const [sessionId, rows] of messageRowsBySession) {
      const parts = partRowsBySession.get(sessionId) ?? [];
      messagesBySession.set(
        sessionId,
        {
          messages: buildMessagesFromRows(rows, parts),
          dataSize: rows.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0)
            + parts.reduce((sum, row) => sum + Buffer.byteLength(row.data), 0),
        }
      );
    }
    return messagesBySession;
  }

  private readMessages(sessionId: string): Message[] {
    const db = this.getReadDb();

    const messageRows = db.prepare(`
      SELECT id, session_id, time_created, time_updated, data
      FROM message
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `).all(sessionId) as OpenCodeMessageRow[];
    const partRows = db.prepare(`
      SELECT id, message_id, session_id, time_created, time_updated, data
      FROM part
      WHERE session_id = ?
      ORDER BY time_created ASC, id ASC
    `).all(sessionId) as OpenCodePartRow[];

    return buildMessagesFromRows(messageRows, partRows);
  }

  private extractSearchIndex(messages: Message[]): ConversationSearchIndex {
    const builder = createConversationSearchIndexBuilder();
    for (const message of messages) {
      if (message.role !== "tool") {
        builder.addMessage(message);
      }
    }
    return builder.build();
  }

  async read(id: string, options?: ConversationReadOptions): Promise<Conversation> {
    const sessionId = id.replace("opencode:", "");
    const row = this.findSessionRow(sessionId);
    if (!row) {
      throw new Error(`对话不存在: ${id}`);
    }

    const messages = this.readMessages(sessionId);
    const meta = this.buildMeta({
      ...row,
      message_count: messages.filter((message) => message.role !== "tool").length,
    });
    const { items, hasMore } = sliceWindow(messages, options);

    return { ...meta, messages: items, hasMore };
  }

  private getTableNames(db: BetterSqlite3.Database): Set<string> {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  }

  private hasColumn(db: BetterSqlite3.Database, tableName: string, columnName: string): boolean {
    const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(tableName)})`).all() as Array<{ name: string }>;
    return rows.some((row) => row.name === columnName);
  }

  private deleteByColumn(
    db: BetterSqlite3.Database,
    tableNames: Set<string>,
    tableName: string,
    columnName: string,
    value: string
  ): void {
    if (!tableNames.has(tableName) || !this.hasColumn(db, tableName, columnName)) return;
    db.prepare(`DELETE FROM ${quoteIdentifier(tableName)} WHERE ${quoteIdentifier(columnName)} = ?`).run(value);
  }

  async delete(id: string): Promise<void> {
    const sessionId = id.replace("opencode:", "");
    const meta = this.findSessionRow(sessionId);
    if (!meta) {
      throw new Error(`对话不存在: ${id}`);
    }

    const db = this.getWriteDb();
    try {
      const tableNames = this.getTableNames(db);
      db.transaction((targetSessionId: string) => {
        for (const tableName of ["part", "message", "session_entry", "session_share", "todo"]) {
          this.deleteByColumn(db, tableNames, tableName, "session_id", targetSessionId);
        }

        this.deleteByColumn(db, tableNames, "event", "aggregate_id", targetSessionId);
        this.deleteByColumn(db, tableNames, "event_sequence", "aggregate_id", targetSessionId);

        if (tableNames.has("session")) {
          db.prepare("DELETE FROM session WHERE id = ?").run(targetSessionId);
        }
      })(sessionId);
    } finally {
      db.close();
    }

    const sessionFilePath = buildSessionFilePath(this.getDbPath(), sessionId);
    invalidateCache(sessionFilePath);
    invalidateListCache(this.getListCacheKey());
  }

  async move(id: string, targetProjectKey: string): Promise<void> {
    const sessionId = id.replace("opencode:", "");
    const targetDirectoryInput = normalizePath(targetProjectKey);
    if (!targetDirectoryInput) {
      throw new Error("目标文件夹不能为空");
    }
    const targetDirectory = await resolveOpenCodeDirectoryValue(targetDirectoryInput);

    const meta = this.findSessionRow(sessionId);
    if (!meta) {
      throw new Error(`对话不存在: ${id}`);
    }

    const db = this.getWriteDb();
    try {
      const result = db.prepare("UPDATE session SET directory = ?, path = ?, time_updated = ? WHERE id = ?")
        .run(targetDirectory, buildOpenCodePathValue(targetDirectory), Date.now(), sessionId);
      if (result.changes === 0) {
        throw new Error(`对话不存在: ${id}`);
      }
    } finally {
      db.close();
    }

    const sessionFilePath = buildSessionFilePath(this.getDbPath(), sessionId);
    invalidateCache(sessionFilePath);
    invalidateListCache(this.getListCacheKey());
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const sessionId = id.replace("opencode:", "");
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("标题不能为空");
    }

    const db = this.getWriteDb();
    try {
      const result = db.prepare("UPDATE session SET title = ?, time_updated = ? WHERE id = ?")
        .run(normalizedTitle, Date.now(), sessionId);
      if (result.changes === 0) {
        throw new Error(`对话不存在: ${id}`);
      }
    } finally {
      db.close();
    }

    const sessionFilePath = buildSessionFilePath(this.getDbPath(), sessionId);
    invalidateCache(sessionFilePath);
    invalidateListCache(this.getListCacheKey());
  }

  async listProjects(): Promise<string[]> {
    const rows = this.listSessionRows();
    return [...new Set(rows.map((row) => resolveProjectPath(row)).filter(Boolean))]
      .sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
  }
}
