import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTitleGenerationMessages, createConversationRoutes } from "../conversations.js";
import {
  invalidateListCache,
  setIndexedListCache,
  setCacheStoreDirForTests,
} from "../../utils/cache.js";
import { getTitle, setTitle, setTitleStoreDirForTests } from "../../utils/title-store.js";
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

test("支持原生标题持久化的 provider 会调用 updateTitle 并清理 overlay", async () => {
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

  const res = await app.request("http://localhost/conversations?provider=codex");
  assert.equal(res.status, 200);

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.conversations[0]?.title, "同步到原生存储");
});

test("列表接口会显示旧 overlay 标题但不回填到支持原生标题的 provider", async () => {
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
  assert.equal(data.conversations[0]?.title, "旧覆盖标题");
  assert.deepEqual(receivedCalls, []);
  assert.equal(await getTitle("codex:legacy-title"), "旧覆盖标题");
});

test("详情接口会显示旧 overlay 标题但不回填到支持原生标题的 provider", async () => {
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
  assert.equal(data.title, "详情覆盖标题");
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
        updateTitleDisabledReason: "禁用手动标题",
        generateTitleDisabledReason: "禁用 AI 标题",
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
  assert.equal(data.capabilities?.updateTitleDisabledReason, "禁用手动标题");
  assert.equal(data.capabilities?.generateTitleDisabledReason, "禁用 AI 标题");
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
