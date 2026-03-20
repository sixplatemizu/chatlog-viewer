import { createReadStream } from "fs";
import { createInterface } from "readline";

// 逐行解析 JSONL 文件，跳过无效行
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
