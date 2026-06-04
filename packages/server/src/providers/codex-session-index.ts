import { mkdir, readFile, writeFile } from "fs/promises";
import { dirname, join } from "path";

export function getCodexSessionIndexPath(storagePath: string): string {
  return join(dirname(storagePath), "session_index.jsonl");
}

export async function upsertCodexSessionIndexThreadName(
  storagePath: string,
  sessionId: string,
  title: string
): Promise<boolean> {
  const indexPath = getCodexSessionIndexPath(storagePath);
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
        const nextEntry = {
          ...entry,
          thread_name: title,
          updated_at: now,
        };
        const nextLine = JSON.stringify(nextEntry);
        if (nextLine !== line) changed = true;
        return nextLine;
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
  await mkdir(dirname(indexPath), { recursive: true });
  await writeFile(indexPath, rewrittenContent, "utf-8");
  return true;
}
