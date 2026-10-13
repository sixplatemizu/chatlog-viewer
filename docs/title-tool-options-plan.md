# 生成标题 model/agent/variant 透传调研规划（2026-10-07）

> 用户批准执行。目标：`chatview-title generate[-batch]` 可指定生成方
> agent / 模型 / 思考强度，例如 opencode + `opencode/exo-free` + high
> 重命名最近 15 条 opencode 对话。

## 现状（源码+help 实测）
- CLI：`title-manager.ts:282-303` 只有 `--cli/--timeout/--retries/
  --fresh/--reuse-session`，无 `--model/--agent/--variant`。
- 服务：`conversation-title.ts:47` 的 `GenerateConversationTitleOptions`
  只有 priority/timeoutMs/retries/reuseSession/availableCliNames。
- 执行：`ai/impl.ts:12-22` 的 `CliTool` 只有固定 args；
  opencode freshArgs 写死 `run --title ChatView AI Title --format json
  -- __PROMPT__`（`:51`），无插入点。
- 路由：`conversations.ts:604,639` 两处 `generate-title` 未传任何
  model/agent/variant，直连默认。
- 生成 CLI 与目标 provider 解耦：`--cli opencode` 锁定生成方，
  `--provider opencode --limit 15` 取最近 15 条（按 updatedAt 倒序
  slice，`title-manager.ts:489-490`）。

## 三家 CLI 参数位（help 实测）
- opencode run：`-m/--model`、`--agent`、`--variant`（reasoning
  effort，provider-specific）、`--title/--format/--dir/--session`。
  `opencode models` 含 `opencode/exo-free`。`--variant high` 是否被
  exo-free 接受需实测，不接受会报错走重试/失败。
- codex exec：`-m/--model` 有，`-c model="o3"` 也可；无 agent/variant
  对应位。思考强度走 `-c` 配置覆盖。
- claude：`--model`、`--agent`、`--effort <low|medium|high|xhigh|max>`
  有；当前 freshArgs 为 `-p ""`，ephemeral 为
  `--no-session-persistence -p ""`（`ai/impl.ts:40-44`）。

## 实现方案（4 文件）
1. `ai/impl.ts`：`CliTool` 加可选 `modelArgs?/agentArgs?/variantArgs?`
   映射（opencode `-m/--agent/--variant`；codex `-m`；claude
   `--model/--agent/--effort`），`GenerateTitleOptions` 加
   `toolOptions?: { model?; agent?; variant? }`，`runCliTool` 拼装。
2. `conversation-title.ts`：`GenerateConversationTitleOptions` 加同名
   三字段并下传。
3. `title-manager.ts`：加 `--model/--agent/--variant` 解析，
   `buildGenerateOptions` 透传，help + 示例同步。
4. skill：`chatview-title/SKILL.md` 命令矩阵与 JSON 示例同步。

## 验证
- typecheck 双包 + 全量 test + eslint。
- 实测：`generate-batch --provider opencode --limit 15 --cli opencode
  --model opencode/exo-free --variant high` dry-run 先行，确认
  variant 被接受后再实跑。

## 进展
- [x] 调研（链路+三家参数位）
- [x] 实现（impl/service/CLI/index/test/skill）
- [x] 全量验证（server test 全过、双包 typecheck、eslint）
- [x] exo-free/high 15 条实测（首轮 12/15，3 条超时；120s 重试 3/3 成功；坏标题 1 条已 rename 修复）
