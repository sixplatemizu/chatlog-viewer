import { createHash } from "crypto";
import { stat } from "fs/promises";
import { glob } from "glob";
import type { IndexedCacheItem } from "./cache.js";

const FILE_STATE_STAT_BATCH_SIZE = 128;

export interface IndexedSourceFile {
  path: string;
  mtimeMs: number;
  size: number;
}

function normalizeIndexedPath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}

export async function collectGlobFileStates(pattern: string): Promise<IndexedSourceFile[]> {
  const files = (await glob(pattern)).map(normalizeIndexedPath).sort();
  const states: Array<IndexedSourceFile | null> = [];

  for (let start = 0; start < files.length; start += FILE_STATE_STAT_BATCH_SIZE) {
    const batch = files.slice(start, start + FILE_STATE_STAT_BATCH_SIZE);
    states.push(...await Promise.all(batch.map(async (filePath) => {
      try {
        const fileStat = await stat(filePath);
        return {
          path: filePath,
          mtimeMs: fileStat.mtimeMs,
          size: fileStat.size,
        };
      } catch {
        return null;
      }
    })));
  }

  return states.filter((item): item is IndexedSourceFile => !!item);
}

export function createIndexedListSourceSignature(files: IndexedSourceFile[]): string {
  const hash = createHash("sha1");
  hash.update(String(files.length));

  for (const file of files) {
    hash.update("\0");
    hash.update(file.path);
    hash.update("\0");
    hash.update(String(file.mtimeMs));
    hash.update("\0");
    hash.update(String(file.size));
  }

  return hash.digest("hex");
}

export async function collectIndexedCacheItemsInBatches(
  filePaths: string[],
  batchSize: number,
  loader: (filePath: string) => Promise<IndexedCacheItem | null>
): Promise<IndexedCacheItem[]> {
  const results: IndexedCacheItem[] = [];
  const normalizedBatchSize = Math.max(1, batchSize);

  for (let start = 0; start < filePaths.length; start += normalizedBatchSize) {
    const batch = filePaths.slice(start, start + normalizedBatchSize);
    const batchResults = await Promise.all(batch.map((filePath) => loader(filePath)));

    for (const item of batchResults) {
      if (item) {
        results.push(item);
      }
    }
  }

  return results;
}
