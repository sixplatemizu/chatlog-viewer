import { ClaudeCodeProvider } from "./src/providers/claude-code.js";

const provider = new ClaudeCodeProvider({
  storagePath: "C:\\Users\\mortis097\\.claude\\projects",
});

console.log("Listing Claude Code conversations...");
const conversations = await provider.list();
console.log("Total conversations:", conversations.total);
console.log("First 3:", JSON.stringify(conversations.conversations.slice(0, 3), null, 2));
