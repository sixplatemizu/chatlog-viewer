# ChatLog Viewer

统一浏览、搜索、整理本机 AI CLI 对话记录的桌面本地 Web 工具，当前默认接入 Claude Code、Codex、OpenCode、iFlow CLI。项目以本地原始数据为准：尽量忠实呈现真实存在的记录，同时用 badge 标记不完整、非默认可见或由 ChatLog Viewer 内部产生的会话。

## 亮点

- 统一聚合多个 provider 的本地原始会话记录，按项目目录分组浏览
- 对工具自身 UI 默认不展示但本地真实存在的记录进行标记区分，例如 OpenCode 子会话、归档、`opencode run` / 标题生成会话
- Markdown 消息渲染、代码高亮、tool call 折叠，适合长对话回看
- 支持 provider 过滤、Codex model provider 过滤、按更新时间 / 创建时间 / provider 排序
- 搜索基于本地索引，支持长消息 chunk search，降低超长会话中段内容漏检概率
- 支持手动改标题、调用本地 CLI 生成标题、消息编辑 / 删除、批量选择、批量删除、项目间移动会话
- AI 标题生成支持 `codex / claude / opencode` 优先级设置，可选择固定会话或每次新建，并会标记 / 清理内部标题生成会话
- 导出支持 `完整导出` 和 `Partial Export` 两种模式，超长对话可优先走 partial
- Provider 路径支持自动发现、环境变量覆盖、配置文件覆盖，并可直接在 UI 中查看与修改
- API 默认只允许本机 Host / Origin 访问，减少误暴露风险

## 当前支持

| Provider | 数据来源 | 浏览 / 搜索 / 导出 | 标题同步 | 消息编辑 / 删除 | 移动 / 删除会话 | 默认路径 |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | JSONL transcript、`sessions-index.json`、`history.jsonl` | 支持 | 按 `/rename` 语义写回 transcript + index | 支持 | 支持 | `~/.claude/projects` |
| Codex | JSONL transcript、`state_5.sqlite`、`session_index.jsonl` | 支持 | 通过 app-server 写回原生 title + thread name | 支持 | 支持 | `~/.codex/sessions` |
| Codex state db | `threads` / `conversation_index` | 支持 metadata-only 回填 | 与 Codex 同步 | 不适用于 metadata-only | 支持残留清理 | `~/.codex/state_5.sqlite` |
| OpenCode | SQLite `session` / `message` / `part` | 支持 | 原生写回 `session.title` | 支持（纯文本 part；保留 tool/reasoning） | 支持 | `~/.local/share/opencode/opencode.db` |
| iFlow CLI | JSONL transcript | 支持 | 暂禁用，缺少稳定原生标题字段 | 支持 | 支持 | `~/.iflow/projects` |

### 列表语义

ChatLog Viewer 的管理目标是忠于本地原始对话数据，而不是复刻各工具自己的 session picker。它会优先呈现本地 DB / 文件中真实存在的数据，对仅 metadata、仅 history、残留记录、子会话、归档会话等状态做显式标记，而不是静默隐藏。

OpenCode 的 `opencode session list`、TUI `/sessions` 和 ChatLog Viewer 的列表语义不同：前两者是 OpenCode 自身的操作视图，ChatLog Viewer 会显示 DB 中所有 `session` 记录，包括 TUI 默认不显示的子会话、归档会话、30 天外会话、`opencode run` / 自动化 one-shot session，以及 ChatLog Viewer AI 标题生成产生的 session。

Claude Code 会对缺少主 transcript 的记录标记 `history 回填`、`索引空壳`、`无 transcript`；Codex 会对仅存在于 `state_5.sqlite` 的记录标记 `state db`、`无 transcript`、`标题回退`；OpenCode 会标记 `子会话`、`已归档`、`30天外`、`run/临时`、`标题生成` 等原始状态。内部 AI 标题生成会话不再过滤隐藏，而是忠实显示并标记 `标题生成`。

## 技术栈

| 层 | 技术 |
| --- | --- |
| Web | React 19 + Vite + TailwindCSS |
| Server | Hono + Node.js |
| Language | TypeScript |
| Package Manager | pnpm workspace |
| Local Cache / Search | better-sqlite3 + 本地索引缓存 |

## 快速开始

### 环境要求

- Node.js `20+`
- pnpm `10+`

### 安装与启动

```bash
pnpm install
pnpm dev
```

- `pnpm dev` 会同时启动 Web 和 Server 两个子进程
- Web: `http://localhost:5173`
- API: `http://127.0.0.1:3456`

## 常用命令

```bash
pnpm dev
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm bench:search-index
pnpm title -- list --scope all --limit 30
```

CI 默认执行 `lint -> typecheck -> test -> build`。

## 核心能力

### 1. 会话浏览

- 侧边栏按项目目录聚合对话
- 长列表支持虚拟滚动
- 对话详情支持分页读取，避免一次性加载全部消息
- 代码块按需加载高亮组件，减轻主包体积

### 2. 搜索与索引

- 搜索优先查询本地 conversation index，而不是每次全量扫日志文件
- 长消息会拆成多个 search chunk 建索引，提升深层中段文本命中率
- 索引带 version 控制，旧索引不会被误当成当前可搜索缓存
- provider 刷新采用流式 / 分批处理，降低大目录重建开销
- 当 provider 尚未完成完整索引时，前端会收到 `partialSearch` 提示

### 3. 导出

- `完整导出`：适合归档和完整备份
- `Partial Export`：仅导出最近一部分消息，适合超长会话快速分享
- 导出支持 `JSON` / `Markdown`
- 服务端先写入临时文件再流式返回，避免大导出时聚合整份内容到内存
- 响应头 `X-Export-Meta` 会标记导出条数、失败项、是否发生截断

### 4. 标题与整理

- 支持手动改标题；对支持原生标题的 provider，UI 修改会写回对应本地记录
- Codex 标题优先通过 app-server `thread/name/set` 写回 State DB `title`，并同步 `session_index.jsonl.thread_name`；不会改写首条消息或 preview
- Claude Code 标题按 `/rename` 语义追加 transcript `custom-title` / `agent-name`，并同步 `sessions-index.json`
- OpenCode 标题会同步 SQLite `session.title`
- UI、title CLI 与 skill 共用同一原生持久化服务，写入后会重新读取并校验 provider 的最终标题
- 支持调用本地 AI CLI 自动生成标题
- 标题生成支持 `codex -> claude -> opencode` 等可调 fallback 优先级
- 每个标题生成 CLI 可选择 `Fresh 模式` 或 `固定模式`，默认使用 Fresh
- Fresh 模式下 Codex 使用 `--ephemeral`、Claude Code 使用 `--no-session-persistence`，不会保留辅助会话；OpenCode 会在生成后按 `sessionID` 精确删除辅助会话
- 固定模式仅在明确需要时启用，会复用最近一次标题生成会话
- 设置页支持查看每个 CLI 是否可用、是否已有固定会话，并可单独或全部重置
- 支持批量选择、批量删除
- 支持在同 provider 的不同项目目录间移动会话
- Codex 会话支持修改 `model_provider`

#### 多 Provider 标题 CLI / Skill

项目提供 `pnpm title` 和 `$chatlog-viewer-title` skill，用同一套流程管理 Codex、Claude Code 与 OpenCode 标题。默认 provider 为 Codex，以保持旧命令兼容；使用 `--provider all` 可统一列出或批量处理三者。

```bash
pnpm title -- --provider all
pnpm title -- list --provider all --scope all --search "关键词" --limit 20
pnpm title -- list --provider claude-code --cwd "$PWD" --exact --limit 30
pnpm title -- rename codex:<session-id> "新标题"
pnpm title -- rename claude-code:<session-id> "新标题"
pnpm title -- rename opencode:<session-id> "新标题"
pnpm title -- generate claude-code:<session-id> --cli opencode,codex,claude --timeout 90000 --retries 2
pnpm title -- generate-batch --provider all --cwd "$PWD" --exact --dry-run
pnpm title -- generate-batch --provider all --cwd "$PWD" --exact --json --continue-on-error
pnpm title -- rollback --report ~/.backups/chatlog-viewer-title/<date>/conversation-title-generate-batch-<timestamp>.json
```

- `list` 默认查看 Codex；`--provider codex|claude-code|opencode|all` 选择数据源，`--cwd <path> --exact` 精确匹配项目，`--project <path> --recursive` 包含子目录；内部标题生成会话默认排除
- `rename` 按目标 provider 原生写回：Codex 使用 app-server 命名语义，Claude Code 使用 `/rename` metadata，OpenCode 更新 `session.title`
- `--provider` 决定目标对话来源，`--cli` 决定 AI 生成引擎，两者互相独立；可将 OpenCode 配置为首选引擎，为任意受支持 provider 的对话生成标题
- OpenCode 的完整 AI 会话仍统一存储在 `~/.local/share/opencode/opencode.db`；`~/.chatlog-viewer/ai-title-sessions/opencode` 仅是隔离工作目录和 fixed session marker，Fresh 模式生成的会话会按 `sessionID` 自动删除
- `generate` / `generate-batch` 支持 `--cli`、`--timeout`、`--retries`，按本次实际使用的 CLI 复用或清理内部会话；标题上下文以近期消息为主，辅以少量开头/中段信息
- `generate-batch` 会在 `~/.backups/chatlog-viewer-title/<date>/` 写入包含 `id / oldTitle / newTitle / filePath / usedCli / attempts / error` 的 JSON 报告，方便审计和回滚
- `generate-batch --dry-run` 只生成目标列表和报告，不调用 AI CLI、不写回标题；`rollback --report <path>` 会按报告中的 `oldTitle` 回滚成功生成过的记录
- `rename`、`generate`、`generate-batch` 与 `rollback` 支持 `--json`：stdout 只返回一个 `schemaVersion: 1` JSON，使用 `ok`、`summary.total/success/failed/skipped` 和 `entries[].status` 判断结果；AI 诊断日志写入 stderr
- `--json` 模式下，dry-run、提前停止后未处理的条目和回滚冲突计入 `skipped`；存在失败条目时进程以非零 code 退出，致命错误以版本化 JSON 写入 stderr
- 通过 pnpm 调用 JSON 模式时使用 `pnpm --silent`，否则 pnpm 自身的 lifecycle banner 会出现在 stdout，影响直接 JSON 解析
- 仓库内 `skills/chatlog-viewer-title` 可安装到本机 skill 目录，在 Codex 中用 `$chatlog-viewer-title` 触发同样的三 provider CLI 工作流

### 5. 消息级操作

- Codex、Claude Code、iFlow 支持消息编辑、单条删除和批量删除
- 消息 ID 基于原始记录稳定字段或 source key 生成，连续编辑 / 删除后仍可继续定位同一消息
- OpenCode 暂不开放消息级编辑 / 删除：OpenCode 正文存放在 SQLite `part.data`，一条 UI 消息可能对应多个 `part`，直接改删 `message` 行容易破坏 tool / reasoning / step 结构
- OpenCode 后续更合适的实现方式是按可见 `part` 级别编辑 / 删除，并尽量对齐 OpenCode 官方 `part.update` / `part.delete` 语义

## Provider 路径解析

路径解析优先级如下：

`环境变量 > 配置文件 > 自动发现 > 默认路径`

### 自动发现

除了默认目录，程序还会尝试在这些常见位置自动发现 provider 数据目录：

- `~/.config`
- `~/Library/Application Support`
- `~/AppData/Roaming`
- `~/AppData/Local`
- `XDG_CONFIG_HOME`
- `APPDATA`
- `LOCALAPPDATA`

### UI 配置

前端提供 `Provider 路径设置` 对话框，可以：

- 查看当前生效路径
- 查看路径来源是 `env` / `config` / `auto` / `default`
- 查看目录或文件是否存在
- 直接保存配置覆盖值
- 调整 AI 标题生成 CLI 优先级
- 查看 AI CLI 可用状态与固定会话状态
- 手动重置单个或全部 AI 标题固定会话

### 配置文件

默认配置文件路径：

```text
~/.chatlog-viewer/config.json
```

也可以通过环境变量 `CHATLOG_VIEWER_CONFIG_PATH` 指定其他位置。

配置示例：

```json
{
  "providers": {
    "claude-code": {
      "storagePath": "/data/claude/projects"
    },
    "codex": {
      "storagePath": "/data/codex/sessions",
      "stateDbPath": "/data/codex/state_5.sqlite"
    },
    "opencode": {
      "storagePath": "/data/opencode",
      "stateDbPath": "/data/opencode/opencode.db"
    },
    "iflow": {
      "storagePath": "/data/iflow/projects"
    }
  }
}
```

### 常用环境变量

```bash
CHATLOG_VIEWER_CONFIG_PATH=/path/to/config.json
CHATLOG_VIEWER_CLAUDE_CODE_PATH=/path/to/claude/projects
CHATLOG_VIEWER_CODEX_SESSIONS_PATH=/path/to/codex/sessions
CHATLOG_VIEWER_CODEX_STATE_DB_PATH=/path/to/codex/state_5.sqlite
CHATLOG_VIEWER_OPENCODE_PATH=/path/to/opencode
CHATLOG_VIEWER_OPENCODE_DB_PATH=/path/to/opencode/opencode.db
CHATLOG_VIEWER_OPENCODE_BIN=/path/to/opencode
CHATLOG_VIEWER_IFLOW_PATH=/path/to/iflow/projects
```

## 项目结构

```text
packages/
├── server/
│   └── src/
│       ├── cli/           # 本地维护命令，例如多 provider 标题管理
│       ├── providers/     # 各 provider 读取 / 删除 / 移动 / 索引逻辑
│       ├── routes/        # API 路由与设置接口
│       ├── utils/         # provider path、JSONL、cache、search index 等工具
│       └── bench/         # benchmark 脚本
└── web/
    └── src/
        ├── components/    # 侧边栏、会话详情、导出、路径设置等 UI
        ├── hooks/         # 数据获取与交互状态
        └── lib/           # API 封装与类型
skills/
└── chatlog-viewer-title/   # Codex 中调用三 provider 标题 CLI 的 skill
```

## 已知限制与后续

- OpenCode 消息编辑 / 删除仅作用于可见纯文本 `part`；tool、reasoning 等结构故意不可改，避免破坏回放。
- OpenCode 新版 `session_message` 投影表尚未适配；当前主路径为 legacy `message` + `part`。
- 大模块拆分（`claude-code.ts` / `codex.ts` / `cache`）属于可维护性优化，不阻塞日常使用。

## 开发说明

- Server 运行在 `127.0.0.1:3456`，默认拒绝非本机 Host / Origin
- 搜索性能相关改动可用 `pnpm bench:search-index` 做基准对比
- 本仓库使用 GitHub Actions 进行基础 CI 校验

## License

MIT
