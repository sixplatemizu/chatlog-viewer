import { homedir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { runKeyedMutation } from "./mutation-queue.js";

type TitleMap = Record<string, string>;
export type TitleHistorySource = "chatlog-viewer" | "ai" | "cleanup";
export type TitleHistoryAction =
  | "set-overlay-title"
  | "set-native-title"
  | "delete-overlay-title"
  | "delete-native-title";

export interface TitleHistoryEntry {
  id: string;
  provider: string;
  action: TitleHistoryAction;
  source: TitleHistorySource;
  oldTitle: string | null;
  newTitle: string | null;
  createdAt: number;
}

export interface TitleMutationOptions {
  historySource?: TitleHistorySource;
  recordHistory?: boolean;
}

let storeDirOverride: string | null = null;

function getStoreDir(): string {
  const envOverride = process.env.CHATLOG_VIEWER_STORE_DIR?.trim();
  return storeDirOverride || envOverride || join(homedir(), ".chatlog-viewer");
}

function getStoreFile(fileName = "titles.json"): string {
  return join(getStoreDir(), fileName);
}

export function setTitleStoreDirForTests(storeDir?: string): void {
  storeDirOverride = storeDir?.trim() || null;
}

async function loadTitles(fileName?: string): Promise<TitleMap> {
  try {
    const data = await readFile(getStoreFile(fileName), "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveTitles(titles: TitleMap, fileName?: string): Promise<void> {
  const storeDir = getStoreDir();
  const targetFile = getStoreFile(fileName);
  const temporaryFile = `${targetFile}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(storeDir, { recursive: true });
  try {
    await writeFile(temporaryFile, JSON.stringify(titles, null, 2), "utf-8");
    await rename(temporaryFile, targetFile);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}

const NATIVE_TITLE_FILE = "native-titles.json";
const TITLE_HISTORY_FILE = "title-history.jsonl";

function getProviderName(id: string): string {
  return id.split(":", 1)[0] || "unknown";
}

async function appendTitleHistory(entry: Omit<TitleHistoryEntry, "provider" | "createdAt">): Promise<void> {
  const historyFile = getStoreFile(TITLE_HISTORY_FILE);
  await runKeyedMutation(historyFile, async () => {
    const storeDir = getStoreDir();
    const record: TitleHistoryEntry = {
      ...entry,
      provider: getProviderName(entry.id),
      createdAt: Date.now(),
    };
    await mkdir(storeDir, { recursive: true });
    await appendFile(historyFile, `${JSON.stringify(record)}\n`, "utf-8");
  });
}

export async function recordTitleHistory(
  entry: Omit<TitleHistoryEntry, "provider" | "createdAt">
): Promise<void> {
  if (entry.oldTitle === entry.newTitle) return;
  await appendTitleHistory(entry);
}

export async function getTitleHistory(id?: string): Promise<TitleHistoryEntry[]> {
  let data = "";
  try {
    data = await readFile(getStoreFile(TITLE_HISTORY_FILE), "utf-8");
  } catch {
    return [];
  }

  const entries = data
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as TitleHistoryEntry];
      } catch {
        return [];
      }
    });

  return id ? entries.filter((entry) => entry.id === id) : entries;
}

export async function getTitle(id: string): Promise<string | null> {
  const titles = await loadTitles();
  return titles[id] ?? null;
}

export async function setTitle(id: string, title: string, options: TitleMutationOptions = {}): Promise<void> {
  let oldTitle: string | null = null;
  await runKeyedMutation(getStoreFile(), async () => {
    const titles = await loadTitles();
    oldTitle = titles[id] ?? null;
    titles[id] = title;
    await saveTitles(titles);
  });
  if (options.recordHistory !== false && oldTitle !== title) {
    await appendTitleHistory({
      id,
      action: "set-overlay-title",
      source: options.historySource ?? "chatlog-viewer",
      oldTitle,
      newTitle: title,
    });
  }
}

export async function deleteTitle(id: string, options: TitleMutationOptions = {}): Promise<void> {
  let oldTitle: string | null = null;
  await runKeyedMutation(getStoreFile(), async () => {
    const titles = await loadTitles();
    oldTitle = titles[id] ?? null;
    delete titles[id];
    await saveTitles(titles);
  });
  if (options.recordHistory !== false && oldTitle !== null) {
    await appendTitleHistory({
      id,
      action: "delete-overlay-title",
      source: options.historySource ?? "cleanup",
      oldTitle,
      newTitle: null,
    });
  }
}

export async function getAllTitles(): Promise<TitleMap> {
  return loadTitles();
}

// 仅用于审计与诊断，不参与 native provider 的标题解析或写回。
export async function getNativeTitleSnapshot(id: string): Promise<string | null> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  return titles[id] ?? null;
}

export async function setNativeTitleSnapshot(
  id: string,
  title: string,
  options: TitleMutationOptions = {}
): Promise<void> {
  let oldTitle: string | null = null;
  await runKeyedMutation(getStoreFile(NATIVE_TITLE_FILE), async () => {
    const titles = await loadTitles(NATIVE_TITLE_FILE);
    oldTitle = titles[id] ?? null;
    titles[id] = title;
    await saveTitles(titles, NATIVE_TITLE_FILE);
  });
  if (options.recordHistory !== false && oldTitle !== title) {
    await appendTitleHistory({
      id,
      action: "set-native-title",
      source: options.historySource ?? "chatlog-viewer",
      oldTitle,
      newTitle: title,
    });
  }
}

export async function deleteNativeTitleSnapshot(
  id: string,
  options: TitleMutationOptions = {}
): Promise<void> {
  let oldTitle: string | null = null;
  await runKeyedMutation(getStoreFile(NATIVE_TITLE_FILE), async () => {
    const titles = await loadTitles(NATIVE_TITLE_FILE);
    oldTitle = titles[id] ?? null;
    delete titles[id];
    await saveTitles(titles, NATIVE_TITLE_FILE);
  });
  if (options.recordHistory !== false && oldTitle !== null) {
    await appendTitleHistory({
      id,
      action: "delete-native-title",
      source: options.historySource ?? "cleanup",
      oldTitle,
      newTitle: null,
    });
  }
}
