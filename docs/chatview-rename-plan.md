# chatview 更名规划（仅规划，未执行，2026-10-04）

> 约束：本轮只出规划与清单，不改任何代码。执行需另行批准。

## 影响面清单（rg 实测）
- `chatlog-viewer` 小写：36 文件（含 package.json、README、skill、vite.config、server 源码/测试、docs）。
- `ChatLog Viewer` 展示名：17 文件。
- `clv-title` 二进制名：仅 `packages/server/src/cli/title-manager.ts` help 文本 1 处。
- `~/.chatlog-viewer` 配置目录：14 文件（provider-paths、title-store、cache、api-token、测试、skill、README、vite.config）。
- `CHATLOG_VIEWER_` 环境变量：20 文件。

## 映射（待确认）
1. 包名/路径 `chatlog-viewer` → `chatview`（含目录名、package.json、import 路径、CI、测试夹具）。
2. 展示名 `ChatLog Viewer` → `ChatView`（Web 标题、skill 名称、docs）。
3. 二进制 `clv-title` 去留单独立项（改名即 breaking change；建议保留别名一版）。
4. 配置目录 `~/.chatlog-viewer` → `~/.chatview`，做迁移 shim：读新写新、读旧迁新，不静默双写。
5. 环境变量 `CHATLOG_VIEWER_*` → `CHATVIEW_*`，保留旧变量兼容读取一版并告警。
6. skill 目录 `skills/chatlog-viewer-title` → `skills/chatview-title`，frontmatter 同步。

## 阶段
1. 清单冻结（本文件即清单 v1）。
2. 映射确认（逐项确认上述 6 条）。
3. 单分支改名（含 skill/agents、docs、README、package 名、CI、测试夹具路径）。
4. 迁移与回滚说明（配置目录 + 环境变量 + 二进制别名）。
5. 全量验证（typecheck + lint + test + skill 自检）后提交。

## 未估工作量
- 完整文件级清单未逐条展开前不估；执行前先冻结清单。
