import { join } from "path";
import type { ConversationMeta, ConversationReadOptions } from "../types.js";
import { getCached, setCache } from "../../utils/cache.js";

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").trim();
}

export function canonicalizeProjectPath(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized) return "";
  return /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("~/")
    ? normalized.toLowerCase()
    : normalized;
}

export function isWindowsHomePath(path: string): boolean {
  const parts = normalizePath(path).split("/").filter(Boolean);
  return parts.length === 3 && /^[A-Za-z]:$/.test(parts[0]) && parts[1] === "Users";
}

export function getProjectSpecificity(project: string, projectKey: string): number {
  const normalized = normalizePath(project);
  if (!normalized || normalized === projectKey) return 0;

  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) return 0;
  if (isWindowsHomePath(normalized)) return 1;
  return parts.length + 10;
}

export function getListCacheKey(providerName: string, storagePath: string): string {
  return `${providerName}::${storagePath}::indexed`;
}

export function sliceWindow<T>(items: T[], options?: ConversationReadOptions): { items: T[]; hasMore: boolean } {
  const limit = options?.limit;
  const before = options?.before ?? 0;

  if (!limit || limit <= 0) {
    return { items, hasMore: false };
  }

  const end = Math.max(0, items.length - before);
  const start = Math.max(0, end - limit);
  return {
    items: items.slice(start, end),
    hasMore: start > 0,
  };
}

export function resolveProjectDirectory(basePath: string, targetProjectKey: string): {
  normalizedProjectKey: string;
  targetProjectDir: string;
} {
  const normalizedProjectKey = normalizePath(targetProjectKey).trim();
  if (!normalizedProjectKey) {
    throw new Error("目标文件夹不能为空");
  }
  if (
    normalizedProjectKey === "."
    || normalizedProjectKey === ".."
    || normalizedProjectKey.includes("/")
  ) {
    throw new Error("目标文件夹不合法");
  }

  const normalizedBasePath = normalizePath(basePath);
  const targetProjectDir = normalizePath(join(basePath, normalizedProjectKey));
  if (
    targetProjectDir !== normalizedBasePath
    && !targetProjectDir.startsWith(`${normalizedBasePath}/`)
  ) {
    throw new Error("目标文件夹不合法");
  }

  return {
    normalizedProjectKey,
    targetProjectDir,
  };
}

export function applyProjectDisplayPathHints(
  items: Array<{ meta: ConversationMeta; searchText?: string; searchChunks?: string[] }>
): Array<{ meta: ConversationMeta; searchText?: string; searchChunks?: string[] }> {
  const bestProjectByKey = new Map<string, string>();

  for (const item of items) {
    const projectKey = item.meta.projectKey || item.meta.project || "";
    const candidate = item.meta.project || item.meta.projectId || projectKey;
    const current = bestProjectByKey.get(projectKey);
    const candidateScore = getProjectSpecificity(candidate, projectKey);
    const currentScore = current ? getProjectSpecificity(current, projectKey) : -1;

    if (
      !current ||
      candidateScore > currentScore ||
      (candidateScore === currentScore && candidate.length > current.length)
    ) {
      bestProjectByKey.set(projectKey, candidate);
    }
  }

  return items.map((item) => {
    const projectKey = item.meta.projectKey || item.meta.project || "";
    const preferredProject = bestProjectByKey.get(projectKey);
    const preferredProjectId = canonicalizeProjectPath(preferredProject || "") || projectKey;

    // 只在 cache 当前 mtime 与 item 一致时才回写，避免与并发刷新的 fresh
    // cache 竞争把更早的 meta 覆盖回去。getCached 返回 null 表示文件已变更
    // 或缓存被清空，跳过本次显示路径修正即可，下一轮 list 会再次尝试。
    const persistMeta = (nextMeta: ConversationMeta): void => {
      const stillFresh = getCached(item.meta.filePath, item.meta.updatedAt);
      if (!stillFresh) return;
      setCache(item.meta.filePath, item.meta.updatedAt, nextMeta);
    };

    if (!preferredProject) {
      if (item.meta.projectId === preferredProjectId) return item;
      const updatedMeta = {
        ...item.meta,
        projectId: preferredProjectId,
      };
      persistMeta(updatedMeta);
      return {
        ...item,
        meta: updatedMeta,
      };
    }

    const currentScore = getProjectSpecificity(item.meta.project, projectKey);
    const preferredScore = getProjectSpecificity(preferredProject, projectKey);
    // 关键约束：仅当当前 item 没有自己的有效 project（specificity === 0，
    // 例如只拿到 encoded projectKey 没解析出 cwd）时才用群组内最优值填充。
    // 否则保留 item 自己的 cwd —— 同一 Claude Code 项目目录下的不同 session
    // 完全可能在不同子目录启动（e.g. `~` 和 `~/sub`），不应被其他 session
    // 的更深路径覆盖。projectId 同样保留自己的而不是用 preferredProjectId，
    // 否则前端按 projectId 分组时会把不同 cwd 的 session 合并到一起。
    const shouldUseFallback = currentScore === 0 && preferredScore > 0;
    const finalProject = shouldUseFallback ? preferredProject : item.meta.project;
    const finalProjectId = shouldUseFallback
      ? preferredProjectId
      : canonicalizeProjectPath(item.meta.project) || preferredProjectId;

    if (item.meta.project === finalProject && item.meta.projectId === finalProjectId) {
      return item;
    }

    const updatedMeta = {
      ...item.meta,
      project: finalProject,
      projectId: finalProjectId,
    };
    persistMeta(updatedMeta);
    return {
      ...item,
      meta: updatedMeta,
    };
  });
}
