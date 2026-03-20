import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir } from "fs/promises";

const STORE_DIR = join(homedir(), ".chatlog-viewer");
const STORE_FILE = join(STORE_DIR, "titles.json");

type TitleMap = Record<string, string>;

async function loadTitles(): Promise<TitleMap> {
  try {
    const data = await readFile(STORE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return {};
  }
}

async function saveTitles(titles: TitleMap): Promise<void> {
  await mkdir(STORE_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(titles, null, 2), "utf-8");
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
