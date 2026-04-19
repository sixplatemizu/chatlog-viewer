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
import { clearProviderPathCache } from "../utils/provider-paths.js";
import { getIndexedCacheSnapshot, getIndexedListCacheKey, setCacheStoreDirForTests } from "../utils/cache.js";

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

    const snapshot = getIndexedCacheSnapshot(getIndexedListCacheKey("codex", provider.getStoragePath()));
    assert.equal(snapshot?.[0]?.meta.id, `codex:${sessionId}`);
    assert.ok(snapshot?.[0]?.searchText?.includes(needle));
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

    const detail = await provider.read(`claude-code:${sessionId}`);
    assert.equal(detail.contentStatus, "history-only");
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

    const detail = await provider.read(`codex:${sessionId}`);
    assert.equal(detail.transcriptMissing, true);
    assert.equal(detail.contentStatus, "metadata-only");
    assert.equal(detail.messages.length, 1);
    assert.match(detail.messages[0]?.content ?? "", /未找到 transcript 文件/);
    assert.match(detail.titleGenerationHint ?? "", /State DB 标题/);
    assert.match(detail.titleGenerationHint ?? "", /State DB 首条消息/);

    const snapshot = getIndexedCacheSnapshot(getIndexedListCacheKey("codex", provider.getStoragePath()));
    assert.equal(snapshot?.[0]?.meta.id, `codex:${sessionId}`);
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

test("Codex move 会真正迁移 transcript 并同步 state db 路径", async () => {
  const fixture = await createBaseFixture("chatlog-viewer-codex-move-");
  const storagePath = join(fixture.baseDir, "sessions");
  const stateDbPath = join(fixture.baseDir, "state_5.sqlite");
  const previousSessionsPath = process.env.CHATLOG_VIEWER_CODEX_SESSIONS_PATH;
  const previousStateDbPath = process.env.CHATLOG_VIEWER_CODEX_STATE_DB_PATH;
  const sessionId = "codex-move-session";
  const originalProject = "C:/Users/tester/Desktop/code_area/original-project";
  const targetProject = "C:/Users/tester/Desktop/code_area/target-project";
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
        1774500000,
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
    assert.ok(movedMeta);
    assert.equal(movedMeta?.projectKey, targetProject.toLowerCase());
    assert.match(movedMeta?.filePath ?? "", /target-project/i);

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
      assert.match(row?.rollout_path ?? "", /target-project/i);
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
  const sourceDir = join(storagePath, "original-project");
  const sourceFile = join(sourceDir, `${sessionId}.jsonl`);
  const targetFile = join(storagePath, "c--users-tester-desktop-code_area-target-project", `${sessionId}.jsonl`);
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
        1774500000,
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
