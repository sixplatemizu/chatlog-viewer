import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

type TitleMap = Record<string, string>;
type NativeTitleSyncSource = "chatlog-viewer" | "codex";

export interface NativeTitleSyncRecord {
  title: string;
  lastNativeTitle: string;
  updatedAt: number;
  source: NativeTitleSyncSource;
}

type NativeTitleSyncMap = Record<string, NativeTitleSyncRecord>;
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
  await mkdir(storeDir, { recursive: true });
  await writeFile(getStoreFile(fileName), JSON.stringify(titles, null, 2), "utf-8");
}

export async function getTitle(id: string): Promise<string | null> {
  const titles = await loadTitles();
  return titles[id] ?? null;
}

export async function setTitle(id: string, title: string): Promise<void> {
  const titles = await loadTitles();
  titles[id] = title;
  await saveTitles(titles);
}

export async function deleteTitle(id: string): Promise<void> {
  const titles = await loadTitles();
  delete titles[id];
  await saveTitles(titles);
}

export async function getAllTitles(): Promise<TitleMap> {
  return loadTitles();
}

const NATIVE_TITLE_FILE = "native-titles.json";
const NATIVE_TITLE_SYNC_FILE = "native-title-sync.json";

export async function getNativeTitle(id: string): Promise<string | null> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  return titles[id] ?? null;
}

async function loadNativeTitleSync(): Promise<NativeTitleSyncMap> {
  try {
    const data = await readFile(getStoreFile(NATIVE_TITLE_SYNC_FILE), "utf-8");
    return JSON.parse(data) as NativeTitleSyncMap;
  } catch {
    return {};
  }
}

async function saveNativeTitleSync(records: NativeTitleSyncMap): Promise<void> {
  const storeDir = getStoreDir();
  await mkdir(storeDir, { recursive: true });
  await writeFile(getStoreFile(NATIVE_TITLE_SYNC_FILE), JSON.stringify(records, null, 2), "utf-8");
}

async function setNativeTitleSyncRecord(
  id: string,
  title: string,
  source: NativeTitleSyncSource
): Promise<void> {
  const records = await loadNativeTitleSync();
  records[id] = {
    title,
    lastNativeTitle: title,
    updatedAt: Date.now(),
    source,
  };
  await saveNativeTitleSync(records);
}

export async function getNativeTitleSyncRecord(id: string): Promise<NativeTitleSyncRecord | null> {
  const records = await loadNativeTitleSync();
  const record = records[id];
  if (record) return record;

  const titles = await loadTitles(NATIVE_TITLE_FILE);
  const legacyTitle = titles[id]?.trim();
  if (!legacyTitle) return null;

  return {
    title: legacyTitle,
    lastNativeTitle: legacyTitle,
    updatedAt: 0,
    source: "chatlog-viewer",
  };
}

export async function setNativeTitle(id: string, title: string): Promise<void> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  titles[id] = title;
  await saveTitles(titles, NATIVE_TITLE_FILE);
  await setNativeTitleSyncRecord(id, title, "chatlog-viewer");
}

export async function setCodexObservedNativeTitle(id: string, title: string): Promise<void> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  titles[id] = title;
  await saveTitles(titles, NATIVE_TITLE_FILE);
  await setNativeTitleSyncRecord(id, title, "codex");
}

export async function markNativeTitleSynced(id: string, title: string): Promise<void> {
  await setNativeTitleSyncRecord(id, title, "chatlog-viewer");
}

export async function deleteNativeTitle(id: string): Promise<void> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  delete titles[id];
  await saveTitles(titles, NATIVE_TITLE_FILE);
  const records = await loadNativeTitleSync();
  delete records[id];
  await saveNativeTitleSync(records);
}
