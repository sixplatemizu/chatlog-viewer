# 项目状态参考 — 2026-05-19

本文档为某轮对话结束时的项目快照，记录当时的功能完成度、已修 bug、未审查范围与运维要点，便于后续工作接续。

## 1. 项目定位

`chatlog-viewer` — 本地单用户的 AI CLI 对话记录管理器。Web 形式（本地 server + 浏览器 UI），强制 loopback-only。支持 Claude Code / Codex / iFlow / OpenCode 四类 CLI 的对话浏览、搜索、编辑、AI 标题生成、目录迁移、批量操作。

## 2. 版本与发版节奏

- 最近正式 tag：`v1.3.2`
- 之后已 commit 但未发版的内容（master 领先 origin/tag）：见第 6 节
- **发版偏好**：不要每次小修都打 tag。攒到一组明显改动或用户主动要求再发，dependabot 等也可以攒着一起发。该偏好已写入 `~/.claude/projects/.../memory/feedback_chatlog_release_cadence.md`。

## 3. 整体架构

```
chatlog-viewer/
├── packages/server/                  Hono + better-sqlite3 + JSONL
│   └── src/
│       ├── app.ts                    Hono app + loopback 校验 + origin CORS
│       ├── index.ts                  入口；启动后异步 compactCacheDb
│       ├── providers/
│       │   ├── types.ts              ConversationProvider 接口
│       │   ├── claude-code.ts        Claude Code provider（~/.claude/projects）
│       │   ├── codex.ts              Codex provider，配合 codex-sqlite-client
│       │   ├── codex-sqlite-client.ts SQLite 读写连接生命周期 + 高层查询
│       │   ├── iflow.ts              iFlow（~/.iflow/projects）
│       │   ├── opencode.ts           OpenCode（SQLite 直接读，~/.local/share/opencode）
│       │   └── shared/provider-utils.ts  通用路径规范化、显示路径修正
│       ├── routes/
│       │   ├── conversations.ts      对话 CRUD / 标题 / 移动 / model provider
│       │   └── settings.ts           provider 路径、AI CLI、Codex providers
│       └── utils/
│           ├── ai.ts                 调用 codex/claude/opencode 生成标题
│           ├── cache.ts              meta_cache + list_cache + FTS5 持久化
│           ├── search-index.ts       FTS5 分块索引
│           ├── file-logger.ts        console 拦截 + 按日期文件持久化
│           ├── provider-paths.ts     存储路径解析 + AI 配置
│           ├── message-actions.ts    单条消息编辑/删除底层
│           └── jsonl.ts              JSONL head/tail/stream 解析
└── packages/web/                     React + Vite + TailwindCSS
    └── src/
        ├── App.tsx                   顶层装配
        ├── components/
        │   ├── Sidebar.tsx           侧栏（含拖拽改宽）
        │   ├── ConversationList.tsx  GroupedVirtuoso 虚拟化分组列表
        │   ├── ConversationViewer.tsx 详情 + 标题编辑 + provider/文件夹下拉
        │   ├── ProviderPathsDialog.tsx 路径与 AI 配置面板
        │   ├── MessageBubble.tsx     单条消息渲染（Markdown + 高亮）
        │   ├── ExportDialog.tsx      导出选项
        │   └── ToastViewport.tsx     全局 toast
        ├── hooks/
        │   ├── useConversations.ts   主状态机
        │   ├── useBatchActions.ts    批量异步操作（迁移 / 切 provider / 生成标题）
        │   └── useTheme.ts           暗黑模式
        └── lib/api.ts                后端 API 客户端
```

**数据流向**：JSONL 源文件 → `parseJsonlHead`/`visitJsonl` → Provider → 持久化 cache（`meta-cache.sqlite` + FTS5）→ 路由 → 前端 React Query 风格的 hook 状态机。

## 4. 已实现功能

**对话管理**
- 列表、详情（分页）、搜索、排序、按 provider / Codex model_provider 筛选
- 按文件夹（项目 cwd）分组折叠，前端用 GroupedVirtuoso 虚拟化
- 单条 / 批量 删除、清理残留、导出（JSON / Markdown）

**对话内容编辑**
- 删除单条消息 / 批量删除多条 / 编辑单条文本

**标题**
- 手动改标题
- 单个 / 批量 AI 生成标题（调用本地 CLI）
- 每个 CLI 可配置 `fixed`（复用 session）/ `fresh`（每次新建），默认 `fresh`

**Claude Code 标题对齐 `/resume`**（v1.3.2 之后新增）
- 优先读取 jsonl 中 `type: "custom-title"` 的 `customTitle` 字段（也支持 `agent-name`）
- 这是 Claude `/resume` 列表显示的会话名来源，UI 与之保持一致
- 全文流式扫描而非只读 head 40 行（覆盖中后段才出现的 custom-title）

**移动**
- 拖拽单条对话到另一文件夹
- 详情页下拉选目标文件夹移动
- 批量移动（侧栏选中后选目标）
- Codex 对话改 model_provider（单 / 批量）

**Provider 路径配置**
- ProviderPathsDialog 允许配置每个 CLI 的 storagePath / stateDbPath
- 支持迁移（移动现有目录到新位置）

**AI CLI 设置**
- titleGenerationCliPriority（按顺序回退）
- titleGenerationCliSessionModes（每个 CLI 独立 fixed/fresh）
- titleGenerationCliDisabled（禁用列表）

**主题** — 亮 / 暗 / 跟随系统。**侧栏** — 拖拽改宽，宽度持久化到 localStorage。

## 5. 测试与质量

| 指标 | 当前 |
|---|---|
| Server tests | **113 / 113** pass |
| Web tests | **41 / 41** pass |
| Lint | 0 warnings |
| TypeScript 编译 | 0 错 |
| Dependabot | 0 open（截至 v1.3.1 后的修复） |

## 6. v1.3.2 之后新增的未发版改动

按 commit 顺序：

| commit | 内容 |
|---|---|
| `a4b3eaf` | applyProjectDisplayPathHints 不再把"群组最深路径"强加给所有 session。修复 Claude Code 在不同 cwd 启动的 session 被错误合并到一个目录 |
| `d9b4d0b` | 新增 `META_CACHE_VERSION` + cache_schema_meta 表；版本不匹配时自动清空 meta_cache / list_cache / indexed_list_cache / conversation_index / conversation_search_chunk。让历史 bug 写入的污染条目自动失效 |
| `ba3d7e0` | Claude Code 标题对齐 `/resume`：扫描 jsonl 中 `custom-title` / `agent-name` 元条目；buildIndexedCacheItem 在 !includeSearchIndex 时也走 scanTranscriptSource（visitJsonl）；META_CACHE_VERSION 4→5 |

下一次发版（用户授权后）应至少包含以上 3 个。

## 7. 关键技术约束 / 设计决策

- **SQLite 同步执行**：`better-sqlite3` 比异步快 5–10×，单进程单用户工具的最佳选择
- **API loopback-only**：app.ts 强制 host 校验 + origin 校验，攻击面接近零
- **mtime 缓存**：JSONL 文件不变就不重读，靠 `META_CACHE_VERSION` 应对抽取逻辑变更
- **FTS5 启动 compact**：`compactCacheDb()` 启动后异步执行 `optimize + VACUUM` 回收墓碑（实测能从 260MB 压回 20MB 以内）
- **Codex SQLite 写连接单例**：通过 `codex-sqlite-client.ts` 复用，写操作不重复 open/close

## 8. 已知未覆盖的盲区

按风险从高到低：

1. **跨平台**：所有验证都在 Windows。macOS / Linux 的路径处理（特别是 `\\?\` 前缀已修但其他差异未测）、case-sensitive 文件系统都没实跑
2. **大规模数据**：当前 80~100 对话规模。500+ 没测，FTS 启动 compact 在 5MB+ 索引上的耗时未知
3. **极端 JSONL 格式**：Codex / Claude Code / iFlow / OpenCode 的 schema 都在演化（如 Codex 0.130.0 起的 `\\?\` rollout_path 前缀）。新版本可能再变
4. **测试覆盖盲点**：前端只 41 个测试且都是组件级，没有端到端（Playwright）；`applyProjectDisplayPathHints` 这次的 bug 就出在没有针对它的测试
5. **并发场景**：连续点 5 次"批量生成标题"导致多个 spawn 子进程同时跑，行为未实测
6. **未深入审查模块**：iFlow provider、ProviderPathsDialog（700 行复杂表单）、search-index 的实现细节都是浅看，可能藏类似 `applyProjectDisplayPathHints` 的逻辑错位

## 9. 已修复的具有代表性的 bug（参考价值）

为防止后续踩同样的坑，列出最容易迷惑的几个：

- **B-cwd 同化**：`applyProjectDisplayPathHints` 用群组内最深 cwd 覆盖所有 session 的 project / projectId。改成只在 item 自己 specificity 为 0 时才填充
- **B-cache 污染**：之前的污染条目在新逻辑下不会自动失效（jsonl mtime 没变）。引入 `META_CACHE_VERSION` schema 版本
- **B-Claude title 不对齐**：UI 只看首条 user 消息，没读 `type: "custom-title"` 元条目。Claude `/resume` 的会话名都靠这个
- **B-OpenCode 标题空输出**：OpenCode 在标题 session 目录下只回 step_start。修复：调用时显式 `--dir <conversation.project>`，必要时回退到 cwd 再试
- **B-`\\?\` 前缀正则失效**：`/^\\\?\//` 在 forward-slash 化后永远匹配不到 `//?/`。正确应为 `/^\/\/\?\//`
- **B-extractCleanOutput 误判**：`含 { 即返回空` 会把 claude/codex 含代码块的输出判空。改为 ≥50% JSON 行才判
- **B-setTimeout 泄漏**：ConversationViewer 的 genStatus 定时器没 cleanup。用 useRef 持有 id
- **B-rotate 节流非原子**：file-logger maybeRotate 加 in-flight Promise 锁
- **B-Codex SQLite count 误导**：SQLite `threads` 表有大量空 session，估值远高于实际对话数。前端只用实际 count

## 10. 运维要点

**启动开发**
```bash
cd ~/Desktop/code_area/chatlog-viewer    # 或 D:/DownloadFiles/code_area/chatlog-viewer（两份同步）
pnpm dev    # server :3456 + vite :5173
```

**测试**
```bash
pnpm --filter server test --run
pnpm --filter web test --run
pnpm lint
pnpm typecheck
```

**Cache 路径**：`~/.chatlog-viewer/`
- `meta-cache.sqlite` — 所有持久化缓存（按 `META_CACHE_VERSION` 自动迁移）
- `logs/server-YYYY-MM-DD.log` — 主日志
- `logs/debug-YYYY-MM-DD.log` — DEBUG 日志
- `titles.json` — overlay 标题（仅 iFlow / metadata-only 情景）
- `ai-title-sessions/<cli>/` — AI 标题生成的 session 目录
- `config.json` — provider 路径 + AI 配置

**Bump META_CACHE_VERSION 的时机**
- ConversationMeta 字段语义变更
- 提取逻辑变更（如本次 custom-title 支持）
- 历史 bug 写入污染条目需要清扫

**端口被占用**
```bash
netstat -ano | grep ":3456"
taskkill //F //PID <pid>
```

## 11. 下一步可考虑（按 ROI 排序，但都非紧急）

1. macOS / Linux 至少跑通 list + 单条删除（用户群拓展时必要）
2. 5000+ 对话规模的压测（如果用户实际增长）
3. iFlow / ProviderPathsDialog / search-index 的深度审查（可能藏类似 cwd 同化的 bug）
4. 端到端测试（Playwright）覆盖批量操作链路

## 12. 仓库

https://github.com/sixplatemizu/chatlog-viewer

最新 tag：v1.3.2 — https://github.com/sixplatemizu/chatlog-viewer/releases/tag/v1.3.2
