import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { PiProvider } from "./pi.js";
import { CodeBuddyProvider } from "./codebuddy.js";
import { WorkBuddyProvider } from "./workbuddy.js";
import { clearProviderPathCache } from "../utils/provider-paths/index.js";
import { setCacheStoreDirForTests } from "../utils/cache/index.js";

// 测试进程独占锁目录，避免与其他测试运行争用共享锁 key（同 claude-code.test.ts 说明）。
process.env.CHATLOG_VIEWER_LOCK_DIR = join(tmpdir(), `chatlog-viewer-test-locks-${process.pid}`);

const PI_SESSION_ID = "01a090ea-6257-748d-87c1-9fcd4d4f09df";

function piLines(): string[] {
  return [
    JSON.stringify({
      type: "session",
      version: 1,
      id: PI_SESSION_ID,
      timestamp: "2026-09-11T14:30:38.866Z",
      cwd: "D:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
    JSON.stringify({
      type: "session_info",
      id: "info-1",
      parentId: null,
      timestamp: "2026-09-11T14:31:00.000Z",
      name: "原始标题",
    }),
    JSON.stringify({
      type: "message",
      id: "msg-user-1",
      parentId: null,
      timestamp: "2026-09-11T14:32:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "第一条用户问题" }] },
    }),
    JSON.stringify({
      type: "message",
      id: "msg-asst-1",
      parentId: "msg-user-1",
      timestamp: "2026-09-11T14:32:05.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "助手回复内容" },
          { type: "toolCall", name: "Read", arguments: { path: "a.txt" } },
        ],
      },
    }),
  ];
}

const CB_SESSION_ID = "01a0905f-4fba-7dd9-9793-963283307f80";

function codeBuddyLines(): string[] {
  return [
    JSON.stringify({
      id: "msg-1",
      timestamp: 1789128609238,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "第一条用户问题" }],
      providerData: {},
      sessionId: CB_SESSION_ID,
      cwd: "d:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
    JSON.stringify({
      id: "title-1",
      timestamp: 1789128657428,
      type: "ai-title",
      aiTitle: "原始标题",
      sessionId: CB_SESSION_ID,
      cwd: "d:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
    JSON.stringify({
      id: "msg-2",
      timestamp: 1789128660000,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "助手回复内容" }],
      sessionId: CB_SESSION_ID,
      cwd: "d:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
  ];
}

function codeBuddySubAgentLines(agentName: string): string[] {
  return [
    JSON.stringify({
      id: "sub-msg-1",
      timestamp: 1789128658837,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "子会话任务" }],
      providerData: { agent: agentName, conversationRequestId: "req-1" },
      sessionId: "sub-session-1",
      cwd: "d:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
    JSON.stringify({
      id: "sub-msg-2",
      timestamp: 1789128660000,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "子会话回复" }],
      providerData: { agent: agentName },
      sessionId: "sub-session-1",
      cwd: "d:\\DownloadFiles\\code_area\\r-bioinfo",
    }),
  ];
}

interface Fixture {
  baseDir: string;
  provider: PiProvider | CodeBuddyProvider;
  filePath: string;
  cleanup: () => Promise<void>;
}

async function createPiFixture(): Promise<Fixture> {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-pi-provider-"));
  const sessionsRoot = join(baseDir, "agent", "sessions");
  const projectDir = join(sessionsRoot, "--D--DownloadFiles-code_area-r-bioinfo--");
  const storeDir = join(baseDir, ".chatlog-viewer");
  const configPath = join(storeDir, "config.json");
  await mkdir(projectDir, { recursive: true });

  const previousPiPath = process.env.CHATLOG_VIEWER_PI_PATH;
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;
  process.env.CHATLOG_VIEWER_PI_PATH = sessionsRoot;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  const fileName = `2026-09-11T14-30-38-866Z_${PI_SESSION_ID}.jsonl`;
  const filePath = join(projectDir, fileName);
  await writeFile(filePath, `${piLines().join("\n")}\n`, "utf-8");

  return {
    baseDir,
    provider: new PiProvider(),
    filePath,
    async cleanup() {
      if (previousPiPath === undefined) delete process.env.CHATLOG_VIEWER_PI_PATH;
      else process.env.CHATLOG_VIEWER_PI_PATH = previousPiPath;
      if (previousStoreDir === undefined) delete process.env.CHATLOG_VIEWER_STORE_DIR;
      else process.env.CHATLOG_VIEWER_STORE_DIR = previousStoreDir;
      if (previousConfigPath === undefined) delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      else process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
      clearProviderPathCache();
      setCacheStoreDirForTests();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

async function createCodeBuddyFixture(): Promise<Fixture & { subDir: string; subFilePath: string }> {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-cb-provider-"));
  const projectsRoot = join(baseDir, "projects");
  const projectDir = join(projectsRoot, "d-DownloadFiles-code_area-r-bioinfo");
  const storeDir = join(baseDir, ".chatlog-viewer");
  const configPath = join(storeDir, "config.json");
  const subDir = join(projectDir, CB_SESSION_ID, "subagents");
  await mkdir(subDir, { recursive: true });

  const previousPath = process.env.CHATLOG_VIEWER_CODEBUDDY_PATH;
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;
  process.env.CHATLOG_VIEWER_CODEBUDDY_PATH = projectsRoot;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  const filePath = join(projectDir, `${CB_SESSION_ID}.jsonl`);
  await writeFile(filePath, `${codeBuddyLines().join("\n")}\n`, "utf-8");
  const subFilePath = join(subDir, "agent-b4da7e339b764896.jsonl");
  await writeFile(subFilePath, `${codeBuddySubAgentLines("statusline-setup").join("\n")}\n`, "utf-8");

  return {
    baseDir,
    provider: new CodeBuddyProvider(),
    filePath,
    subDir,
    subFilePath,
    async cleanup() {
      if (previousPath === undefined) delete process.env.CHATLOG_VIEWER_CODEBUDDY_PATH;
      else process.env.CHATLOG_VIEWER_CODEBUDDY_PATH = previousPath;
      if (previousStoreDir === undefined) delete process.env.CHATLOG_VIEWER_STORE_DIR;
      else process.env.CHATLOG_VIEWER_STORE_DIR = previousStoreDir;
      if (previousConfigPath === undefined) delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      else process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
      clearProviderPathCache();
      setCacheStoreDirForTests();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

test("Pi 会列出会话并解析消息，标题优先使用 session_info", async () => {
  const fixture = await createPiFixture();
  try {
    assert.equal(await fixture.provider.detect(), true);
    const list = await fixture.provider.list();
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, `pi:${PI_SESSION_ID}`);
    assert.equal(list[0]!.title, "原始标题");
    assert.equal(list[0]!.messageCount, 2);

    const conversation = await fixture.provider.read(`pi:${PI_SESSION_ID}`);
    assert.equal(conversation.messages.length, 3);
    assert.equal(conversation.messages[0]!.role, "user");
    assert.equal(conversation.messages[0]!.content, "第一条用户问题");
    assert.equal(conversation.messages[1]!.role, "assistant");
    assert.equal(conversation.messages[2]!.role, "tool");
    assert.equal(conversation.messages[2]!.toolName, "Read");
  } finally {
    await fixture.cleanup();
  }
});

test("Pi 支持原生标题写回、消息编辑与消息删除", async () => {
  const fixture = await createPiFixture();
  try {
    await fixture.provider.updateTitle(`pi:${PI_SESSION_ID}`, "新标题");
    const relisted = await fixture.provider.list();
    assert.equal(relisted[0]!.title, "新标题");
    const raw = await readFile(fixture.filePath, "utf-8");
    assert.ok(raw.includes("\"name\":\"新标题\""));

    const conversation = await fixture.provider.read(`pi:${PI_SESSION_ID}`);
    const userMessage = conversation.messages.find((item) => item.role === "user")!;
    await fixture.provider.updateMessage(`pi:${PI_SESSION_ID}`, userMessage.messageId!, "改后的问题");
    const edited = await fixture.provider.read(`pi:${PI_SESSION_ID}`);
    assert.equal(edited.messages.find((item) => item.role === "user")!.content, "改后的问题");

    const toolMessage = edited.messages.find((item) => item.role === "tool")!;
    await fixture.provider.deleteMessage(`pi:${PI_SESSION_ID}`, toolMessage.messageId!);
    const afterDelete = await fixture.provider.read(`pi:${PI_SESSION_ID}`);
    assert.equal(afterDelete.messages.some((item) => item.role === "tool"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("Pi 支持会话移动与删除", async () => {
  const fixture = await createPiFixture();
  try {
    await fixture.provider.move(`pi:${PI_SESSION_ID}`, "--D--other-project--");
    const moved = await fixture.provider.list();
    assert.equal(moved[0]!.projectKey, "--D--other-project--");

    await fixture.provider.delete(`pi:${PI_SESSION_ID}`);
    const afterDelete = await fixture.provider.list();
    assert.equal(afterDelete.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("CodeBuddy 会列出主会话与子会话并建立父子关联", async () => {
  const fixture = await createCodeBuddyFixture();
  try {
    assert.equal(await fixture.provider.detect(), true);
    const list = await fixture.provider.list();
    assert.equal(list.length, 2);
    const main = list.find((item) => item.id === `codebuddy:${CB_SESSION_ID}`)!;
    assert.ok(main);
    assert.equal(main.title, "原始标题");
    const sub = list.find((item) => item.id.startsWith("codebuddy:sub:"))!;
    assert.ok(sub);
    assert.ok(sub.title.startsWith("statusline-setup"));
    assert.ok(sub.badges?.some((badge) => badge.label === "子会话"));
    assert.ok(sub.badges?.some((badge) => badge.title?.includes(CB_SESSION_ID)));
    assert.equal(main.badges?.find((badge) => badge.label === "含1个子会话")?.title, "子会话：statusline-setup");
    assert.equal(sub.projectKey, `${main.projectKey}/${CB_SESSION_ID}`);
    assert.ok(list.indexOf(main) < list.indexOf(sub));

    const conversation = await fixture.provider.read(`codebuddy:${CB_SESSION_ID}`);
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.messages[0]!.content, "第一条用户问题");

    const subConversation = await fixture.provider.read(sub.id);
    assert.equal(subConversation.messages.length, 2);
    assert.equal(subConversation.messages[0]!.content, "子会话任务");
  } finally {
    await fixture.cleanup();
  }
});

test("CodeBuddy 支持原生标题写回、消息编辑与消息删除", async () => {
  const fixture = await createCodeBuddyFixture();
  try {
    await fixture.provider.updateTitle(`codebuddy:${CB_SESSION_ID}`, "新标题");
    const relisted = await fixture.provider.list();
    assert.equal(relisted.find((item) => item.id === `codebuddy:${CB_SESSION_ID}`)!.title, "新标题");
    const raw = await readFile(fixture.filePath, "utf-8");
    assert.ok(raw.includes("\"aiTitle\":\"新标题\""));

    const conversation = await fixture.provider.read(`codebuddy:${CB_SESSION_ID}`);
    const userMessage = conversation.messages.find((item) => item.role === "user")!;
    await fixture.provider.updateMessage(`codebuddy:${CB_SESSION_ID}`, userMessage.messageId!, "改后的问题");
    const edited = await fixture.provider.read(`codebuddy:${CB_SESSION_ID}`);
    assert.equal(edited.messages.find((item) => item.role === "user")!.content, "改后的问题");

    const assistantMessage = edited.messages.find((item) => item.role === "assistant")!;
    await fixture.provider.deleteMessage(`codebuddy:${CB_SESSION_ID}`, assistantMessage.messageId!);
    const afterDelete = await fixture.provider.read(`codebuddy:${CB_SESSION_ID}`);
    assert.equal(afterDelete.messages.some((item) => item.role === "assistant"), false);
  } finally {
    await fixture.cleanup();
  }
});

test("CodeBuddy 主会话删除连带子目录、移动连带子目录", async () => {
  const fixture = await createCodeBuddyFixture();
  try {
    await fixture.provider.move(`codebuddy:${CB_SESSION_ID}`, "d-other-project");
    const moved = await fixture.provider.list();
    assert.equal(moved.filter((item) => item.id === `codebuddy:${CB_SESSION_ID}`).length, 1);
    assert.equal(moved.find((item) => item.id === `codebuddy:${CB_SESSION_ID}`)!.projectKey, "d-other-project");
    const subAfterMove = moved.find((item) => item.id.startsWith("codebuddy:sub:"))!;
    assert.ok(subAfterMove);
    assert.equal(subAfterMove.projectKey, `d-other-project/${CB_SESSION_ID}`);

    await fixture.provider.delete(`codebuddy:${CB_SESSION_ID}`);
    const afterDelete = await fixture.provider.list();
    assert.equal(afterDelete.length, 0);
  } finally {
    await fixture.cleanup();
  }
});

const WB_SESSION_ID = "wb-move-session-1";

function workBuddyLines(sessionId: string, cwd: string): string[] {
  return [
    JSON.stringify({
      id: "wb-msg-1",
      parentId: null,
      timestamp: 1789128609238,
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "第一条用户问题" }],
      sessionId,
      cwd,
    }),
    JSON.stringify({
      id: "wb-msg-2",
      parentId: "wb-msg-1",
      timestamp: 1789128660000,
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "助手回复内容" }],
      sessionId,
      cwd,
    }),
  ];
}

interface WorkBuddyFixture {
  baseDir: string;
  provider: WorkBuddyProvider;
  cleanup: () => Promise<void>;
}

async function createWorkBuddyFixture(): Promise<WorkBuddyFixture> {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-wb-provider-"));
  const storeDir = join(baseDir, ".chatlog-viewer");
  const sourceCwd = "D:/src-project";

  const db = new BetterSqlite3(join(baseDir, "workbuddy.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      cwd TEXT,
      title TEXT,
      custom_title TEXT,
      status TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      last_activity_at INTEGER,
      deleted_at INTEGER,
      source_mode TEXT,
      model TEXT,
      permission_mode TEXT,
      is_playground INTEGER
    )
  `);
  db.prepare(
    "INSERT INTO sessions (id, cwd, title, custom_title, status, created_at, updated_at, last_activity_at, deleted_at, source_mode, model, permission_mode, is_playground) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(WB_SESSION_ID, sourceCwd, "原始标题", null, "completed", 1789128609000, 1789128660000, null, null, null, null, null, 0);
  db.close();

  const sourceProjectDir = join(baseDir, "projects", "d-src-project");
  await mkdir(sourceProjectDir, { recursive: true });
  await writeFile(
    join(sourceProjectDir, `${WB_SESSION_ID}.jsonl`),
    `${workBuddyLines(WB_SESSION_ID, sourceCwd).join("\n")}\n`,
    "utf-8"
  );

  const previousPath = process.env.CHATLOG_VIEWER_WORKBUDDY_PATH;
  const previousDbPath = process.env.CHATLOG_VIEWER_WORKBUDDY_DB_PATH;
  const previousStoreDir = process.env.CHATLOG_VIEWER_STORE_DIR;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;
  process.env.CHATLOG_VIEWER_WORKBUDDY_PATH = baseDir;
  delete process.env.CHATLOG_VIEWER_WORKBUDDY_DB_PATH;
  process.env.CHATLOG_VIEWER_STORE_DIR = storeDir;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = join(storeDir, "config.json");
  clearProviderPathCache();
  setCacheStoreDirForTests(storeDir);

  const provider = new WorkBuddyProvider();
  return {
    baseDir,
    provider,
    async cleanup() {
      provider.closeDb();
      if (previousPath === undefined) delete process.env.CHATLOG_VIEWER_WORKBUDDY_PATH;
      else process.env.CHATLOG_VIEWER_WORKBUDDY_PATH = previousPath;
      if (previousDbPath === undefined) delete process.env.CHATLOG_VIEWER_WORKBUDDY_DB_PATH;
      else process.env.CHATLOG_VIEWER_WORKBUDDY_DB_PATH = previousDbPath;
      if (previousStoreDir === undefined) delete process.env.CHATLOG_VIEWER_STORE_DIR;
      else process.env.CHATLOG_VIEWER_STORE_DIR = previousStoreDir;
      if (previousConfigPath === undefined) delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      else process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
      clearProviderPathCache();
      setCacheStoreDirForTests();
      await rm(baseDir, { recursive: true, force: true });
    },
  };
}

test("WorkBuddy 移动会话更新 DB cwd 并按编码目录搬移 transcript", async () => {
  const fixture = await createWorkBuddyFixture();
  try {
    await fixture.provider.move(`workbuddy:${WB_SESSION_ID}`, "D:/ProgramData/WorkBuddy/target");

    const db = new BetterSqlite3(join(fixture.baseDir, "workbuddy.db"), { readonly: true });
    const row = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(WB_SESSION_ID) as { cwd: string };
    db.close();
    assert.equal(row.cwd, "D:/ProgramData/WorkBuddy/target");

    const movedFile = join(fixture.baseDir, "projects", "d-ProgramData-WorkBuddy-target", `${WB_SESSION_ID}.jsonl`);
    const content = await readFile(movedFile, "utf-8");
    assert.match(content, /第一条用户问题/);

    const conversation = await fixture.provider.read(`workbuddy:${WB_SESSION_ID}`);
    assert.equal(conversation.messages.length, 2);
    assert.equal(conversation.projectKey, "d:/programdata/workbuddy/target");
  } finally {
    await fixture.cleanup();
  }
});

test("WorkBuddy 移动到非法目录被拒绝且 DB 与文件保持原状", async () => {
  const fixture = await createWorkBuddyFixture();
  try {
    await assert.rejects(
      () => fixture.provider.move(`workbuddy:${WB_SESSION_ID}`, "../../escape"),
      /目标文件夹不合法/
    );

    const db = new BetterSqlite3(join(fixture.baseDir, "workbuddy.db"), { readonly: true });
    const row = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(WB_SESSION_ID) as { cwd: string };
    db.close();
    assert.equal(row.cwd, "D:/src-project");

    const stillThere = await readFile(
      join(fixture.baseDir, "projects", "d-src-project", `${WB_SESSION_ID}.jsonl`),
      "utf-8"
    );
    assert.match(stillThere, /第一条用户问题/);
  } finally {
    await fixture.cleanup();
  }
});

test("WorkBuddy 移动到已有同名 transcript 的目标目录被拒绝且状态不变", async () => {
  const fixture = await createWorkBuddyFixture();
  try {
    const conflictDir = join(fixture.baseDir, "projects", "d-ProgramData-WorkBuddy-target");
    await mkdir(conflictDir, { recursive: true });
    await writeFile(join(conflictDir, `${WB_SESSION_ID}.jsonl`), "占位内容\n", "utf-8");

    // 同一 sessionId 出现多副本时定位直接报错，move 拒绝执行而不是静默只改 DB
    await assert.rejects(
      () => fixture.provider.move(`workbuddy:${WB_SESSION_ID}`, "D:/ProgramData/WorkBuddy/target"),
      /定位到多个同名对话文件/
    );

    const db = new BetterSqlite3(join(fixture.baseDir, "workbuddy.db"), { readonly: true });
    const row = db.prepare("SELECT cwd FROM sessions WHERE id = ?").get(WB_SESSION_ID) as { cwd: string };
    db.close();
    assert.equal(row.cwd, "D:/src-project");

    const stillThere = await readFile(
      join(fixture.baseDir, "projects", "d-src-project", `${WB_SESSION_ID}.jsonl`),
      "utf-8"
    );
    assert.match(stillThere, /第一条用户问题/);
  } finally {
    await fixture.cleanup();
  }
});

test("CodeBuddy 移动到已有同名 transcript 的目标目录被拒绝且源文件不动", async () => {
  const fixture = await createCodeBuddyFixture();
  try {
    const conflictDir = join(fixture.baseDir, "projects", "d-other-project");
    await mkdir(conflictDir, { recursive: true });
    await writeFile(join(conflictDir, `${CB_SESSION_ID}.jsonl`), "占位内容\n", "utf-8");

    await assert.rejects(
      () => fixture.provider.move(`codebuddy:${CB_SESSION_ID}`, "d-other-project"),
      /定位到多个同名对话文件/
    );

    const stillThere = await readFile(fixture.filePath, "utf-8");
    assert.match(stillThere, /第一条用户问题/);
  } finally {
    await fixture.cleanup();
  }
});
