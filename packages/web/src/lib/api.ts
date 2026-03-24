const BASE = "/api";

export class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(message: string, status: number, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.details = details;
  }
}

function extractApiErrorMessage(details: unknown, fallback: string): string {
  if (
    details &&
    typeof details === "object" &&
    "error" in details &&
    typeof (details as { error?: unknown }).error === "string"
  ) {
    return (details as { error: string }).error;
  }

  return fallback;
}

async function createApiError(res: Response): Promise<ApiError> {
  const fallback = `请求失败 (${res.status})`;
  const contentType = res.headers.get("content-type") || "";

  try {
    if (contentType.includes("application/json")) {
      const details = await res.json();
      return new ApiError(extractApiErrorMessage(details, fallback), res.status, details);
    }

    const text = (await res.text()).trim();
    return new ApiError(text || fallback, res.status);
  } catch {
    return new ApiError(fallback, res.status);
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw await createApiError(res);
  return res.json() as Promise<T>;
}

async function requestBlob(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, init);
  if (!res.ok) throw await createApiError(res);
  return res;
}

export function getErrorMessage(error: unknown, fallback = "请求失败"): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export interface ProviderInfo {
  name: string;
  displayName: string;
  available: boolean;
  storagePath: string;
}

export type ProviderPathSource = "env" | "config" | "auto" | "default";

export interface ProviderPathInfo {
  name: string;
  displayName: string;
  configuredStoragePath?: string;
  configuredStateDbPath?: string;
  storagePath: string;
  storageExists: boolean;
  storageSource: ProviderPathSource;
  stateDbPath?: string;
  stateDbExists?: boolean;
  stateDbSource?: ProviderPathSource;
}

export interface ProviderPathSettings {
  configPath: string;
  providers: ProviderPathInfo[];
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
  fileSize: number;
  filePath: string;
  modelProvider?: string;
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
  hasMore?: boolean;
}

export interface ConversationListResponse {
  total: number;
  conversations: ConversationMeta[];
  partialSearch?: boolean;
  warnings?: string[];
}

export async function fetchProviders(signal?: AbortSignal): Promise<ProviderInfo[]> {
  return requestJson<ProviderInfo[]>(`${BASE}/providers`, { signal });
}

export async function fetchProviderPathSettings(signal?: AbortSignal): Promise<ProviderPathSettings> {
  return requestJson<ProviderPathSettings>(`${BASE}/settings/provider-paths`, { signal });
}

export async function updateProviderPathSettings(payload: {
  providers: Record<string, { storagePath?: string | null; stateDbPath?: string | null }>;
}): Promise<ProviderPathSettings> {
  return requestJson<ProviderPathSettings>(`${BASE}/settings/provider-paths`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

export async function fetchConversations(params: {
  provider?: string;
  search?: string;
  sort?: string;
  modelProvider?: string;
  signal?: AbortSignal;
}): Promise<ConversationListResponse> {
  const qs = new URLSearchParams();
  if (params.provider) qs.set("provider", params.provider);
  if (params.search) qs.set("search", params.search);
  if (params.sort) qs.set("sort", params.sort);
  if (params.modelProvider !== undefined) qs.set("modelProvider", params.modelProvider);
  return requestJson<ConversationListResponse>(
    `${BASE}/conversations?${qs}`,
    { signal: params.signal }
  );
}

export async function fetchConversation(
  id: string,
  options?: {
    before?: number;
    limit?: number;
    signal?: AbortSignal;
  }
): Promise<Conversation> {
  const qs = new URLSearchParams();
  if (options?.limit !== undefined) qs.set("limit", String(options.limit));
  if (options?.before !== undefined) qs.set("before", String(options.before));
  const suffix = qs.size > 0 ? `?${qs}` : "";

  return requestJson<Conversation>(`${BASE}/conversations/${encodeURIComponent(id)}${suffix}`, {
    signal: options?.signal,
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await requestJson<{ success: boolean }>(`${BASE}/conversations/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export interface ExportFailure {
  id: string;
  error: string;
}

export interface ExportMeta {
  requested: number;
  exported: number;
  failed: number;
  failures: ExportFailure[];
}

export interface ExportResult {
  blob: Blob;
  meta?: ExportMeta;
}

export async function exportConversations(
  ids: string[],
  format: "json" | "markdown"
): Promise<ExportResult> {
  const res = await requestBlob(`${BASE}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids, format }),
  });

  const blob = await res.blob();
  const metaHeader = res.headers.get("X-Export-Meta");
  let meta: ExportMeta | undefined;

  if (metaHeader) {
    try {
      const decoded = typeof atob === "function"
        ? atob(metaHeader.replace(/-/g, "+").replace(/_/g, "/"))
        : "";
      meta = decoded ? JSON.parse(decoded) as ExportMeta : undefined;
    } catch {
      meta = undefined;
    }
  }

  return { blob, meta };
}

export async function updateTitle(
  id: string,
  title: string
): Promise<{ success: boolean; title: string }> {
  return requestJson<{ success: boolean; title: string }>(
    `${BASE}/conversations/${encodeURIComponent(id)}/title`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    }
  );
}

export async function generateAiTitle(
  id: string
): Promise<{ success: boolean; title: string; usedCli: string; error?: string }> {
  return requestJson<{ success: boolean; title: string; usedCli: string; error?: string }>(
    `${BASE}/conversations/${encodeURIComponent(id)}/generate-title`,
    { method: "POST" }
  );
}

export interface AvailableCliInfo {
  name: string;
  hasSession: boolean;
}

export async function fetchAvailableClis(): Promise<AvailableCliInfo[]> {
  return requestJson<AvailableCliInfo[]>(`${BASE}/ai/clis`);
}

export interface ProjectInfo {
  provider: string;
  projectKey: string;
  displayName: string;
}

export async function fetchProjects(provider?: string): Promise<ProjectInfo[]> {
  const qs = provider ? `?provider=${provider}` : "";
  return requestJson<ProjectInfo[]>(`${BASE}/projects${qs}`);
}

export async function moveConversation(
  id: string,
  targetProjectKey: string
): Promise<{ success: boolean; error?: string }> {
  return requestJson<{ success: boolean; error?: string }>(
    `${BASE}/conversations/${encodeURIComponent(id)}/move`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectKey }),
    }
  );
}

export interface CodexModelProvider {
  name: string;
  count: number;
}

export async function fetchCodexProviders(signal?: AbortSignal): Promise<CodexModelProvider[]> {
  return requestJson<CodexModelProvider[]>(`${BASE}/codex-providers`, { signal });
}

export async function changeModelProvider(
  id: string,
  modelProvider: string
): Promise<{ success: boolean; error?: string }> {
  return requestJson<{ success: boolean; error?: string }>(
    `${BASE}/conversations/${encodeURIComponent(id)}/model-provider`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelProvider }),
    }
  );
}
