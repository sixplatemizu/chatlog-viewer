import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, open, readFile, rm, stat, utimes } from "node:fs/promises";
import { homedir } from "node:os";
import { MutationConflictError } from "./errors.js";

const pendingByKey = new Map<string, Promise<void>>();
const LOCK_WAIT_TIMEOUT_MS = 30_000;
const LOCK_STALE_AFTER_MS = 120_000;
const LOCK_RETRY_INTERVAL_MS = 50;
const LOCK_HEARTBEAT_INTERVAL_MS = 10_000;

interface MutationLockRecord {
  key: string;
  ownerId: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

function getLockDirectory(): string {
  return process.env.CHATLOG_VIEWER_LOCK_DIR?.trim()
    || join(homedir(), ".chatlog-viewer", "locks");
}

function getLockPath(key: string): string {
  const hash = createHash("sha256").update(key).digest("hex");
  return join(getLockDirectory(), `${hash}.lock`);
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error
      && typeof error === "object"
      && "code" in error
      && (error as { code?: unknown }).code === "EPERM";
  }
}

async function readLockRecord(lockPath: string): Promise<MutationLockRecord | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf-8")) as MutationLockRecord;
  } catch {
    return null;
  }
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
  let lockStat;
  try {
    lockStat = await stat(lockPath);
  } catch {
    return true;
  }

  if (Date.now() - lockStat.mtimeMs <= LOCK_STALE_AFTER_MS) {
    return false;
  }

  const record = await readLockRecord(lockPath);
  if (record?.hostname === hostname() && isProcessAlive(record.pid)) {
    return false;
  }

  try {
    const verifyStat = await stat(lockPath);
    if (verifyStat.mtimeMs !== lockStat.mtimeMs || verifyStat.size !== lockStat.size) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
}

async function acquireProcessLock(key: string): Promise<() => Promise<void>> {
  const lockPath = getLockPath(key);
  const ownerId = `${process.pid}-${randomUUID()}`;
  const startedAt = Date.now();
  await mkdir(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      const handle = await open(lockPath, "wx");
      const record: MutationLockRecord = {
        key,
        ownerId,
        pid: process.pid,
        hostname: hostname(),
        createdAt: Date.now(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(record)}\n`, "utf-8");
        await handle.sync();
      } finally {
        await handle.close();
      }

      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => undefined);
      }, LOCK_HEARTBEAT_INTERVAL_MS);
      heartbeat.unref();

      return async () => {
        clearInterval(heartbeat);
        const current = await readLockRecord(lockPath);
        if (current?.ownerId === ownerId) {
          await rm(lockPath, { force: true });
        }
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "EEXIST") throw error;
    }

    if (await removeStaleLock(lockPath)) {
      continue;
    }
    if (Date.now() - startedAt >= LOCK_WAIT_TIMEOUT_MS) {
      throw new MutationConflictError(`等待数据写入锁超时，请关闭其他修改进程后重试: ${key}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
  }
}

export async function runKeyedMutation<T>(
  key: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = pendingByKey.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = previous
    .catch(() => undefined)
    .then(() => new Promise<void>((resolve) => {
      release = resolve;
    }));

  pendingByKey.set(key, current);
  await previous.catch(() => undefined);

  let releaseProcessLock: (() => Promise<void>) | null = null;
  try {
    releaseProcessLock = await acquireProcessLock(key);
    return await task();
  } finally {
    if (releaseProcessLock) {
      await releaseProcessLock();
    }
    release();
    if (pendingByKey.get(key) === current) {
      pendingByKey.delete(key);
    }
  }
}

export async function runKeyedMutations<T>(
  keys: string[],
  task: () => Promise<T>
): Promise<T> {
  const uniqueKeys = [...new Set(keys.map((key) => key.trim()).filter(Boolean))].sort();

  const run = async (index: number): Promise<T> => {
    if (index >= uniqueKeys.length) {
      return await task();
    }
    return await runKeyedMutation(uniqueKeys[index], () => run(index + 1));
  };

  return await run(0);
}
