import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeProvider } from "./claude-code.js";
import { clearProviderPathCache } from "../utils/provider-paths.js";
import { getIndexedCacheSnapshot, getIndexedListCacheKey, setCacheStoreDirForTests } from "../utils/cache.js";
import { setNativeTitleSnapshot } from "../utils/title-store.js";

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
  const configPath = join(storeDir, "config.json");
  await mkdir(storagePath, { recursive: true });

  const previousClaudePath = process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH;
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;
  process.env.CHATLOG_VIEWER_CLAUDE_CODE_PATH = storagePath;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  return {
    baseDir,
    storagePath,
    storeDir,
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

      if (previousConfigPath === undefined) {
        delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      } else {
        process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
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

test("Claude Code 标题以 transcript 原生 metadata 为准并按 /rename 语义追加", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "88888888-8888-4888-8888-888888888888";
  const projectKey = "C--Users-tester-Desktop-code_area-chatlog-viewer";
  const projectDir = join(fixture.storagePath, projectKey);
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "sessions-index.json"), JSON.stringify({
      version: 1,
      entries: [
        {
          sessionId,
          fullPath: transcriptPath,
          summary: "索引旧标题",
          customTitle: "索引旧标题",
          firstPrompt: "原始首条问题",
          messageCount: 1,
          created: "2026-03-01T00:00:00.000Z",
          modified: "2026-03-02T00:00:00.000Z",
          projectPath: "C:\\Users\\tester\\Desktop\\code_area\\chatlog-viewer",
          isSidechain: false,
        },
      ],
    }, null, 2), "utf-8");
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "custom-title",
          sessionId,
          customTitle: "transcript 旧标题",
          summary: "transcript 旧标题",
          timestamp: "2026-03-01T00:00:00.000Z",
          isMeta: true,
        }),
        JSON.stringify({
          type: "user",
          uuid: "claude-title-1",
          sessionId,
          cwd: "C:/Users/tester/Desktop/code_area/chatlog-viewer",
          timestamp: "2026-03-01T00:00:01.000Z",
          message: {
            role: "user",
            content: "原始首条问题",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    await setNativeTitleSnapshot(`claude-code:${sessionId}`, "UI 持久标题");
    const listed = await fixture.provider.list();
    assert.equal(listed[0]?.title, "transcript 旧标题");

    const detail = await fixture.provider.read(`claude-code:${sessionId}`);
    assert.equal(detail.title, "transcript 旧标题");

    await fixture.provider.updateTitle(`claude-code:${sessionId}`, "二次修改标题");

    const updatedIndex = JSON.parse(
      await readFile(join(projectDir, "sessions-index.json"), "utf-8")
    ) as {
      entries: Array<{ sessionId: string; summary?: string; customTitle?: string; agentName?: string }>;
    };
    const updatedEntry = updatedIndex.entries.find((entry) => entry.sessionId === sessionId);
    assert.equal(updatedEntry?.summary, "二次修改标题");
    assert.equal(updatedEntry?.customTitle, "二次修改标题");
    assert.equal(updatedEntry?.agentName, "二次修改标题");

    const transcriptLines = (await readFile(transcriptPath, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as {
        type: string;
        customTitle?: string;
        agentName?: string;
        sessionId?: string;
      });
    const customTitleEntries = transcriptLines.filter((entry) => entry.type === "custom-title");
    const agentNameEntries = transcriptLines.filter((entry) => entry.type === "agent-name");
    assert.equal(customTitleEntries.length, 2);
    assert.equal(customTitleEntries.at(-1)?.customTitle, "二次修改标题");
    assert.equal(customTitleEntries.at(-1)?.sessionId, sessionId);
    assert.equal(agentNameEntries.length, 1);
    assert.equal(agentNameEntries[0]?.agentName, "二次修改标题");
    assert.equal(agentNameEntries[0]?.sessionId, sessionId);

    const relisted = await fixture.provider.list();
    assert.equal(relisted[0]?.title, "二次修改标题");
    const reread = await fixture.provider.read(`claude-code:${sessionId}`);
    assert.equal(reread.title, "二次修改标题");

    await Promise.all([
      fixture.provider.updateTitle(`claude-code:${sessionId}`, "并发标题一"),
      fixture.provider.updateTitle(`claude-code:${sessionId}`, "并发标题二"),
    ]);
    const concurrentIndex = JSON.parse(
      await readFile(join(projectDir, "sessions-index.json"), "utf-8")
    ) as {
      entries: Array<{ sessionId: string; customTitle?: string; summary?: string; agentName?: string }>;
    };
    const concurrentEntry = concurrentIndex.entries.find((entry) => entry.sessionId === sessionId);
    assert.equal(concurrentEntry?.customTitle, "并发标题二");
    assert.equal(concurrentEntry?.summary, "并发标题二");
    assert.equal(concurrentEntry?.agentName, "并发标题二");
    assert.equal((await fixture.provider.read(`claude-code:${sessionId}`)).title, "并发标题二");
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code 会标记 ChatLog Viewer 内部 AI 标题生成会话", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "99999999-9999-4999-8999-999999999999";
  const projectKey = "C--Users-tester-AppData-Roaming-chatlog-viewer-ai-title-sessions-claude";
  const projectDir = join(fixture.storagePath, projectKey);
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const titleSessionDir = join(fixture.storeDir, "ai-title-sessions", "claude");

  try {
    await mkdir(projectDir, { recursive: true });
    await mkdir(titleSessionDir, { recursive: true });
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          type: "user",
          uuid: "claude-title-session-1",
          sessionId,
          cwd: titleSessionDir,
          timestamp: "2026-03-01T00:00:00.000Z",
          message: {
            role: "user",
            content: "请为目标对话生成标题",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "claude-title-session-2",
          sessionId,
          timestamp: "2026-03-01T00:00:05.000Z",
          message: {
            role: "assistant",
            content: "生成的标题",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const conversations = await fixture.provider.list();
    assert.equal(conversations.length, 1);
    assert.equal(conversations[0]?.id, `claude-code:${sessionId}`);
    assert.equal(conversations[0]?.badges?.some((badge) => badge.label === "标题生成"), true);

    const detail = await fixture.provider.read(`claude-code:${sessionId}`);
    assert.equal(detail.badges?.some((badge) => badge.label === "标题生成"), true);
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

test("Claude Code move 会迁移 transcript 并同步源目标 index", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "77777777-7777-4777-8777-777777777777";
  const sourceProjectKey = "source-project";
  const targetProjectKey = "target-project";
  const sourceProjectDir = join(fixture.storagePath, sourceProjectKey);
  const targetProjectDir = join(fixture.storagePath, targetProjectKey);
  const sourceTranscriptPath = join(sourceProjectDir, `${sessionId}.jsonl`);
  const sourceIndexPath = join(sourceProjectDir, "sessions-index.json");
  const targetIndexPath = join(targetProjectDir, "sessions-index.json");

  try {
    await mkdir(sourceProjectDir, { recursive: true });
    await writeFile(sourceTranscriptPath, `${JSON.stringify({
      type: "user",
      uuid: "claude-move-success",
      sessionId,
      cwd: "C:/source-project",
      timestamp: "2026-03-03T00:00:00.000Z",
      message: { role: "user", content: "迁移成功测试" },
    })}\n`, "utf-8");
    await writeFile(sourceIndexPath, JSON.stringify({
      version: 1,
      entries: [{
        sessionId,
        fullPath: sourceTranscriptPath,
        summary: "迁移成功测试",
        firstPrompt: "迁移成功测试",
        modified: "2026-03-03T00:00:00.000Z",
        isSidechain: false,
      }],
    }), "utf-8");

    await fixture.provider.move(`claude-code:${sessionId}`, targetProjectKey);

    await assert.rejects(() => readFile(sourceTranscriptPath, "utf-8"));
    assert.match(await readFile(join(targetProjectDir, `${sessionId}.jsonl`), "utf-8"), /迁移成功测试/);
    const sourceIndex = JSON.parse(await readFile(sourceIndexPath, "utf-8")) as { entries: Array<{ sessionId: string }> };
    const targetIndex = JSON.parse(await readFile(targetIndexPath, "utf-8")) as { entries: Array<{ sessionId: string }> };
    assert.equal(sourceIndex.entries.some((entry) => entry.sessionId === sessionId), false);
    assert.equal(targetIndex.entries.some((entry) => entry.sessionId === sessionId), true);
  } finally {
    await fixture.cleanup();
  }
});

test("Claude Code move 在目标 index 写入失败时会恢复文件和两个 index", async () => {
  const fixture = await createProviderFixture();
  const sessionId = "88888888-8888-4888-8888-888888888888";
  const sourceProjectKey = "source-rollback";
  const targetProjectKey = "target-rollback";
  const sourceProjectDir = join(fixture.storagePath, sourceProjectKey);
  const targetProjectDir = join(fixture.storagePath, targetProjectKey);
  const sourceTranscriptPath = join(sourceProjectDir, `${sessionId}.jsonl`);
  const sourceIndexPath = join(sourceProjectDir, "sessions-index.json");
  const targetIndexPath = join(targetProjectDir, "sessions-index.json");
  const sourceIndexContent = JSON.stringify({
    version: 1,
    entries: [{
      sessionId,
      fullPath: sourceTranscriptPath,
      summary: "回滚测试",
      firstPrompt: "回滚测试",
      modified: "2026-03-03T00:00:00.000Z",
      isSidechain: false,
    }],
  }, null, 2);
  const targetIndexContent = JSON.stringify({ version: 1, entries: [] }, null, 2);

  try {
    await mkdir(sourceProjectDir, { recursive: true });
    await mkdir(targetProjectDir, { recursive: true });
    await writeFile(sourceTranscriptPath, `${JSON.stringify({
      type: "user",
      uuid: "claude-move-rollback",
      sessionId,
      cwd: "C:/source-rollback",
      timestamp: "2026-03-03T00:00:00.000Z",
      message: { role: "user", content: "回滚测试" },
    })}\n`, "utf-8");
    await writeFile(sourceIndexPath, sourceIndexContent, "utf-8");
    await writeFile(targetIndexPath, targetIndexContent, "utf-8");

    const mutableProvider = fixture.provider as unknown as {
      writeSessionIndexFile(indexPath: string, indexFile: unknown): Promise<void>;
    };
    const originalWriteIndex = mutableProvider.writeSessionIndexFile.bind(fixture.provider);
    mutableProvider.writeSessionIndexFile = async (indexPath, indexFile) => {
      if (indexPath.replace(/\\/g, "/") === targetIndexPath.replace(/\\/g, "/")) {
        throw new Error("注入目标 index 写入失败");
      }
      await originalWriteIndex(indexPath, indexFile);
    };

    await assert.rejects(
      fixture.provider.move(`claude-code:${sessionId}`, targetProjectKey),
      /注入目标 index 写入失败/
    );

    assert.match(await readFile(sourceTranscriptPath, "utf-8"), /回滚测试/);
    await assert.rejects(() => readFile(join(targetProjectDir, `${sessionId}.jsonl`), "utf-8"));
    assert.equal(await readFile(sourceIndexPath, "utf-8"), sourceIndexContent);
    assert.equal(await readFile(targetIndexPath, "utf-8"), targetIndexContent);
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
