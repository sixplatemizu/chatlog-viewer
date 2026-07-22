import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProviderPathCache,
  getAppConfig,
  getProviderConfigPath,
  getTitleGenerationCliPriority,
  getTitleGenerationCliSessionModes,
  normalizeTitleGenerationCliPriority,
  normalizeTitleGenerationCliSessionModes,
  resolveProviderPaths,
  updateProviderConfigs,
} from "../../utils/provider-paths.js";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof BetterSqlite3;

test.afterEach(() => {
  clearProviderPathCache();
});

test("环境变量优先于自动发现和默认路径", () => {
  const homeDir = "/home/tester";
  const resolved = resolveProviderPaths("claude-code", {
    homeDir,
    env: {
      CHATLOG_VIEWER_CLAUDE_CODE_PATH: "~/custom/claude-projects",
    },
    pathExists: (path) => path === "/home/tester/custom/claude-projects",
  });

  assert.equal(resolved.storagePath, "/home/tester/custom/claude-projects");
  assert.equal(resolved.storageExists, true);
  assert.equal(resolved.storageSource, "env");
});

test("配置文件值支持相对路径并优先于自动发现", () => {
  const resolved = resolveProviderPaths("iflow", {
    homeDir: "/home/tester",
    configDir: "/configs/chatlog-viewer",
    config: {
      providers: {
        iflow: {
          storagePath: "../data/iflow-projects",
        },
      },
    },
    pathExists: (path) => path === "/configs/data/iflow-projects",
  });

  assert.equal(resolved.storagePath, "/configs/data/iflow-projects");
  assert.equal(resolved.storageExists, true);
  assert.equal(resolved.storageSource, "config");
});

test("自动发现会命中 XDG_CONFIG_HOME 下的 Codex 目录", () => {
  const homeDir = "/home/tester";
  const env = {
    XDG_CONFIG_HOME: "/xdg-config",
  };
  const resolved = resolveProviderPaths("codex", {
    homeDir,
    env,
    pathExists: (path, kind) => {
      if (kind === "directory") return path === "/xdg-config/codex/sessions";
      if (kind === "file") return path === "/xdg-config/codex/state_5.sqlite";
      return false;
    },
  });

  assert.equal(resolved.storagePath, "/xdg-config/codex/sessions");
  assert.equal(resolved.storageSource, "auto");
  assert.equal(resolved.stateDbPath, "/xdg-config/codex/state_5.sqlite");
  assert.equal(resolved.stateDbSource, "auto");
  assert.equal(resolved.stateDbExists, true);
});

test("Codex state db 会优先跟随已解析的 sessions 上级目录", () => {
  const resolved = resolveProviderPaths("codex", {
    homeDir: "/home/tester",
    config: {
      providers: {
        codex: {
          storagePath: "/mnt/data/codex/sessions",
        },
      },
    },
    pathExists: (path, kind) => {
      if (kind === "directory") return path === "/mnt/data/codex/sessions";
      if (kind === "file") return path === "/mnt/data/codex/state_5.sqlite";
      return false;
    },
  });

  assert.equal(resolved.storagePath, "/mnt/data/codex/sessions");
  assert.equal(resolved.storageSource, "config");
  assert.equal(resolved.stateDbPath, "/mnt/data/codex/state_5.sqlite");
  assert.equal(resolved.stateDbSource, "auto");
});

test("OpenCode 会解析数据目录并优先使用同目录 opencode.db", () => {
  const resolved = resolveProviderPaths("opencode", {
    homeDir: "/home/tester",
    config: {
      providers: {
        opencode: {
          storagePath: "/data/opencode",
        },
      },
    },
    pathExists: (path, kind) => {
      if (kind === "directory") return path === "/data/opencode";
      if (kind === "file") return path === "/data/opencode/opencode.db";
      return false;
    },
  });

  assert.equal(resolved.storagePath, "/data/opencode");
  assert.equal(resolved.storageSource, "config");
  assert.equal(resolved.stateDbPath, "/data/opencode/opencode.db");
  assert.equal(resolved.stateDbSource, "auto");
  assert.equal(resolved.stateDbExists, true);
});

test("OpenCode state db 支持环境变量覆盖", () => {
  const resolved = resolveProviderPaths("opencode", {
    homeDir: "/home/tester",
    env: {
      CHATLOG_VIEWER_OPENCODE_DB_PATH: "/custom/opencode.db",
    },
    openCodeDbPath: null,
    pathExists: (path, kind) => kind === "file" && path === "/custom/opencode.db",
  });

  assert.equal(resolved.stateDbPath, "/custom/opencode.db");
  assert.equal(resolved.stateDbSource, "env");
  assert.equal(resolved.stateDbExists, true);
});

test("OpenCode 会使用 CLI 返回的 DB 路径作为自动发现候选", () => {
  const resolved = resolveProviderPaths("opencode", {
    homeDir: "/home/tester",
    openCodeDbPath: "/custom/share/opencode/opencode.db",
    pathExists: (path, kind) => {
      if (kind === "directory") return path === "/custom/share/opencode";
      if (kind === "file") return path === "/custom/share/opencode/opencode.db";
      return false;
    },
  });

  assert.equal(resolved.storagePath, "/custom/share/opencode");
  assert.equal(resolved.storageSource, "auto");
  assert.equal(resolved.stateDbPath, "/custom/share/opencode/opencode.db");
  assert.equal(resolved.stateDbSource, "auto");
  assert.equal(resolved.stateDbExists, true);
});

test("未命中任何候选时回退到默认路径", () => {
  const resolved = resolveProviderPaths("claude-code", {
    homeDir: "/home/tester",
    pathExists: () => false,
  });

  assert.equal(resolved.storagePath, "/home/tester/.claude/projects");
  assert.equal(resolved.storageExists, false);
  assert.equal(resolved.storageSource, "default");
});

test("配置文件路径支持环境变量覆盖", () => {
  const configPath = getProviderConfigPath(
    {
      CHATLOG_VIEWER_CONFIG_PATH: "$APPDATA/chatlog-viewer/config.json",
      APPDATA: "/appdata",
    },
    "/home/tester"
  );

  assert.equal(configPath, "/appdata/chatlog-viewer/config.json");
});

test("标题生成 CLI 优先级会归一化并补齐缺失项", () => {
  assert.deepEqual(
    normalizeTitleGenerationCliPriority(["codex", "iflow", "opencode", "codex"]),
    ["codex", "opencode", "claude"]
  );
});

test("标题生成 CLI 会话模式会归一化无效值并补齐默认 fresh", () => {
  assert.deepEqual(
    normalizeTitleGenerationCliSessionModes({
      codex: "fresh",
      claude: "bad",
      opencode: "fixed",
      iflow: "fresh",
    }),
    {
      codex: "fresh",
      claude: "fresh",
      opencode: "fixed",
    }
  );
});

test("更新 provider 配置会写入文件并支持清空回退", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-provider-paths-"));
  const env = {
    CHATLOG_VIEWER_CONFIG_PATH: join(baseDir, "config.json"),
  };

  try {
    await updateProviderConfigs(
      {
        codex: {
          storagePath: "/data/codex/sessions",
          stateDbPath: "/data/codex/state_5.sqlite",
        },
        "claude-code": {
          storagePath: "/data/claude/projects",
        },
      },
      env,
      baseDir,
      {
        ai: {
          titleGenerationCliPriority: ["codex", "claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fixed",
            opencode: "fixed",
          },
        },
      }
    );

    const saved = JSON.parse(
      await readFile(join(baseDir, "config.json"), "utf-8")
    ) as {
      providers?: Record<string, { storagePath?: string; stateDbPath?: string }>;
      ai?: {
        titleGenerationCliPriority?: string[];
        titleGenerationCliSessionModes?: Record<string, string>;
      };
    };

    assert.equal(saved.providers?.codex?.storagePath, "/data/codex/sessions");
    assert.equal(saved.providers?.codex?.stateDbPath, "/data/codex/state_5.sqlite");
    assert.equal(saved.providers?.["claude-code"]?.storagePath, "/data/claude/projects");
    assert.deepEqual(saved.ai?.titleGenerationCliPriority, ["codex", "claude", "opencode"]);
    assert.deepEqual(saved.ai?.titleGenerationCliSessionModes, {
      codex: "fresh",
      claude: "fixed",
      opencode: "fixed",
    });

    await updateProviderConfigs(
      {
        codex: {
          storagePath: "",
          stateDbPath: "",
        },
      },
      env,
      baseDir
    );

    const loaded = getAppConfig(env, baseDir);
    assert.equal(loaded.config.providers?.codex, undefined);
    assert.equal(loaded.config.providers?.["claude-code"]?.storagePath, "/data/claude/projects");
    assert.deepEqual(getTitleGenerationCliPriority(env, baseDir), ["codex", "claude", "opencode"]);
    assert.deepEqual(getTitleGenerationCliSessionModes(env, baseDir), {
      codex: "fresh",
      claude: "fixed",
      opencode: "fixed",
    });
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("更新 provider 配置时可自动迁移 storagePath 目录内容", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-provider-migrate-storage-"));
  const configPath = join(baseDir, "config.json");
  const sourcePath = join(baseDir, "source-projects");
  const nestedPath = join(sourcePath, "demo");
  const targetPath = join(baseDir, "target-projects");
  const env = {
    CHATLOG_VIEWER_CONFIG_PATH: configPath,
  };

  try {
    await mkdir(nestedPath, { recursive: true });
    await writeFile(join(nestedPath, "session.jsonl"), "{\"type\":\"message\"}\n", "utf-8");
    await writeFile(
      configPath,
      `${JSON.stringify({
        providers: {
          "claude-code": {
            storagePath: sourcePath,
          },
        },
      }, null, 2)}\n`,
      "utf-8"
    );
    clearProviderPathCache();

    const updated = await updateProviderConfigs(
      {
        "claude-code": {
          storagePath: targetPath,
        },
      },
      env,
      baseDir,
      {
        migrations: {
          "claude-code": {
            storagePath: true,
          },
        },
      }
    );

    await access(join(targetPath, "demo", "session.jsonl"));
    await assert.rejects(() => access(sourcePath));
    assert.equal(updated.migrationResults.length, 1);
    assert.equal(updated.migrationResults[0]?.providerName, "claude-code");
    assert.equal(updated.migrationResults[0]?.pathType, "storagePath");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("OpenCode storage 迁移会安全复制内嵌 DB 和其他数据", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-opencode-migrate-"));
  const configPath = join(baseDir, "config.json");
  const sourcePath = join(baseDir, "opencode-source");
  const targetPath = join(baseDir, "opencode-target");
  const sourceDbPath = join(sourcePath, "opencode.db");
  const targetDbPath = join(targetPath, "opencode.db");
  const env = { CHATLOG_VIEWER_CONFIG_PATH: configPath };

  try {
    await mkdir(join(sourcePath, "storage", "session"), { recursive: true });
    await writeFile(join(sourcePath, "storage", "session", "session-1.json"), "{}\n", "utf-8");
    const sourceDb = new Database(sourceDbPath);
    sourceDb.pragma("journal_mode = WAL");
    sourceDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)");
    sourceDb.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("session-1", "OpenCode 标题");
    sourceDb.close();
    await writeFile(configPath, `${JSON.stringify({
      providers: {
        opencode: {
          storagePath: sourcePath,
          stateDbPath: sourceDbPath,
        },
      },
    }, null, 2)}\n`, "utf-8");
    clearProviderPathCache();

    const updated = await updateProviderConfigs(
      {
        opencode: {
          storagePath: targetPath,
          stateDbPath: targetDbPath,
        },
      },
      env,
      baseDir,
      { migrations: { opencode: { storagePath: true, stateDbPath: true } } }
    );

    await assert.rejects(() => access(sourcePath));
    await access(join(targetPath, "storage", "session", "session-1.json"));
    const targetDb = new Database(targetDbPath, { readonly: true });
    try {
      const row = targetDb.prepare("SELECT title FROM session WHERE id = ?").get("session-1") as {
        title: string;
      } | undefined;
      assert.equal(row?.title, "OpenCode 标题");
    } finally {
      targetDb.close();
    }
    assert.deepEqual(
      updated.migrationResults.map((item) => item.pathType),
      ["stateDbPath", "storagePath"]
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("OpenCode 组合迁移发生目标冲突时恢复源数据和旧配置", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-opencode-rollback-"));
  const configPath = join(baseDir, "config.json");
  const sourcePath = join(baseDir, "opencode-source");
  const targetPath = join(baseDir, "opencode-target");
  const sourceDbPath = join(sourcePath, "opencode.db");
  const targetDbPath = join(targetPath, "opencode.db");
  const env = { CHATLOG_VIEWER_CONFIG_PATH: configPath };

  try {
    await mkdir(join(sourcePath, "storage"), { recursive: true });
    await mkdir(targetPath, { recursive: true });
    await writeFile(join(sourcePath, "storage", "session.json"), "source\n", "utf-8");
    await writeFile(join(targetPath, "storage"), "conflict\n", "utf-8");
    const sourceDb = new Database(sourceDbPath);
    sourceDb.exec("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)");
    sourceDb.prepare("INSERT INTO session (id, title) VALUES (?, ?)").run("session-1", "原始标题");
    sourceDb.close();
    await writeFile(configPath, `${JSON.stringify({
      providers: {
        opencode: {
          storagePath: sourcePath,
          stateDbPath: sourceDbPath,
        },
      },
    }, null, 2)}\n`, "utf-8");
    clearProviderPathCache();

    await assert.rejects(
      updateProviderConfigs(
        {
          opencode: {
            storagePath: targetPath,
            stateDbPath: targetDbPath,
          },
        },
        env,
        baseDir,
        { migrations: { opencode: { storagePath: true, stateDbPath: true } } }
      ),
      /目标路径已存在同名内容/
    );

    await access(sourceDbPath);
    await access(join(sourcePath, "storage", "session.json"));
    await assert.rejects(() => access(targetDbPath));
    const persisted = JSON.parse(await readFile(configPath, "utf-8")) as {
      providers?: { opencode?: { storagePath?: string; stateDbPath?: string } };
    };
    assert.equal(persisted.providers?.opencode?.storagePath, sourcePath);
    assert.equal(persisted.providers?.opencode?.stateDbPath, sourceDbPath);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("自动迁移会拒绝过于宽泛的源目录", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-provider-migrate-guard-"));
  const configPath = join(baseDir, "config.json");
  const env = {
    CHATLOG_VIEWER_CONFIG_PATH: configPath,
  };

  try {
    await writeFile(
      configPath,
      `${JSON.stringify({
        providers: {
          "claude-code": {
            storagePath: baseDir,
          },
        },
      }, null, 2)}\n`,
      "utf-8"
    );
    clearProviderPathCache();

    await assert.rejects(
      () => updateProviderConfigs(
        {
          "claude-code": {
            storagePath: join(baseDir, "target-projects"),
          },
        },
        env,
        baseDir,
        {
          migrations: {
            "claude-code": {
              storagePath: true,
            },
          },
        }
      ),
      /源路径过于宽泛或敏感/
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("更新 provider 配置时可自动迁移 Codex state db 文件", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-provider-migrate-statedb-"));
  const configPath = join(baseDir, "config.json");
  const sessionsPath = join(baseDir, "sessions");
  const sourceStateDbPath = join(baseDir, "state_5.sqlite");
  const targetStateDbPath = join(baseDir, "migrated", "state_5.sqlite");
  const env = {
    CHATLOG_VIEWER_CONFIG_PATH: configPath,
  };

  try {
    await mkdir(sessionsPath, { recursive: true });
    const sourceDb = new Database(sourceStateDbPath);
    sourceDb.pragma("journal_mode = WAL");
    sourceDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    sourceDb.prepare("INSERT INTO threads (id, title) VALUES (?, ?)").run("thread-1", "WAL 中的标题");
    sourceDb.close();
    await writeFile(
      configPath,
      `${JSON.stringify({
        providers: {
          codex: {
            storagePath: sessionsPath,
            stateDbPath: sourceStateDbPath,
          },
        },
      }, null, 2)}\n`,
      "utf-8"
    );
    clearProviderPathCache();

    const updated = await updateProviderConfigs(
      {
        codex: {
          storagePath: sessionsPath,
          stateDbPath: targetStateDbPath,
        },
      },
      env,
      baseDir,
      {
        migrations: {
          codex: {
            stateDbPath: true,
          },
        },
      }
    );
    await access(targetStateDbPath);
    await assert.rejects(() => access(sourceStateDbPath));
    const targetDb = new Database(targetStateDbPath, { readonly: true });
    try {
      const row = targetDb.prepare("SELECT title FROM threads WHERE id = ?").get("thread-1") as {
        title: string;
      } | undefined;
      assert.equal(row?.title, "WAL 中的标题");
    } finally {
      targetDb.close();
    }
    assert.equal(updated.migrationResults.length, 1);
    assert.equal(updated.migrationResults[0]?.providerName, "codex");
    assert.equal(updated.migrationResults[0]?.pathType, "stateDbPath");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("活动 SQLite 被占用时拒绝迁移并保持旧配置和源数据", async () => {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-provider-migrate-active-db-"));
  const configPath = join(baseDir, "config.json");
  const sessionsPath = join(baseDir, "sessions");
  const sourceStateDbPath = join(baseDir, "state_5.sqlite");
  const targetStateDbPath = join(baseDir, "migrated", "state_5.sqlite");
  const env = { CHATLOG_VIEWER_CONFIG_PATH: configPath };

  try {
    await mkdir(sessionsPath, { recursive: true });
    const sourceDb = new Database(sourceStateDbPath);
    sourceDb.pragma("journal_mode = WAL");
    sourceDb.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT)");
    sourceDb.prepare("INSERT INTO threads (id, title) VALUES (?, ?)").run("thread-active", "活动标题");
    // 保持独占事务，跨平台模拟“活动数据库被占用”
    sourceDb.exec("BEGIN EXCLUSIVE");
    await writeFile(configPath, `${JSON.stringify({
      providers: {
        codex: {
          storagePath: sessionsPath,
          stateDbPath: sourceStateDbPath,
        },
      },
    }, null, 2)}\n`, "utf-8");
    clearProviderPathCache();

    try {
      await assert.rejects(
        updateProviderConfigs(
          {
            codex: {
              storagePath: sessionsPath,
              stateDbPath: targetStateDbPath,
            },
          },
          env,
          baseDir,
          { migrations: { codex: { stateDbPath: true } } }
        ),
        /busy|locked|占用|EPERM|EBUSY|SQLITE_BUSY/i
      );
    } finally {
      try {
        sourceDb.exec("COMMIT");
      } catch {
        // ignore
      }
      sourceDb.close();
    }

    await access(sourceStateDbPath);
    await assert.rejects(() => access(targetStateDbPath));
    const persistedConfig = JSON.parse(await readFile(configPath, "utf-8")) as {
      providers?: { codex?: { stateDbPath?: string } };
    };
    assert.equal(persistedConfig.providers?.codex?.stateDbPath, sourceStateDbPath);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
