import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProviderPathCache,
  getAppConfig,
  getProviderConfigPath,
  getTitleGenerationCliPriority,
  normalizeTitleGenerationCliPriority,
  resolveProviderPaths,
  updateProviderConfigs,
} from "../../utils/provider-paths.js";

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
    normalizeTitleGenerationCliPriority(["codex", "iflow", "codex"]),
    ["codex", "iflow", "claude"]
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
          titleGenerationCliPriority: ["codex", "iflow", "claude"],
        },
      }
    );

    const saved = JSON.parse(
      await readFile(join(baseDir, "config.json"), "utf-8")
    ) as {
      providers?: Record<string, { storagePath?: string; stateDbPath?: string }>;
      ai?: { titleGenerationCliPriority?: string[] };
    };

    assert.equal(saved.providers?.codex?.storagePath, "/data/codex/sessions");
    assert.equal(saved.providers?.codex?.stateDbPath, "/data/codex/state_5.sqlite");
    assert.equal(saved.providers?.["claude-code"]?.storagePath, "/data/claude/projects");
    assert.deepEqual(saved.ai?.titleGenerationCliPriority, ["codex", "iflow", "claude"]);

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
    assert.deepEqual(getTitleGenerationCliPriority(env, baseDir), ["codex", "iflow", "claude"]);
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
    await writeFile(sourceStateDbPath, "sqlite", "utf-8");
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
    assert.equal(updated.migrationResults.length, 1);
    assert.equal(updated.migrationResults[0]?.providerName, "codex");
    assert.equal(updated.migrationResults[0]?.pathType, "stateDbPath");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
