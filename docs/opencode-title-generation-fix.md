# OpenCode 标题生成问题记录

日期：2026-05-17

## 背景

本次排查涉及两个现象：

1. Codex 0.130.0 下，UI 能看到旧 Codex 会话，但 Codex `/resume` 默认列表只显示最新会话。
2. ChatLog Viewer 调用 OpenCode 生成标题时，OpenCode 进程退出码为 0，但 `stdout=0B stderr=0B`，最终标题为空。

## Codex /resume 结论

旧 Codex 会话在 `~/.codex/state_5.sqlite` 中仍然存在，transcript 文件也存在。UI 能看到这些记录，是因为 ChatLog Viewer 会同时读取 transcript 和 state db。

Codex 0.130.0 的 `/resume` 默认筛选逻辑更严格，`codex resume --help` 中出现了：

```text
--include-non-interactive
Include non-interactive sessions in the resume picker and --last selection
```

旧记录的关键字段类似：

```text
cli_version = 0.114.0 / 0.116.0
thread_source = NULL
session_meta.originator = codex_cli_rs
cwd = d:\downloadfiles\code_area
```

新记录的关键字段类似：

```text
cli_version = 0.130.0
thread_source = user
session_meta.originator = codex-tui
cwd = \\?\D:\DownloadFiles\code_area
```

因此，0.130.0 很可能把旧记录归类为 non-interactive 或 legacy session，默认 `/resume` picker 不显示。降级到 Codex 0.120.0 后该问题消失，说明 0.120.0 对旧格式记录仍然兼容，或尚未启用这类严格筛选。

本次没有继续修改 Codex state db，也没有保留任何未完成的 Codex 迁移代码。

## OpenCode 问题根因

原实现中，所有 AI CLI 都运行在固定标题会话目录：

```text
~/.chatlog-viewer/ai-title-sessions/<cli>
```

对 OpenCode 来说，在以下目录直接运行会复现空输出：

```text
~/.chatlog-viewer/ai-title-sessions/opencode
```

实际表现：

```text
opencode 退出 code=0 stdout=0B stderr=0B
```

但在真实项目目录，或显式传入 `--dir <真实项目目录>` 时，OpenCode 可以正常输出 JSON events。因此问题不是 OpenCode 完全不可用，而是 ChatLog Viewer 调用 OpenCode 时没有给它明确的项目目录，导致 OpenCode 在标题 session 目录下静默结束。

另外还发现一个提取逻辑问题：如果 OpenCode JSON 输出中只有 `step_start` 等状态事件，旧逻辑可能把 `step-start` 当作标题。现在已经避免这种误判。

## 本次修改

### 1. OpenCode 调用增加项目目录

文件：`packages/server/src/utils/ai.ts`

为 OpenCode 配置增加 `projectDirArg: "--dir"`。生成标题时，如果调用方提供 `projectDir`，最终命令形态为：

```text
opencode run --dir <conversation.project> --format json -- <prompt>
```

这样 OpenCode 不再只依赖 `~/.chatlog-viewer/ai-title-sessions/opencode` 作为工作目录。

### 2. 路由传入真实对话项目路径

文件：`packages/server/src/routes/conversations.ts`

单条标题生成和批量标题生成都会把 `conversation.project` 传给 `generateTitle`：

```ts
generateTitle(buildTitleGenerationMessages(conversation), {
  priority: getTitleGenerationCliPriority(),
  reuseSession: getTitleGenerationCliSessionReuse(),
  projectDir: conversation.project,
});
```

### 3. 空输出变成可诊断错误

文件：`packages/server/src/utils/ai.ts`

如果 CLI 退出码为 0 但没有任何输出，现在会抛出包含 `cwd` 和 `dir` 的错误，例如：

```text
opencode 未产生输出（cwd=..., dir=D:/DownloadFiles/code_area）
```

这比旧的“输出为空或格式无效”更容易定位问题。

### 4. OpenCode JSON 提取更严格

文件：`packages/server/src/utils/ai.ts`

现在 JSON 输出只接受真正的文本事件：

```json
{"type":"text","part":{"type":"text","text":"标题"}}
```

如果输出只有 `step_start` / `step-start` 等状态事件，会被视为无有效标题，不会误提取成标题。

### 5. OpenCode 无有效标题时自动回退目录

文件：`packages/server/src/utils/ai.ts`

如果 OpenCode 在 `conversation.project` 下有输出但没有有效标题，会自动回退到当前 server 工作目录再试一次。真实验证中，部分目录只返回 `step_start`，回退后可以得到正常 `text` 标题事件。

### 6. 新增测试

文件：`packages/server/src/utils/__tests__/ai.test.ts`

新增覆盖：

- OpenCode 生成标题时会显式传入 `--dir <projectDir>`。
- OpenCode 空输出会返回可诊断错误。
- OpenCode JSON 状态事件不会被误提取为标题。

## 验证结果

已执行并通过：

```text
pnpm --filter server exec tsx src/utils/__tests__/ai.test.ts
pnpm --filter server test
pnpm typecheck
pnpm build
```

还用真实 OpenCode 做过源码级验证，结果能生成正常标题，例如：

```text
分析OpenCode标题生成为空的原因
OpenCode标题为空原因分析
```

## 当前状态

OpenCode 现在可以用于 ChatLog Viewer 的 AI 标题生成。

本次最终保留的代码修改集中在：

```text
packages/server/src/utils/ai.ts
packages/server/src/routes/conversations.ts
packages/server/src/utils/__tests__/ai.test.ts
```

没有保留 Codex state db 迁移相关代码，也没有修改用户本地 `~/.codex/state_5.sqlite`。

## 后续注意

1. 如果未来 OpenCode 再次出现空输出，优先查看日志中的 `cwd` 和 `dir`。
2. 如果某个目录下 OpenCode 只输出 `step_start`，说明该目录初始化或 agent/model 行为可能异常，目录回退逻辑会尝试兜底。
3. Codex `/resume` 旧记录显示问题与 OpenCode 标题生成不是同一个根因。若以后重新升级到 Codex 0.130.0 或更高版本，需要单独处理旧 Codex thread 的 resume 兼容迁移。
