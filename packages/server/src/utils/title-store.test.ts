import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getNativeTitleSnapshot,
  getTitle,
  setNativeTitleSnapshot,
  setTitle,
  setTitleStoreDirForTests,
} from "./title-store.js";

test("标题存储并发写入不同会话时不会丢失记录", async () => {
  const storeDir = await mkdtemp(join(tmpdir(), "chatlog-viewer-title-store-"));
  setTitleStoreDirForTests(storeDir);

  try {
    const ids = Array.from({ length: 30 }, (_, index) => `codex:concurrent-${index}`);
    await Promise.all(ids.map((id, index) => setTitle(id, `overlay-${index}`)));
    await Promise.all(ids.map((id, index) => setNativeTitleSnapshot(id, `native-${index}`)));

    const overlayTitles = await Promise.all(ids.map((id) => getTitle(id)));
    const nativeTitles = await Promise.all(ids.map((id) => getNativeTitleSnapshot(id)));
    assert.deepEqual(overlayTitles, ids.map((_, index) => `overlay-${index}`));
    assert.deepEqual(nativeTitles, ids.map((_, index) => `native-${index}`));
  } finally {
    setTitleStoreDirForTests();
    await rm(storeDir, { recursive: true, force: true });
  }
});
