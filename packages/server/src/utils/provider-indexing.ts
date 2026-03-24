import type { IndexedCacheItem } from "./cache.js";

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
