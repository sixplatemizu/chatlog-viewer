import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
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
