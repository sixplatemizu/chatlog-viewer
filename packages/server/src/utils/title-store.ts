import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

type TitleMap = Record<string, string>;
let storeDirOverride: string | null = null;

function getStoreDir(): string {
  const envOverride = process.env.CHATLOG_VIEWER_STORE_DIR?.trim();
  return storeDirOverride || envOverride || join(homedir(), ".chatlog-viewer");
}

function getStoreFile(): string {
  return join(getStoreDir(), "titles.json");
}

export function setTitleStoreDirForTests(storeDir?: string): void {
  storeDirOverride = storeDir?.trim() || null;
}

async function loadTitles(): Promise<TitleMap> {
  try {
    const data = await readFile(getStoreFile(), "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveTitles(titles: TitleMap): Promise<void> {
  const storeDir = getStoreDir();
  await mkdir(storeDir, { recursive: true });
  await writeFile(getStoreFile(), JSON.stringify(titles, null, 2), "utf-8");
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
