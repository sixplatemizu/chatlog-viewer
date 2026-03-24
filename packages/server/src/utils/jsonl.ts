import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { createInterface } from "readline";

const MIN_TAIL_READ_BYTES = 8 * 1024;
const DEFAULT_WINDOW_READ_BYTES = 128 * 1024;
const DEFAULT_SAMPLE_WINDOW_COUNT = 5;

export interface ParseJsonlWindowOptions {
  headBytes?: number;
  middleBytes?: number;
  tailBytes?: number;
  sampleWindowCount?: number;
}

export interface CountJsonlLinesOptions {
  fastIncludes?: string[];
}

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

export async function parseJsonlWindow<T = unknown>(
  filePath: string,
  options?: ParseJsonlWindowOptions
): Promise<T[]> {
  const fileStat = await stat(filePath);
  const fileSize = fileStat.size;
  if (fileSize <= 0) return [];

  const headBytes = Math.max(options?.headBytes ?? DEFAULT_WINDOW_READ_BYTES, MIN_TAIL_READ_BYTES);
  const middleBytes = Math.max(options?.middleBytes ?? headBytes, MIN_TAIL_READ_BYTES);
  const tailBytes = Math.max(options?.tailBytes ?? DEFAULT_WINDOW_READ_BYTES, MIN_TAIL_READ_BYTES);
  const sampleWindowCount = Math.max(options?.sampleWindowCount ?? DEFAULT_SAMPLE_WINDOW_COUNT, 2);

  const readWindow = (start: number, end: number): Promise<string> => new Promise((resolve, reject) => {
    let content = "";
    const stream = createReadStream(filePath, {
      encoding: "utf-8",
      start,
      end,
    });

    stream.on("data", (chunk) => {
      content += chunk;
    });
    stream.on("end", () => {
      let normalized = content;
      if (start > 0) {
        const firstNewline = normalized.indexOf("\n");
        if (firstNewline >= 0) normalized = normalized.slice(firstNewline + 1);
      }
      if (end < fileSize - 1) {
        const lastNewline = normalized.lastIndexOf("\n");
        if (lastNewline >= 0) normalized = normalized.slice(0, lastNewline);
      }
      resolve(normalized);
    });
    stream.on("error", reject);
  });

  if (fileSize <= headBytes + tailBytes) {
    return parseJsonl<T>(filePath);
  }

  const ranges: Array<{ start: number; end: number }> = [];
  ranges.push({ start: 0, end: Math.min(fileSize - 1, headBytes - 1) });

  const middleWindowCount = Math.max(sampleWindowCount - 2, 0);
  const middleStartFloor = headBytes;
  const middleStartCeiling = Math.max(
    middleStartFloor,
    fileSize - tailBytes - middleBytes
  );
  for (let index = 0; index < middleWindowCount; index++) {
    const ratio = (index + 1) / (middleWindowCount + 1);
    const start = Math.min(
      Math.max(middleStartFloor, Math.floor((fileSize - middleBytes) * ratio)),
      middleStartCeiling
    );
    const end = Math.min(fileSize - 1, start + middleBytes - 1);
    if (start < end) {
      ranges.push({ start, end });
    }
  }

  ranges.push({ start: Math.max(0, fileSize - tailBytes), end: fileSize - 1 });

  const chunks = await Promise.all(
    ranges.map((range) => readWindow(range.start, range.end))
  );
  return chunks.flatMap((chunk) => parseJsonlText<T>(chunk));
}

export function getAdaptiveSearchWindowOptions(fileSize: number): Required<ParseJsonlWindowOptions> {
  if (fileSize <= 2 * 1024 * 1024) {
    return {
      headBytes: 96 * 1024,
      middleBytes: 64 * 1024,
      tailBytes: 96 * 1024,
      sampleWindowCount: 5,
    };
  }

  if (fileSize <= 8 * 1024 * 1024) {
    return {
      headBytes: 80 * 1024,
      middleBytes: 48 * 1024,
      tailBytes: 80 * 1024,
      sampleWindowCount: 7,
    };
  }

  if (fileSize <= 32 * 1024 * 1024) {
    return {
      headBytes: 64 * 1024,
      middleBytes: 32 * 1024,
      tailBytes: 64 * 1024,
      sampleWindowCount: 9,
    };
  }

  return {
    headBytes: 48 * 1024,
    middleBytes: 24 * 1024,
    tailBytes: 48 * 1024,
    sampleWindowCount: 13,
  };
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

// 使用可选的快速字符串预筛后，按 JSON 结构准确计数，避免正文中的转义片段误命中。
export async function countLines(
  filePath: string,
  matcher: (value: unknown) => boolean,
  options?: CountJsonlLinesOptions
): Promise<number> {
  let count = 0;
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (options?.fastIncludes && !options.fastIncludes.some((pattern) => trimmed.includes(pattern))) {
      continue;
    }

    try {
      if (matcher(JSON.parse(trimmed))) {
        count++;
      }
    } catch {
      // 跳过无法解析的行
    }
  }
  return count;
}
