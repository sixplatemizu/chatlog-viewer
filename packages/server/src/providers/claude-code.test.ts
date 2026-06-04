import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code.js";
import { clearProviderPathCache } from "../utils/provider-paths.js";
import { getIndexedCacheSnapshot, getIndexedListCacheKey, setCacheStoreDirForTests } from "../utils/cache.js";

function createHistoryLine(input: {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}): string {
  return `${JSON.stringify(input)}\n`;
}

async function createProviderFixture() {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-claude-provider-"));
  const storagePath = join(baseDir, "projects");
  const storeDir = join(baseDir, ".chatlog-viewer");
  await mkdir(storagePath, { recursive: true });

  const previousClaudePath = process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = storagePath;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  return {
    baseDir,
    storagePath,
    provider: new ClaudeCodeProvider(),
    async cleanup() {
      if (previousClaudePath === undefined) {
        delete process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = previousClaudePath;
      }

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

test("Claude Code 会从 sessions-index 与 history.jsonl 构建目录型会话，并支持标题写回", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const orphanSessionId = "22222222-2222-4222-8222-222222222222";
  const projectKey = "C--Users-tester-Desktop-code_area-r-bioinfo";
  const projectDir = join(fixture.storagePath, projectKey);
  const historyPath = join(fixture.baseDir, "history.jsonl");

  try {
    await mkdir(join(projectDir, sessionId), { recursive: true });
    await mkdir(join(projectDir, orphanSessionId), { recursive: true });

    await writeFile(join(projectDir, "sessions-index.json"), JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId,
          fullPath: `C:\\Users\\tester\\.claude\\projects\\${projectKey}\\${sessionId}.jsonl`,
          summary: "索引标题",
          firstPrompt: "原始首条问题",
          messageCount: 5,
          created: "2026-03-01T00:00:00.000Z",
          modified: "2026-03-02T00:00:00.000Z",
          projectPath: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          isSidechain: false,
        },
      ],
      originalPath: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
    }, null, 2), "utf-8");

    await writeFile(
      historyPath,
      [
        createHistoryLine({
          display: "/resume",
          timestamp: 1_772_000_000_000,
          project: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          sessionId,
        }),
        createHistoryLine({
          display: "真实用户问题",
          timestamp: 1_772_000_100_000,
          project: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          sessionId,
        }),
        createHistoryLine({
          display: "继续补充",
          timestamp: 1_772_000_200_000,
          project: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          sessionId,
        }),
      ].join(""),
      "utf-8"
    );

    const conversations = await fixture.provider.list();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `claude-code:${sessionId}`);
    assert.equal(conversations[0]?.title, "索引标题");
    assert.equal(conversations[0]?.project, "C:/Users/tester/Desktop/code_area/r-bioinfo");

    const conversation = await fixture.provider.read(`claude-code:${sessionId}`);
    assert.equal(conversation.messages[0]?.role, "system");
    assert.ok(conversation.messages.some((message) => message.content === "真实用户问题"));
    assert.ok(conversation.messages.some((message) => message.content === "继续补充"));

    await fixture.provider.updateTitle(`claude-code:${sessionId}`, "同步后的标题");
    const updatedIndex = JSON.parse(
      await readFile(join(projectDir, "sessions-index.json"), "utf-8")
    ) as {
      entries: Array<{ sessionId: string; summary?: string; customTitle?: string }>;
    };
    const updatedEntry = updatedIndex.entries.find((entry) => entry.sessionId === sessionId);
    assert.equal(updatedEntry?.summary, "同步后的标题");
    assert.equal(updatedEntry?.customTitle, "同步后的标题");
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code 会从带尾部损坏的 sessions-index 中恢复 history-only 会话", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const projectKey = "C--Users-tester-Desktop-code_area-r-bioinfo";
  const projectDir = join(fixture.storagePath, projectKey);
  const historyPath = join(fixture.baseDir, "history.jsonl");

  try {
    await mkdir(projectDir, { recursive: true });
    const validIndex = JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId,
          summary: "可恢复索引标题",
          firstPrompt: "损坏索引中的首条问题",
          messageCount: 3,
          created: "2026-03-01T00:00:00.000Z",
          modified: "2026-03-02T00:00:00.000Z",
          projectPath: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          isSidechain: false,
        },
      ],
      originalPath: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
    }, null, 2);
    await writeFile(
      join(projectDir, "sessions-index.json"),
      `${validIndex}"isSidechain": false\n    }\n  ]\n}`,
      "utf-8"
    );
    await writeFile(
      historyPath,
      [
        createHistoryLine({
          display: "history 恢复问题",
          timestamp: 1_772_000_100_000,
          project: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
          sessionId,
        }),
      ].join(""),
      "utf-8"
    );

    const conversations = await fixture.provider.list();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `claude-code:${sessionId}`);
    assert.equal(conversations[0]?.title, "可恢复索引标题");
    assert.equal(conversations[0]?.contentStatus, "history-only");
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "history 回填"), true);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code 会回填仅存在于 history.jsonl 与 session 目录中的会话", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "33333333-3333-4333-8333-333333333333";
  const projectKey = "C--Users-tester-Desktop-code_area-r-bioinfo";
  const projectDir = join(fixture.storagePath, projectKey);
  const historyPath = join(fixture.baseDir, "history.jsonl");

  try {
    await mkdir(join(projectDir, sessionId), { recursive: true });
    await writeFile(
      historyPath,
      createHistoryLine({
        display: "history only title",
        timestamp: 1_772_100_000_000,
        project: "C:\\Users\\tester\\Desktop\\code_area\\r-bioinfo",
        sessionId,
      }),
      "utf-8"
    );

    const conversations = await fixture.provider.list();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `claude-code:${sessionId}`);
    assert.equal(conversations[0]?.title, "history only title");
    assert.equal(conversations[0]?.messageCount, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code 在 eagerSearchIndex 模式下会为 transcript 一次构建搜索索引", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "44444444-4444-4444-8444-444444444444";
  const projectKey = "C--Users-tester-Desktop-code_area-chatlog-viewer";
  const projectDir = join(fixture.storagePath, projectKey);
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const needle = "claude-provider-needle";

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          sessionId,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          timestamp: "2026-03-03T00:00:00.000Z",
          message: {
            role: "user",
            content: `请定位 ${needle} 的实现`,
          },
        }),
        JSON.stringify({
          type: "assistant",
          sessionId,
          timestamp: "2026-03-03T00:00:05.000Z",
          message: {
            role: "assistant",
            content: `${needle} 已经出现在回答正文里`,
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const conversations = await fixture.provider.list({ eagerSearchIndex: true });
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.title, `请定位 ${needle} 的实现`);

    const snapshot = getIndexedCacheSnapshot(
      getIndexedListCacheKey("claude-code", fixture.provider.getStoragePath())
    );
    assert.equal(snapshot?.[0]?.meta.id, `claude-code:${sessionId}`);
    assert.ok(snapshot?.[0]?.searchText?.includes(needle));
    assert.ok(snapshot?.[0]?.searchChunks?.some((chunk) => chunk.includes(needle)));
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code move 会拒绝越界的目标目录", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const projectKey = "C--Users-tester-Desktop-code_area-chatlog-viewer";
  const projectDir = join(fixture.storagePath, projectKey);
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "claude-move-1",
          sessionId,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          timestamp: "2026-03-03T00:00:00.000Z",
          message: {
            role: "user",
            content: "移动测试",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    await assert.rejects(
      fixture.provider.move(`claude-code:${sessionId}`, "../outside-project"),
      /目标文件夹不合法/
    );
    const content = await readFile(transcriptPath, "utf-8");
    assert.match(content, /移动测试/);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code 消息在连续编辑和删除其它消息后保持稳定 messageId", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "66666666-6666-4666-8666-666666666666";
  const projectKey = "C--Users-tester-Desktop-code_area-chatlog-viewer";
  const projectDir = join(fixture.storagePath, projectKey);
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "claude-1",
          sessionId,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          timestamp: "2026-03-03T00:00:00.000Z",
          message: {
            role: "user",
            content: "第一条消息",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "claude-2",
          sessionId,
          timestamp: "2026-03-03T00:00:05.000Z",
          message: {
            id: "msg-claude-2",
            role: "assistant",
            content: "第二条消息",
          },
        }),
        JSON.stringify({
          type: "user",
          uuid: "claude-3",
          sessionId,
          timestamp: "2026-03-03T00:00:08.000Z",
          message: {
            role: "user",
            content: "第三条消息",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const initial = await fixture.provider.read(`claude-code:${sessionId}`);
    const firstMessageId = initial.messages[0]?.messageId;
    const targetMessageId = initial.messages[1]?.messageId;

    assert.ok(firstMessageId);
    assert.ok(targetMessageId);

    await fixture.provider.updateMessage(`claude-code:${sessionId}`, targetMessageId!, "第二条消息-第一次编辑");
    await fixture.provider.updateMessage(`claude-code:${sessionId}`, targetMessageId!, "第二条消息-第二次编辑");
    await fixture.provider.deleteMessages(`claude-code:${sessionId}`, [firstMessageId!]);
    await fixture.provider.updateMessage(`claude-code:${sessionId}`, targetMessageId!, "第二条消息-删除后再次编辑");

    const updated = await fixture.provider.read(`claude-code:${sessionId}`);
    assert.equal(updated.messages.length, 2);
    assert.equal(updated.messages[0]?.messageId, targetMessageId);
    assert.equal(updated.messages[0]?.content, "第二条消息-删除后再次编辑");
  } finally {
    await fixture.cleanup();
  }
});
