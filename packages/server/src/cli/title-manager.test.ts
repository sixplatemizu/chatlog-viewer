import test from "node:test";
import assert from "node:assert/strict";
import type { ConversationMeta } from "../providers/types.js";
import { buildRollbackEntries, filterConversations, matchesProject, parseArgs, type CliOptions } from "./title-manager.js";

function createOptions(overrides: Partial<CliOptions> = {}): CliOptions {
  return {
    scope: "all",
    search: "",
    limit: 20,
    format: "table",
    projectPath: "",
    projectMode: "exact",
    includeTitleSessions: false,
    continueOnError: false,
    dryRun: false,
    reportPath: "",
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
    "--dry-run",
    "--continue-on-error",
    "--report",
    "~/.backups/report.json",
  ]);

  assert.equal(parsed.command, "generate-batch");
  assert.equal(parsed.options.scope, "cwd");
  assert.equal(parsed.options.projectPath, "C:/Users/mortis097");
  assert.equal(parsed.options.projectMode, "exact");
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.continueOnError, true);
  assert.equal(parsed.options.reportPath, "~/.backups/report.json");
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

test("rollback 只计划回滚成功生成过标题的条目", () => {
  const entries = buildRollbackEntries({
    kind: "generate-batch",
    dryRun: false,
    startedAt: "2026-06-05T00:00:00.000Z",
    projectMode: "exact",
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
