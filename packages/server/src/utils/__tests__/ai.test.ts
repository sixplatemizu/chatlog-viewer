import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Message } from "../../providers/types.js";
import {
  buildTitlePromptContextForTest,
  extractCleanOutput,
  extractOpenCodeSessionId,
  generateTitle,
  getAvailableClis,
  resetSession,
} from "../ai.js";

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

async function createFakeOpenCodeEnv(options: { emptyOutput?: boolean } = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-ai-opencode-test-"));
  const binDir = join(baseDir, "bin");
  const configPath = join(baseDir, "config.json");
  const sessionDir = join(baseDir, "ai-title-sessions", "opencode");
  const runnerPath = join(binDir, "fake-opencode-cli.mjs");
  const unixWrapperPath = join(binDir, "opencode");
  const cmdWrapperPath = join(binDir, "opencode.cmd");
  const previousPath = process.env.PATH;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;

  await mkdir(binDir, { recursive: true });
  await writeFile(
    runnerPath,
    `import { appendFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write("opencode 1.15.0");
  process.exit(0);
}

appendFileSync(join(process.cwd(), "opencode.calls.log"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n", "utf8");
${options.emptyOutput ? "process.exit(0);" : `const sessionId = "ses_chatlog_title";
const isResume = args.includes("--session");
const text = isResume ? "OpenCode 复用标题" : "OpenCode 标题";
process.stdout.write(JSON.stringify({ type: "text", part: { type: "text", text, sessionID: sessionId } }) + "\\n");
process.exit(0);`}
`,
    "utf-8"
  );
  await writeFile(
    unixWrapperPath,
    `#!/usr/bin/env sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "${process.execPath}" "$SCRIPT_DIR/fake-opencode-cli.mjs" "$@"
# cmd-shim-target=${runnerPath.replaceAll(String.fromCharCode(92), "/")}
`,
    "utf-8"
  );
  await writeFile(
    cmdWrapperPath,
    `@echo off\r\n"${process.execPath}" "%~dp0fake-opencode-cli.mjs" %*\r\n`,
    "utf-8"
  );
  await chmod(unixWrapperPath, 0o755);

  process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
  process.env.CHATLOG_VIEWER_CONFIG_PATH = configPath;

  return {
    baseDir,
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

async function readOpenCodeCallLog(sessionDir: string) {
  const content = await readFile(join(sessionDir, "opencode.calls.log"), "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as {
      args: string[];
      cwd: string;
    });
}

function findCli(clis: Awaited<ReturnType<typeof getAvailableClis>>, name: string) {
  return clis.find((item) => item.name === name);
}

test("标题提取会跳过 OpenCode default 状态行", () => {
  assert.equal(
    extractCleanOutput("\u001b[0m\n> default · deepseek-v4-flash\n\u001b[0m\n真实标题\n"),
    "真实标题"
  );
});

test("标题提取会优先读取 OpenCode JSON text 事件", () => {
  assert.equal(
    extractCleanOutput([
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "JSON 标题" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
    ].join("\n")),
    "JSON 标题"
  );
});

test("标题提取会拒绝 OpenCode JSON default 占位输出", () => {
  assert.equal(
    extractCleanOutput([
      JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
      JSON.stringify({ type: "text", part: { type: "text", text: "default" } }),
      JSON.stringify({ type: "step_finish", part: { type: "step-finish" } }),
    ].join("\n")),
    ""
  );
});

test("标题提取会拒绝 CLI 状态占位输出", () => {
  assert.equal(extractCleanOutput("default"), "");
  assert.equal(extractCleanOutput("> default · deepseek-v4-flash"), "");
});

test("OpenCode session ID 会从 JSON event 中提取", () => {
  assert.equal(
    extractOpenCodeSessionId(JSON.stringify({
      type: "text",
      part: { type: "text", text: "标题", sessionID: "ses_chatlog_title" },
    })),
    "ses_chatlog_title"
  );
  assert.equal(extractOpenCodeSessionId("非 JSON 输出"), null);
});

test("标题上下文只使用最新消息", () => {
  const messages = Array.from({ length: 24 }, (_, index): Message => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: `第${index + 1}轮 ${index < 6 ? "早期背景" : "普通内容"} ${index >= 14 ? "近期核心主题" : ""}`.trim(),
  }));

  const context = buildTitlePromptContextForTest(messages, 5000);

  assert.match(context, /近期核心主题/);
  assert.match(context, /第24轮/);
  assert.match(context, /第15轮/);
  assert.doesNotMatch(context, /第1轮/);
  assert.doesNotMatch(context, /第14轮/);
  assert.doesNotMatch(context, /早期背景/);
});

test("指定的 AI CLI 不可用时不会回退到优先级外工具", async () => {
  await assert.rejects(
    generateTitle(SAMPLE_MESSAGES, {
      priority: ["opencode"],
      availableCliNames: ["codex"],
    }),
    /没有可用的 AI CLI 工具/
  );
});

test("OpenCode 生成标题时始终使用专用 session 目录", async () => {
  const env = await createFakeOpenCodeEnv();
  const projectDir = join(env.baseDir, "project");

  try {
    await mkdir(projectDir);

    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["opencode"],
      projectDir,
    });

    assert.equal(result.title, "OpenCode 标题");
    assert.equal(result.usedCli, "opencode");
    assert.equal(result.sessionRetained, false);
    assert.equal(result.sessionPersisted, true);
    assert.equal(result.generatedSessionId, "ses_chatlog_title");

    const calls = await readOpenCodeCallLog(env.sessionDir);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.args.slice(0, 5), [
      "run",
      "--dir",
      env.sessionDir,
      "--title",
      "ChatLog Viewer AI Title",
    ]);
    assert.ok(calls[0]?.args.includes("--"));
    assert.equal(calls[0]?.cwd, env.sessionDir);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("AI 标题生成过程日志只写入 stderr", async () => {
  const env = await createFakeOpenCodeEnv();
  const stdoutLogs: string[] = [];
  const stderrLogs: string[] = [];
  const originalLog = console.log;
  const originalStderrWrite = process.stderr.write;

  console.log = (...args: unknown[]) => {
    stdoutLogs.push(args.map(String).join(" "));
  };
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrLogs.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stderr.write;

  try {
    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["opencode"],
    });

    assert.equal(result.title, "OpenCode 标题");
    assert.deepEqual(stdoutLogs, []);
    assert.ok(stderrLogs.some((line) => line.includes("[AI] 执行 opencode")));
    assert.ok(stderrLogs.some((line) => line.includes("[AI] 成功使用 opencode")));
  } finally {
    console.log = originalLog;
    process.stderr.write = originalStderrWrite;
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("Windows pnpm shim 会绕过 cmd 并原样传递 prompt 元字符", async () => {
  const env = await createFakeOpenCodeEnv();
  const message = '检查 <tag> | 管道 & 命令 ^ 转义 %PATH% 和 "引号"';

  try {
    const result = await generateTitle([{ role: "user", content: message }], {
      priority: ["opencode"],
    });

    assert.equal(result.title, "OpenCode 标题");
    const calls = await readOpenCodeCallLog(env.sessionDir);
    assert.equal(calls.length, 1);
    const prompt = calls[0]?.args.at(-1) ?? "";
    assert.ok(prompt.includes(message));
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("OpenCode 空输出会返回可诊断错误", async () => {
  const env = await createFakeOpenCodeEnv({ emptyOutput: true });
  const projectDir = join(env.baseDir, "project");

  try {
    await mkdir(projectDir);

    await assert.rejects(
      generateTitle(SAMPLE_MESSAGES, {
        priority: ["opencode"],
        projectDir,
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /opencode 未产生输出/);
        assert.ok(error.message.includes(`dir=${env.sessionDir}`));
        return true;
      }
    );
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("OpenCode 固定模式会按准确 session ID 复用会话", async () => {
  const env = await createFakeOpenCodeEnv();

  try {
    const first = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["opencode"],
      reuseSession: true,
    });
    const second = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["opencode"],
      reuseSession: true,
    });

    assert.equal(first.title, "OpenCode 标题");
    assert.equal(first.sessionRetained, true);
    assert.equal(second.title, "OpenCode 复用标题");
    assert.equal(second.sessionRetained, true);

    const calls = await readOpenCodeCallLog(env.sessionDir);
    assert.equal(calls.length, 2);
    assert.ok(calls[0]?.args.includes("--title"));
    assert.equal(calls[1]?.args[calls[1].args.indexOf("--session") + 1], "ses_chatlog_title");
    assert.equal(calls[1]?.args[calls[1].args.indexOf("--dir") + 1], env.sessionDir);

    const marker = JSON.parse(await readFile(join(env.sessionDir, ".session.json"), "utf-8")) as {
      sessionId?: string;
    };
    assert.equal(marker.sessionId, "ses_chatlog_title");
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("Codex Fresh 模式使用 ephemeral 且不记录固定会话", async () => {
  const env = await createFakeCodexEnv();

  try {
    const result = await generateTitle(SAMPLE_MESSAGES, {
      priority: ["codex"],
      reuseSession: false,
    });

    assert.equal(result.title, "新建会话标题");
    assert.equal(result.sessionRetained, false);
    assert.equal(result.sessionPersisted, false);

    const calls = await readCallLog(env.sessionDir);
    assert.equal(calls.length, 1);
    assert.ok(calls[0]?.args.includes("--ephemeral"));

    const available = await getAvailableClis();
    assert.equal(findCli(available, "codex")?.hasSession, false);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("首次固定模式生成会创建可复用会话并写入 session 状态", async () => {
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
    assert.equal(calls[0]?.args.includes("--ephemeral"), false);
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
