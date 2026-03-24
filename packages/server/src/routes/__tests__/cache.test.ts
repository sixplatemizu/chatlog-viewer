import test from "node:test";
import assert from "node:assert/strict";
import {
  getIndexedCacheSnapshot,
  getIndexedListCache,
  hasFreshIndexedListCache,
  queryConversationIndex,
  setIndexedListCache,
  invalidateListCache,
} from "../../utils/cache.js";
import type { ConversationMeta } from "../../providers/types.js";

function createConversationMeta(id: string): ConversationMeta {
  return {
    id,
    provider: "codex",
    title: "测试对话",
    project: "/tmp/project",
    projectKey: "project",
    createdAt: 1,
    updatedAt: 2,
    messageCount: 3,
    fileSize: 4,
    filePath: `/tmp/${id}.jsonl`,
  };
}

test("indexed list cache 可以命中并读取列表", () => {
  const cacheKey = `test-indexed-${Date.now()}`;
  const items = [createConversationMeta("codex:1")];

  setIndexedListCache(cacheKey, items);
  const cached = getIndexedListCache(cacheKey, 60_000);

  assert.deepEqual(cached, items);

  invalidateListCache(cacheKey);
});

test("indexed list cache 过期后返回 null", () => {
  const cacheKey = `test-indexed-expired-${Date.now()}`;
  const items = [createConversationMeta("codex:2")];

  setIndexedListCache(cacheKey, items);
  const cached = getIndexedListCache(cacheKey, -1);

  assert.equal(cached, null);

  invalidateListCache(cacheKey);
});

test("conversation index 支持按消息内容搜索", () => {
  const cacheKey = `test-index-search-${Date.now()}`;
  const needle = `needle-${Date.now()}`;

  setIndexedListCache(cacheKey, [{
    meta: createConversationMeta("codex:3"),
    searchText: `hello ${needle} world`,
  }]);

  const snapshot = getIndexedCacheSnapshot(cacheKey);
  assert.equal(snapshot?.[0]?.searchText, `hello ${needle} world`);

  const matched = queryConversationIndex({
    providers: ["codex"],
    search: needle,
  });
  assert.equal(matched.some((item) => item.id === "codex:3"), true);

  invalidateListCache(cacheKey);
});

test("partial indexed list cache 在需要完整搜索索引时不会命中", () => {
  const cacheKey = `test-index-partial-${Date.now()}`;
  const items = [createConversationMeta("codex:4")];

  setIndexedListCache(cacheKey, items, { searchReady: false });

  assert.deepEqual(getIndexedListCache(cacheKey, 60_000), items);
  assert.equal(getIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), null);
  assert.equal(hasFreshIndexedListCache(cacheKey, 60_000, { requireSearchReady: true }), false);

  invalidateListCache(cacheKey);
});
