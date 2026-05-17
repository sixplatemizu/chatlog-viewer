import { getProviderPaths } from "./src/utils/provider-paths.js";

const providers = ["claude-code", "codex", "opencode", "iflow"];

for (const name of providers) {
  const paths = getProviderPaths(name);
  console.log(name + ":");
  console.log("  storagePath:", paths.storagePath);
  console.log("  storageExists:", paths.storageExists);
  console.log("  storageSource:", paths.storageSource);
  if (paths.stateDbPath) {
    console.log("  stateDbPath:", paths.stateDbPath);
    console.log("  stateDbExists:", paths.stateDbExists);
  }
  console.log();
}
