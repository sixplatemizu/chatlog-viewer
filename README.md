# ChatLog Viewer

统一浏览、搜索、整理本机 AI CLI 对话记录的桌面本地 Web 工具，当前默认接入 Claude Code、Codex、iFlow CLI。

## 亮点

- 统一聚合多个 provider 的会话记录，按项目目录分组浏览
- Markdown 消息渲染、代码高亮、tool call 折叠，适合长对话回看
- 支持 provider 过滤、Codex model provider 过滤、按更新时间 / 创建时间 / provider 排序
- 搜索基于本地索引，支持长消息 chunk search，降低超长会话中段内容漏检概率
- 支持手动改标题、调用本地 CLI 生成标题、批量选择、批量删除、项目间移动会话
- AI 标题生成支持 `iflow / codex / claude` 优先级设置，并为每个 CLI 复用固定会话
- 导出支持 `完整导出` 和 `Partial Export` 两种模式，超长对话可优先走 partial
- Provider 路径支持自动发现、环境变量覆盖、配置文件覆盖，并可直接在 UI 中查看与修改
- API 默认只允许本机 Host / Origin 访问，减少误暴露风险

## 当前支持

| Provider | 状态 | 默认路径 |
| --- | --- | --- |
| Claude Code | 完整支持 | `~/.claude/projects` |
| Codex | 完整支持 | `~/.codex/sessions` |
| Codex state db | 完整支持 | `~/.codex/state_5.sqlite` |
| iFlow CLI | 完整支持 | `~/.iflow/projects` |

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

- 支持手动改标题
- 支持调用本地 AI CLI 自动生成标题
- 标题生成支持 `iflow -> codex -> claude` 等可调 fallback 优先级
- 每个标题生成 CLI 会复用固定会话，避免每次都新建新对话
- 设置页支持查看每个 CLI 是否可用、是否已有固定会话，并可单独或全部重置
- 支持批量选择、批量删除
- 支持在同 provider 的不同项目目录间移动会话
- Codex 会话支持修改 `model_provider`

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
CHATLOG_VIEWER_IFLOW_PATH=/path/to/iflow/projects
```

## 项目结构

```text
packages/
├── server/
│   └── src/
│       ├── providers/     # 各 provider 读取 / 删除 / 移动 / 索引逻辑
│       ├── routes/        # API 路由与设置接口
│       ├── utils/         # provider path、JSONL、cache、search index 等工具
│       └── bench/         # benchmark 脚本
└── web/
    └── src/
        ├── components/    # 侧边栏、会话详情、导出、路径设置等 UI
        ├── hooks/         # 数据获取与交互状态
        └── lib/           # API 封装与类型
```

## 开发说明

- Server 运行在 `127.0.0.1:3456`，默认拒绝非本机 Host / Origin
- 搜索性能相关改动可用 `pnpm bench:search-index` 做基准对比
- 本仓库使用 GitHub Actions 进行基础 CI 校验

## License

MIT
