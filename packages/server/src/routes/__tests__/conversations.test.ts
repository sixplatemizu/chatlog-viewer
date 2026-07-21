import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createConversationRoutes } from "../conversations.js";
import {
  buildTitleGenerationMessages,
  cleanupFreshTitleGenerationSessions,
} from "../../services/conversation-title.js";
import {
  invalidateListCache,
  setIndexedListCache,
  setCacheStoreDirForTests,
} from "../../utils/cache.js";
import {
  getNativeTitleSnapshot,
  getTitle,
  getTitleHistory,
  setTitle,
  setTitleStoreDirForTests,
} from "../../utils/title-store.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  ConversationListOptions,
} from "../../providers/types.js";

let storeDir = "";

test.before(async () => {
  storeDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-conversations-test-"));
  setCacheStoreDirForTests(storeDir);
  setTitleStoreDirForTests(storeDir);
});

test.after(async () => {
  setCacheStoreDirForTests();
  setTitleStoreDirForTests();
  if (storeDir) {
    await rm(storeDir, { recursive: true, force: true });
  }
});

type ProviderOverrides = Partial<ConversationProvider> & {
  name: string;
  displayName: string;
  conversations?: ConversationMeta[];
};

function createProvider(overrides: ProviderOverrides): ConversationProvider {
  const conversations = overrides.conversations ?? [];
  const storagePath = `/tmp/${overrides.name}-${Math.random().toString(36).slice(2)}`;
  const defaultCapabilities = overrides.name === "iflow"
    ? {
        titleSyncMode: "overlay" as const,
        canUpdateTitle: false,
        canGenerateTitle: false,
        updateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
        generateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
      }
    : undefined;

  return {
    name: overrides.name,
    displayName: overrides.displayName,
    capabilities: overrides.capabilities ?? defaultCapabilities,
    detect: overrides.detect ?? (async () => true),
    list: overrides.list ?? (async (_options?: ConversationListOptions) => conversations),
    getListSourceSignature: overrides.getListSourceSignature,
    read:
      overrides.read ??
      (async (id: string) => {
        const meta = conversations.find((item) => item.id === id);
        if (!meta) throw new Error(`对话不存在: ${id}`);
        return { ...meta, messages: [] } as Conversation;
      }),
    delete: overrides.delete ?? (async () => {}),
    move: overrides.move,
    updateTitle: overrides.updateTitle,
    updateMessage: overrides.updateMessage,
    deleteMessage: overrides.deleteMessage,
    deleteMessages: overrides.deleteMessages,
    listProjects: overrides.listProjects,
    getStoragePath: overrides.getStoragePath ?? (() => storagePath),
  };
}

function createConversationMeta(partial: Partial<ConversationMeta> & Pick<ConversationMeta, "id" | "provider">): ConversationMeta {
  return {
    title: "测试对话",
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 1,
    messageCount: 1,
    fileSize: 1,
    filePath: "/tmp/project/session.jsonl",
    ...partial,
  };
}

async function createFakeTitleEnv(toolName: "codex" | "opencode") {
  const baseDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-route-ai-test-"));
  const binDir = join(baseDir, "bin");
  const configPath = join(baseDir, "config.json");
  const sessionDir = join(baseDir, "ai-title-sessions", toolName);
  const runnerPath = join(binDir, "fake-title-cli.mjs");
  const unixWrapperPath = join(binDir, toolName);
  const cmdWrapperPath = join(binDir, `${toolName}.cmd`);
  const previousPath = process.env.PATH;
  const previousConfigPath = process.env.CHATLOG_VIEWER_CONFIG_PATH;

  await mkdir(binDir, { recursive: true });
  await writeFile(
    runnerPath,
    `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , toolName, ...args] = process.argv;
if (args.includes("--version")) {
  process.stdout.write(\`\${toolName} fake 1.0.0\`);
  process.exit(0);
}

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

    process.stdout.write("复用路由标题");
    process.exit(0);
    return;
  }

  writeFileSync(sessionFile, "active", "utf8");
  if (toolName === "opencode") {
    process.stdout.write(JSON.stringify({
      type: "text",
      part: { type: "text", text: "新建路由标题", sessionID: "ses_route_title" },
    }) + "\\n");
  } else {
    process.stdout.write("新建路由标题");
  }
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
exec "${process.execPath}" "$SCRIPT_DIR/fake-title-cli.mjs" ${toolName} "$@"
`,
    "utf-8"
  );
  await writeFile(
    cmdWrapperPath,
    `@echo off\r\n"${process.execPath}" "%~dp0fake-title-cli.mjs" ${toolName} %*\r\n`,
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

async function createFakeCodexTitleEnv() {
  return createFakeTitleEnv("codex");
}

async function createFakeOpenCodeTitleEnv() {
  return createFakeTitleEnv("opencode");
}

async function readFakeCodexTitleCalls(sessionDir: string) {
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

test("provider 过滤为空时返回空列表", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({ id: "codex:1", provider: "codex" }),
      ],
    }),
  ]);

  const res = await app.request("http://localhost/conversations?provider=");
  assert.equal(res.status, 200);

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.total, 0);
  assert.deepEqual(data.conversations, []);
});

test("列表接口不会修改 provider 返回的原始对话对象", async () => {
  const sourceConversations = [
    createConversationMeta({
      id: "codex:raw-1",
      provider: "codex",
      title: "原始标题",
    }),
  ];

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: sourceConversations,
    }),
  ]);

  const titleRes = await app.request("http://localhost/conversations/codex%3Araw-1/title", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "覆盖标题" }),
  });
  assert.equal(titleRes.status, 200);

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.conversations[0]?.title, "覆盖标题");
  assert.equal(sourceConversations[0]?.title, "原始标题");
});

test("支持原生标题持久化的 provider 会调用 updateTitle 并记录 UI 来源标题", async () => {
  const sourceConversations = [
    createConversationMeta({
      id: "codex:native-1",
      provider: "codex",
      title: "原始标题",
    }),
  ];
  const receivedCalls: Array<{ id: string; title: string }> = [];

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: sourceConversations,
      updateTitle: async (id, title) => {
        receivedCalls.push({ id, title });
        sourceConversations[0] = {
          ...sourceConversations[0],
          title,
        };
      },
    }),
  ]);

  const titleRes = await app.request("http://localhost/conversations/codex%3Anative-1/title", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "同步到原生存储" }),
  });
  assert.equal(titleRes.status, 200);
  assert.deepEqual(receivedCalls, [{
    id: "codex:native-1",
    title: "同步到原生存储",
  }]);
  assert.equal(await getTitle("codex:native-1"), null);
  assert.equal(await getNativeTitleSnapshot("codex:native-1"), "同步到原生存储");
  const history = await getTitleHistory("codex:native-1");
  assert.equal(history.at(-1)?.source, "chatlog-viewer");
  assert.equal(history.at(-1)?.action, "set-native-title");
  assert.equal(history.at(-1)?.newTitle, "同步到原生存储");

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.conversations[0]?.title, "同步到原生存储");
});

test("列表接口不会用旧 overlay 覆盖支持原生标题的 provider", async () => {
  const sourceConversations = [
    createConversationMeta({
      id: "codex:legacy-title",
      provider: "codex",
      title: "原始标题",
    }),
  ];
  const receivedCalls: Array<{ id: string; title: string }> = [];

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: sourceConversations,
      updateTitle: async (id, title) => {
        receivedCalls.push({ id, title });
        sourceConversations[0] = {
          ...sourceConversations[0],
          title,
        };
      },
    }),
  ]);

  await setTitle("codex:legacy-title", "旧覆盖标题");

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.conversations[0]?.title, "原始标题");
  assert.deepEqual(receivedCalls, []);
  assert.equal(await getTitle("codex:legacy-title"), "旧覆盖标题");
});

test("详情接口不会用旧 overlay 覆盖支持原生标题的 provider", async () => {
  const sourceConversations = [
    createConversationMeta({
      id: "codex:legacy-detail",
      provider: "codex",
      title: "原始标题",
    }),
  ];
  const receivedCalls: Array<{ id: string; title: string }> = [];

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: sourceConversations,
      updateTitle: async (id, title) => {
        receivedCalls.push({ id, title });
        sourceConversations[0] = {
          ...sourceConversations[0],
          title,
        };
      },
      read: async (id) => ({
        ...sourceConversations.find((item) => item.id === id)!,
        messages: [],
      }),
    }),
  ]);

  await setTitle("codex:legacy-detail", "详情覆盖标题");

  const res = await app.request("http://localhost/conversations/codex%3Alegacy-detail");
  assert.equal(res.status, 200);

  const data = await res.json() as Conversation;
  assert.equal(data.title, "原始标题");
  assert.deepEqual(receivedCalls, []);
  assert.equal(await getTitle("codex:legacy-detail"), "详情覆盖标题");
});

test("列表和详情接口会返回标题同步模式", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({
          id: "codex:title-sync",
          provider: "codex",
          title: "原生标题",
        }),
      ],
      updateTitle: async () => {},
      updateMessage: async () => {},
      deleteMessage: async () => {},
      move: async () => {},
      read: async (id) => ({
        ...createConversationMeta({
          id,
          provider: "codex",
          title: "原生标题",
        }),
        messages: [],
      }),
    }),
    createProvider({
      name: "iflow",
      displayName: "iFlow",
      capabilities: {
        titleSyncMode: "overlay",
        canUpdateTitle: false,
        canGenerateTitle: false,
        updateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
        generateTitleDisabledReason: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
      },
      conversations: [
        createConversationMeta({
          id: "iflow:title-sync",
          provider: "iflow",
          title: "覆盖标题",
        }),
      ],
      read: async (id) => ({
        ...createConversationMeta({
          id,
          provider: "iflow",
          title: "覆盖标题",
        }),
        messages: [],
      }),
    }),
  ]);

  const listRes = await app.request("http://localhost/conversations?provider=codex,iflow");
  assert.equal(listRes.status, 200);

  const listData = (await listRes.json()) as {
    conversations: Array<ConversationMeta & { titleSyncMode?: "native" | "overlay" }>;
  };
  const codexConversation = listData.conversations.find((item) => item.id === "codex:title-sync");
  const iflowConversation = listData.conversations.find((item) => item.id === "iflow:title-sync");
  assert.equal(codexConversation?.titleSyncMode, "native");
  assert.equal(iflowConversation?.titleSyncMode, "overlay");
  assert.equal(codexConversation?.capabilities?.canUpdateTitle, true);
  assert.equal(codexConversation?.capabilities?.canGenerateTitle, true);
  assert.equal(codexConversation?.capabilities?.canEditMessage, true);
  assert.equal(codexConversation?.capabilities?.canDeleteMessage, true);
  assert.equal(codexConversation?.capabilities?.canMoveConversation, true);
  assert.equal(codexConversation?.capabilities?.canDeleteConversation, true);
  assert.equal(iflowConversation?.capabilities?.canUpdateTitle, false);
  assert.equal(iflowConversation?.capabilities?.canGenerateTitle, false);

  const detailRes = await app.request("http://localhost/conversations/codex%3Atitle-sync");
  assert.equal(detailRes.status, 200);

  const detailData = await detailRes.json() as Conversation;
  assert.equal(detailData.titleSyncMode, "native");
  assert.equal(detailData.capabilities?.canUpdateTitle, true);
});

test("provider capabilities 会覆盖默认标题能力", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "iflow",
      displayName: "iFlow",
      capabilities: {
        titleSyncMode: "overlay",
        canUpdateTitle: false,
        canGenerateTitle: false,
        canEditMessage: false,
        canDeleteMessage: false,
        canMoveConversation: false,
        canDeleteConversation: false,
        supportsMetadataOnly: true,
        updateTitleDisabledReason: "禁用手动标题",
        generateTitleDisabledReason: "禁用 AI 标题",
        editMessageDisabledReason: "禁用消息编辑",
        deleteMessageDisabledReason: "禁用消息删除",
        moveConversationDisabledReason: "禁用对话移动",
        deleteConversationDisabledReason: "禁用对话删除",
      },
      conversations: [
        createConversationMeta({
          id: "iflow:capabilities",
          provider: "iflow",
          title: "原始标题",
        }),
      ],
      read: async (id) => ({
        ...createConversationMeta({
          id,
          provider: "iflow",
          title: "原始标题",
        }),
        messages: [],
      }),
    }),
  ]);

  const res = await app.request("http://localhost/conversations/iflow%3Acapabilities");
  assert.equal(res.status, 200);

  const data = await res.json() as Conversation;
  assert.equal(data.titleSyncMode, "overlay");
  assert.equal(data.capabilities?.canUpdateTitle, false);
  assert.equal(data.capabilities?.canGenerateTitle, false);
  assert.equal(data.capabilities?.canEditMessage, false);
  assert.equal(data.capabilities?.canDeleteMessage, false);
  assert.equal(data.capabilities?.canMoveConversation, false);
  assert.equal(data.capabilities?.canDeleteConversation, false);
  assert.equal(data.capabilities?.supportsMetadataOnly, true);
  assert.equal(data.capabilities?.updateTitleDisabledReason, "禁用手动标题");
  assert.equal(data.capabilities?.generateTitleDisabledReason, "禁用 AI 标题");
  assert.equal(data.capabilities?.editMessageDisabledReason, "禁用消息编辑");
  assert.equal(data.capabilities?.deleteMessageDisabledReason, "禁用消息删除");
  assert.equal(data.capabilities?.moveConversationDisabledReason, "禁用对话移动");
  assert.equal(data.capabilities?.deleteConversationDisabledReason, "禁用对话删除");
});

test("iFlow 标题修改接口会被禁用", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "iflow",
      displayName: "iFlow",
      conversations: [
        createConversationMeta({
          id: "iflow:readonly-title",
          provider: "iflow",
          title: "原始标题",
        }),
      ],
    }),
  ]);

  const titleRes = await app.request("http://localhost/conversations/iflow%3Areadonly-title/title", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "不应该成功" }),
  });

  assert.equal(titleRes.status, 400);
  assert.deepEqual(await titleRes.json(), {
    error: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
  });
});

test("iFlow AI 标题生成接口会被禁用", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "iflow",
      displayName: "iFlow",
      conversations: [
        createConversationMeta({
          id: "iflow:readonly-ai-title",
          provider: "iflow",
          title: "原始标题",
        }),
      ],
      read: async (id) => ({
        ...createConversationMeta({
          id,
          provider: "iflow",
          title: "原始标题",
        }),
        messages: [],
      }),
    }),
  ]);

  const res = await app.request("http://localhost/conversations/iflow%3Areadonly-ai-title/generate-title", {
    method: "POST",
  });

  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), {
    error: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
  });
});

test("AI 标题生成路由会复用固定 CLI 会话", async () => {
  const env = await createFakeCodexTitleEnv();
  const sourceConversations = [
    createConversationMeta({
      id: "codex:route-ai-title",
      provider: "codex",
      title: "原始标题",
    }),
    createConversationMeta({
      id: "codex:fixed-internal-title-session",
      provider: "codex",
      title: "内部标题生成",
      badges: [{ label: "标题生成", tone: "cyan" }],
    }),
  ];
  const savedTitles: string[] = [];
  const deletedIds: string[] = [];

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["codex", "claude", "opencode"],
          titleGenerationCliDisabled: ["claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fixed",
            claude: "fresh",
            opencode: "fresh",
          },
        },
      }),
      "utf-8"
    );

    const app = createConversationRoutes([
      createProvider({
        name: "codex",
        displayName: "Codex",
        conversations: sourceConversations,
        read: async (id) => ({
          ...sourceConversations.find((item) => item.id === id)!,
          messages: [{
            role: "user",
            content: "请分析标题生成路由是否复用固定会话",
          }],
        }),
        updateTitle: async (id, title) => {
          savedTitles.push(title);
          const conversation = sourceConversations.find((item) => item.id === id);
          if (conversation) conversation.title = title;
        },
        delete: async (id) => {
          deletedIds.push(id);
        },
      }),
    ]);

    const first = await app.request("http://localhost/conversations/codex%3Aroute-ai-title/generate-title", {
      method: "POST",
    });
    assert.equal(first.status, 200);
    assert.equal((await first.json() as { title: string }).title, "新建路由标题");

    const second = await app.request("http://localhost/conversations/codex%3Aroute-ai-title/generate-title", {
      method: "POST",
    });
    assert.equal(second.status, 200);
    assert.equal((await second.json() as { title: string }).title, "复用路由标题");

    const calls = await readFakeCodexTitleCalls(env.sessionDir);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.isResume, false);
    assert.equal(calls[1]?.isResume, true);
    assert.deepEqual(savedTitles, ["新建路由标题", "复用路由标题"]);
    assert.deepEqual(deletedIds, []);
    const history = await getTitleHistory("codex:route-ai-title");
    assert.deepEqual(history.map((entry) => entry.source), ["ai", "ai"]);
    assert.deepEqual(history.map((entry) => entry.newTitle), ["新建路由标题", "复用路由标题"]);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("Codex Fresh 模式使用 ephemeral 并保留历史标题会话", async () => {
  const env = await createFakeCodexTitleEnv();
  const targetConversation = createConversationMeta({
    id: "codex:route-ai-title-cleanup",
    provider: "codex",
    title: "原始标题",
  });
  const titleSession = createConversationMeta({
    id: "codex:internal-title-session",
    provider: "codex",
    title: "内部标题生成",
    badges: [{ label: "标题生成", tone: "cyan" }],
  });
  const sourceConversations = [targetConversation, titleSession];
  const savedTitles: string[] = [];
  const deletedIds: string[] = [];

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["codex", "claude", "opencode"],
          titleGenerationCliDisabled: ["claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fixed",
            opencode: "fixed",
          },
        },
      }),
      "utf-8"
    );

    const app = createConversationRoutes([
      createProvider({
        name: "codex",
        displayName: "Codex",
        conversations: sourceConversations,
        read: async (id) => {
          if (id !== targetConversation.id) throw new Error(`对话不存在: ${id}`);
          return {
            ...targetConversation,
            messages: [{
              role: "user",
              content: "请分析标题生成路由是否自动清理内部会话",
            }],
          };
        },
        updateTitle: async (_id, title) => {
          savedTitles.push(title);
          targetConversation.title = title;
        },
        delete: async (id) => {
          deletedIds.push(id);
        },
      }),
    ]);

    const response = await app.request("http://localhost/conversations/codex%3Aroute-ai-title-cleanup/generate-title", {
      method: "POST",
    });
    assert.equal(response.status, 200);

    const data = (await response.json()) as {
      title: string;
      usedCli: string;
      cleanedTitleSessions: number;
    };
    assert.equal(data.title, "新建路由标题");
    assert.equal(data.usedCli, "codex");
    assert.equal(data.cleanedTitleSessions, 0);
    assert.deepEqual(savedTitles, ["新建路由标题"]);
    assert.deepEqual(deletedIds, []);
    const calls = await readFakeCodexTitleCalls(env.sessionDir);
    assert.ok(calls[0]?.args.includes("--ephemeral"));
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("AI 标题生成路由会自动删除 OpenCode fresh 模式内部标题生成会话", async () => {
  const env = await createFakeOpenCodeTitleEnv();
  const targetConversation = createConversationMeta({
    id: "opencode:route-ai-title-cleanup",
    provider: "opencode",
    title: "原始标题",
  });
  const titleSession = createConversationMeta({
    id: "opencode:internal-title-session",
    provider: "opencode",
    title: "ChatLog Viewer AI Title",
    badges: [{ label: "标题生成", tone: "cyan" }],
  });
  const sourceConversations = [targetConversation, titleSession];
  const deletedIds: string[] = [];

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["opencode", "codex", "claude"],
          titleGenerationCliDisabled: ["codex", "claude"],
          titleGenerationCliSessionModes: {
            codex: "fixed",
            claude: "fixed",
            opencode: "fresh",
          },
        },
      }),
      "utf-8"
    );

    const app = createConversationRoutes([
      createProvider({
        name: "opencode",
        displayName: "OpenCode",
        conversations: sourceConversations,
        read: async (id) => {
          if (id !== targetConversation.id) throw new Error(`对话不存在: ${id}`);
          return {
            ...targetConversation,
            messages: [{
              role: "user",
              content: "请分析 OpenCode 标题生成后是否清理内部会话",
            }],
          };
        },
        updateTitle: async (_id, title) => {
          targetConversation.title = title;
        },
        delete: async (id) => {
          deletedIds.push(id);
        },
      }),
    ]);

    const response = await app.request("http://localhost/conversations/opencode%3Aroute-ai-title-cleanup/generate-title", {
      method: "POST",
    });
    assert.equal(response.status, 200);

    const data = (await response.json()) as {
      title: string;
      usedCli: string;
      cleanedTitleSessions: number;
    };
    assert.equal(data.title, "新建路由标题");
    assert.equal(data.usedCli, "opencode");
    assert.equal(data.cleanedTitleSessions, 1);
    assert.deepEqual(deletedIds, ["opencode:ses_route_title"]);
    assert.equal(deletedIds.includes(titleSession.id), false);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("AI 标题生成不会覆盖生成期间发生的手动标题修改", async () => {
  const env = await createFakeCodexTitleEnv();
  let readCount = 0;
  const savedTitles: string[] = [];

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["codex"],
          titleGenerationCliDisabled: ["claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fresh",
            opencode: "fresh",
          },
        },
      }),
      "utf-8"
    );

    const provider = createProvider({
      name: "codex",
      displayName: "Codex",
      read: async (id) => {
        readCount += 1;
        return {
          ...createConversationMeta({
            id,
            provider: "codex",
            title: readCount === 1 ? "生成开始标题" : "用户手动新标题",
          }),
          messages: [{ role: "user", content: "请生成标题" }],
        };
      },
      updateTitle: async (_id, title) => {
        savedTitles.push(title);
      },
    });
    const app = createConversationRoutes([provider]);

    const response = await app.request("http://localhost/conversations/codex%3Aai-conflict/generate-title", {
      method: "POST",
    });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /已保留当前标题/);
    assert.deepEqual(savedTitles, []);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("Fresh 标题会话快照失败时只清理精确 session ID", async () => {
  const env = await createFakeOpenCodeTitleEnv();
  const deletedIds: string[] = [];
  let listCalls = 0;

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["opencode"],
          titleGenerationCliDisabled: ["codex", "claude"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fresh",
            opencode: "fresh",
          },
        },
      }),
      "utf-8"
    );

    const target = createConversationMeta({
      id: "opencode:snapshot-failure-target",
      provider: "opencode",
      title: "原始标题",
    });
    const provider = createProvider({
      name: "opencode",
      displayName: "OpenCode",
      list: async () => {
        listCalls += 1;
        throw new Error("快照读取失败");
      },
      read: async () => ({
        ...target,
        messages: [{ role: "user", content: "请生成标题" }],
      }),
      updateTitle: async (_id, title) => {
        target.title = title;
      },
      delete: async (id) => {
        deletedIds.push(id);
      },
    });
    const app = createConversationRoutes([provider]);

    const response = await app.request(
      "http://localhost/conversations/opencode%3Asnapshot-failure-target/generate-title",
      { method: "POST" }
    );
    assert.equal(response.status, 200);
    assert.equal(listCalls, 1);
    assert.deepEqual(deletedIds, ["opencode:ses_route_title"]);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("fresh 标题会话清理会保留调用前已有的 fixed 会话", async () => {
  const existing = createConversationMeta({
    id: "codex:existing-title-session",
    provider: "codex",
    title: "已有标题会话",
    badges: [{ label: "标题生成", tone: "cyan" }],
  });
  const created = createConversationMeta({
    id: "codex:created-title-session",
    provider: "codex",
    title: "新建标题会话",
    badges: [{ label: "标题生成", tone: "cyan" }],
  });
  const deletedIds: string[] = [];
  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    conversations: [existing, created],
    delete: async (id) => {
      deletedIds.push(id);
    },
  });

  const cleaned = await cleanupFreshTitleGenerationSessions(
    [provider],
    "codex",
    false,
    true,
    undefined,
    new Set([existing.id])
  );

  assert.equal(cleaned, 1);
  assert.deepEqual(deletedIds, [created.id]);
});

test("OpenCode fresh 标题会话按返回的 session ID 精确清理", async () => {
  const deletedIds: string[] = [];
  const provider = createProvider({
    name: "opencode",
    displayName: "OpenCode",
    delete: async (id) => {
      deletedIds.push(id);
    },
  });

  const cleaned = await cleanupFreshTitleGenerationSessions(
    [provider],
    "opencode",
    false,
    true,
    "ses_generated"
  );

  assert.equal(cleaned, 1);
  assert.deepEqual(deletedIds, ["opencode:ses_generated"]);
});

test("AI 标题生成路由在不固定模式下每次新建 CLI 会话", async () => {
  const env = await createFakeCodexTitleEnv();
  const sourceConversations = [
    createConversationMeta({
      id: "codex:route-ai-title-fresh",
      provider: "codex",
      title: "原始标题",
    }),
  ];

  try {
    await writeFile(
      join(env.baseDir, "config.json"),
      JSON.stringify({
        ai: {
          titleGenerationCliPriority: ["codex", "claude", "opencode"],
          titleGenerationCliDisabled: ["claude", "opencode"],
          titleGenerationCliSessionModes: {
            codex: "fresh",
            claude: "fixed",
            opencode: "fixed",
          },
        },
      }),
      "utf-8"
    );

    const app = createConversationRoutes([
      createProvider({
        name: "codex",
        displayName: "Codex",
        conversations: sourceConversations,
        read: async (id) => ({
          ...sourceConversations.find((item) => item.id === id)!,
          messages: [{
            role: "user",
            content: "请分析标题生成路由的不固定模式",
          }],
        }),
        updateTitle: async (_id, title) => {
          sourceConversations[0]!.title = title;
        },
      }),
    ]);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.request("http://localhost/conversations/codex%3Aroute-ai-title-fresh/generate-title", {
        method: "POST",
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { title: string }).title, "新建路由标题");
    }

    const calls = await readFakeCodexTitleCalls(env.sessionDir);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.isResume, false);
    assert.equal(calls[1]?.isResume, false);
  } finally {
    env.restoreEnv();
    await rm(env.baseDir, { recursive: true, force: true });
  }
});

test("批量 AI 标题生成会跳过 iFlow 并返回禁用错误", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "iflow",
      displayName: "iFlow",
      conversations: [
        createConversationMeta({
          id: "iflow:batch-readonly",
          provider: "iflow",
          title: "原始标题",
        }),
      ],
    }),
  ]);

  const res = await app.request("http://localhost/conversations/generate-title/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ids: ["iflow:batch-readonly"] }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    success: false,
    generated: 0,
    failed: 1,
    results: [{
      id: "iflow:batch-readonly",
      error: "iFlow 当前没有稳定的原生标题字段，已禁用修改标题",
    }],
  });
});

test("Codex metadata-only 对话生成 AI 标题时会优先使用 metadata hint", () => {
  const messages = buildTitleGenerationMessages({
    ...createConversationMeta({
      id: "codex:state-only-title",
      provider: "codex",
      title: "State DB 标题",
      transcriptMissing: true,
      titleGenerationHint: "当前对话缺少 transcript，请仅根据以下 metadata 生成标题：\n现有标题: State DB 标题\n首条用户消息摘要: State DB 首条消息\n项目目录: C:/Users/tester/Desktop/code_area/chatlog-viewer\nCodex provider: custom",
      messageCount: 0,
    }),
    messages: [{
      role: "system",
      content: "当前仅保留 metadata，未找到 transcript 文件。",
    }],
  });

  assert.deepEqual(messages, [{
    role: "user",
    content: "当前对话缺少 transcript，请仅根据以下 metadata 生成标题：\n现有标题: State DB 标题\n首条用户消息摘要: State DB 首条消息\n项目目录: C:/Users/tester/Desktop/code_area/chatlog-viewer\nCodex provider: custom",
  }]);
});

test("无 modelProvider 筛选时会返回完整的 Codex provider 计数", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({
          id: "codex:openai-1",
          provider: "codex",
          modelProvider: "openai",
        }),
        createConversationMeta({
          id: "codex:openai-2",
          provider: "codex",
          modelProvider: "openai",
        }),
        createConversationMeta({
          id: "codex:azure-1",
          provider: "codex",
          modelProvider: "azure",
        }),
      ],
    }),
  ]);

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = (await res.json()) as {
    total: number;
    conversations: ConversationMeta[];
    codexModelProviderCounts: Record<string, number>;
  };
  assert.equal(data.total, 3);
  assert.deepEqual(data.codexModelProviderCounts, {
    openai: 2,
    azure: 1,
  });
});

test("modelProvider 筛选后仍返回筛选前的 Codex provider 计数", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({
          id: "codex:openai-1",
          provider: "codex",
          modelProvider: "openai",
        }),
        createConversationMeta({
          id: "codex:openai-2",
          provider: "codex",
          modelProvider: "openai",
        }),
        createConversationMeta({
          id: "codex:azure-1",
          provider: "codex",
          modelProvider: "azure",
        }),
      ],
    }),
  ]);

  const res = await app.request("http://localhost/conversations?provider=codex&modelProvider=openai");
  assert.equal(res.status, 200);

  const data = (await res.json()) as {
    total: number;
    conversations: ConversationMeta[];
    codexModelProviderCounts: Record<string, number>;
  };
  assert.equal(data.total, 2);
  assert.deepEqual(data.conversations.map((item) => item.id).sort(), ["codex:openai-1", "codex:openai-2"]);
  assert.deepEqual(data.codexModelProviderCounts, {
    openai: 2,
    azure: 1,
  });
});

test("空 modelProvider 过滤会排除所有带 modelProvider 的 Codex 对话", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({
          id: "codex:with-provider",
          provider: "codex",
          modelProvider: "openai",
        }),
        createConversationMeta({
          id: "codex:without-provider",
          provider: "codex",
        }),
      ],
    }),
    createProvider({
      name: "claude-code",
      displayName: "Claude Code",
      conversations: [
        createConversationMeta({
          id: "claude-code:1",
          provider: "claude-code",
          updatedAt: 2,
        }),
      ],
    }),
  ]);

  const res = await app.request(
    "http://localhost/conversations?provider=codex,claude-code&modelProvider="
  );
  assert.equal(res.status, 200);

  const data = (await res.json()) as {
    total: number;
    conversations: ConversationMeta[];
    codexModelProviderCounts: Record<string, number>;
  };
  assert.equal(data.total, 2);
  assert.deepEqual(
    data.conversations.map((item) => item.id).sort(),
    ["claude-code:1", "codex:without-provider"]
  );
  assert.deepEqual(data.codexModelProviderCounts, {
    openai: 1,
  });
});

test("详情接口会把 limit 和 before 透传给 provider.read", async () => {
  let receivedOptions: { limit?: number; before?: number } | undefined;

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      conversations: [
        createConversationMeta({ id: "codex:detail-1", provider: "codex" }),
      ],
      read: async (id, options) => {
        receivedOptions = options;
        return {
          ...createConversationMeta({ id, provider: "codex" }),
          messages: [],
          hasMore: true,
        } as Conversation;
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Adetail-1?limit=200&before=400");
  assert.equal(res.status, 200);
  assert.deepEqual(receivedOptions, { limit: 200, before: 400 });
});

test("详情接口对普通读取错误返回 500", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      read: async () => {
        throw new Error("读取失败");
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Afailed");
  assert.equal(res.status, 500);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "读取失败");
});

test("消息编辑接口会把 messageId 和 content 透传给 provider.updateMessage", async () => {
  let receivedId = "";
  let receivedMessageId = "";
  let receivedContent = "";

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      updateMessage: async (id, messageId, content) => {
        receivedId = id;
        receivedMessageId = messageId;
        receivedContent = content;
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Amsg-1/messages/text%3Aabc%3A1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "更新后的消息" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(
    { receivedId, receivedMessageId, receivedContent },
    {
      receivedId: "codex:msg-1",
      receivedMessageId: "text:abc:1",
      receivedContent: "更新后的消息",
    }
  );
});

test("消息编辑接口会拒绝超过 100 万字符的正文", async () => {
  let updateCalls = 0;
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      updateMessage: async () => {
        updateCalls += 1;
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Amsg-large/messages/text%3A1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x".repeat(1_000_001) }),
  });

  assert.equal(res.status, 400);
  assert.match((await res.json() as { error: string }).error, /1000000/);
  assert.equal(updateCalls, 0);
});

test("消息删除接口在 provider 不支持时返回 400", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "opencode",
      displayName: "OpenCode",
    }),
  ]);

  const res = await app.request("http://localhost/conversations/opencode%3Amsg-1/messages/text%3Aabc%3A1", {
    method: "DELETE",
  });
  assert.equal(res.status, 400);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "OpenCode 不支持删除消息");
});

test("批量消息删除接口会优先调用 provider.deleteMessages", async () => {
  let receivedId = "";
  let receivedMessageIds: string[] = [];

  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      deleteMessages: async (id, messageIds) => {
        receivedId = id;
        receivedMessageIds = messageIds;
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Amsg-1/messages/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messageIds: ["text:abc:2", "text:abc:1"] }),
  });
  assert.equal(res.status, 200);

  const data = await res.json() as { success: boolean; deleted: number };
  assert.equal(data.success, true);
  assert.equal(data.deleted, 2);
  assert.equal(receivedId, "codex:msg-1");
  assert.deepEqual(receivedMessageIds, ["text:abc:2", "text:abc:1"]);
});

test("批量 model provider 切换接口会调用 CodexProvider.changeModelProviders", async () => {
  let receivedIds: string[] = [];
  let receivedModelProvider = "";

  const codexProvider = Object.assign(
    createProvider({
      name: "codex",
      displayName: "Codex",
    }),
    {
      changeModelProviders: async (ids: string[], modelProvider: string) => {
        receivedIds = ids;
        receivedModelProvider = modelProvider;
        return ids.length;
      },
    }
  ) as ConversationProvider & {
    changeModelProviders(ids: string[], modelProvider: string): Promise<number>;
  };

  const app = createConversationRoutes([codexProvider]);

  const res = await app.request("http://localhost/conversations/model-provider/batch", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids: ["codex:thread-1", "codex:thread-2"],
      modelProvider: "openai",
    }),
  });
  assert.equal(res.status, 200);

  const data = await res.json() as { success: boolean; updated: number };
  assert.equal(data.success, true);
  assert.equal(data.updated, 2);
  assert.deepEqual(receivedIds, ["codex:thread-1", "codex:thread-2"]);
  assert.equal(receivedModelProvider, "openai");
});

test("批量 model provider 切换接口会拒绝混合非 Codex 对话", async () => {
  const codexProvider = Object.assign(
    createProvider({
      name: "codex",
      displayName: "Codex",
    }),
    {
      changeModelProviders: async () => 0,
    }
  ) as ConversationProvider & {
    changeModelProviders(ids: string[], modelProvider: string): Promise<number>;
  };

  const app = createConversationRoutes([codexProvider]);

  const res = await app.request("http://localhost/conversations/model-provider/batch", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids: ["codex:thread-1", "claude-code:thread-2"],
      modelProvider: "openai",
    }),
  });
  assert.equal(res.status, 400);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "批量切换 model provider 仅支持 Codex 对话");
});

test("删除接口对不存在对话会自动清理残留记录", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      delete: async () => {
        throw new Error("对话不存在: codex:missing");
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/codex%3Amissing", {
    method: "DELETE",
  });
  assert.equal(res.status, 200);

  const data = await res.json() as { success: boolean; cleanedStale?: boolean };
  assert.equal(data.success, true);
  assert.equal(data.cleanedStale, true);
});

test("批量删除接口会自动跳过已失效的残留记录", async () => {
  const deletedIds: string[] = [];
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      delete: async (id) => {
        if (id === "codex:missing") {
          throw new Error("对话不存在: codex:missing");
        }
        deletedIds.push(id);
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations/batch-delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ids: ["codex:ok-1", "codex:missing", "codex:ok-2", "codex:ok-1"],
    }),
  });
  assert.equal(res.status, 200);

  const data = await res.json() as {
    success: boolean;
    deleted: number;
    failed: number;
    failures: Array<{ id: string; error: string }>;
  };
  assert.equal(data.success, true);
  assert.equal(data.deleted, 3);
  assert.equal(data.failed, 0);
  assert.deepEqual(deletedIds.sort(), ["codex:ok-1", "codex:ok-2"]);
  assert.deepEqual(data.failures, []);
});

test("刷新 provider 后会优先使用新索引结果", async () => {
  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    list: async () => {
      const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
      setIndexedListCache(cacheKey, [{
        meta: createConversationMeta({
          id: "codex:indexed-1",
          provider: "codex",
          title: "索引结果",
          updatedAt: 10,
        }),
        searchText: "needle-indexed",
      }]);
      return [createConversationMeta({
        id: "codex:fallback-1",
        provider: "codex",
        title: "回退结果",
        updatedAt: 1,
      })];
    },
  });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/conversations?provider=codex&search=needle-indexed");
  assert.equal(res.status, 200);

  const data = await res.json() as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.total, 1);
  assert.equal(data.conversations[0]?.id, "codex:indexed-1");

  invalidateListCache(`codex::${provider.getStoragePath()}::indexed`);
});

test("搜索请求会要求 provider 同步补齐搜索索引", async () => {
  const eagerFlags: boolean[] = [];

  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    list: async (options) => {
      eagerFlags.push(!!options?.eagerSearchIndex);
      const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
      setIndexedListCache(cacheKey, [{
        meta: createConversationMeta({
          id: "codex:indexed-search",
          provider: "codex",
          title: "索引结果",
          updatedAt: 10,
        }),
        searchText: "needle-search-ready",
      }], { searchReady: !!options?.eagerSearchIndex });
      return [createConversationMeta({
        id: "codex:fallback-search",
        provider: "codex",
        title: "回退结果",
        updatedAt: 1,
      })];
    },
  });

  const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
  setIndexedListCache(cacheKey, [
    createConversationMeta({
      id: "codex:partial-search",
      provider: "codex",
      title: "部分索引",
      updatedAt: 2,
    }),
  ], { searchReady: false });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/conversations?provider=codex&search=needle-search-ready");
  assert.equal(res.status, 200);

  const data = await res.json() as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.total, 1);
  assert.equal(data.conversations[0]?.id, "codex:indexed-search");
  assert.deepEqual(eagerFlags, [true]);

  invalidateListCache(cacheKey);
});

test("底层文件 signature 变化后会跳过旧 indexed cache 并触发 provider 刷新", async () => {
  let listCalls = 0;

  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    getListSourceSignature: async () => "signature-v2",
    list: async () => {
      listCalls += 1;
      const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
      setIndexedListCache(cacheKey, [{
        meta: createConversationMeta({
          id: "codex:refreshed",
          provider: "codex",
          title: "刷新结果",
          updatedAt: 10,
        }),
      }], { sourceSignature: "signature-v2" });
      return [createConversationMeta({
        id: "codex:fallback-stale",
        provider: "codex",
        title: "旧缓存回退",
        updatedAt: 1,
      })];
    },
  });

  const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
  setIndexedListCache(cacheKey, [
    createConversationMeta({
      id: "codex:stale-cache",
      provider: "codex",
      title: "旧缓存",
      updatedAt: 2,
    }),
  ], { sourceSignature: "signature-v1" });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = await res.json() as { total: number; conversations: ConversationMeta[] };
  assert.equal(listCalls, 1);
  assert.equal(data.total, 1);
  assert.equal(data.conversations[0]?.id, "codex:refreshed");

  invalidateListCache(cacheKey);
});

test("provider 过滤只刷新当前选中的 provider", async () => {
  let codexDetectCalls = 0;
  let opencodeDetectCalls = 0;
  let opencodeListCalls = 0;
  const codex = createProvider({
    name: "codex",
    displayName: "Codex",
    detect: async () => {
      codexDetectCalls += 1;
      return true;
    },
    conversations: [createConversationMeta({
      id: "codex:active-only",
      provider: "codex",
      title: "仅刷新 Codex",
    })],
  });
  const opencode = createProvider({
    name: "opencode",
    displayName: "OpenCode",
    detect: async () => {
      opencodeDetectCalls += 1;
      return true;
    },
    list: async () => {
      opencodeListCalls += 1;
      return [];
    },
  });
  const app = createConversationRoutes([codex, opencode]);

  const response = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(response.status, 200);
  assert.equal(codexDetectCalls, 1);
  assert.equal(opencodeDetectCalls, 0);
  assert.equal(opencodeListCalls, 0);
});

test("列表接口会在索引层完成分页、项目和 model provider 筛选", async () => {
  let listCalls = 0;
  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    list: async () => {
      listCalls += 1;
      return [];
    },
  });
  const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
  setIndexedListCache(cacheKey, [
    createConversationMeta({
      id: "codex:v",
      provider: "codex",
      project: "/tmp/project-a",
      projectKey: "/tmp/project-a",
      modelProvider: "v",
      updatedAt: 50,
    }),
    createConversationMeta({
      id: "codex:custom",
      provider: "codex",
      project: "/tmp/project-a",
      projectKey: "/tmp/project-a",
      modelProvider: "custom",
      updatedAt: 40,
    }),
    createConversationMeta({
      id: "codex:no-model",
      provider: "codex",
      project: "/tmp/project-a",
      projectKey: "/tmp/project-a",
      updatedAt: 30,
    }),
    createConversationMeta({
      id: "codex:other-project",
      provider: "codex",
      project: "/tmp/project-b",
      projectKey: "/tmp/project-b",
      modelProvider: "v",
      updatedAt: 20,
    }),
  ]);

  const app = createConversationRoutes([provider]);
  const res = await app.request(
    "http://localhost/conversations?provider=codex&project=%2Ftmp%2Fproject-a&modelProvider=v&limit=1&offset=1"
  );
  assert.equal(res.status, 200);

  const data = await res.json() as {
    total: number;
    conversations: ConversationMeta[];
    providerCounts: Record<string, number>;
    codexModelProviderCounts: Record<string, number>;
    listTruncated: boolean;
  };
  assert.equal(listCalls, 0);
  assert.equal(data.total, 2);
  assert.deepEqual(data.conversations.map((item) => item.id), ["codex:no-model"]);
  assert.deepEqual(data.providerCounts, { codex: 2 });
  assert.deepEqual(data.codexModelProviderCounts, {
    custom: 1,
    v: 1,
  });
  assert.equal(data.listTruncated, false);

  invalidateListCache(cacheKey);
});

test("/projects 会优先复用 fresh indexed cache 中的项目列表", async () => {
  let listProjectsCalls = 0;

  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    getListSourceSignature: async () => "projects-signature-v1",
    listProjects: async () => {
      listProjectsCalls += 1;
      return ["fallback-project"];
    },
  });

  const cacheKey = `codex::${provider.getStoragePath()}::indexed`;
  setIndexedListCache(cacheKey, [
    createConversationMeta({
      id: "codex:project-1",
      provider: "codex",
      projectKey: "C:/Users/tester/Desktop/code_area/r-bioinfo",
      project: "C:/Users/tester/Desktop/code_area/r-bioinfo",
    }),
    createConversationMeta({
      id: "codex:project-2",
      provider: "codex",
      projectKey: "C:/Users/tester/Desktop/code_area/r-bioinfo",
      project: "C:/Users/tester/Desktop/code_area/r-bioinfo/subdir",
    }),
  ], { sourceSignature: "projects-signature-v1" });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/projects?provider=codex");
  assert.equal(res.status, 200);

  const data = await res.json() as Array<{ provider: string; projectKey: string; displayName: string }>;
  assert.equal(listProjectsCalls, 0);
  assert.deepEqual(data, [{
    provider: "codex",
    projectKey: "C:/Users/tester/Desktop/code_area/r-bioinfo",
    displayName: "C:/Users/tester/Desktop/code_area/r-bioinfo/subdir",
  }]);

  invalidateListCache(cacheKey);
});

test("/projects 在 indexed cache 不可用时会回退到 provider.listProjects", async () => {
  let listProjectsCalls = 0;

  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    getListSourceSignature: async () => "projects-signature-v2",
    listProjects: async () => {
      listProjectsCalls += 1;
      return ["fallback-project"];
    },
  });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/projects?provider=codex");
  assert.equal(res.status, 200);

  const data = await res.json() as Array<{ provider: string; projectKey: string; displayName: string }>;
  assert.equal(listProjectsCalls, 1);
  assert.deepEqual(data, [{
    provider: "codex",
    projectKey: "fallback-project",
    displayName: "fallback-project",
  }]);
});

test("搜索降级到标题和目录匹配时会返回 partialSearch 提示", async () => {
  const provider = createProvider({
    name: "codex",
    displayName: "Codex",
    list: async () => [
      createConversationMeta({
        id: "codex:fallback-only",
        provider: "codex",
        title: "仅标题命中",
      }),
    ],
  });

  const app = createConversationRoutes([provider]);
  const res = await app.request("http://localhost/conversations?provider=codex&search=标题");
  assert.equal(res.status, 200);

  const data = await res.json() as {
    total: number;
    conversations: ConversationMeta[];
    partialSearch: boolean;
    warnings: string[];
  };
  assert.equal(data.partialSearch, true);
  assert.equal(data.warnings.length, 1);
  assert.match(data.warnings[0] || "", /搜索索引尚未就绪/);
  assert.equal(data.conversations[0]?.id, "codex:fallback-only");
});

test("普通列表 provider 读取失败时返回 partialResults 和具体 warning", async () => {
  const app = createConversationRoutes([
    createProvider({
      name: "opencode",
      displayName: "OpenCode",
      list: async () => {
        throw new Error("database is locked");
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations?provider=opencode");
  assert.equal(res.status, 200);
  const data = await res.json() as {
    total: number;
    partialResults: boolean;
    warnings: string[];
  };
  assert.equal(data.total, 0);
  assert.equal(data.partialResults, true);
  assert.match(data.warnings[0] || "", /database is locked/);
});

test("provider 返回部分数据 warning 时保留列表并标记 partialResults", async () => {
  const conversation = createConversationMeta({
    id: "codex:partial-state-db",
    provider: "codex",
    title: "来自 transcript 的标题",
  });
  const app = createConversationRoutes([
    createProvider({
      name: "codex",
      displayName: "Codex",
      list: async (options) => {
        options?.onWarning?.("Codex State DB 已损坏，已仅使用 transcript 数据");
        return [conversation];
      },
    }),
  ]);

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);
  const data = await res.json() as {
    total: number;
    conversations: ConversationMeta[];
    partialResults: boolean;
    warnings: string[];
  };
  assert.equal(data.total, 1);
  assert.equal(data.conversations[0]?.id, conversation.id);
  assert.equal(data.partialResults, true);
  assert.match(data.warnings[0] || "", /仅使用 transcript/);
});
