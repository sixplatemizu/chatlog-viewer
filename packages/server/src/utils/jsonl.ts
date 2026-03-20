import { createReadStream } from "fs";
import { createInterface } from "readline";

// 全量解析 JSONL（仅用于 read 详情时）
export async function parseJsonl<T = unknown>(filePath: string): Promise<T[]> {
  const results: T[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // 跳过无法解析的行
    }
  }
  return results;
}

// 只读前 N 行并解析（用于 extractMeta，避免全量读取大文件）
export async function parseJsonlHead<T = unknown>(
  filePath: string,
  maxLines: number = 40
): Promise<T[]> {
  const results: T[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let count = 0;
  for await (const line of rl) {
    if (count >= maxLines) break;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
      count++;
    } catch {
      // 跳过
    }
  }
  rl.close();
  return results;
}

// 快速计算文件中匹配指定模式的行数（不做 JSON 解析）
export async function countLines(
  filePath: string,
  patterns: string[]
): Promise<number> {
  let count = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    for (const p of patterns) {
      if (line.includes(p)) {
        count++;
        break;
      }
    }
  }
  return count;
}
