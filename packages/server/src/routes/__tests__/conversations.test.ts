import test from "node:test";
import assert from "node:assert/strict";
import { createConversationRoutes } from "../conversations.js";
import {
  invalidateListCache,
  setIndexedListCache,
} from "../../utils/cache.js";
import type {
  ConversationProvider,
  ConversationMeta,
  Conversation,
  ConversationListOptions,
} from "../../providers/types.js";

type ProviderOverrides = Partial<ConversationProvider> & {
  name: string;
  displayName: string;
  conversations?: ConversationMeta[];
};

function createProvider(overrides: ProviderOverrides): ConversationProvider {
  const conversations = overrides.conversations ?? [];
  const storagePath = `/tmp/${overrides.name}-${Math.random().toString(36).slice(2)}`;

  return {
    name: overrides.name,
    displayName: overrides.displayName,
    detect: overrides.detect ?? (async () => true),
    list: overrides.list ?? (async (_options?: ConversationListOptions) => conversations),
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

test("删除接口对不存在对话返回 404", async () => {
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
  assert.equal(res.status, 404);

  const data = await res.json() as { error: string };
  assert.equal(data.error, "对话不存在: codex:missing");
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
