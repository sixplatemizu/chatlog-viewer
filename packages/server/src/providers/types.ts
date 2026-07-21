// 统一数据模型

export interface ConversationReadOptions {
  before?: number;
  limit?: number;
}

export interface ConversationListOptions {
  eagerSearchIndex?: boolean;
  onWarning?: (message: string) => void;
}

export type TitleSyncMode = "native" | "overlay";

export interface ConversationProviderCapabilities {
  titleSyncMode?: TitleSyncMode;
  canUpdateTitle?: boolean;
  canGenerateTitle?: boolean;
  canEditMessage?: boolean;
  canDeleteMessage?: boolean;
  canMoveConversation?: boolean;
  canDeleteConversation?: boolean;
  supportsMetadataOnly?: boolean;
  updateTitleDisabledReason?: string;
  generateTitleDisabledReason?: string;
  editMessageDisabledReason?: string;
  deleteMessageDisabledReason?: string;
  moveConversationDisabledReason?: string;
  deleteConversationDisabledReason?: string;
}

export interface ConversationCapabilities {
  canUpdateTitle: boolean;
  canGenerateTitle: boolean;
  canEditMessage: boolean;
  canDeleteMessage: boolean;
  canMoveConversation: boolean;
  canDeleteConversation: boolean;
  supportsMetadataOnly: boolean;
  updateTitleDisabledReason?: string;
  generateTitleDisabledReason?: string;
  editMessageDisabledReason?: string;
  deleteMessageDisabledReason?: string;
  moveConversationDisabledReason?: string;
  deleteConversationDisabledReason?: string;
}

export interface ConversationProvider {
  name: string;
  displayName: string;
  capabilities?: ConversationProviderCapabilities;
  detect(): Promise<boolean>;
  list(options?: ConversationListOptions): Promise<ConversationMeta[]>;
  getListSourceSignature?(options?: ConversationListOptions): Promise<string | null>;
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

export type ConversationContentStatus = "full" | "history-only" | "metadata-only";

export type ConversationBadgeTone = "gray" | "blue" | "cyan" | "amber" | "rose" | "indigo" | "green";

export interface ConversationBadge {
  label: string;
  tone?: ConversationBadgeTone;
  title?: string;
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
  transcriptMissing?: boolean;
  contentStatus?: ConversationContentStatus; // 当前能提供的内容层级：完整 transcript、history 回退或仅 metadata
  titleGenerationHint?: string; // transcript 缺失时用于 AI 标题生成的元数据提示
  cleanupCandidate?: boolean; // 标记为可直接清理的残留记录，不等于 metadata-only
  badges?: ConversationBadge[]; // 展示原始记录状态，例如非 TUI 默认可切换、子会话、归档等
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
