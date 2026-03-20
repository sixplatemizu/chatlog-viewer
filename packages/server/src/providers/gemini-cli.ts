import type { ConversationProvider, Conversation } from "./types.js";

// Gemini CLI - experimental，待确认格式
export class GeminiProvider implements ConversationProvider {
  name = "gemini-cli";
  displayName = "Gemini CLI (实验性)";

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
    throw new Error("Gemini CLI provider 尚未实现");
  }

  async delete(_id: string): Promise<void> {
    throw new Error("Gemini CLI provider 尚未实现");
  }
}
