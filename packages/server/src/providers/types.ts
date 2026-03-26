// 统一数据模型

export interface ConversationReadOptions {
  before?: number;
  limit?: number;
}

export interface ConversationListOptions {
  eagerSearchIndex?: boolean;
}

export type TitleSyncMode = "native" | "overlay";

export interface ConversationProviderCapabilities {
  titleSyncMode?: TitleSyncMode;
  canUpdateTitle?: boolean;
  canGenerateTitle?: boolean;
  updateTitleDisabledReason?: string;
  generateTitleDisabledReason?: string;
}

export interface ConversationCapabilities {
  canUpdateTitle: boolean;
  canGenerateTitle: boolean;
  updateTitleDisabledReason?: string;
  generateTitleDisabledReason?: string;
}

export interface ConversationProvider {
  name: string;
  displayName: string;
  capabilities?: ConversationProviderCapabilities;
  detect(): Promise<boolean>;
  list(options?: ConversationListOptions): Promise<ConversationMeta[]>;
  getListSourceSignature?(): Promise<string | null>;
  read(id: string, options?: ConversationReadOptions): Promise<Conversation>;
  delete(id: string): Promise<void>;
  move?(id: string, targetProjectKey: string): Promise<void>;
  updateTitle?(id: string, title: string): Promise<void>;
  updateMessage?(id: string, messageId: string, content: string): Promise<void>;
  deleteMessage?(id: string, messageId: string): Promise<void>;
  deleteMessages?(id: string, messageIds: string[]): Promise<void>;
  listProjects?(): Promise<string[]>;
  getStoragePath(): string;
}

export interface ConversationMeta {
  id: string;
  provider: string;
  title: string;
  titleSyncMode?: TitleSyncMode;
  capabilities?: ConversationCapabilities;
  project: string;          // 显示用的可读路径（优先来自 cwd）
  projectKey: string;       // provider 内部项目 key（用于移动或定位存储目录）
  projectId?: string;       // 稳定分组 identity（优先规范化 cwd，缺失时退回 projectKey）
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  fileSize: number;         // 文件体积（字节）
  filePath: string;
  modelProvider?: string;   // Codex 的 model_provider（如 right、custom 等）
}

export interface Conversation extends ConversationMeta {
  messages: Message[];
  hasMore?: boolean;
}

export interface Message {
  messageId?: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
  editable?: boolean;
  deletable?: boolean;
}
