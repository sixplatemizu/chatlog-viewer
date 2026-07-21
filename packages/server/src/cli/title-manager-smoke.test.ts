import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type BetterSqlite3 from "better-sqlite3";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;
const serverPackageDir = fileURLToPath(new URL("../../", import.meta.url));

interface RenameCliResult {
  schemaVersion: number;
  command: string;
  ok: boolean;
  summary: {
    total: number;
    success: number;
    failed: number;
    skipped: number;
  };
  entries: Array<{
    id: string;
    oldTitle: string;
    newTitle: string;
    status: string;
  }>;
}

function runRenameCli(
  id: string,
  title: string,
  env: NodeJS.ProcessEnv
): RenameCliResult {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "src/cli/title-manager.ts",
    "rename",
    id,
    title,
    "--json",
  ], {
    cwd: serverPackageDir,
    env,
    encoding: "utf-8",
    timeout: 30_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as RenameCliResult;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.command, "rename");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.summary, {
    total: 1,
    success: 1,
    failed: 0,
    skipped: 0,
  });
  assert.equal(parsed.entries[0]?.id, id);
  assert.equal(parsed.entries[0]?.newTitle, title);
  assert.equal(parsed.entries[0]?.status, "success");
  return parsed;
}

function createBaseEnv(baseDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CHATLOG_VIEWER_STORE_DIR: join(baseDir, ".chatlog-viewer"),
    CHATLOG_VIEWER_CONFIG_PATH: join(baseDir, ".chatlog-viewer", "config.json"),
    CHATLOG_VIEWER_CODEX_APP_SERVER_RENAME: "0",
  };
}

test("title CLI 会将 Codex rename 持久化到 State DB 和 session index", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-cli-codex-smoke-"));
  const sessionsPath = join(baseDir, "sessions");
  const stateDbPath = join(baseDir, "state_5.sqlite");
  const sessionId = "019d-cli-codex-smoke";
  const newTitle = "Codex CLI 持久化标题";

  try {
    await mkdir(join(sessionsPath, "2026", "07", "21"), { recursive: true });
    const transcriptPath = join(sessionsPath, "2026", "07", "21", `${sessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      [
        JSON.stringify({
          timestamp: "2026-07-21T00:00:00.000Z",
          type: "session_meta",
          payload: {
            id: sessionId,
            cwd: "C:/Users/tester/project",
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-21T00:00:01.000Z",
          type: "event_msg",
          payload: {
            type: "user_message",
            message: "Codex 原标题",
          },
        }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const db = new Database(stateDbPath);
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
    db.prepare(`
      INSERT INTO threads (
        id, rollout_path, created_at, updated_at, source,
        model_provider, cwd, title, first_user_message, preview
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      transcriptPath,
      1_753_056_000,
      1_753_056_001,
      "cli",
      "codex",
      "C:\\Users\\tester\\project",
      "Codex 原标题",
      "Codex 原标题",
      "Codex 原标题"
    );
    db.close();

    runRenameCli(`codex:${sessionId}`, newTitle, {
      ...createBaseEnv(baseDir),
      CHATLOG_VIEWER_CODEX_SESSIONS_PATH: sessionsPath,
      CHATLOG_VIEWER_CODEX_STATE_DB_PATH: stateDbPath,
    });

    const verifyDb = new Database(stateDbPath, { readonly: true });
    const row = verifyDb.prepare("SELECT title FROM threads WHERE id = ?").get(sessionId) as { title: string };
    verifyDb.close();
    assert.equal(row.title, newTitle);

    const sessionIndex = await readFile(join(baseDir, "session_index.jsonl"), "utf-8");
    assert.match(sessionIndex, new RegExp(`"id":"${sessionId}"`));
    assert.match(sessionIndex, new RegExp(`"thread_name":"${newTitle}"`));
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("title CLI 会按 Claude Code /rename 语义同步 transcript 和 session index", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-cli-claude-smoke-"));
  const projectsPath = join(baseDir, "projects");
  const projectKey = "C--Users-tester-project";
  const projectDir = join(projectsPath, projectKey);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`);
  const indexPath = join(projectDir, "sessions-index.json");
  const newTitle = "Claude CLI 持久化标题";

  try {
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: "user",
        uuid: "user-1",
        sessionId,
        timestamp: "2026-07-21T00:00:00.000Z",
        cwd: "C:/Users/tester/project",
        message: {
          role: "user",
          content: "Claude 原标题",
        },
      })}\n`,
      "utf-8"
    );
    await writeFile(indexPath, JSON.stringify({
      version: 1,
      originalPath: "C:\\Users\\tester\\project",
      entries: [{
        sessionId,
        fullPath: transcriptPath,
        summary: "Claude 原标题",
        firstPrompt: "Claude 原标题",
        messageCount: 1,
        created: "2026-07-21T00:00:00.000Z",
        modified: "2026-07-21T00:00:00.000Z",
        projectPath: "C:\\Users\\tester\\project",
        isSidechain: false,
      }],
    }, null, 2), "utf-8");

    runRenameCli(`claude-code:${sessionId}`, newTitle, {
      ...createBaseEnv(baseDir),
      CHATLOG_VIEWER_CLAUDE_CODE_PATH: projectsPath,
    });

    const transcript = await readFile(transcriptPath, "utf-8");
    assert.match(transcript, new RegExp(`"customTitle":"${newTitle}"`));

    const index = JSON.parse(await readFile(indexPath, "utf-8")) as {
      entries: Array<{ sessionId: string; customTitle?: string; summary?: string }>;
    };
    const entry = index.entries.find((item) => item.sessionId === sessionId);
    assert.equal(entry?.customTitle, newTitle);
    assert.equal(entry?.summary, newTitle);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("title CLI 会将 OpenCode rename 写入 session.title", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-cli-opencode-smoke-"));
  const storagePath = join(baseDir, "opencode");
  const dbPath = join(storagePath, "opencode.db");
  const sessionId = "ses_cli_opencode_smoke";
  const newTitle = "OpenCode CLI 持久化标题";

  try {
    await mkdir(storagePath, { recursive: true });
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE project (
        id TEXT PRIMARY KEY,
        worktree TEXT,
        name TEXT
      );
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        parent_id TEXT,
        directory TEXT,
        title TEXT,
        permission TEXT,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        time_archived INTEGER,
        path TEXT
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL,
        data TEXT NOT NULL
      );
    `);
    db.prepare("INSERT INTO project (id, worktree, name) VALUES (?, ?, ?)")
      .run("project-1", "C:/Users/tester/project", "project");
    db.prepare(`
      INSERT INTO session (
        id, project_id, parent_id, directory, title, permission,
        time_created, time_updated, time_archived, path
      ) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL)
    `).run(sessionId, "project-1", "C:/Users/tester/project", "OpenCode 原标题", 1_753_056_000_000, 1_753_056_001_000);
    db.prepare(`
      INSERT INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      "msg-1",
      sessionId,
      1_753_056_000_000,
      1_753_056_000_000,
      JSON.stringify({ role: "user" })
    );
    db.prepare(`
      INSERT INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "part-1",
      "msg-1",
      sessionId,
      1_753_056_000_000,
      1_753_056_000_000,
      JSON.stringify({ type: "text", text: "OpenCode 原标题" })
    );
    db.close();

    runRenameCli(`opencode:${sessionId}`, newTitle, {
      ...createBaseEnv(baseDir),
      CHATLOG_VIEWER_OPENCODE_PATH: storagePath,
      CHATLOG_VIEWER_OPENCODE_DB_PATH: dbPath,
    });

    const verifyDb = new Database(dbPath, { readonly: true });
    const row = verifyDb.prepare("SELECT title FROM session WHERE id = ?").get(sessionId) as { title: string };
    verifyDb.close();
    assert.equal(row.title, newTitle);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
