# 项目状态参考 — 2026-07-22

本机单用户稳定版候选快照。发版标签：`v1.4.0`。

## 定位

本地 AI CLI 对话管理器（Claude Code / Codex / OpenCode / iFlow）：浏览、搜索、导出、标题、消息编辑删除、迁移与批量操作。Loopback-only。

## 能力对齐

| 能力 | Claude | Codex | OpenCode | iFlow |
| --- | --- | --- | --- | --- |
| 浏览 / 搜索 / 导出 | ✅ | ✅ | ✅ | ✅ |
| 原生标题 | ✅ | ✅ | ✅ | ❌ overlay 禁用 |
| AI 生成标题 | ✅ | ✅ | ✅ | ❌ |
| 消息编辑 / 删除 | ✅ | ✅ | ✅ 文本 part | ✅ |
| 移动 / 删除会话 | ✅ | ✅ | ✅ | ✅ |
| metadata-only | ✅ | ✅ | ✅ 空 session | ❌ |
| 并发 409 | 文件 mtime | 文件 mtime | part revision | 文件 mtime |

## 自 v1.3.4 以来要点

- OpenCode part 级消息编辑/删除 + mutation 锁 + 409
- OpenCode 空会话 `metadata-only`；列表体积聚合修复
- CI：Linux 路径 exact match、Windows 临时目录清理、SQLite 占用检测
- 依赖：`@hono/node-server` 2.x、vite 6.4.3、tsx 4.23.1、overrides 清零 audit
- cache/ai facade 拆分；审查计划 P2-8 关闭

## 非阻塞后续

1. OpenCode `session_message` 投影表兼容
2. 大模块深拆（claude-code / codex / cache）
3. 物理断电 / 磁盘满等手工破坏性测试

## 发版门槛（已满足）

- P1 数据安全与 CAS
- audit 0
- Ubuntu + Windows + E2E + Benchmark CI 绿
- 真实 title CLI smoke 与浏览器 E2E
