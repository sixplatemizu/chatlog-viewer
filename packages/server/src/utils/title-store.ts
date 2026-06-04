import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

type TitleMap = Record<string, string>;
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

export async function getNativeTitle(id: string): Promise<string | null> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  return titles[id] ?? null;
}

export async function setNativeTitle(id: string, title: string): Promise<void> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  titles[id] = title;
  await saveTitles(titles, NATIVE_TITLE_FILE);
}

export async function deleteNativeTitle(id: string): Promise<void> {
  const titles = await loadTitles(NATIVE_TITLE_FILE);
  delete titles[id];
  await saveTitles(titles, NATIVE_TITLE_FILE);
}
