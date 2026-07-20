import { randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { runKeyedMutation } from "../utils/mutation-queue.js";

export function getCodexSessionIndexPath(storagePath: string): string {
  return join(dirname(storagePath), "session_index.jsonl");
}

export async function upsertCodexSessionIndexThreadName(
  storagePath: string,
  sessionId: string,
  title: string
): Promise<boolean> {
  const indexPath = getCodexSessionIndexPath(storagePath);
  return await runKeyedMutation(indexPath, async () => {
    let originalContent: string;
    try {
      originalContent = await readFile(indexPath, "utf-8");
    } catch {
      originalContent = "";
    }

    let matched = false;
    let changed = false;
    const now = new Date().toISOString();
    const rewrittenLines = originalContent
      .split(/\r?\n/)
      .filter((line, index, lines) => line.trim() || index < lines.length - 1)
      .map((line) => {
        if (!line.trim()) return line;
        try {
          const entry = JSON.parse(line) as { id?: string; thread_name?: string; updated_at?: string; [key: string]: unknown };
          if (entry.id !== sessionId) return line;

          matched = true;
          if (entry.thread_name === title) return line;
          changed = true;
          return JSON.stringify({
            ...entry,
            thread_name: title,
            updated_at: now,
          });
        } catch {
          return line;
        }
      });

    if (!matched) {
      rewrittenLines.push(JSON.stringify({
        id: sessionId,
        thread_name: title,
        updated_at: now,
      }));
      changed = true;
    }

    if (!changed) return false;
    const rewrittenContent = rewrittenLines.join("\n") + "\n";
    const temporaryPath = `${indexPath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(indexPath), { recursive: true });
    try {
      await writeFile(temporaryPath, rewrittenContent, "utf-8");
      await rename(temporaryPath, indexPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    return true;
  });
}

export async function getCodexSessionIndexThreadName(
  storagePath: string,
  sessionId: string
): Promise<string | null> {
  const indexPath = getCodexSessionIndexPath(storagePath);
  return await runKeyedMutation(indexPath, async () => {
    let content = "";
    try {
      content = await readFile(indexPath, "utf-8");
    } catch {
      return null;
    }

    for (const line of content.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line) as { id?: string; thread_name?: string };
        if (entry.id === sessionId) {
          return entry.thread_name?.trim() || null;
        }
      } catch {
        // 忽略损坏行，继续查找目标记录。
      }
    }
    return null;
  });
}
