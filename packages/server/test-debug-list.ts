import { ClaudeCodeProvider } from "./src/providers/claude-code.js";
import { hasFreshIndexedListCache, queryConversationIndex } from "./src/utils/cache.js";

const provider = new ClaudeCodeProvider({
  storagePath: "C:\\Users\\mortis097\\.claude\\projects",
});

function getProviderListCacheKey(p: { name: string }): string {
  return `${p.name}::list`;
}

console.log("1. Testing detect()...");
const isAvailable = await provider.detect();
console.log("   detect() result:", isAvailable);

console.log("\n2. Testing list() directly...");
const conversations = await provider.list({ eagerSearchIndex: false });
console.log("   list() returned:", Array.isArray(conversations) ? conversations.length + " items" : typeof conversations);
if (Array.isArray(conversations) && conversations.length > 0) {
  console.log("   First item:", JSON.stringify(conversations[0], null, 2));
}

console.log("\n3. Testing cache...");
const cacheKey = getProviderListCacheKey(provider);
console.log("   cacheKey:", cacheKey);
const hasCache = hasFreshIndexedListCache(cacheKey, undefined, { requireSearchReady: false });
console.log("   hasFreshIndexedListCache:", hasCache);

if (hasCache) {
  console.log("\n4. Querying cache...");
  const cached = queryConversationIndex({ cacheKeys: [cacheKey], search: undefined, sort: "updatedAt" });
  console.log("   cached items:", cached.length);
  if (cached.length > 0) {
    console.log("   First cached:", JSON.stringify(cached[0], null, 2));
  }
}
