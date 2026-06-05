import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { ClaudeCodeProvider } from "./claude-code.js";
import { clearCodexMessageIdentityCacheForTests, CodexProvider } from "./codex.js";
import { IFlowProvider } from "./iflow.js";
import { OpenCodeProvider } from "./opencode.js";
import { clearProviderPathCache } from "../utils/provider-paths.js";
import { getIndexedCacheSnapshot, getIndexedListCacheKey, queryConversationIndex, setCacheStoreDirForTests } from "../utils/cache.js";
import { getNativeTitle, setNativeTitle } from "../utils/title-store.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

async function createBaseFixture(prefix: string) {
  const baseDir = await mkdtemp(join(tmpdir(), prefix));
  const storeDir = join(baseDir, ".chatlog-viewer");
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  return {
    baseDir,
    storeDir,
    async cleanup(extraRestore?: () => void) {
      extraRestore?.();

      if (previousStoreDir === undefined) {
        delete process.env.CHATLOG_VIEWER_STORE_DIR;
      } else {
        process.env.CHATLOG_VIEWER_STORE_DIR = previousStoreDir;
      }

      clearProviderPathCache();
      setCacheStoreDirForTests();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

function buildExpectedCodexTranscriptPath(storagePath: string, sessionId: string, createdAtMs: number): string {
  const date = new Date(createdAtMs);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  const second = String(date.getSeconds()).padStart(2, "0");
  return join(
    storagePath,
    year,
    month,
    day,
    `rollout-${year}-${month}-${day}T${hour}-${minute}-${second}-${sessionId}.jsonl`
  );
}

function getCodexIndexedCacheKey(provider: CodexProvider): string {
  return (provider as unknown as { getListCacheKey: () => string }).getListCacheKey();
}

test("Codex 在 eagerSearchIndex 模式下会同步构建搜索索引", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-indexing-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-session-1";
  const needle = "codex-index-needle";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      join(storagePath, "project-a", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: `请查找 ${needle}`,
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: `用户再次提到 ${needle}` }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "output_text", text: `${needle} 已写入搜索索引` }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:04.000Z",
          type: "response_item",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: "<environment_context>隐藏环境上下文 hidden-env-needle</environment_context>" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:05.000Z",
          type: "response_item",
          payload: {
            role: "assistant",
            content: [{ type: "output_text", text: "" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          model_provider TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        "INSERT INTO threads (id, model_provider, title, first_user_message) VALUES (?, ?, ?, ?)"
      ).run(sessionId, "codex", "Codex 原生标题", "旧首条消息");
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.title, "Codex 原生标题");
    assert.equal(conversations[0]?.messageCount, 2);

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.messages.length, 2);

    const snapshot = getIndexedCacheSnapshot(getCodexIndexedCacheKey(provider));
    assert.equal(snapshot?.[0]?.meta.id, `codex:${sessionId}`);
    assert.ok(snapshot?.[0]?.searchText?.includes(needle));
    assert.equal(snapshot?.[0]?.searchText?.includes("hidden-env-needle"), false);
    assert.ok(snapshot?.[0]?.searchChunks?.some((chunk) => chunk.includes(needle)));
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Claude Code 的 hint-only 空壳会标记为 metadata-only 且可清理", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-claude-cleanup-candidate-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
  const sessionId = "11111111-1111-1111-1111-111111111111";

  try {
    process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = storagePath;
    clearProviderPathCache();

    const projectDir = join(storagePath, "demo-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{
          sessionId,
          summary: "Claude 空壳记录",
          messageCount: 0,
          modified: "2026-03-02T00:00:00.000Z",
        }],
      }, null, 2),
      "utf-8"
    );
    await writeFile(join(fixture.baseDir, "history.jsonl"), "", "utf-8");

    const provider = new ClaudeCodeProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `claude-code:${sessionId}`);
    assert.equal(conversations[0]?.contentStatus, "metadata-only");
    assert.equal(conversations[0]?.cleanupCandidate, true);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "索引空壳"), true);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "无 transcript"), true);
    assert.equal(conversations[0]?.messageCount, 0);
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = previousStoragePath;
      }
    });
  }
});

test("Claude Code 的 history-only 会话不会被标记为残留记录", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-claude-history-only-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
  const sessionId = "22222222-2222-2222-2222-222222222222";

  try {
    process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = storagePath;
    clearProviderPathCache();

    const projectDir = join(storagePath, "demo-project");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      join(projectDir, "sessions-index.json"),
      JSON.stringify({
        version: 1,
        entries: [{
          sessionId,
          summary: "Claude history 记录",
          messageCount: 2,
          modified: "2026-03-02T00:00:00.000Z",
        }],
      }, null, 2),
      "utf-8"
    );
    await writeFile(
      join(fixture.baseDir, "history.jsonl"),
      `${JSON.stringify({
        sessionId,
        display: "Claude history 提问",
        timestamp: 1774500000000,
        project: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
      })}\n`,
      "utf-8"
    );

    const provider = new ClaudeCodeProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.contentStatus, "history-only");
    assert.equal(conversations[0]?.cleanupCandidate, false);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "history 回填"), true);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "无 transcript"), true);

    const detail = await provider.read(`claude-code:${sessionId}`);
    assert.equal(detail.contentStatus, "history-only");
    assert.equal(detail.badges?.some((badge) => badge.label === "history 回填"), true);
    assert.equal(detail.messages[0]?.role, "system");
    assert.equal(detail.messages[1]?.role, "user");
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = previousStoragePath;
      }
    });
  }
});

test("iFlow 在 eagerSearchIndex 模式下会同步构建搜索索引", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-iflow-indexing-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_IFLOW_PATH;
  const sessionId = "session-iflow-1";
  const needle = "iflow-index-needle";

  try {
    process.env.CHATLOG_VIEWER_IFLOW_PATH = storagePath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "demo-project"), { recursive: true });
    await writeFile(
      join(storagePath, "demo-project", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          uuid: "1",
          parentUuid: null,
          sessionId,
          timestamp: "2026-03-02T00:00:00.000Z",
          type: "user",
          isSidechain: false,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          message: {
            role: "user",
            content: `请搜索 ${needle}`,
          },
        }),
        JSON.stringify({
          uuid: "2",
          parentUuid: "1",
          sessionId,
          timestamp: "2026-03-02T00:00:03.000Z",
          type: "assistant",
          isSidechain: false,
          message: {
            role: "assistant",
            content: `${needle} 已进入 iFlow 搜索索引`,
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const provider = new IFlowProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.title, `请搜索 ${needle}`);

    const snapshot = getIndexedCacheSnapshot(getIndexedListCacheKey("iflow", provider.getStoragePath()));
    assert.equal(snapshot?.[0]?.meta.id, `iflow:${sessionId}`);
    assert.ok(snapshot?.[0]?.searchText?.includes(needle));
    assert.ok(snapshot?.[0]?.searchChunks?.some((chunk) => chunk.includes(needle)));
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_IFLOW_PATH;
      } else {
        process.env.CHATLOG_VIEWER_IFLOW_PATH = previousStoragePath;
      }
    });
  }
});

function createOpenCodeSchema(db: BetterSqlite3.Database): void {
  db.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY,
      worktree TEXT,
      name TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );

    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      parent_id TEXT,
      slug TEXT,
      directory TEXT,
      title TEXT,
      version TEXT,
      permission TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      time_archived INTEGER,
      path TEXT
    );

    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );

    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );

    CREATE TABLE session_entry (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      type TEXT,
      time_created INTEGER,
      time_updated INTEGER,
      data TEXT
    );

    CREATE TABLE session_share (
      session_id TEXT,
      id TEXT,
      secret TEXT,
      url TEXT,
      time_created INTEGER,
      time_updated INTEGER
    );

    CREATE TABLE todo (
      session_id TEXT,
      content TEXT,
      status TEXT,
      priority TEXT,
      position INTEGER,
      time_created INTEGER,
      time_updated INTEGER
    );

    CREATE TABLE event (
      id TEXT PRIMARY KEY,
      aggregate_id TEXT,
      seq INTEGER,
      type TEXT,
      data TEXT
    );

    CREATE TABLE event_sequence (
      aggregate_id TEXT PRIMARY KEY,
      seq INTEGER
    );
  `);
}

test("OpenCode 会从 SQLite 构建列表、详情和搜索索引", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-opencode-indexing-");
  const storagePath = join(fixture.baseDir, "opencode");
  const dbPath = join(storagePath, "opencode.db");
  const previousStoragePath = process.env.CHATLOG_VIEWER_OPENCODE_PATH;
  const previousDbPath = process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
  const sessionId = "ses_opencode_indexing";
  const userMessageId = "msg_opencode_user";
  const assistantMessageId = "msg_opencode_assistant";
  const childSessionId = "ses_opencode_child";
  const needle = "opencode-index-needle";
  const now = Date.now();
  const oldSessionId = "ses_opencode_old";
  const runSessionId = "ses_opencode_run";
  const archivedSessionId = "ses_opencode_archived";
  const titleGenerationSessionId = "ses_opencode_title_generation";
  let provider: OpenCodeProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_OPENCODE_PATH = storagePath;
    process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = dbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });
    const db = new Database(dbPath);
    try {
      createOpenCodeSchema(db);
      db.prepare(
        "INSERT INTO project (id, worktree, name, time_created, time_updated) VALUES (?, ?, ?, ?, ?)"
      ).run("proj-demo", "/", "chatlog-viewer", 1774500000000, 1774500000000);
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "proj-demo",
        null,
        "demo-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "OpenCode 原生标题",
        "1.14.30",
        now - 10_000,
        now,
        null,
        null
      );
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        childSessionId,
        "proj-demo",
        sessionId,
        "child-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "OpenCode 子会话标题",
        "1.14.30",
        now - 9_000,
        now - 8_000,
        null,
        null
      );
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path, permission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        oldSessionId,
        "proj-demo",
        null,
        "old-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "OpenCode 旧会话",
        "1.14.30",
        now - 31 * 24 * 60 * 60 * 1000,
        now - 31 * 24 * 60 * 60 * 1000,
        null,
        null,
        null
      );
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path, permission
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        runSessionId,
        "proj-demo",
        null,
        "deny-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "New session - 2026-05-03T15:42:07.067Z",
        "1.14.30",
        now - 7_000,
        now - 6_000,
        null,
        null,
        JSON.stringify([
          { permission: "question", pattern: "*", action: "deny" },
          { permission: "plan_enter", pattern: "*", action: "deny" },
          { permission: "plan_exit", pattern: "*", action: "deny" },
        ])
      );
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        archivedSessionId,
        "proj-demo",
        null,
        "archived-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "OpenCode 已归档会话",
        "1.14.30",
        now - 5_500,
        now - 5_000,
        now - 1_000,
        null
      );
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        titleGenerationSessionId,
        "proj-demo",
        null,
        "title-generation-session",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "ChatLog Viewer AI Title - 2026-05-03T15:42:07.067Z",
        "1.14.30",
        now - 4_500,
        now - 4_000,
        null,
        null
      );
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(userMessageId, sessionId, 1774500001000, 1774500001000, JSON.stringify({ role: "user", time: 1774500001000 }));
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run(assistantMessageId, sessionId, 1774500002000, 1774500003000, JSON.stringify({ role: "assistant" }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("prt_user_text", userMessageId, sessionId, 1774500001000, 1774500001000, JSON.stringify({ type: "text", text: `请搜索 ${needle}` }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("prt_assistant_text", assistantMessageId, sessionId, 1774500002000, 1774500002000, JSON.stringify({ type: "text", text: `${needle} 已写入 OpenCode 搜索索引` }));
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run("msg_child", childSessionId, 1774500006000, 1774500006000, JSON.stringify({ role: "user" }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("prt_child", "msg_child", childSessionId, 1774500006000, 1774500006000, JSON.stringify({ type: "text", text: "子会话详情仍可读取" }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "prt_tool",
          assistantMessageId,
          sessionId,
          1774500002500,
          1774500002500,
          JSON.stringify({
            type: "tool",
            tool: "read",
            state: {
              input: { filePath: "src/app.ts" },
              output: "工具输出",
              status: "completed",
            },
          })
        );
    } finally {
      db.close();
    }

    provider = new OpenCodeProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    const conversationById = new Map(conversations.map((item) => [item.id, item]));
    assert.deepEqual(new Set(conversations.map((item) => item.id)), new Set([
      `opencode:${sessionId}`,
      `opencode:${childSessionId}`,
      `opencode:${oldSessionId}`,
      `opencode:${runSessionId}`,
      `opencode:${archivedSessionId}`,
      `opencode:${titleGenerationSessionId}`,
    ]));
    assert.equal(conversations[0]?.id, `opencode:${sessionId}`);
    assert.equal(conversationById.get(`opencode:${sessionId}`)?.title, "OpenCode 原生标题");
    assert.equal(conversationById.get(`opencode:${sessionId}`)?.messageCount, 2);
    assert.equal(conversationById.get(`opencode:${sessionId}`)?.project, "C:/Users/tester/Desktop/code_area/chatlog-viewer");
    assert.ok((conversationById.get(`opencode:${sessionId}`)?.fileSize ?? 0) > 0);
    assert.equal(conversationById.get(`opencode:${childSessionId}`)?.badges?.some((badge) => badge.label === "子会话"), true);
    assert.equal(conversationById.get(`opencode:${oldSessionId}`)?.badges?.some((badge) => badge.label === "30天外"), true);
    assert.equal(conversationById.get(`opencode:${runSessionId}`)?.badges?.some((badge) => badge.label === "run/临时"), true);
    assert.equal(conversationById.get(`opencode:${archivedSessionId}`)?.badges?.some((badge) => badge.label === "已归档"), true);
    assert.equal(conversationById.get(`opencode:${titleGenerationSessionId}`)?.badges?.some((badge) => badge.label === "标题生成"), true);

    const cacheKey = getIndexedListCacheKey("opencode", provider.getStoragePath());
    const snapshot = getIndexedCacheSnapshot(cacheKey);
    assert.equal(snapshot?.some((item) => item.meta.id === `opencode:${sessionId}`), true);
    assert.equal(snapshot?.some((item) => item.meta.id === `opencode:${childSessionId}`), true);
    assert.ok(snapshot?.find((item) => item.meta.id === `opencode:${sessionId}`)?.searchText?.includes(needle));
    assert.ok(snapshot?.find((item) => item.meta.id === `opencode:${sessionId}`)?.searchChunks?.some((chunk) => chunk.includes(needle)));
    const indexedChildMatches = queryConversationIndex({ cacheKeys: [cacheKey], search: "子会" });
    assert.equal(indexedChildMatches[0]?.id, `opencode:${childSessionId}`);
    assert.equal(indexedChildMatches[0]?.badges?.some((badge) => badge.label === "子会话"), true);

    const childDetail = await provider.read(`opencode:${childSessionId}`);
    assert.equal(childDetail.title, "OpenCode 子会话标题");
    assert.equal(childDetail.badges?.some((badge) => badge.label === "子会话"), true);
    const runDetail = await provider.read(`opencode:${runSessionId}`);
    assert.equal(runDetail.title, "New session - 2026-05-03T15:42:07.067Z");
    assert.equal(runDetail.badges?.some((badge) => badge.label === "run/临时"), true);
    assert.equal(childDetail.messages[0]?.content, "子会话详情仍可读取");

    const detail = await provider.read(`opencode:${sessionId}`);
    assert.equal(detail.messages.length, 3);
    assert.equal(detail.messages[0]?.role, "user");
    assert.equal(detail.messages[0]?.content, `请搜索 ${needle}`);
    assert.equal(detail.messages[2]?.role, "tool");
    assert.equal(detail.messages[2]?.toolName, "read");
    assert.match(detail.messages[2]?.toolInput ?? "", /src\/app\.ts/);
  } finally {
    provider?.closeDb();
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_PATH = previousStoragePath;
      }

      if (previousDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = previousDbPath;
      }
    });
  }
});

test("OpenCode 支持 metadata 级移动会话", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-opencode-move-");
  const storagePath = join(fixture.baseDir, "opencode");
  const dbPath = join(storagePath, "opencode.db");
  const previousStoragePath = process.env.CHATLOG_VIEWER_OPENCODE_PATH;
  const previousDbPath = process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
  const sessionId = "ses_opencode_move";
  let provider: OpenCodeProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_OPENCODE_PATH = storagePath;
    process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = dbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });
    const db = new Database(dbPath);
    try {
      createOpenCodeSchema(db);
      db.prepare(
        "INSERT INTO project (id, worktree, name, time_created, time_updated) VALUES (?, ?, ?, ?, ?)"
      ).run("proj-demo", "/", null, 1774500000000, 1774500000000);
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sessionId, "proj-demo", null, "demo", "C:/Users/tester/Desktop/code_area/original-project", "待移动标题", "1.14.30", 1774500000000, 1774500000000, null, "Users/tester/Desktop/code_area/original-project");
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run("msg_move", sessionId, 1774500001000, 1774500001000, JSON.stringify({ role: "user" }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("prt_move", "msg_move", sessionId, 1774500001000, 1774500001000, JSON.stringify({ type: "text", text: "移动测试" }));
    } finally {
      db.close();
    }

    provider = new OpenCodeProvider();
    await provider.move(`opencode:${sessionId}`, "C:/Users/tester/Desktop/code_area/target-project");

    const moved = await provider.read(`opencode:${sessionId}`);
    assert.equal(moved.project, "C:/Users/tester/Desktop/code_area/target-project");
    assert.equal(moved.projectKey, "c:/users/tester/desktop/code_area/target-project");

    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT directory, path, time_updated FROM session WHERE id = ?").get(sessionId) as {
        directory: string;
        path: string;
        time_updated: number;
      };
      assert.equal(row.directory, "C:\\Users\\tester\\Desktop\\code_area\\target-project");
      assert.equal(row.path, "Users/tester/Desktop/code_area/target-project");
      assert.ok(row.time_updated >= 10_000_000_000);
    } finally {
      verifyDb.close();
    }
  } finally {
    provider?.closeDb();
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_PATH = previousStoragePath;
      }

      if (previousDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = previousDbPath;
      }
    });
  }
});

test("OpenCode 支持写回标题并级联删除会话", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-opencode-delete-");
  const storagePath = join(fixture.baseDir, "opencode");
  const dbPath = join(storagePath, "opencode.db");
  const previousStoragePath = process.env.CHATLOG_VIEWER_OPENCODE_PATH;
  const previousDbPath = process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
  const sessionId = "ses_opencode_delete";
  let provider: OpenCodeProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_OPENCODE_PATH = storagePath;
    process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = dbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });
    const db = new Database(dbPath);
    try {
      createOpenCodeSchema(db);
      db.prepare(
        "INSERT INTO project (id, worktree, name, time_created, time_updated) VALUES (?, ?, ?, ?, ?)"
      ).run("proj-demo", "C:/Users/tester/Desktop/code_area/chatlog-viewer", null, 1774500000000, 1774500000000);
      db.prepare(
        `INSERT INTO session (
          id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived, path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(sessionId, "proj-demo", null, "demo", "C:/Users/tester/Desktop/code_area/chatlog-viewer", "旧标题", "1.14.30", 1774500000000, 1774500000000, null, null);
      db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)")
        .run("msg_delete", sessionId, 1774500001000, 1774500001000, JSON.stringify({ role: "user" }));
      db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("prt_delete", "msg_delete", sessionId, 1774500001000, 1774500001000, JSON.stringify({ type: "text", text: "删除测试" }));
      db.prepare("INSERT INTO session_entry (id, session_id, type, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)")
        .run("entry_delete", sessionId, "test", 1774500001000, 1774500001000, "{}");
      db.prepare("INSERT INTO session_share (session_id, id, secret, url, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)")
        .run(sessionId, "share_delete", "secret", "https://example.test", 1774500001000, 1774500001000);
      db.prepare("INSERT INTO todo (session_id, content, status, priority, position, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(sessionId, "todo", "pending", "low", 0, 1774500001000, 1774500001000);
      db.prepare("INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (?, ?, ?, ?, ?)")
        .run("event_delete", sessionId, 1, "test", "{}");
      db.prepare("INSERT INTO event_sequence (aggregate_id, seq) VALUES (?, ?)")
        .run(sessionId, 1);
    } finally {
      db.close();
    }

    provider = new OpenCodeProvider();
    await provider.updateTitle(`opencode:${sessionId}`, "新标题");
    const updatedList = await provider.list();
    assert.equal(updatedList[0]?.id, `opencode:${sessionId}`);
    assert.equal(updatedList[0]?.title, "新标题");

    const updated = await provider.read(`opencode:${sessionId}`);
    assert.equal(updated.title, "新标题");

    const titleDb = new Database(dbPath, { readonly: true });
    try {
      const row = titleDb.prepare("SELECT title, time_updated FROM session WHERE id = ?").get(sessionId) as {
        title: string;
        time_updated: number;
      };
      assert.equal(row.title, "新标题");
      assert.ok(row.time_updated >= 10_000_000_000);
    } finally {
      titleDb.close();
    }

    await provider.delete(`opencode:${sessionId}`);

    const verifyDb = new Database(dbPath, { readonly: true });
    try {
      for (const tableName of ["session", "message", "part", "session_entry", "session_share", "todo"]) {
        const row = verifyDb.prepare(`SELECT count(*) AS count FROM ${tableName} WHERE ${tableName === "session" ? "id" : "session_id"} = ?`).get(sessionId) as { count: number };
        assert.equal(row.count, 0, `${tableName} 应已清理`);
      }
      const eventRow = verifyDb.prepare("SELECT count(*) AS count FROM event WHERE aggregate_id = ?").get(sessionId) as { count: number };
      const sequenceRow = verifyDb.prepare("SELECT count(*) AS count FROM event_sequence WHERE aggregate_id = ?").get(sessionId) as { count: number };
      assert.equal(eventRow.count, 0);
      assert.equal(sequenceRow.count, 0);
    } finally {
      verifyDb.close();
    }
  } finally {
    provider?.closeDb();
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_PATH = previousStoragePath;
      }

      if (previousDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_OPENCODE_DB_PATH = previousDbPath;
      }
    });
  }
});

test("Codex 消息在连续编辑和删除其它消息后保持稳定 messageId", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-message-id-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-session-message-id";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      join(storagePath, "project-a", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "第一条消息" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "第二条消息" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:03.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "第三条消息" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          model_provider TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        "INSERT INTO threads (id, model_provider, title, first_user_message) VALUES (?, ?, ?, ?)"
      ).run(sessionId, "codex", "Codex 标题", "第一条消息");
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const initial = await provider.read(`codex:${sessionId}`);
    const firstMessageId = initial.messages[0]?.messageId;
    const targetMessageId = initial.messages[1]?.messageId;

    assert.ok(firstMessageId);
    assert.ok(targetMessageId);

    await provider.updateMessage(`codex:${sessionId}`, targetMessageId!, "第二条消息-第一次编辑");
    await provider.updateMessage(`codex:${sessionId}`, targetMessageId!, "第二条消息-第二次编辑");
    await provider.deleteMessages(`codex:${sessionId}`, [firstMessageId!]);
    await provider.updateMessage(`codex:${sessionId}`, targetMessageId!, "第二条消息-删除后再次编辑");

    const updated = await provider.read(`codex:${sessionId}`);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0]?.messageId, targetMessageId);
    assert.equal(updated.messages[0]?.content, "第二条消息-删除后再次编辑");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 结构重复消息在删除后续重复项后仍保持原 messageId", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-duplicate-message-id-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-session-duplicate-message-id";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      join(storagePath, "project-a", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "引导消息" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "重复消息-A" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "重复消息-B" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          model_provider TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        "INSERT INTO threads (id, model_provider, title, first_user_message) VALUES (?, ?, ?, ?)"
      ).run(sessionId, "codex", "Codex 重复消息标题", "引导消息");
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const initial = await provider.read(`codex:${sessionId}`);
    const targetMessageId = initial.messages[1]?.messageId;
    const duplicateBelowMessageId = initial.messages[2]?.messageId;

    assert.ok(targetMessageId);
    assert.ok(duplicateBelowMessageId);
    assert.notEqual(targetMessageId, duplicateBelowMessageId);

    await provider.deleteMessages(`codex:${sessionId}`, [duplicateBelowMessageId!]);
    await provider.updateMessage(`codex:${sessionId}`, targetMessageId!, "重复消息-A-删除后继续编辑");

    const updated = await provider.read(`codex:${sessionId}`);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[1]?.messageId, targetMessageId);
    assert.equal(updated.messages[1]?.content, "重复消息-A-删除后继续编辑");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 删除重复消息后即使服务重启也能继续使用旧 messageId", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-restart-message-id-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-session-restart-message-id";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      join(storagePath, "project-a", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "引导消息" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "重复消息-A" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "重复消息-B" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          model_provider TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        "INSERT INTO threads (id, model_provider, title, first_user_message) VALUES (?, ?, ?, ?)"
      ).run(sessionId, "codex", "Codex 重启标题", "引导消息");
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const initial = await provider.read(`codex:${sessionId}`);
    const targetMessageId = initial.messages[1]?.messageId;
    const duplicateBelowMessageId = initial.messages[2]?.messageId;

    assert.ok(targetMessageId);
    assert.ok(duplicateBelowMessageId);

    await provider.deleteMessages(`codex:${sessionId}`, [duplicateBelowMessageId!]);

    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    clearCodexMessageIdentityCacheForTests();
    provider = new CodexProvider();

    await provider.updateMessage(`codex:${sessionId}`, targetMessageId!, "重启后继续编辑");

    const updated = await provider.read(`codex:${sessionId}`);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[1]?.messageId, targetMessageId);
    assert.equal(updated.messages[1]?.content, "重启后继续编辑");
  } finally {
    clearCodexMessageIdentityCacheForTests();
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 会回填仅存在于 state db 的对话并提供 metadata-only 详情", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-state-only-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-state-only-session";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "custom",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "State DB 标题",
        "State DB 首条消息"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `codex:${sessionId}`);
    assert.equal(conversations[0]?.title, "State DB 标题");
    assert.equal(conversations[0]?.modelProvider, "custom");
    assert.equal(conversations[0]?.transcriptMissing, true);
    assert.equal(conversations[0]?.contentStatus, "metadata-only");
    assert.equal(conversations[0]?.cleanupCandidate, undefined);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "state db"), true);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "无 transcript"), true);

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.transcriptMissing, true);
    assert.equal(detail.contentStatus, "metadata-only");
    assert.equal(detail.badges?.some((badge) => badge.label === "state db"), true);
    assert.equal(detail.messages.length, 1);
    assert.match(detail.messages[0]?.content ?? "", /未找到 transcript 文件/);
    assert.match(detail.titleGenerationHint ?? "", /State DB 标题/);
    assert.match(detail.titleGenerationHint ?? "", /State DB 首条消息/);

    const snapshot = getIndexedCacheSnapshot(getCodexIndexedCacheKey(provider));
    assert.equal(snapshot?.[0]?.meta.id, `codex:${sessionId}`);
    assert.equal(snapshot?.[0]?.meta.badges?.some((badge) => badge.label === "state db"), true);
    assert.ok(snapshot?.[0]?.searchText?.includes("State DB 标题"));
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 删除仅存在于 state db 的对话后不会再次回填", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-state-only-delete-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-state-only-delete-session";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "custom",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "待删除 State DB 对话",
        "State DB 首条消息"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const beforeDelete = await provider.list({ eagerSearchIndex: true });
    assert.equal(beforeDelete.some((item) => item.id === `codex:${sessionId}`), true);

    await provider.delete(`codex:${sessionId}`);

    const afterDelete = await provider.list({ eagerSearchIndex: true });
    assert.equal(afterDelete.some((item) => item.id === `codex:${sessionId}`), false);
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 手动标题写入 state db 后会刷新 transcript 列表标题", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-native-title-refresh-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-native-title-refresh-session";
  const sourceFile = join(storagePath, "project-a", `${sessionId}.jsonl`);
  const sessionIndexFile = join(fixture.baseDir, "session_index.jsonl");
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      sessionIndexFile,
      `${JSON.stringify({
        id: sessionId,
        thread_name: "旧 session index 标题",
        updated_at: "2026-03-01T00:00:00.000Z",
      })}\n`,
      "utf-8"
    );
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hi",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:02.000Z",
          type: "response_item",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: "请分析肝母细胞瘤机制相关研究进展" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          preview TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile,
        1774500000,
        1774500300,
        "cli",
        "octopus",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "hi",
        "hi",
        "hi"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const before = await provider.list({ eagerSearchIndex: true });
    assert.equal(before[0]?.title, "请分析肝母细胞瘤机制相关研究进展");
    assert.equal(before[0]?.badges?.some((badge) => badge.label === "标题回退"), true);

    await provider.updateTitle(`codex:${sessionId}`, "手动持久化标题");
    await setNativeTitle(`codex:${sessionId}`, "手动持久化标题");

    const after = await provider.list({ eagerSearchIndex: true });
    assert.equal(after[0]?.title, "手动持久化标题");
    assert.equal(after[0]?.badges?.some((badge) => badge.label === "标题回退") ?? false, false);

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.title, "手动持久化标题");

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT title, first_user_message, preview FROM threads WHERE id = ?").get(sessionId) as {
        title: string;
        first_user_message: string;
        preview: string;
      } | undefined;
      assert.equal(row?.title, "手动持久化标题");
      assert.equal(row?.first_user_message, "手动持久化标题");
      assert.equal(row?.preview, "手动持久化标题");
    } finally {
      verifyDb.close();
    }

    const firstLine = (await readFile(sourceFile, "utf-8")).split("\n")[0]!;
    const meta = JSON.parse(firstLine) as { type: string; payload: { title?: string; id?: string } };
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.payload.id, sessionId);
    assert.equal(meta.payload.title, "手动持久化标题");

    const sessionIndexLine = (await readFile(sessionIndexFile, "utf-8")).trim();
    const sessionIndex = JSON.parse(sessionIndexLine) as { id: string; thread_name: string };
    assert.equal(sessionIndex.id, sessionId);
    assert.equal(sessionIndex.thread_name, "手动持久化标题");

    const transcriptLines = (await readFile(sourceFile, "utf-8")).split("\n");
    const weakenedMeta = JSON.parse(transcriptLines[0]!) as { type: string; payload: { title?: string } };
    weakenedMeta.payload.title = "hi";
    transcriptLines[0] = JSON.stringify(weakenedMeta);
    await writeFile(sourceFile, transcriptLines.join("\n"), "utf-8");
    const pollutedDb = new Database(stateDbPath);
    try {
      pollutedDb.prepare("UPDATE threads SET title = ?, first_user_message = ?, preview = ? WHERE id = ?")
        .run("hi", "hi", "hi", sessionId);
    } finally {
      pollutedDb.close();
    }
    await writeFile(
      sessionIndexFile,
      `${JSON.stringify({ id: sessionId, thread_name: "hi", updated_at: "2026-03-01T00:00:09.000Z" })}\n`,
      "utf-8"
    );

    const afterTranscriptReset = await provider.list({ eagerSearchIndex: true });
    assert.equal(afterTranscriptReset[0]?.title, "手动持久化标题");
    assert.equal(afterTranscriptReset[0]?.badges?.some((badge) => badge.label === "标题回退") ?? false, false);

    const healedFirstLine = (await readFile(sourceFile, "utf-8")).split("\n")[0]!;
    const healedMeta = JSON.parse(healedFirstLine) as { type: string; payload: { title?: string } };
    assert.equal(healedMeta.payload.title, "手动持久化标题");

    const healedDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = healedDb.prepare("SELECT title, first_user_message, preview FROM threads WHERE id = ?").get(sessionId) as {
        title: string;
        first_user_message: string;
        preview: string;
      } | undefined;
      assert.equal(row?.title, "手动持久化标题");
      assert.equal(row?.first_user_message, "手动持久化标题");
      assert.equal(row?.preview, "手动持久化标题");
    } finally {
      healedDb.close();
    }

    const healedIndexLine = (await readFile(sessionIndexFile, "utf-8")).trim();
    const healedIndex = JSON.parse(healedIndexLine) as { id: string; thread_name: string };
    assert.equal(healedIndex.thread_name, "手动持久化标题");

    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    provider = null;

    const resetDb = new Database(stateDbPath);
    try {
      resetDb.prepare("UPDATE threads SET title = ?, first_user_message = ?, preview = ? WHERE id = ?")
        .run("hi", "hi", "hi", sessionId);
    } finally {
      resetDb.close();
    }

    provider = new CodexProvider();
    const afterCodexReset = await provider.list({ eagerSearchIndex: true });
    assert.equal(afterCodexReset[0]?.title, "手动持久化标题");
    assert.equal(afterCodexReset[0]?.badges?.some((badge) => badge.label === "标题回退") ?? false, false);

    const restoredDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = restoredDb.prepare("SELECT title, first_user_message, preview FROM threads WHERE id = ?").get(sessionId) as {
        title: string;
        first_user_message: string;
        preview: string;
      } | undefined;
      assert.equal(row?.title, "手动持久化标题");
      assert.equal(row?.first_user_message, "手动持久化标题");
      assert.equal(row?.preview, "手动持久化标题");
    } finally {
      restoredDb.close();
    }

    const detailAfterCodexReset = await provider.read(`codex:${sessionId}`);
    assert.equal(detailAfterCodexReset.title, "手动持久化标题");

    const externalTitleDb = new Database(stateDbPath);
    try {
      externalTitleDb.prepare("UPDATE threads SET title = ?, first_user_message = ?, preview = ? WHERE id = ?")
        .run("Codex 本地新标题", "Codex 本地新标题", "Codex 本地新标题", sessionId);
    } finally {
      externalTitleDb.close();
    }

    const afterExternalTitle = await provider.list({ eagerSearchIndex: true });
    assert.equal(afterExternalTitle[0]?.title, "Codex 本地新标题");
    assert.equal(await getNativeTitle(`codex:${sessionId}`), "Codex 本地新标题");

    const externalSyncedFirstLine = (await readFile(sourceFile, "utf-8")).split("\n")[0]!;
    const externalSyncedMeta = JSON.parse(externalSyncedFirstLine) as { type: string; payload: { title?: string } };
    assert.equal(externalSyncedMeta.payload.title, "Codex 本地新标题");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 手动标题会在缺少 session_index 记录时新增本地 resume 标题", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-session-index-upsert-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-session-index-upsert-session";
  const sourceFile = join(storagePath, "project-a", `${sessionId}.jsonl`);
  const sessionIndexFile = join(fixture.baseDir, "session_index.jsonl");
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hi",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          preview TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile,
        1774500000,
        1774500300,
        "cli",
        "octopus",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "hi",
        "hi",
        "hi"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    await provider.updateTitle(`codex:${sessionId}`, "UI 手动标题");

    const sessionIndexLine = (await readFile(sessionIndexFile, "utf-8")).trim();
    const sessionIndex = JSON.parse(sessionIndexLine) as { id: string; thread_name: string };
    assert.equal(sessionIndex.id, sessionId);
    assert.equal(sessionIndex.thread_name, "UI 手动标题");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex fork 子对话弱标题会继承父对话标题并同步本地 resume", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-fork-title-inheritance-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const parentId = "codex-fork-parent-session";
  const childId = "codex-fork-child-session";
  const parentFile = join(storagePath, "project-a", `${parentId}.jsonl`);
  const childFile = join(storagePath, "project-a", `${childId}.jsonl`);
  const sessionIndexFile = join(fixture.baseDir, "session_index.jsonl");
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await writeFile(
      parentFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: parentId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "请审查 chatlog-viewer 项目",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );
    await writeFile(
      childFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:01:00.000Z",
          type: "session_meta",
          payload: {
            id: childId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
            forked_from_id: parentId,
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:01:00.500Z",
          type: "session_meta",
          payload: {
            id: parentId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:01:00.750Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "父会话历史中的有效问题不应覆盖 fork 标题继承",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:01:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "hi",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );
    await writeFile(
      sessionIndexFile,
      [
        JSON.stringify({ id: parentId, thread_name: "父会话正式标题", updated_at: "2026-03-01T00:00:02.000Z" }),
        JSON.stringify({ id: childId, thread_name: "hi", updated_at: "2026-03-01T00:01:02.000Z" }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          preview TEXT
        )
      `);
      const insert = db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      insert.run(
        parentId,
        parentFile,
        1774500000,
        1774500300,
        "cli",
        "octopus",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "父会话正式标题",
        "父会话正式标题",
        "父会话正式标题"
      );
      insert.run(
        childId,
        childFile,
        1774500060,
        1774500360,
        "cli",
        "octopus",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "hi",
        "hi",
        "hi"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const items = await provider.list({ eagerSearchIndex: true });
    const child = items.find((item) => item.id === `codex:${childId}`);
    assert.equal(child?.title, "父会话正式标题");

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT title, first_user_message, preview FROM threads WHERE id = ?").get(childId) as {
        title: string;
        first_user_message: string;
        preview: string;
      } | undefined;
      assert.equal(row?.title, "父会话正式标题");
      assert.equal(row?.first_user_message, "父会话正式标题");
      assert.equal(row?.preview, "父会话正式标题");
    } finally {
      verifyDb.close();
    }

    const childFirstLine = (await readFile(childFile, "utf-8")).split("\n")[0]!;
    const childMeta = JSON.parse(childFirstLine) as {
      type: string;
      payload: { id?: string; forked_from_id?: string; title?: string };
    };
    assert.equal(childMeta.type, "session_meta");
    assert.equal(childMeta.payload.id, childId);
    assert.equal(childMeta.payload.forked_from_id, parentId);
    assert.equal(childMeta.payload.title, "父会话正式标题");

    const sessionIndexLines = (await readFile(sessionIndexFile, "utf-8")).trim().split(/\r?\n/);
    const childIndex = sessionIndexLines
      .map((line) => JSON.parse(line) as { id: string; thread_name: string })
      .find((entry) => entry.id === childId);
    assert.equal(childIndex?.thread_name, "父会话正式标题");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 可直接修改仅存在于 state db 的对话标题", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-state-only-title-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-state-only-title-session";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "custom",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "原始 State DB 标题",
        "原始 State DB 首条消息"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    await provider.updateTitle(`codex:${sessionId}`, "新的 State DB 标题");

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.title, "新的 State DB 标题");
    assert.match(detail.titleGenerationHint ?? "", /新的 State DB 标题/);

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT title, first_user_message FROM threads WHERE id = ?").get(sessionId) as {
        title: string;
        first_user_message: string;
      } | undefined;
      assert.equal(row?.title, "新的 State DB 标题");
      assert.equal(row?.first_user_message, "新的 State DB 标题");
    } finally {
      verifyDb.close();
    }
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex state-only 对话会用 UI 管理标题修复回退标题", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-state-only-managed-title-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-state-only-managed-title-session";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });
    await setNativeTitle(`codex:${sessionId}`, "UI 管理标题");

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          preview TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "octopus",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "hi",
        "hi",
        "hi"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const list = await provider.list({ eagerSearchIndex: true });
    assert.equal(list[0]?.title, "UI 管理标题");
    assert.equal(list[0]?.contentStatus, "metadata-only");

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.title, "UI 管理标题");
    assert.match(detail.titleGenerationHint ?? "", /UI 管理标题/);

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT title, first_user_message, preview FROM threads WHERE id = ?").get(sessionId) as {
        title: string;
        first_user_message: string;
        preview: string;
      } | undefined;
      assert.equal(row?.title, "UI 管理标题");
      assert.equal(row?.first_user_message, "UI 管理标题");
      assert.equal(row?.preview, "UI 管理标题");
    } finally {
      verifyDb.close();
    }
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 可修改仅存在于 state db 的对话 provider", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-state-only-provider-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-state-only-provider-session";
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(storagePath, { recursive: true });

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "v",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "仅状态库对话",
        "仅状态库首条消息"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const updated = await provider.changeModelProviders([`codex:${sessionId}`], "custom");
    assert.equal(updated, 1);

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get(sessionId) as { model_provider: string } | undefined;
      assert.equal(row?.model_provider, "custom");
    } finally {
      verifyDb.close();
    }
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 列表会标记 ChatLog Viewer 内部 AI 标题生成会话", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-title-session-badge-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const configPath = join(fixture.baseDir, ".chatlog-viewer", "config.json");
  const titleSessionDir = join(fixture.baseDir, ".chatlog-viewer", "ai-title-sessions", "codex");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;
  const sessionId = "codex-internal-title-session";
  const sourceFile = join(storagePath, "2026", "06", "01", `rollout-2026-06-01T10-11-09-${sessionId}.jsonl`);
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "2026", "06", "01"), { recursive: true });
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-06-01T10:11:09.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: titleSessionDir,
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-01T10:11:10.000Z",
          type: "response_item",
          payload: {
            role: "user",
            content: [{ type: "input_text", text: "请为以下AI对话生成一个简短标题" }],
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT,
          preview TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message, preview
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile,
        1780280000,
        1780280100,
        "cli",
        "octopus",
        titleSessionDir,
        "内部标题生成会话",
        "内部标题生成会话",
        "内部标题生成会话"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const conversations = await provider.list({ eagerSearchIndex: true });
    const conversation = conversations.find((item) => item.id === `codex:${sessionId}`);
    assert.ok(conversation);
    assert.equal(conversation.badges?.some((badge) => badge.label === "标题生成"), true);
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }

      if (previousConfigPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
      }
    });
  }
});

test("Codex 修改有 transcript 的对话 provider 时会同步 session_meta", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-provider-session-meta-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-provider-session-meta";
  const sourceDir = join(storagePath, "project-a");
  const sourceFile = join(sourceDir, `${sessionId}.jsonl`);
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
            model_provider: "v",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "provider 同步测试",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile,
        1774500000,
        1774500300,
        "cli",
        "v",
        "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        "provider 同步测试",
        "provider 同步测试"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const updated = await provider.changeModelProviders([`codex:${sessionId}`], "octopus");
    assert.equal(updated, 1);

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT model_provider FROM threads WHERE id = ?").get(sessionId) as { model_provider: string } | undefined;
      assert.equal(row?.model_provider, "octopus");
    } finally {
      verifyDb.close();
    }

    const firstLine = (await readFile(sourceFile, "utf-8")).split("\n")[0]!;
    const meta = JSON.parse(firstLine) as { type: string; payload: { model_provider?: string } };
    assert.equal(meta.type, "session_meta");
    assert.equal(meta.payload.model_provider, "octopus");
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex move 会真正迁移 transcript 并同步 state db 路径", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-move-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-move-session";
  const originalProject = "C:/Users/tester/Desktop/code_area/original-project";
  const targetProject = "C:/Users/tester/Desktop/code_area/target-project";
  const createdAt = 1774500000;
  const sourceDir = join(storagePath, "original-project");
  const sourceFile = join(sourceDir, `${sessionId}.jsonl`);
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: originalProject.replace(/\//g, "\\"),
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "移动测试",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile.replace(/\//g, "\\"),
        createdAt,
        1774500300,
        "cli",
        "custom",
        originalProject.replace(/\//g, "\\"),
        "移动测试标题",
        "移动测试"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    await provider.move(`codex:${sessionId}`, targetProject);

    const movedList = await provider.list({ eagerSearchIndex: false });
    const movedMeta = movedList.find((item) => item.id === `codex:${sessionId}`);
    const expectedMovedPath = buildExpectedCodexTranscriptPath(storagePath, sessionId, createdAt * 1000).replace(/\\/g, "/");
    assert.ok(movedMeta);
    assert.equal(movedMeta?.projectKey, targetProject.toLowerCase());
    assert.equal(movedMeta?.filePath, expectedMovedPath);

    await assert.rejects(stat(sourceFile));
    const movedFilePath = movedMeta?.filePath;
    assert.ok(movedFilePath);
    const movedContent = await readFile(movedFilePath!, "utf-8");
    assert.match(movedContent, /target-project/i);

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT rollout_path, cwd FROM threads WHERE id = ?").get(sessionId) as {
        rollout_path: string;
        cwd: string;
      } | undefined;
      assert.ok(row);
      assert.equal(row?.rollout_path.replace(/\\/g, "/"), expectedMovedPath);
      assert.match(row?.cwd ?? "", /target-project/i);
    } finally {
      verifyDb.close();
    }
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex move 在 state db 更新失败时会回滚 transcript 迁移", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-move-rollback-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-move-rollback-session";
  const originalProject = "C:/Users/tester/Desktop/code_area/original-project";
  const targetProject = "C:/Users/tester/Desktop/code_area/target-project";
  const createdAt = 1774500000;
  const sourceDir = join(storagePath, "original-project");
  const sourceFile = join(sourceDir, `${sessionId}.jsonl`);
  const targetFile = buildExpectedCodexTranscriptPath(storagePath, sessionId, createdAt * 1000);
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      sourceFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: originalProject.replace(/\//g, "\\"),
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "迁移回滚测试",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        sourceFile.replace(/\//g, "\\"),
        createdAt,
        1774500300,
        "cli",
        "custom",
        originalProject.replace(/\//g, "\\"),
        "迁移回滚测试",
        "迁移回滚测试"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const patchedProvider = provider as unknown as {
      sqliteClient: {
        updateThreadLocation: (sessionId: string, updates: { cwd?: string; rolloutPath?: string | null }) => boolean;
      };
    };
    const originalUpdateThreadLocation = patchedProvider.sqliteClient.updateThreadLocation.bind(patchedProvider.sqliteClient);
    patchedProvider.sqliteClient.updateThreadLocation = () => false;

    await assert.rejects(
      provider.move(`codex:${sessionId}`, targetProject),
      /未能同步 Codex state db/
    );

    patchedProvider.sqliteClient.updateThreadLocation = originalUpdateThreadLocation;
    (provider as unknown as { closeDb?: () => void }).closeDb?.();
    provider = null;

    const rolledBackContent = await readFile(sourceFile, "utf-8");
    assert.match(rolledBackContent, /original-project/i);
    await assert.rejects(stat(targetFile));

    const verifyDb = new Database(stateDbPath, { readonly: true });
    try {
      const row = verifyDb.prepare("SELECT rollout_path, cwd FROM threads WHERE id = ?").get(sessionId) as {
        rollout_path: string;
        cwd: string;
      } | undefined;
      assert.ok(row);
      assert.match(row?.rollout_path ?? "", /original-project/i);
      assert.match(row?.cwd ?? "", /original-project/i);
    } finally {
      verifyDb.close();
    }
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 会基于 session_meta 精确定位文件，避免被包含 sessionId 的文件名误命中", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-file-match-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-match-session";
  const realDir = join(storagePath, "real-project");
  const fakeDir = join(storagePath, "fake-project");
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(realDir, { recursive: true });
    await mkdir(fakeDir, { recursive: true });
    await writeFile(
      join(fakeDir, `noise-${sessionId}.jsonl`),
      `${JSON.stringify({
        timestamp: "2026-03-01T00:00:00.000Z",
        type: "session_meta",
        payload: {
          id: "some-other-session",
          cwd: "C:\\Users\\tester\\Desktop\\code_area\\fake-project",
        },
      })}\n`,
      "utf-8"
    );
    await writeFile(
      join(realDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\tester\\Desktop\\code_area\\real-project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "真实命中",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        "",
        1774500000,
        1774500300,
        "cli",
        "custom",
        "C:/Users/tester/Desktop/code_area/real-project",
        "真实命中",
        "真实命中"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();
    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.title, "真实命中");
    assert.match(detail.filePath, /real-project/);
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("Codex 不会盲目信任 state db 中错误指向的 rollout_path", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-rollout-path-mismatch-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-rollout-mismatch-session";
  const wrongSessionId = "codex-other-session";
  const realDir = join(storagePath, "real-project");
  const wrongDir = join(storagePath, "wrong-project");
  const realFile = join(realDir, `${sessionId}.jsonl`);
  const wrongFile = join(wrongDir, `${wrongSessionId}.jsonl`);
  let provider: CodexProvider | null = null;

  try {
    process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = storagePath;
    process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = stateDbPath;
    clearProviderPathCache();

    await mkdir(realDir, { recursive: true });
    await mkdir(wrongDir, { recursive: true });
    await writeFile(
      wrongFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: wrongSessionId,
            cwd: "C:\\Users\\tester\\Desktop\\code_area\\wrong-project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "错误 transcript",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );
    await writeFile(
      realFile,
      [
        JSON.stringify({
          timestamp: "2026-03-01T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:\\Users\\tester\\Desktop\\code_area\\real-project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-03-01T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "真实 transcript",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
    try {
      db.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          rollout_path TEXT,
          created_at INTEGER,
          updated_at INTEGER,
          source TEXT,
          model_provider TEXT,
          cwd TEXT,
          title TEXT,
          first_user_message TEXT
        )
      `);
      db.prepare(
        `INSERT INTO threads (
          id, rollout_path, created_at, updated_at, source, model_provider, cwd, title, first_user_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        sessionId,
        wrongFile.replace(/\//g, "\\"),
        1774500000,
        1774500300,
        "cli",
        "custom",
        "C:/Users/tester/Desktop/code_area/real-project",
        "真实 transcript",
        "真实 transcript"
      );
    } finally {
      db.close();
    }

    provider = new CodexProvider();

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.title, "真实 transcript");
    assert.match(detail.filePath, /real-project/);

    await provider.delete(`codex:${sessionId}`);
    await assert.rejects(stat(realFile));
    const wrongContent = await readFile(wrongFile, "utf-8");
    assert.match(wrongContent, /错误 transcript/);
  } finally {
    (provider as unknown as { closeDb?: () => void } | null)?.closeDb?.();
    await fixture.cleanup(() => {
      if (previousSessionsPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH = previousSessionsPath;
      }

      if (previousStateDbPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH = previousStateDbPath;
      }
    });
  }
});

test("iFlow move 会拒绝越界的目标目录", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-iflow-move-path-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_IFLOW_PATH;
  const sessionId = "session-iflow-move-path";

  try {
    process.env.CHATLOG_VIEWER_IFLOW_PATH = storagePath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "demo-project"), { recursive: true });
    await writeFile(
      join(storagePath, "demo-project", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          uuid: "iflow-move-1",
          parentUuid: null,
          sessionId,
          timestamp: "2026-03-02T00:00:00.000Z",
          type: "user",
          isSidechain: false,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          message: {
            role: "user",
            content: "移动测试",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const provider = new IFlowProvider();
    await assert.rejects(
      provider.move(`iflow:${sessionId}`, "../outside-project"),
      /目标文件夹不合法/
    );
    const content = await readFile(join(storagePath, "demo-project", `${sessionId}.jsonl`), "utf-8");
    assert.match(content, /移动测试/);
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_IFLOW_PATH;
      } else {
        process.env.CHATLOG_VIEWER_IFLOW_PATH = previousStoragePath;
      }
    });
  }
});

test("iFlow 会拒绝多个目录下同 sessionId 的歧义定位", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-iflow-duplicate-session-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_IFLOW_PATH;
  const sessionId = "session-iflow-duplicate";

  try {
    process.env.CHATLOG_VIEWER_IFLOW_PATH = storagePath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "project-a"), { recursive: true });
    await mkdir(join(storagePath, "project-b"), { recursive: true });
    const content = [
      JSON.stringify({
        uuid: "iflow-dup-1",
        parentUuid: null,
        sessionId,
        timestamp: "2026-03-02T00:00:00.000Z",
        type: "user",
        isSidechain: false,
        cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
        message: {
          role: "user",
          content: "重复 sessionId",
        },
      }),
    ].join("\n") + "\n";
    await writeFile(join(storagePath, "project-a", `${sessionId}.jsonl`), content, "utf-8");
    await writeFile(join(storagePath, "project-b", `${sessionId}.jsonl`), content, "utf-8");

    const provider = new IFlowProvider();
    await assert.rejects(
      provider.read(`iflow:${sessionId}`),
      /定位到多个同名对话文件/
    );
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_IFLOW_PATH;
      } else {
        process.env.CHATLOG_VIEWER_IFLOW_PATH = previousStoragePath;
      }
    });
  }
});

test("iFlow 消息在连续编辑和删除其它消息后保持稳定 messageId", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-iflow-message-id-");
  const storagePath = join(fixture.baseDir, "projects");
  const previousStoragePath = process.env.CHATLOG_VIEWER_IFLOW_PATH;
  const sessionId = "session-iflow-message-id";

  try {
    process.env.CHATLOG_VIEWER_IFLOW_PATH = storagePath;
    clearProviderPathCache();

    await mkdir(join(storagePath, "demo-project"), { recursive: true });
    await writeFile(
      join(storagePath, "demo-project", `${sessionId}.jsonl`),
      [
        JSON.stringify({
          uuid: "iflow-1",
          parentUuid: null,
          sessionId,
          timestamp: "2026-03-02T00:00:00.000Z",
          type: "user",
          isSidechain: false,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          message: {
            role: "user",
            content: "第一条消息",
          },
        }),
        JSON.stringify({
          uuid: "iflow-2",
          parentUuid: "iflow-1",
          sessionId,
          timestamp: "2026-03-02T00:00:02.000Z",
          type: "assistant",
          isSidechain: false,
          message: {
            role: "assistant",
            content: "第二条消息",
          },
        }),
        JSON.stringify({
          uuid: "iflow-3",
          parentUuid: "iflow-2",
          sessionId,
          timestamp: "2026-03-02T00:00:03.000Z",
          type: "user",
          isSidechain: false,
          message: {
            role: "user",
            content: "第三条消息",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const provider = new IFlowProvider();
    const initial = await provider.read(`iflow:${sessionId}`);
    const firstMessageId = initial.messages[0]?.messageId;
    const targetMessageId = initial.messages[1]?.messageId;

    assert.ok(firstMessageId);
    assert.ok(targetMessageId);

    await provider.updateMessage(`iflow:${sessionId}`, targetMessageId!, "第二条消息-第一次编辑");
    await provider.updateMessage(`iflow:${sessionId}`, targetMessageId!, "第二条消息-第二次编辑");
    await provider.deleteMessages(`iflow:${sessionId}`, [firstMessageId!]);
    await provider.updateMessage(`iflow:${sessionId}`, targetMessageId!, "第二条消息-删除后再次编辑");

    const updated = await provider.read(`iflow:${sessionId}`);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0]?.messageId, targetMessageId);
    assert.equal(updated.messages[0]?.content, "第二条消息-删除后再次编辑");
  } finally {
    await fixture.cleanup(() => {
      if (previousStoragePath === undefined) {
        delete process.env.CHATLOG_VIEWER_IFLOW_PATH;
      } else {
        process.env.CHATLOG_VIEWER_IFLOW_PATH = previousStoragePath;
      }
    });
  }
});
