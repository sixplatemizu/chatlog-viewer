import test from "node:test";
import assert from "node:assert/strict";
import { createConversationRoutes } from "../conversations.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
} from "../../providers/types.js";

type ProviderOverrides = Partial<ConversationProvider> & {
  name: string;
  displayName: string;
  conversations?: ConversationMeta[];
};

function createProvider(overrides: ProviderOverrides): ConversationProvider {
  const conversations = overrides.conversations ?? [];

  return {
    name: overrides.name,
    displayName: overrides.displayName,
    detect: overrides.detect ?? (async () => true),
    list: overrides.list ?? (async () => conversations),
    read:
      overrides.read ??
      (async (id: string) => {
        const meta = conversations.find((item) => item.id === id);
        if (!meta) throw new Error(`对话不存在: ${id}`);
        return { ...meta, messages: [] } as Conversation;
      }),
    delete: overrides.delete ?? (async () => {}),
    move: overrides.move,
    listProjects: overrides.listProjects,
    getStoragePath: overrides.getStoragePath ?? (() => `/tmp/${overrides.name}`),
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

  const data = (await res.json()) as { total: number; conversations: ConversationMeta[] };
  assert.equal(data.total, 2);
  assert.deepEqual(
    data.conversations.map((item) => item.id).sort(),
    ["claude-code:1", "codex:without-provider"]
  );
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
