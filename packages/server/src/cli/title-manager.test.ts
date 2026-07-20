import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation, ConversationMeta, ConversationProvider } from "../providers/types.js";
import { getTitle, setTitle, setTitleStoreDirForTests } from "../utils/title-store.js";
import {
  applyRollbackEntry,
  buildTitleCliJsonResult,
  buildRollbackEntries,
  filterConversations,
  formatCliJson,
  matchesProject,
  normalizeConversationId,
  parseArgs,
  summarizeTitleEntries,
  TITLE_CLI_SCHEMA_VERSION,
  type CliOptions,
  type RollbackReportEntry,
} from "./title-manager.js";

function createOverlayProvider(title: string): ConversationProvider {
  return {
    name: "overlay-test",
    displayName: "Overlay Test",
    capabilities: { titleSyncMode: "overlay" },
    detect: async () => true,
    list: async () => [],
    read: async (id) => ({
      ...createConversation({ id, provider: "overlay-test", title }),
      messages: [],
    } as Conversation),
    delete: async () => {},
    getStoragePath: () => "/tmp/overlay-test",
  };
}

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    scope: "all",
    search: "",
    limit: 20,
    format: "table",
    projectPath: "",
    projectMode: "exact",
    provider: "codex",
    includeTitleSessions: false,
    continueOnError: false,
    dryRun: false,
    reportPath: "",
    force: false,
    ...overrides,
  };
}

function createConversation(overrides: Partial<ConversationMeta>): ConversationMeta {
  return {
    id: "codex:1",
    provider: "codex",
    title: "测试标题",
    project: "C:/Users/mortis097",
    projectKey: "C:/Users/mortis097",
    projectId: "C:/Users/mortis097",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    fileSize: 1,
    filePath: "session.jsonl",
    ...overrides,
  };
}

test("title CLI 会解析 cwd/project、dry-run 和 report 参数", () => {
  const parsed = parseArgs([
    "generate-batch",
    "--cwd",
    "C:/Users/mortis097",
    "--exact",
    "--provider",
    "all",
    "--dry-run",
    "--continue-on-error",
    "--report",
    "~/.backups/report.json",
    "--force",
  ]);

  assert.equal(parsed.command, "generate-batch");
  assert.equal(parsed.options.scope, "cwd");
  assert.equal(parsed.options.projectPath, "C:/Users/mortis097");
  assert.equal(parsed.options.projectMode, "exact");
  assert.equal(parsed.options.provider, "all");
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.continueOnError, true);
  assert.equal(parsed.options.reportPath, "~/.backups/report.json");
  assert.equal(parsed.options.force, true);
});

test("title CLI 会按默认 provider 补全 ID 并保留完整 provider ID", () => {
  assert.equal(normalizeConversationId("session-1"), "codex:session-1");
  assert.equal(normalizeConversationId("session-2", "claude-code"), "claude-code:session-2");
  assert.equal(normalizeConversationId("claude:session-3"), "claude-code:session-3");
  assert.equal(normalizeConversationId("opencode:session-4"), "opencode:session-4");
  assert.throws(() => normalizeConversationId("session-5", "all"), /完整对话 ID/);
  assert.throws(() => normalizeConversationId("iflow:session-6"), /不支持的对话 ID/);
});

test("title CLI 会解析 Claude Code alias 并拒绝无效 provider", () => {
  assert.equal(parseArgs(["list", "--provider", "claude-code"]).options.provider, "claude-code");
  assert.equal(parseArgs(["list", "--provider", "claude"]).options.provider, "claude-code");
  assert.equal(parseArgs(["list", "--provider", "open-code"]).options.provider, "opencode");
  assert.throws(() => parseArgs(["list", "--provider", "iflow"]), /provider 只能是/);
});

test("project exact 只匹配当前项目，recursive 会包含子目录", () => {
  const parent = createConversation({ id: "codex:parent", project: "C:/Users/mortis097", projectKey: "C:/Users/mortis097", projectId: "C:/Users/mortis097" });
  const child = createConversation({ id: "codex:child", project: "C:/Users/mortis097/work", projectKey: "C:/Users/mortis097/work", projectId: "C:/Users/mortis097/work" });
  const sibling = createConversation({ id: "codex:sibling", project: "C:/Users/other", projectKey: "C:/Users/other", projectId: "C:/Users/other" });

  assert.equal(matchesProject(parent, createOptions({ scope: "cwd", projectPath: "C:/Users/mortis097", projectMode: "exact" })), true);
  assert.equal(matchesProject(child, createOptions({ scope: "cwd", projectPath: "C:/Users/mortis097", projectMode: "exact" })), false);
  assert.equal(matchesProject(child, createOptions({ scope: "cwd", projectPath: "C:/Users/mortis097", projectMode: "recursive" })), true);
  assert.equal(matchesProject(sibling, createOptions({ scope: "cwd", projectPath: "C:/Users/mortis097", projectMode: "recursive" })), false);
});

test("list 过滤默认排除内部标题生成会话", () => {
  const conversations = [
    createConversation({ id: "codex:normal", title: "普通会话", updatedAt: 2 }),
    createConversation({
      id: "codex:title",
      title: "内部标题生成",
      updatedAt: 3,
      badges: [{ label: "标题生成" }],
    }),
  ];

  const filtered = filterConversations(conversations, createOptions({ scope: "all" }));
  assert.deepEqual(filtered.map((item) => item.id), ["codex:normal"]);

  const included = filterConversations(conversations, createOptions({ scope: "all", includeTitleSessions: true }));
  assert.deepEqual(included.map((item) => item.id), ["codex:title", "codex:normal"]);
});

test("list 会合并三类 provider 并按更新时间排序", () => {
  const conversations = [
    createConversation({ id: "claude-code:claude", provider: "claude-code", title: "Claude 标题", updatedAt: 20 }),
    createConversation({ id: "codex:codex", provider: "codex", title: "Codex 标题", updatedAt: 30 }),
    createConversation({ id: "opencode:open", provider: "opencode", title: "OpenCode 标题", updatedAt: 10 }),
  ];

  const filtered = filterConversations(conversations, createOptions({ provider: "all" }));
  assert.deepEqual(filtered.map((item) => item.id), [
    "codex:codex",
    "claude-code:claude",
    "opencode:open",
  ]);

  const searched = filterConversations(conversations, createOptions({ provider: "all", search: "opencode" }));
  assert.deepEqual(searched.map((item) => item.id), ["opencode:open"]);
});

test("title CLI JSON schema 可直接解析并准确统计成功、失败与跳过", () => {
  const entries = [
    {
      id: "codex:success",
      oldTitle: "旧标题一",
      newTitle: "新标题一",
      status: "success",
      usedCli: "opencode",
      attempts: 1,
      cleanedTitleSessions: 1,
      durationMs: 120,
    },
    {
      id: "claude-code:failed",
      oldTitle: "旧标题二",
      status: "failed",
      error: "AI CLI 超时",
    },
    {
      id: "opencode:skipped",
      oldTitle: "旧标题三",
      status: "skipped",
      error: "前序条目失败",
    },
  ] as const;

  const output = formatCliJson(buildTitleCliJsonResult("generate-batch", entries, {
    reportPath: "C:/Users/mortis097/.backups/report.json",
  }));
  const parsed = JSON.parse(output) as {
    schemaVersion: number;
    command: string;
    ok: boolean;
    summary: { total: number; success: number; failed: number; skipped: number };
    entries: typeof entries;
  };

  assert.equal(parsed.schemaVersion, TITLE_CLI_SCHEMA_VERSION);
  assert.equal(parsed.command, "generate-batch");
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.summary, {
    total: 3,
    success: 1,
    failed: 1,
    skipped: 1,
  });
  assert.equal(parsed.entries[0]?.usedCli, "opencode");
  assert.doesNotMatch(output, /\[AI\]/);
});

test("title CLI 单条 generate JSON 保留执行与清理信息", () => {
  const entry = {
    id: "codex:single",
    oldTitle: "旧标题",
    newTitle: "新标题",
    status: "success",
    usedCli: "opencode",
    attempts: 2,
    cleanedTitleSessions: 1,
    durationMs: 345,
  } as const;

  const parsed = JSON.parse(formatCliJson(buildTitleCliJsonResult("generate", [entry]))) as {
    ok: boolean;
    summary: { total: number; success: number; failed: number; skipped: number };
    entries: Array<typeof entry>;
  };

  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.summary, {
    total: 1,
    success: 1,
    failed: 0,
    skipped: 0,
  });
  assert.deepEqual(parsed.entries[0], entry);
});

test("title CLI 将 dry-run 和冲突条目计入 skipped", () => {
  assert.deepEqual(
    summarizeTitleEntries([
      { status: "dry-run" },
      { status: "skipped-conflict" },
      { status: "rolled-back" },
    ]),
    {
      total: 3,
      success: 1,
      failed: 0,
      skipped: 2,
    }
  );
});

test("rollback 只计划回滚成功生成过标题的条目", () => {
  const entries = buildRollbackEntries({
    kind: "generate-batch",
    dryRun: false,
    startedAt: "2026-06-05T00:00:00.000Z",
    projectMode: "exact",
    provider: "all",
    total: 3,
    success: 1,
    failed: 1,
    entries: [
      { id: "codex:ok", oldTitle: "旧标题", newTitle: "新标题", status: "success" },
      { id: "codex:failed", oldTitle: "失败旧标题", status: "failed", error: "失败" },
      { id: "codex:dry", oldTitle: "dry旧标题", status: "dry-run" },
    ],
  });

  assert.deepEqual(entries.map((entry) => [entry.id, entry.status]), [
    ["codex:ok", "pending"],
    ["codex:failed", "skipped"],
    ["codex:dry", "skipped"],
  ]);
});

test("rollback 检测到较新的 overlay 标题时标记 skipped-conflict", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-title-rollback-"));
  setTitleStoreDirForTests(storeDir);
  try {
    const provider = createOverlayProvider("原生标题");
    await setTitle("overlay-test:1", "用户后续标题");
    const entry: RollbackReportEntry = {
      id: "overlay-test:1",
      oldTitle: "旧标题",
      generatedTitle: "AI 标题",
      status: "pending",
    };

    await applyRollbackEntry(provider, entry);

    assert.equal(entry.status, "skipped-conflict");
    assert.match(entry.error ?? "", /用户后续标题/);
    assert.equal(await getTitle(entry.id), "用户后续标题");
  } finally {
    setTitleStoreDirForTests();
    await rm(storeDir, { recursive: true, force: true });
  }
});
