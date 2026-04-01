import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Message } from "../../providers/types.js";
import { generateTitle, getAvailableClis, resetSession } from "../ai.js";

const SAMPLE_MESSAGES: Message[] = [
  {
    role: "user",
    content: "请帮我排查一个标题生成相关的问题。",
  },
  {
    role: "assistant",
    content: "我先检查当前实现是否每次都会新建会话。",
  },
];

async function createFakeCodexEnv() {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-ai-test-"));
  const binDir = join(baseDir, "bin");
  const configPath = join(baseDir, "config.json");
  const sessionDir = join(baseDir, "ai-title-sessions", "codex");
  const runnerPath = join(binDir, "fake-title-cli.mjs");
  const unixWrapperPath = join(binDir, "codex");
  const cmdWrapperPath = join(binDir, "codex.cmd");
  const previousPath = process.env.PATH;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;

  await mkdir(binDir, { recursive: true });
  await writeFile(
    runnerPath,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , toolName, ...args] = process.argv;
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  const cwd = process.cwd();
  const sessionFile = join(cwd, \`\${toolName}.session\`);
  const callsFile = join(cwd, \`\${toolName}.calls.log\`);
  const isResume = args.includes("resume") || args.includes("--resume") || args.includes("-c") || args.includes("--continue");

  appendFileSync(callsFile, \`\${JSON.stringify({ args, isResume, inputLength: input.length })}\\n\`, "utf8");

  if (isResume) {
    if (!existsSync(sessionFile)) {
      process.stderr.write("No conversation found to resume");
      process.exit(1);
      return;
    }

    process.stdout.write("复用会话标题");
    process.exit(0);
    return;
  }

  writeFileSync(sessionFile, "active", "utf8");
  process.stdout.write("新建会话标题");
  process.exit(0);
});

process.stdin.resume();
`,
    "utf-8"
  );
  await writeFile(
    unixWrapperPath,
    `#!/usr/bin/env sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${process.execPath}" "$SCRIPT_DIR/fake-title-cli.mjs" codex "$@"
`,
    "utf-8"
  );
  await writeFile(
    cmdWrapperPath,
    `@echo off\r\n"${process.execPath}" "%~dp0fake-title-cli.mjs" codex %*\r\n`,
    "utf-8"
  );
  await chmod(unixWrapperPath, 0o755);

  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;

  return {
    baseDir,
    configPath,
    sessionDir,
    restoreEnv() {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;

      if (previousConfigPath === undefined) delete process.env.CHATLOG_VIEWER_CONFIG_PATH;
      else process.env.CHATLOG_VIEWER_CONFIG_PATH = previousConfigPath;
    },
  };
}

async function readCallLog(sessionDir: string) {
  const content = await readFile(join(sessionDir, "codex.calls.log"), "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      args: string[];
      isResume: boolean;
      inputLength: number;
    });
}

function findCli(clis: Awaited<ReturnType<typeof getAvailableClis>>, name: string) {
  return clis.find((item) => item.name === name);
}

test("首次生成标题会创建固定会话并写入 session 状态", async () => {
  const env = await createFakeCodexEnv();

  try {
    const before = await getAvailableClis();
    assert.equal(findCli(before, "codex")?.discoverable, true);
    assert.equal(findCli(before, "codex")?.healthy, true);
    assert.equal(findCli(before, "codex")?.hasSession, false);

    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["codex"],
      reuseSession: true,
    });

    assert.equal(result.title, "新建会话标题");
    assert.equal(result.usedCli, "codex");

    const calls = await readCallLog(env.sessionDir);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.isResume, false);
    assert.ok((calls[0]?.inputLength ?? 0) > 0);

    const after = await getAvailableClis();
    assert.equal(findCli(after, "codex")?.discoverable, true);
    assert.equal(findCli(after, "codex")?.healthy, true);
    assert.equal(findCli(after, "codex")?.hasSession, true);

    await resetSession("codex");
    const resetAfter = await getAvailableClis();
    assert.equal(findCli(resetAfter, "codex")?.hasSession, false);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("已有固定会话时会优先复用 resume 会话", async () => {
  const env = await createFakeCodexEnv();

  try {
    await mkdir(env.sessionDir, { recursive: true });
    await writeFile(join(env.sessionDir, ".session.json"), "{\"lastUsedAt\":\"2026-03-25T00:00:00.000Z\"}\n", "utf-8");
    await writeFile(join(env.sessionDir, "codex.session"), "active", "utf-8");

    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["codex"],
      reuseSession: true,
    });

    assert.equal(result.title, "复用会话标题");
    const calls = await readCallLog(env.sessionDir);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.isResume, true);
    assert.ok(calls[0]?.args.includes("resume"));
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("session 标记失效时会自动回退到 fresh 模式", async () => {
  const env = await createFakeCodexEnv();

  try {
    await mkdir(env.sessionDir, { recursive: true });
    await writeFile(join(env.sessionDir, ".session.json"), "{\"lastUsedAt\":\"2026-03-25T00:00:00.000Z\"}\n", "utf-8");

    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["codex"],
      reuseSession: true,
    });

    assert.equal(result.title, "新建会话标题");

    const calls = await readCallLog(env.sessionDir);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.isResume, true);
    assert.equal(calls[1]?.isResume, false);

    const available = await getAvailableClis();
    assert.equal(findCli(available, "codex")?.discoverable, true);
    assert.equal(findCli(available, "codex")?.healthy, true);
    assert.equal(findCli(available, "codex")?.hasSession, true);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});
