# chatview 更名规划（已执行完毕归档，2026-10-04 规划 → 2026-10-07 落地）

> 原约束"只出规划不改代码"已解除：用户批准后在 `rename/chatview`
> 分支执行完毕并合入 `master`，分支已删。6 条映射全部落地，
> 旧标识保留一版兼容（详见下）。P6/P7 可选树状通用化维持不扩展。

## 影响面清单（rg 实测）
- `chatlog-viewer` 小写：36 文件（含 package.json、README、skill、vite.config、server 源码/测试、docs）。
- `ChatLog Viewer` 展示名：17 文件。
- `clv-title` 二进制名：仅 `packages/server/src/cli/title-manager.ts` help 文本 1 处。
- `~/.chatlog-viewer` 配置目录：14 文件（provider-paths、title-store、cache、api-token、测试、skill、README、vite.config）。
- `CHATLOG_VIEWER_` 环境变量：20 文件。

## 映射（已全部落地）
1. 包名/路径 `chatlog-viewer` → `chatview` ✅（`8e473a7`；含目录名、package.json、CLI `chatview-title` 直接改名无别名）。
2. 展示名 `ChatLog Viewer` → `ChatView` ✅（同上；Web 标题、skill 名、内部标题前缀）。
3. 二进制 `clv-title` → `chatview-title` ✅（直接改名，未保留别名；help/报错文案同步）。
4. 配置目录 `~/.chatlog-viewer` → `~/.chatview` ✅（`c5e18ba`；读新写新，旧目录仅兼容读取，不双写）。
5. 环境变量 `CHATLOG_VIEWER_*` → `CHATVIEW_*` ✅（同上；新变量优先，旧变量兼容一版，无告警）。
6. skill 目录 `skills/chatlog-viewer-title` → `skills/chatview-title` ✅（`8e473a7`；frontmatter 同步；另加 `--model/--agent/--variant` 命令矩阵于 `af5af42`）。

## 落盘提交
- `8e473a7 feat(rename)`：展示名与内部标题切 ChatView。
- `c5e18ba feat(rename)`：路径与变量迁移至 chatview 并保留兼容。
- `f9cbc99 feat(rename)`：README 与残留标识切 chatview（historySource 新值兼容旧值）。
- `af5af42 feat(title)`：`--model/--agent/--variant` 透传（opencode 全项、claude 映射 `--effort`、codex 仅模型）。

## 阶段（均已完成）
1. 清单冻结 ✅（36/17/1/14/20 文件计数见上）。
2. 映射确认 ✅（6 条逐项确认，见上）。
3. 单分支改名 ✅（`rename/chatview`，已合入 master 并删分支）。
4. 迁移说明 ✅（旧变量/旧目录/旧标题前缀三处双读兼容；二进制未留别名）。
5. 全量验证 ✅（双包 typecheck + 全量 test + eslint 全过后提交）。

## 备注
- 当时"完整文件级清单未展开不估"实际是边做边覆盖的，特此更正。
- P6/P7 可选树状通用化维持不扩展结论，归档于深拆文档，不在本文件展开。
