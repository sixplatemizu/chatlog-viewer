# 上手问题收尾与三要求执行计划（2026-10-04）

> 经用户批准执行。事实核查先行，方案报批后动手；分阶段落盘，异常即停即报。

## 基线
- 已提交：`953d86f` 三家 provider、`e51d322` pi ID 口径。
- 未提交 4 文件：`Sidebar.tsx` 筛选沉底；`codebuddy.ts` 徽标/分组/排序/子删除；
  `workbuddy.ts` 徽标去重；`new-providers.test.ts` 断言补齐。

## 阶段与检查点
1. P1 收尾提交：4 文件验证（server/web typecheck、server test、eslint）后提交。
2. P2 彻底删除：workbuddy 多同名文件吞错修复；各家空目录 best-effort 清理；
   codex `session_index.jsonl` 条目确认；claude history-only 幽灵行运行时复验。
3. P3 opencode 标题：诊断透出（health/priority/attempts）；`extractCleanOutput`
   事件兼容；sessionID 多键抽取加日志；清理快照差集核对。
4. P4 CLI/skill：目标 provider 扩 7 家（iflow 只读拦截）；生成 CLI 保持 3 项；
   输出契约不变；skill 重写命令矩阵与 JSON 示例。
5. P5 全量验证提交：typecheck + lint + test + 提交。
6. P6 更名规划：只出 `docs/chatview-rename-plan.md`，不改代码。

## 监控
- 每阶段结束汇报；命令异常退出或测试失败立即停下汇报，不兜底。
- 提交前必查 `git status`、`git diff --stat`、`git log --oneline`。

## 进展
- [x] 基线核查（4 文件 diff、typecheck/test 通过）
- [x] P1 提交（29fa620）
- [x] P2 删除修复（共用 removeEmptyParentDirs；workbuddy 多同名文件报错不吞）
- [x] P3 标题修复（opencode 事件行判定 + 失败带 mode 诊断）
- [x] P4 CLI/skill（目标扩 7 家；生成 CLI 保持 3 项；skill 同步）
- [x] P5 全量验证提交（8d00deb；server test 全过，typecheck 双包过，eslint 目标文件过）
- [x] P6 更名规划文档（docs/chatview-rename-plan.md，仅规划未执行）
