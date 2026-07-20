import { spawnSync } from "node:child_process";
import { globSync } from "glob";

const testFiles = globSync("src/**/*.test.ts").sort();

if (testFiles.length === 0) {
  console.error("未找到测试文件");
  process.exit(1);
}

for (const testFile of testFiles) {
  const result = spawnSync(process.execPath, [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    testFile,
  ], {
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

process.exit(0);
