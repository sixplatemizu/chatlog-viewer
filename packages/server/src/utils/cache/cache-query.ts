// conversation_index 查询层：WHERE/ORDER BY 构建与分页查询。
// DB 连接与 schema 见 ./cache-db.ts，内存缓存与读写 API 见 ./impl.ts。
import type { ConversationMeta } from "../../providers/types.js";
import { SEARCH_INDEX_VERSION } from "../search-index.js";
import { getDb, hasChunkFtsSupport, hasConversationFtsSupport } from "./cache-db.js";

export type ConversationIndexSort = "updatedAt" | "createdAt" | "provider";

export interface ConversationIndexQueryOptions {
  cacheKeys: string[];
  search?: string;
  sort?: ConversationIndexSort;
  modelProviders?: string[];
  projects?: string[];
  limit?: number;
  offset?: number;
}

export interface ConversationIndexQueryResult {
  conversations: ConversationMeta[];
  total: number;
  providerCounts: Record<string, number>;
  codexModelProviderCounts: Record<string, number>;
}

export interface ConversationIndexRow {
  id: string;
  provider: string;
  title: string;
  search_text: string | null;
  project: string;
  project_key: string;
  project_id: string | null;
  created_at: number;
  updated_at: number;
  message_count: number;
  file_size: number;
  file_path: string;
  model_provider: string | null;
  meta_json: string | null;
  search_version?: number;
}

export function buildConversationMetaFromIndexRow(row: ConversationIndexRow): ConversationMeta {
  const fallback: ConversationMeta = {
    id: row.id,
    provider: row.provider,
    title: row.title,
    project: row.project,
    projectKey: row.project_key,
    projectId: row.project_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messageCount: row.message_count,
    fileSize: row.file_size,
    filePath: row.file_path,
    modelProvider: row.model_provider ?? undefined,
  };

  if (!row.meta_json) return fallback;

  try {
    const parsed = JSON.parse(row.meta_json) as unknown;
    if (!parsed || typeof parsed !== "object") return fallback;
    const parsedMeta = parsed as Partial<ConversationMeta>;
    const meta = { ...fallback, ...parsedMeta };
    return {
      ...meta,
      id: fallback.id,
      provider: fallback.provider,
      title: fallback.title,
      project: fallback.project,
      projectKey: fallback.projectKey,
      projectId: fallback.projectId,
      createdAt: fallback.createdAt,
      updatedAt: fallback.updatedAt,
      messageCount: fallback.messageCount,
      fileSize: fallback.fileSize,
      filePath: fallback.filePath,
      modelProvider: fallback.modelProvider ?? meta.modelProvider,
    };
  } catch {
    return fallback;
  }
}

function buildLikePattern(search: string): string {
  return `%${search.toLowerCase()}%`;
}

function buildFtsSearchQuery(search: string): string | null {
  const terms = search
    .trim()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);

  if (terms.length === 0) {
    return null;
  }

  if (terms.some((term) => Array.from(term).length < 3)) {
    return null;
  }

  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

function buildConversationIndexWhere(
  options: ConversationIndexQueryOptions,
  includeModelProviderFilter: boolean
): { sql: string; params: Array<string | number> } {
  const whereClauses: string[] = [];
  const params: Array<string | number> = [];

  const cacheKeyPlaceholders = options.cacheKeys.map(() => "?").join(", ");
  whereClauses.push(`conversation_index.cache_key IN (${cacheKeyPlaceholders})`);
  params.push(...options.cacheKeys);

  if (options.projects !== undefined) {
    if (options.projects.length === 0) {
      whereClauses.push("0 = 1");
    } else {
      const placeholders = options.projects.map(() => "?").join(", ");
      whereClauses.push(`(
        conversation_index.project IN (${placeholders})
        OR conversation_index.project_key IN (${placeholders})
        OR conversation_index.project_id IN (${placeholders})
      )`);
      params.push(...options.projects, ...options.projects, ...options.projects);
    }
  }

  if (options.search) {
    whereClauses.push("conversation_index.search_version = ?");
    params.push(SEARCH_INDEX_VERSION);

    const ftsQuery = buildFtsSearchQuery(options.search);
    if (ftsQuery && (hasConversationFtsSupport() || hasChunkFtsSupport())) {
      const searchClauses: string[] = [];
      if (hasConversationFtsSupport()) {
        searchClauses.push(`
          EXISTS (
            SELECT 1
            FROM conversation_index_fts
            WHERE conversation_index_fts.rowid = conversation_index.rowid
              AND conversation_index_fts MATCH ?
          )
        `);
        params.push(ftsQuery);
      }
      if (hasChunkFtsSupport()) {
        searchClauses.push(`
          EXISTS (
            SELECT 1
            FROM conversation_search_chunk_fts
            JOIN conversation_search_chunk
              ON conversation_search_chunk.rowid = conversation_search_chunk_fts.rowid
            WHERE conversation_search_chunk.conversation_id = conversation_index.id
              AND conversation_search_chunk.cache_key = conversation_index.cache_key
              AND conversation_search_chunk.search_version = conversation_index.search_version
              AND conversation_search_chunk_fts MATCH ?
          )
        `);
        params.push(ftsQuery);
      }

      whereClauses.push(`(${searchClauses.join(" OR ")})`);
    } else {
      const lowerPattern = buildLikePattern(options.search);
      whereClauses.push(`
        (
          LOWER(conversation_index.title) LIKE ?
          OR LOWER(conversation_index.project) LIKE ?
          OR LOWER(COALESCE(conversation_index.search_text, '')) LIKE ?
          OR EXISTS (
            SELECT 1
            FROM conversation_search_chunk
            WHERE conversation_search_chunk.conversation_id = conversation_index.id
              AND conversation_search_chunk.cache_key = conversation_index.cache_key
              AND conversation_search_chunk.search_version = conversation_index.search_version
              AND LOWER(conversation_search_chunk.content) LIKE ?
          )
        )
      `);
      params.push(lowerPattern, lowerPattern, lowerPattern, lowerPattern);
    }
  }

  if (includeModelProviderFilter && options.modelProviders !== undefined) {
    if (options.modelProviders.length === 0) {
      whereClauses.push(`(
        conversation_index.provider <> 'codex'
        OR conversation_index.model_provider IS NULL
        OR conversation_index.model_provider = ''
      )`);
    } else {
      const placeholders = options.modelProviders.map(() => "?").join(", ");
      whereClauses.push(`(
        conversation_index.provider <> 'codex'
        OR conversation_index.model_provider IS NULL
        OR conversation_index.model_provider = ''
        OR conversation_index.model_provider IN (${placeholders})
      )`);
      params.push(...options.modelProviders);
    }
  }

  return {
    sql: whereClauses.join(" AND "),
    params,
  };
}

function getConversationIndexOrderBy(sort: ConversationIndexSort | undefined): string {
  if (sort === "createdAt") {
    return "conversation_index.created_at DESC";
  }
  if (sort === "provider") {
    return "conversation_index.provider ASC, conversation_index.updated_at DESC";
  }
  return "conversation_index.updated_at DESC";
}

export function queryConversationIndexPage(
  options: ConversationIndexQueryOptions
): ConversationIndexQueryResult {
  if (options.cacheKeys.length === 0) {
    return {
      conversations: [],
      total: 0,
      providerCounts: {},
      codexModelProviderCounts: {},
    };
  }

  try {
    const database = getDb();
    const baseWhere = buildConversationIndexWhere(options, false);
    const filteredWhere = buildConversationIndexWhere(options, true);
    const limit = options.limit === undefined
      ? undefined
      : Math.max(0, Math.floor(options.limit));
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const pageParams = [...filteredWhere.params];
    let pageClause = "";

    if (limit !== undefined) {
      pageClause = "LIMIT ? OFFSET ?";
      pageParams.push(limit, offset);
    } else if (offset > 0) {
      pageClause = "LIMIT -1 OFFSET ?";
      pageParams.push(offset);
    }

    const rows = database.prepare(`
      SELECT
        conversation_index.id,
        conversation_index.provider,
        conversation_index.title,
        conversation_index.search_text,
        conversation_index.project,
        conversation_index.project_key,
        conversation_index.project_id,
        conversation_index.created_at,
        conversation_index.updated_at,
        conversation_index.message_count,
        conversation_index.file_size,
        conversation_index.file_path,
        conversation_index.model_provider,
        conversation_index.meta_json
      FROM conversation_index
      WHERE ${filteredWhere.sql}
      ORDER BY ${getConversationIndexOrderBy(options.sort)}
      ${pageClause}
    `).all(...pageParams) as ConversationIndexRow[];

    const providerRows = database.prepare(`
      SELECT conversation_index.provider, COUNT(*) AS count
      FROM conversation_index
      WHERE ${filteredWhere.sql}
      GROUP BY conversation_index.provider
    `).all(...filteredWhere.params) as Array<{ provider: string; count: number }>;
    const providerCounts = Object.fromEntries(
      providerRows.map((row) => [row.provider, row.count])
    );
    const total = providerRows.reduce((sum, row) => sum + row.count, 0);

    const modelProviderRows = database.prepare(`
      SELECT conversation_index.model_provider, COUNT(*) AS count
      FROM conversation_index
      WHERE ${baseWhere.sql}
        AND conversation_index.provider = 'codex'
        AND conversation_index.model_provider IS NOT NULL
        AND conversation_index.model_provider <> ''
      GROUP BY conversation_index.model_provider
    `).all(...baseWhere.params) as Array<{ model_provider: string; count: number }>;

    return {
      conversations: rows.map((row) => buildConversationMetaFromIndexRow(row)),
      total,
      providerCounts,
      codexModelProviderCounts: Object.fromEntries(
        modelProviderRows.map((row) => [row.model_provider, row.count])
      ),
    };
  } catch (error) {
    console.error(`[cache] queryConversationIndexPage error:`, error);
    return {
      conversations: [],
      total: 0,
      providerCounts: {},
      codexModelProviderCounts: {},
    };
  }
}

export function queryConversationIndex(
  options: ConversationIndexQueryOptions
): ConversationMeta[] {
  return queryConversationIndexPage(options).conversations;
}
