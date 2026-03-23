import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { createInterface } from "readline";

const MIN_TAIL_READ_BYTES = 8 * 1024;

export interface ParseJsonlTailContext {
  reachedStart: boolean;
  bytesRead: number;
  fileSize: number;
}

export interface ParseJsonlTailOptions<T> {
  bytesHint?: number;
  maxBytes?: number;
  isEnough?: (items: T[], context: ParseJsonlTailContext) => boolean;
}

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

// 倒序读取文件尾部指定字节数，尽量只解析最近一段内容
async function readFileTail(
  filePath: string,
  fileSize: number,
  bytes: number
): Promise<{ content: string; reachedStart: boolean }> {
  const start = Math.max(0, fileSize - bytes);

  return new Promise((resolve, reject) => {
    let content = "";
    const stream = createReadStream(filePath, {
      encoding: "utf-8",
      start,
      end: fileSize > 0 ? fileSize - 1 : undefined,
    });

    stream.on("data", (chunk) => {
      content += chunk;
    });
    stream.on("end", () => {
      const reachedStart = start === 0;
      if (!reachedStart) {
        const firstNewline = content.indexOf("\n");
        if (firstNewline >= 0) {
          content = content.slice(firstNewline + 1);
        }
      }
      resolve({ content, reachedStart });
    });
    stream.on("error", reject);
  });
}

function parseJsonlText<T>(content: string): T[] {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const parsed: T[] = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line) as T);
    } catch {
      // 跳过无法解析的行
    }
  }

  return parsed;
}

export async function parseJsonlTail<T = unknown>(
  filePath: string,
  options: number | ParseJsonlTailOptions<T> = 256 * 1024
): Promise<T[]> {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;
  if (fileSize <= 0) return [];

  const normalizedOptions = typeof options === "number"
    ? { bytesHint: options }
    : options;

  const baseBytesHint = Math.max(
    normalizedOptions.bytesHint ?? 256 * 1024,
    MIN_TAIL_READ_BYTES
  );
  const maxBytes = Math.min(
    Math.max(normalizedOptions.maxBytes ?? fileSize, baseBytesHint),
    fileSize
  );

  let bytesRead = Math.min(baseBytesHint, maxBytes);

  while (true) {
    const { content, reachedStart } = await readFileTail(filePath, fileSize, bytesRead);
    const parsed = parseJsonlText<T>(content);

    if (
      reachedStart ||
      !normalizedOptions.isEnough ||
      normalizedOptions.isEnough(parsed, { reachedStart, bytesRead, fileSize })
    ) {
      return parsed;
    }

    if (bytesRead >= maxBytes) {
      return parsed;
    }

    bytesRead = Math.min(maxBytes, Math.max(bytesRead * 2, bytesRead + baseBytesHint));
  }
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
