// 统一数据模型

export interface ConversationReadOptions {
  before?: number;
  limit?: number;
}

export interface ConversationListOptions {
  eagerSearchIndex?: boolean;
}

export interface ConversationProvider {
  name: string;
  displayName: string;
  detect(): Promise<boolean>;
  list(options?: ConversationListOptions): Promise<ConversationMeta[]>;
  read(id: string, options?: ConversationReadOptions): Promise<Conversation>;
  delete(id: string): Promise<void>;
  move?(id: string, targetProjectKey: string): Promise<void>;
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
  project: string;         // 显示用的可读路径（来自 cwd）
  projectKey: string;       // 分组用的 key（来自文件夹名，保证同项目一致）
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
