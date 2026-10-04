# 新增 Provider 规划：pi / codebuddy / workbuddy ＋ 已有三家优化

> 调研日期 2026-10-03。全部结论来自本机实测（~/.pi、~/.codebuddy、~/.workbuddy），非文档推测。
> 实现前请用户确认本规划。

## 1. 存储格式核实结论

### 1.1 pi（CLI，~/.pi/agent/sessions/）

- 目录结构：`sessions/<转义cwd>/<时间戳>_<uuid>.jsonl`，转义规则 `--D--DownloadFiles-code_area-r-bioinfo--`（首尾 `--` 去掉、`--` 还原为 `:`/`\`）。实测 6 文件共 694 行。
- 行类型：`session`（keys: type,version,id,timestamp,cwd）→ 元数据；`message`（616 行主体，`message:{role,content:[{type}]}`）；`thinking_level_change`、`model_change`（记录 modelId，如 kimi-k2.6 / gpt-5.6-luna / deepseek-v4-flash）、`custom`（customType 仅 plannotator:31、web-search-results:6，可忽略）、`custom_message`（subagent-slash-result）、`session_info`（name 字段即用户命名标题，仅 1/6 文件有）、`context_edit`（targetId+replacement，可忽略）。
- message shapes 约 20 种：`user:text`、`assistant:text/thinking/toolCall 组合`、`toolResult:text(+多段)`、`system:string`。thinking 块含加密 reasoning（encrypted_content），只取 text。
- 标题策略：`session_info.name` 优先（有则用），否则首条非 `<` 开头 user 文本截 100 字（过滤 skill 注入文本），否则 `未知对话`。
- 子会话：pi 无独立 subagent 文件（subagent 结果以内联 `custom_message` 存在），无需树状结构。

### 1.2 codebuddy（CLI，~/.codebuddy/projects/）

- 目录结构：`projects/<projectKey>/<sessionId>.jsonl`（主会话）＋ 同名子目录 `<sessionId>/subagents/agent-*.jsonl` ＋ `<sessionId>/tool-results/call_*-render.txt` ＋ `projects/<projectKey>/memory/*.md`。实测 11 主文件，仅 1 个带 subagent（2 个文件，agent 均为 statusline-setup）。
- 主文件行类型：`message:user/assistant`（content 为 input_text/output_text 数组）、`reasoning`、`function_call`（顶层 `name/callId/arguments(JSON字符串)`）、`function_call_result`（顶层 `name/callId/status/output`）、`ai-title`（`aiTitle` 中文标题，每文件最多 1 行，11 个中仅 1 个有）、`summary`（`/statusline` 类短文本）、`turn-metrics`、`file-history-snapshot`。无 session-meta 行。
- **subagent 关联键（已核实三段链）**：
  1. 主文件 `function_call` 行：`name:"Agent"` ＋ `callId`（如 call_b876accaf8ff4dabb5633c8c）；
  2. 对应 `function_call_result` 行：同 `callId`，`output.text` 含 `[Agent ID: agent-b4da7e339b764896]`（正则 `/resume="?(agent-[a-f0-9]+)"?/` 提取）；
  3. 子文件 `<parentSessionId>/subagents/agent-<hex>.jsonl`，首行 `providerData.agent`（如 statusline-setup，显示用）＋ `providerData.conversationRequestId`。注意子文件 `sessionId` 是独立新 ID（与父目录名不同），**关联只能走 output 文本里的 Agent ID，不能走 sessionId**。
- tool-results：`call_<hex>-render.txt` 为命令 stdout 存档，主文件不直接引用文件名（引用的是 callId），read 时可按需展开，list 阶段忽略。
- 标题策略：`ai-title` 行优先，否则首条 user 文本（过滤 `<system-reminder` 开头）截 100 字。
- 树状展示：`ConversationMeta.badges` 加 `{label:"子会话", tone:"indigo", title:"父会话:<id>"}`，主会话 badges 加 `{label:"含2个子会话", tone:"gray"}`。另给 subagent 的 meta 设 `projectKey` 与主会话相同使列表分在一起，前端按 badges 已可区分，无需改前端结构。

### 1.3 workbuddy（GUI，~/.workbuddy/）

- **消息正文已找到**：`projects/<projectKey>/<sessionId>.jsonl`（与 codebuddy 同构！行类型 `message:user/assistant`、`function_call(_result)`、`reasoning`、`ai-title`、`file-history-snapshot`、`resend-fork-notice`）。实测 543 行样例 user:29/assistant:99/fc:168。
- `workbuddy.db/sessions` 表只做索引用：id/cwd/title/custom_title（custom_title 优先）/status/created_at/updated_at/deleted_at/model。核实：DB 共 11 行，projects 下 jsonl 共 10 个，`2098317726158155776`（纯数字 ID，cwd 为空，deleted_at=-1）在 projects 无对应文件 → **DB 为准做软删除过滤**（deleted_at 非 null 即隐藏，-1 视为已删）。
- status 分布：completed:10、archived:1 → archived 用 badges 标记 `{label:"已归档", tone:"amber"}`。
- projects key 编码：`c-Users-...`（C 盘）、`d-...`（D 盘），首字母即盘符。
- 同目录 `.meta.json` 仅含 hostKind/acpConnectionId，无用；`.file-rollback.ndjson` 为文件回滚记录，无用。
- traces/ 目录为性能追踪（span 无消息文本），audit-log 为审计日志，均不纳入。
- 标题策略：DB `custom_title || title` 优先（GUI 可改名），缺失再读 jsonl 首 user 文本。

### 1.4 已有三家优化

- Codex：`codex-sqlite-client.ts` 已有 `getTableColumns/getRequiredThreadColumns` 列存在性检查（:132-159）＋ delete 级联表检查（:306-349）。**无需再改**，cometix 分叉风险已覆盖。
- OpenCode：全仓 grep 确认只读 `session/message/part`（v1 表），无 `session_v2` 引用。按用户要求**忽略 session_v2**，不加 warning（用户明确说忽略）。
- Claude Code：格式未变，无需改。

## 2. 实现清单（对标 claude/codex/opencode/iflow 全功能）

### 2.1 新文件（对标 claude-code/codex/opencode 完整能力矩阵）

三家新 provider 全部实现 `ConversationProvider` 接口全量方法（detect/list/getListSourceSignature/read/delete/move/updateTitle/updateMessage/deleteMessage(s)/listProjects/getStoragePath），capabilities 与 claude/codex/opencode 看齐：`titleSyncMode:"native", canUpdateTitle:true, canGenerateTitle:true, canEditMessage:true, canDeleteMessage:true, canMoveConversation:true, canDeleteConversation:true`。AI 生成标题经 `persistConversationTitle` 的 `provider.updateTitle` 分支自动写回原生存储，无需接 title-manager CLI。iflow 仅借作文件型代码脚手架（729 行最短），不照抄其禁用项。
- `packages/server/src/providers/codebuddy.ts` — CodeBuddyProvider（文件型 ＋ subagent 扫描：list 时对每个主会话读同名 `subagents/` 目录，为每个 agent-*.jsonl 生成一条 meta（id:`codebuddy:sub:<agentId>`，badges 标记父会话）；move/delete 主会话时连带 subagents 目录；updateTitle 重写 `ai-title` 行（无则追加））。
- `packages/server/src/providers/workbuddy.ts` — WorkBuddyProvider（DB+文件混合：list 读 `workbuddy.db/sessions` 过滤 deleted；read 读 `projects/<key>/<id>.jsonl`；delete 删 jsonl＋DB 行标 deleted_at；move 改 DB cwd＋搬 jsonl；updateTitle 写 DB custom_title（titleSyncMode:"native"）；updateMessage/deleteMessage 走 jsonl 行重写，与 iflow 同机制）。

### 2.2 接线修改

- `providers/types.ts`：不动（接口已够）。
- `utils/provider-paths.ts`：`ResolvedProviderName` 加 `"pi"|"codebuddy"|"workbuddy"`；各加 env 键（CHATLOG_VIEWER_PI_PATH / CODEBUDDY_PATH / WORKBUDDY_PATH）＋默认路径（~/.pi/agent/sessions、~/.codebuddy/projects、~/.workbuddy）＋候选构造；workbuddy 加 stateDb（workbuddy.db）。
- `routes/settings.ts`：RESOLVED_PROVIDER_NAMES 加三家；stateDb 允许名单加 workbuddy。
- `app.ts`：createDefaultProviders 加三家。
- 前端：`ConversationList.tsx`＋`Sidebar.tsx` 加三家徽标色（pi 紫、codebuddy 青、workbuddy 绿，具体色值待定）；`useBatchActions.ts` 批量守卫复核（默认仅 codex，新 provider 不进批量，无需改）。
- 测试：`provider-indexing.test.ts` 加三家 list/read 用例（用临时目录 fixture，不碰真实 ~/.数据）。

### 2.3 不做的事

- title-manager CLI 不新增三家：AI 生成标题复用现有 codex/claude/opencode CLI 生成文本，经各 provider 的 `updateTitle` 原生写回（`persistConversationTitle` 的 `provider.updateTitle` 分支），无需额外接线。
- export 路由通用，无需改。
- 豆包：本次不做（LevelDB spike 另排）。

## 3. 检查点与监控

- 检查点 1：pi provider 单测通过；检查点 2：codebuddy（含 subagent）单测通过；检查点 3：workbuddy 单测通过；检查点 4：全量 typecheck+lint+test。
- 每完成一个检查点汇报一次；测试失败或异常立即停下汇报，不擅自兜底。

## 4. 实现结果（2026-10-04 收尾）

- 落盘文件：`packages/server/src/providers/pi.ts`、`codebuddy.ts`、`workbuddy.ts`、`new-providers.test.ts`（6 用例：pi 列出/读/改标题/编辑/删消息/移动/删除，codebuddy 主子关联/标题写回/级联删移）。
- 接线：`app.ts` 注册 7 家；`provider-paths.ts` 加三家路径分支（含 workbuddy stateDb）；`settings.ts` 放行 workbuddy stateDb；前端 `ConversationList/Sidebar/ConversationViewer` 加三家徽标色与显示名。
- lint 收尾删除了三个无用函数：codebuddy 的 `AGENT_ID_RESUME_RE/AGENT_ID_BRACKET_RE/extractAgentIdFromText/collectReferencedAgentIds`（子会话关联走 subagents 目录文件名，无需解析 output 文本）；workbuddy 的 `collectIndexedCacheItemsInBatches` import（list 按 DB 行逐条构建，未走批量 loader）。workbuddy search-index 统一调 `appendSearchIndexEntry`，与全仓契约对齐。
- 验证：server 全量 test 19 组 pass/fail 全 0（含新 6 用例，EXIT:0）；server `tsc --noEmit` 通过；web `tsc --noEmit` 通过；`eslint` 指定文件 0 错误。
- 待用户手动：重启 dev server 验证页面。
