import type { ConversationProvider, Conversation } from "./types.js";

// OpenCode - experimental，SQLite 存储
export class OpenCodeProvider implements ConversationProvider {
  name = "opencode";
  displayName = "OpenCode (实验性)";

  getStoragePath(): string {
    return "";
  }

  async detect(): Promise<boolean> {
    return false;
  }

  async list() {
    return [];
  }

  async read(_id: string): Promise<Conversation> {
    throw new Error("OpenCode provider 尚未实现");
  }

  async delete(_id: string): Promise<void> {
    throw new Error("OpenCode provider 尚未实现");
  }
}
