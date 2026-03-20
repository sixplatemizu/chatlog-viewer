# ChatLog Viewer

AI CLI 对话记录管理器 — 统一管理 Claude Code / Codex / iFlow CLI 的对话记录。

## 功能

- **多工具支持** — Claude Code、Codex、iFlow CLI，按项目文件夹分组展示
- **对话查看** — Markdown 渲染、代码高亮、tool call 折叠
- **搜索与筛选** — 全文搜索、按工具/时间排序
- **标题管理** — 手动编辑 + AI 自动生成（调用本地 CLI，支持会话复用和批量生成）
- **批量操作** — 多选/全选，批量导出（JSON/Markdown）、批量删除
- **拖拽移动** — 在不同项目文件夹间拖拽迁移对话
- **暗黑模式** — 跟随系统 / 手动切换

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React + Vite + TailwindCSS |
| 后端 | Hono (Node.js) |
| 语言 | TypeScript |
| 包管理 | pnpm monorepo |

## 快速开始

```bash
# 安装依赖
pnpm install

# 同时启动前后端
pnpm dev
```

浏览器打开 http://localhost:5173

## 项目结构

```
packages/
├── server/         # Hono 后端 (端口 3456)
│   └── src/
│       ├── providers/    # 各 CLI 工具的 adapter
│       ├── routes/       # REST API
│       └── utils/        # JSONL 解析、标题存储、AI 调用
└── web/            # React 前端 (端口 5173)
    └── src/
        ├── components/   # UI 组件
        ├── hooks/        # 状态管理
        └── lib/          # API 封装
```

## 支持的 CLI 工具

| 工具 | 存储路径 | 状态 |
|---|---|---|
| Claude Code | `~/.claude/projects/` | ✅ 完整支持 |
| Codex | `~/.codex/sessions/` | ✅ 完整支持 |
| iFlow CLI | `~/.iflow/projects/` | ✅ 完整支持 |
| Gemini CLI | — | 🔬 实验性 |
| OpenCode | — | 🔬 实验性 |

## License

MIT
