# OpenCode 消息编辑 / 删除设计

更新时间：2026-07-22

## 背景

Claude Code / Codex / iFlow 已支持消息级编辑与删除；OpenCode 暂不支持。

原因：OpenCode 本地存储是 SQLite 多表结构。UI 上的一条“消息”通常不是 `message` 表的一行，而是：

- `message`：消息头（role、时间、会话关联）
- `part`：消息体片段（text / tool / reasoning / step 等）

若直接 `DELETE FROM message` 或改 `message.data`，容易破坏 tool call、reasoning、step-finish 等结构。

## 目标

1. 支持编辑可见文本消息
2. 支持删除可见文本消息
3. 不破坏 tool / reasoning / step 结构
4. 与 OpenCode 官方语义尽量一致
5. 兼容 legacy `message`/`part` 与未来投影表

## 非目标（首期）

- 不支持编辑 tool 输入/输出
- 不支持编辑 reasoning 内部结构
- 不支持跨会话剪切/粘贴消息
- 不重写 OpenCode 运行时状态机

## 数据模型观察

当前读取路径（`providers/opencode.ts`）：

1. 读 `message` 行
2. 按 `message_id` 聚合 `part`
3. 将 text-like part 投影为 UI `Message`
4. tool / reasoning 可能映射为独立 UI 项或折叠内容

因此：

- UI `messageId` 应绑定 **可见 part 主键**（或稳定合成键），而不是仅绑定 `message.id`
- 删除“一条用户/助手文本”通常应删除对应 text part，并在该 message 已无可见 part 时再清理 message 行

## 推荐方案

### 方案 A（推荐）：part 级编辑 / 删除

对齐 OpenCode 官方 `part.update` / `part.delete` 语义。

#### 编辑

输入：`conversationId`, `messageId(=partId)`, `content`

步骤：

1. 解析 `opencode:<sessionId>`
2. 校验 part 存在且 `session_id` 匹配
3. 仅允许 `type` 属于可编辑集合：`text` / `text-delta` 等纯文本类
4. 更新 `part.data` 内文本字段（保留其余 JSON 字段）
5. 更新 `part.time_updated` 与 `session.time_updated`
6. 失效 cache / search index
7. 返回刷新后的会话详情

#### 删除

输入：`conversationId`, `messageIds(=partIds[])`

步骤：

1. 校验每个 part 可删（纯文本可见 part）
2. 事务内删除这些 part
3. 对因此变成“无任何 part”的 message 删除 message 行
4. 若 message 仍有 tool/reasoning part，则保留 message 行
5. 更新 session 时间戳并失效缓存

### 方案 B（不推荐）：message 级整行删除

实现简单，但会连带删除 tool/reasoning/step，破坏回放结构。仅在确认 message 仅含单一 text part 时可作为内部优化路径，不应作为默认策略。

## Capability 与 API

保持现有 capability model：

```ts
canEditMessage: false // 实现前
canDeleteMessage: false
deleteMessageDisabledReason: "..."
```

实现后改为：

```ts
canEditMessage: true
canDeleteMessage: true
```

路由层继续复用：

- `PATCH /conversations/:id/messages/:messageId`
- `DELETE /conversations/:id/messages`
- 统一 mutation lock / revision / 409 冲突语义

## 一致性与并发

1. 使用现有跨进程 lock（按 sessionId）
2. 写前读取 part 的 `time_updated` 或内容 hash 作为 revision
3. revision 变化返回 `409`
4. 事务：`BEGIN` → 改 part/message → 更新 session → `COMMIT`
5. 写后：`invalidateListCache` + 重建该 session 的 search 索引条目

## 兼容策略

| 存储形态 | 策略 |
|---|---|
| legacy `message` + `part` | 首期主路径 |
| 新版 `session_message` 投影 | 检测表存在时走投影适配层 |
| 仅 metadata / 空会话 | 返回明确错误，不静默空成功 |

检测顺序：

1. 有 `part` 表 → part 级路径
2. 仅有投影表 → 投影适配
3. 都没有 → `schema-incompatible`

## 测试计划

### 单元 / 集成

1. 编辑 text part，详情读回新文本
2. 删除 text part，不影响同 message 的 tool part
3. 删除 message 下最后一个 part 时清理 message 行
4. 并发编辑同一 part：后写冲突 `409`
5. 非法编辑 tool/reasoning：`400`
6. cache 失效后列表/搜索同步

### 回归

1. 标题写回、会话删除、move 不受影响
2. 搜索 chunk 重建正确
3. Windows 路径与 SQLite WAL 场景

## 实施阶段

### Phase 1

- 为 UI message 建立稳定 `partId` 映射
- capability 仍关闭，仅内部 API 可测

### Phase 2

- 实现 text part 编辑
- 实现 text part 删除 + 空 message 清理
- 打开 capability 与 UI 入口

### Phase 3

- 投影表兼容
- 批量删除优化
- 与 OpenCode 官方 API 行为 diff 文档

## 验收标准

1. OpenCode 文本消息可编辑/删除，且 tool/reasoning 结构保持完整
2. 与 Claude/Codex/iFlow 的 capability 行为一致
3. 故障不静默成功，冲突可诊断
4. 相关测试在 Ubuntu/Windows CI 通过

## 风险

1. OpenCode schema 升级导致字段变化
2. 多 part 合成 UI 消息时 ID 映射歧义
3. 搜索索引与列表缓存短暂不一致

缓解：schema 探测 + 稳定 sourceKey + 写后强制失效缓存。
