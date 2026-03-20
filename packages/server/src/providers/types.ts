// 统一数据模型

export interface ConversationProvider {
  name: string;
  displayName: string;
  detect(): Promise<boolean>;
  list(): Promise<ConversationMeta[]>;
  read(id: string): Promise<Conversation>;
  delete(id: string): Promise<void>;
  move?(id: string, targetProjectKey: string): Promise<void>;
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
}

export interface Conversation extends ConversationMeta {
  messages: Message[];
}

export interface Message {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  timestamp?: number;
  toolName?: string;
  toolInput?: string;
  toolResult?: string;
}
