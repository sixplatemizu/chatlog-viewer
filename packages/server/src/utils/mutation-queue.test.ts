import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const helperScript = `
  import { readFile, writeFile } from "node:fs/promises";
  import { runKeyedMutation } from ${JSON.stringify(new URL("./mutation-queue.ts", import.meta.url).href)};
  const [key, counterPath] = process.argv.slice(1);
  await runKeyedMutation(key, async () => {
    const value = Number(await readFile(counterPath, "utf-8").catch(() => "0"));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await writeFile(counterPath, String(value + 1), "utf-8");
  });
`;

function runHelper(key: string, counterPath: string, lockDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--eval", helperScript, key, counterPath], {
      env: { ...process.env, CHATLOG_VIEWER_LOCK_DIR: lockDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`helper 退出码 ${code}: ${stderr}`));
    });
  });
}

test("runKeyedMutation 会在不同 Node 进程之间串行执行同一个 key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chatlog-viewer-process-lock-"));
  const counterPath = join(dir, "counter.txt");
  const lockDir = join(dir, "locks");

  try {
    await Promise.all([
      runHelper("shared-key", counterPath, lockDir),
      runHelper("shared-key", counterPath, lockDir),
    ]);
    assert.equal(await readFile(counterPath, "utf-8"), "2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
