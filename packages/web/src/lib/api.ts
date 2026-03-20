const BASE = "/api";

export interface ProviderInfo {
  name: string;
  displayName: string;
  available: boolean;
  storagePath: string;
}

export interface ConversationMeta {
  id: string;
  provider: string;
  title: string;
  project: string;
  projectKey: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  filePath: string;
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}

export interface Conversation extends ConversationMeta {
  messages: Message[];
}

export async function fetchProviders(): Promise<ProviderInfo[]> {
  const res = await fetch(`${BASE}/providers`);
  return res.json();
}

export async function fetchConversations(params: {
  provider?: string;
  search?: string;
  sort?: string;
}): Promise<{ total: number; conversations: ConversationMeta[] }> {
  const qs = new URLSearchParams();
  if (params.provider) qs.set("provider", params.provider);
  if (params.search) qs.set("search", params.search);
  if (params.sort) qs.set("sort", params.sort);
  const res = await fetch(`${BASE}/conversations?${qs}`);
  return res.json();
}

export async function fetchConversation(id: string): Promise<Conversation> {
  const res = await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`);
  return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export async function exportConversations(
  ids: string[],
  format: "json" | "markdown"
): Promise<Blob> {
  const res = await fetch(`${BASE}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, format }),
  });
  return res.blob();
}

export async function updateTitle(
  id: string,
  title: string
): Promise<{ success: boolean; title: string }> {
  const res = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/title`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }
  );
  return res.json();
}

export async function generateAiTitle(
  id: string
): Promise<{ success: boolean; title: string; usedCli: string; error?: string }> {
  const res = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/generate-title`,
    { method: "POST" }
  );
  return res.json();
}

export async function fetchAvailableClis(): Promise<string[]> {
  const res = await fetch(`${BASE}/ai/clis`);
  return res.json();
}

export interface ProjectInfo {
  provider: string;
  projectKey: string;
  displayName: string;
}

export async function fetchProjects(provider?: string): Promise<ProjectInfo[]> {
  const qs = provider ? `?provider=${provider}` : "";
  const res = await fetch(`${BASE}/projects${qs}`);
  return res.json();
}

export async function moveConversation(
  id: string,
  targetProjectKey: string
): Promise<{ success: boolean; error?: string }> {
  const res = await fetch(
    `${BASE}/conversations/${encodeURIComponent(id)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectKey }),
    }
  );
  return res.json();
}
