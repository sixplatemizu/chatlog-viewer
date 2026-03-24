import { spawnSync } from "node:child_process";
import { globSync } from "glob";

const testFiles = globSync("src/**/*.test.ts").sort();

if (testFiles.length === 0) {
  console.error("未找到测试文件");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
