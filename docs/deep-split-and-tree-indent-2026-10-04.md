# 深拆与树状缩进执行计划（2026-10-04）

> 经用户批准执行。决策：OpenCode `session_message`/`session_v2` 投影表**忽略**，专注 legacy `message`+`part` 主路径；豆包 LevelDB spike **暂缓**；大模块深拆与 CodeBuddy 真树状缩进**批准执行**。原则：简洁克制、适度抽象、public behavior 与测试不变。

## 阶段与检查点

1. P1 CodeBuddy 树状缩进：前端 `ConversationList` 对 `codebuddy:sub:*` 会话在父会话下渲染缩进层级；排序保证子紧随其父；分组与虚拟滚动逻辑不变。server 测试 + web typecheck 过。
2. P2 claude-code.ts 深拆：拆出 `claude-code-title.ts`（原生标题读写与标题辅助）与 `claude-code-session-index.ts`（sessions-index.jsonl 读写锁内操作），镜像 codex 的 `codex-title.ts`/`codex-session-index.ts` 命名。facade 稳定。
3. P3 cache/impl.ts 深拆：拆出 `cache-db.ts`（连接/状态/schema/迁移）与查询层模块；`cache/index.ts` facade 导出保持不变。
4. P4 codex.ts 评估：已有 4 个卫星模块，剩余部分若为编排 facade 则记录"不再拆"的结论，不为拆而拆。
5. P5 全量验证：server/web typecheck + eslint + 全量 test，通过后提交；更新本文档进展。

## 监控

- 每阶段结束自查测试；失败立即停下修复，不兜底。
- 提交前查 `git status`、`git diff --stat`。

## 进展

- [x] P1 树状缩进（web typecheck ✅；server 测试本机为环境性失败，见下节，留 CI 验证）
- [x] P2 claude-code.ts 深拆：实拆 5 个卫星模块（types/title/messages/session-index/source），facade 1767→约 1200 行；server typecheck ✅；故障注入回归（测试 9 `reading 'bind'`）已修复并验证清零
- [x] P3 cache 深拆：拆出 `cache-db.ts`（约 430 行，连接/状态/schema/迁移/prune/compact）与 `cache-query.ts`（约 330 行，索引查询层）；impl.ts 1617→950 行；`cache/index.ts` 分组 re-export，对外导出面不变。server typecheck ✅ / eslint ✅ / cache.test.ts 13/13 ✅
- [x] P4 codex.ts 评估并记录结论（2026-10-06，已产出：不再拆，见下节）
- [ ] P5 全量验证提交
- [x] R1 锁目录清理 + 瞬态失败根因修正 + 测试锁目录隔离（2026-10-05，见「改进收敛批次」节）
- [x] R2 resolveMessageLineNumbers 六家收敛（约 160 行重复消除）
- [x] R3 iflow/pi move 抽取共享 `moveTranscriptFileToProject`
- [x] R4 cache/ai 兼容层收口（20 处 import 直连，删除 2 个兼容文件）
- [x] R5 provider-paths.ts 拆分（1176 行 → 8 模块目录，20 个消费方更新）

## 环境限制（本机沙箱，2026-10-04 实测）

以下失败均为环境性，与代码无关，留 CI 验证：

> **2026-10-05 勘误**：下述第 1/2 条对锁失败根因的归因（配额/死锁文件）不准确，真实机制见文末「改进收敛批次」节的修正分析。核心结论不变：与本仓库代码无关，且已通过测试锁目录隔离根治。

1. **safe-delete 钩子**：主机拦截 `~/.chatlog-viewer/locks/` 下锁文件删除（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，每轮进程删除配额 50）。claude-code.test.ts 10 例中 5 例、provider-indexing.test.ts 7 例失败全部源于此。
2. **陈旧锁级联**：测试中途被钩子拦截后锁未清理，`~/.chatlog-viewer/locks/` 已累积 31 个死进程锁（含 `opencode:session:ses_opencode_conflict` 的 `7f143b3e…lock`），导致后续运行（含隔离单测）命中旧锁等待超时。**沙箱外手动清空该目录后本机可复测**。
3. **run-tests.ts**：按字母序执行且首败即中止（title-manager-smoke 的 node spawn EBUSY 也为沙箱拦截）；单测需逐文件直跑。
4. **裸 `node` 走 fnm shim 报错**：需用全路径 `C:\Users\mortis097\.workbuddy\binaries\node\versions\22.22.2-3\node.exe` + `node_modules/tsx/dist/cli.mjs` 直跑。

### P2 测试验证记录（结论：真回归清零）

- claude-code.test.ts：5 过 5 败，5 败均为 SAFE_DELETE；测试 9（move 目标 index 写入失败恢复）故障注入已生效——DI 修复（`upsertClaudeSessionIndexEntryUnlocked` 增加 `deps.writeIndexFile`，类恢复私有 `writeSessionIndexFile`）验证成功，失败点在注入后的锁文件删除被钩子拦截。
- provider-indexing.test.ts：7 败 = 4 直接 SAFE_DELETE + 2 锁超时级联（codex 19/20）+ 1 OpenCode 并发 409 锁超时（隔离重跑同因）；该文件触及的 opencode/codex/mutation-queue 代码本次均未改动。
- title-manager / codex 三个测试文件此前直跑 ✅。

### P3 测试验证记录（2026-10-04，结论：无业务回归）

- cache.test.ts（拆分最直接覆盖面）：**13/13 全过**，0 环境失败。
- claude-code.test.ts：9 过 1 败；唯一失败为 safe-delete 钩子自身 `spawnSync node.exe ETIMEDOUT`（沙箱拦截钩子子进程），非业务代码。
- provider-indexing.test.ts：25 过 8 败，8 败全环境性（钩子子进程 ETIMEDOUT ×3、配额拦截 ×1、锁级联超时 ×3、genie-trash spawn 超时 ×1），**零业务断言错误**。与拆分前基线（7 败）对比失败集合漂移（OpenCode 2 例恢复、Codex/iFlow 5 例新中招）——中招者取决于每轮删除配额消耗时序，印证随机环境拦截而非代码路径问题。
- 注：拆分前的 31 个陈旧锁在本轮运行中被部分清理，环境干扰有所缓解但仍存在。

## P3 cache 深拆交接方案（已执行完成，留档）

现状：`utils/cache.ts`（兼容入口 `export *`）→ `cache/index.ts`（27 行 facade）→ `impl.ts`（1617 行）。无外部直连 `impl.js`。

拆两个模块，facade 导出面完全不变：

1. **`cache-db.ts`**（连接/状态/schema/迁移/维护）：`Database` require、常量 `CACHE_PRUNE_INTERVAL_MS`/`VACUUM_INTERVAL_MS`/`META_CACHE_MAX_AGE_MS`/`LIST_CACHE_MAX_AGE_MS`/`MESSAGE_IDENTITY_CACHE_MAX_AGE_MS`/`KEEP_META_ROWS`/`META_CACHE_VERSION`、状态变量 `db`/`dbPath`/`lastPruneAt`/`lastVacuumAt`/FTS 标志×2/`storeDirOverride`、`getStoreDir`/`getDbPath`/`getDb`/`migrateMetaCacheVersion`/`ensureXxxSchema`×3/`pruneCacheStorage`/`compactCacheDb`，新导出 `resetDbState`/`setStoreDirOverride`/FTS 标志 getter/内存重置 hook。
2. **`cache-query.ts`**（索引查询层）：类型 `ConversationIndexSort`/`ConversationIndexQueryOptions`/`ConversationIndexQueryResult`、`buildLikePattern`/`buildFtsSearchQuery`/`ConversationIndexRow`(export)/`buildConversationMetaFromIndexRow`(export)/`buildConversationIndexWhere`/`getConversationIndexOrderBy`/`queryConversationIndexPage`/`queryConversationIndex`。

`impl.ts` 保留：LRUMap 与三个内存缓存、`INDEX_TTL_MS`/`SIGNATURE_CACHE_MAX_AGE_MS`、全部读写 API（getCached/setCache/list/indexed-list/snapshot/persisted-identity/invalidate×2）、`setCacheStoreDirForTests`、`resetCacheState`（改为清内存 + 调 `resetDbState`）、`createIndexedItemSignature`、`hasIndexedSearchData`。

关键耦合（已核实）：`resetCacheState` 跨内存/DB 两层，getDb 路径切换分支经 hook 清内存保持原行为；`SEARCH_INDEX_VERSION` impl 与 query 两处使用；测试均配套 `setCacheStoreDirForTests`，无裸改 env 路径。`cache/index.ts` 按来源分组 re-export，对外面不变。

## 变更清单（全部未提交）

- M `README.md`（七家 provider 功能同步，turn 2 产出，独立提交）
- M `packages/web/src/components/ConversationList.tsx`（P1 树状缩进）
- M `packages/server/src/providers/claude-code.ts`（P2 facade 重写）
- ?? `claude-code-types.ts`/`claude-code-title.ts`/`claude-code-messages.ts`/`claude-code-session-index.ts`/`claude-code-source.ts`（P2 卫星模块）
- M `packages/server/src/utils/cache/impl.ts`（P3 瘦身 1617→950 行）
- M `packages/server/src/utils/cache/index.ts`（P3 分组 re-export；注意本文件被重写后含 CRLF 行尾，git 将自动规范化，提交前核对 diff）
- M `packages/server/src/utils/cache/cache-db.ts`、`cache-query.ts`（P3 新模块，?? 标记）
- M `packages/server/src/providers/workbuddy.ts`（bugfix：move 重写 + 同名防护 + 定位异常不吞，含 `encodeWorkBuddyProjectDir`）
- M `packages/server/src/providers/iflow.ts`/`pi.ts`/`codebuddy.ts`/`codex.ts`（bugfix：move 同名覆盖防护；codebuddy 另含子目录回滚）
- M `packages/server/src/providers/new-providers.test.ts`（workbuddy 首批测试 +2、同名拒绝测试 +2）
- ?? 本文档

建议提交切分：① P1+P2+P3 同批（同属本计划的 web+server 改动，可 `feat(providers,web,cache): 深拆与树状缩进`）；② README 同步单独 `docs(readme): …`；③ 计划文档随 ① 或单独 chore 均可。P5 全量验证通过后再执行提交。

## 范围扩展需求（2026-10-04 用户提出，已决策：维持原方案不扩展）

用户曾提议深拆覆盖其余 provider、树状结构推广全部 CLI，经核查支持度后**决定维持原方案**（P1-P5 不变，不新增 P6/P7）。核查结论存档：

### 深拆体量核查（>1000 行为候补线）

| 模块 | 行数 | 卫星模块 | 结论建议 |
|---|---|---|---|
| codex.ts | 1695 | 4 个（app-server/sqlite-client/title/session-index） | P4 评估照旧 |
| opencode.ts | 1018 | 0 | 可纳入拆分评估 |
| codebuddy.ts | 1017 | 0 | 可纳入拆分评估 |
| workbuddy.ts | 825 | 0 | 低于候补线，建议不动 |
| pi.ts | 772 | 0 | 同上 |
| iflow.ts | 731 | 0 | 同上 |

### 树状结构支持度核查（按数据层能力分级）

| Provider | 子会话数据模型 | 现有呈现 | 可行性 |
|---|---|---|---|
| codebuddy | 独立文件 `subagents/*.jsonl`，id `codebuddy:sub:*`，projectKey 含父 id | 徽标+树状缩进+父前子后（P1 已做） | ✅ 已完成 |
| opencode | `session.parent_id` 列现成（opencode.ts:152） | 仅「子会话」徽标 | A 级：数据现成，接入成本低 |
| codex | `forked_from_id`（thread 分叉） | 无父子呈现（仅标题继承处理） | B 级：可做，fork 是"分叉"语义需定义呈现 |
| claude-code | transcript 内嵌 `isSidechain` 条目（非独立会话） | 无（sidechain 当噪音排除） | C 级：提升为独立条目成本高，建议仅父会话加「含子代理」徽标或不做 |
| workbuddy | `sessions` 表**无 parent 字段**（字段清单已核实 workbuddy.ts:82-96） | 无子会话概念 | D 级：数据层不支持，无法实现 |
| pi / iflow | 无子会话结构 | 无 | D 级：同上 |

### 实施路径建议（若批准）

1. **P6 树状通用化**：`ConversationMeta` 增加通用字段（`parentConversationId?`、`conversationKind?`、子代理名）；web `ConversationList` 去 codebuddy 硬编码改读通用字段；opencode 首个接入（parent_id → 通用字段 + 父前子后排序）。一次改造多 provider 复用。
2. **P7 codex fork 照应**：依赖 P6 字段，呈现方式需用户定（树状子项 or 仅「fork 自」徽标）。
3. claude-code sidechain / workbuddy / pi / iflow：数据层不支持或成本不匹配，建议明确记录"不做"结论。

> 注：用户表述「workbuddy 要实现」与事实不符——已实现树状缩进的是 CodeBuddy；workbuddy 会话表无父子字段，需向用户澄清。

## P4 codex.ts 评估结论（2026-10-06）：不再拆

- 现状：`codex.ts` 1680 行，类方法 42 个，已有 4 卫星模块
  （app-server / sqlite-client / title / session-index）。
- 剩余主体为 Provider 编排（list 索引、scan/extract、read 窗口、move 回滚、
  message mutation），方法间共享 `sqliteClient`、`backgroundRefreshes`、
  缓存键等实例状态，继续拆分需跨模块传实例或造新抽象，收益为负。
- 结论：保持编排 facade 现状，不再拆。后续若单方法膨胀超 200 行再按方法级抽取。

**症状**：WebUI 移动 workbuddy 对话到另一文件夹报「目标文件夹不合法」失败；但 DB 层已生效（列表/WorkBuddy 侧显示已移动），打开无对话内容。

**根因**（`workbuddy.ts` move，自 953d86f 引入即错，无测试覆盖）：
1. workbuddy 的 projectKey 是**完整 cwd 路径**（canonicalize 后含 `/`），而 move 第 2 步把它传给要求「单级目录名」的 `resolveProjectDirectory`（`includes("/")` 检查必抛「目标文件夹不合法」）。
2. **先改 DB 后搬文件、失败不回滚** → DB cwd 已更新而 transcript 留在旧目录的半完成状态；WorkBuddy 产品按 cwd 编码目录定位 transcript，新目录无文件 → 打开无内容。

**修复**：
- 新增 `encodeWorkBuddyProjectDir(cwd)`：按 WorkBuddy 真实存储布局把 cwd 编码为 projects 子目录名（`/`、`\` 分段、盘符去冒号小写、`-` 连接、拒绝 `.`/`..` 段防逃逸）。编码规则经 12 条真实数据（DB cwd ↔ projects 目录名）核对确认。
- move 顺序反转：先搬 transcript → 成功后更新 DB cwd → DB 失败回滚文件搬移（与 claude-code move 的「先文件后索引+回滚」模式一致）。
- 补测试 ×2（该 provider 首个测试）：移动成功（DB cwd/编码目录/read 内容/projectKey 四断言）+ 非法目标拒绝且 DB 与文件原状。new-providers.test.ts 8/8 全过；typecheck ✅ / eslint ✅。

**遗留**：用户此前失败移动留下的不一致会话（DB 新 cwd + transcript 旧目录），在 WebUI 对同目标重试一次移动即可自愈（修复后的 move 能通配定位旧文件并搬到正确位置）；若 WorkBuddy 侧仍显示无内容，重启 WorkBuddy 刷新其缓存。

## bugfix：七家 provider move 一致性核查（2026-10-05，用户要求确认 workbuddy 修复并排查其余 6 家）

**核查结论：无 workbuddy 类「必现」bug；web 三处入口（详情下拉/列表拖放/批量移动）均传会话 projectKey，与各 provider move 语义匹配。**

| Provider | projectKey 语义 | move 模式 | 结论 |
|---|---|---|---|
| claude-code | 单级编码目录名 | 先搬文件→改索引→快照回滚 | ✅ 健康（本就有同名防护） |
| codex | cwd 真实路径 | 先 rename→改写 session_meta→同步 state db→回滚 | ✅ 健康（本轮补同名防护） |
| opencode | cwd 真实路径 | 纯 DB 单步原子（数据全在 opencode.db，无文件搬移） | ✅ 健康 |
| iflow / pi | 单级目录名 | 单步原子 rename | ✅ 健康（本轮补同名防护） |
| codebuddy | 单级目录名 | rename + 附属子目录连带 | ◐ 修复两处（见下） |
| workbuddy | canonical cwd | 先文件后 DB + 回滚（上节已修复） | ✅ 修复确认（补同名防护） |

**本轮修复（对齐 claude-code 的防护标准）**：
1. 同名覆盖防护：iflow/pi/codebuddy/workbuddy 在 rename 前 stat 目标文件，已存在则抛「目标目录已存在同名 transcript」；codex 在 rename 前 stat `targetFilePath`（其回滚逻辑既有，抛错即走）。
2. codebuddy 附属子目录搬移失败不再静默吞掉：改为显式判断 `isDirectory()` 后搬移，失败回滚主文件 rename 再抛错，避免会话与附属数据分裂。
3. **workbuddy move 真 bug**：`locateTranscriptFile(...).catch(() => null)` 会把「定位到多个同名对话文件」吞成 null → 多副本异常状态下 move 静默只改 DB 不搬文件（半完成状态重现）。已改为定位异常直接传播（null 仅保留 metadata-only 会话语义）。注：iflow/codebuddy 的定位函数本就不吞此类错误（provider-indexing 测试 32「iFlow 拒绝多副本歧义定位」既有覆盖）。

**测试**：new-providers.test.ts 新增 ×2——workbuddy/codebuddy「目标已存在同名副本时拒绝移动且状态不变」（断言 `/定位到多个同名对话文件/` + 源文件与 DB 原状）。**验证：new-providers.test.ts 10/10 全过；provider-indexing.test.ts 33/33 全过（Codex move 迁移与回滚、iFlow 越界/多副本拒绝、OpenCode metadata 移动均在列，且此前 8 个环境失败全部通过——陈旧锁已清零干扰）；typecheck ✅ / eslint ✅。**

**残留环境现象（非代码问题）**：claude-code.test.ts 测试 1/8 出现 keyed 锁超时（`claude-title:`/`claude-move:` 前缀），三轮运行失败集合漂移（1、8 → 8 → 1、8），本轮未改动 claude-code 相关文件，同文件内 move 测试 7/9 稳定通过——定性为 `~/.chatlog-viewer/locks/` 69 个死锁文件（safe-delete 历史拦截所致）的暂态干扰，不绕过主机钩子删除，留 CI 或手动清空后复测。

## 深度核查：七家迁移逐项验证 + 架构调研（2026-10-05 用户三问）

### Q1 锁机制与"环境暂态"的准确解释（依据 mutation-queue.ts 179 行实现）

- **两级锁**：进程内 `pendingByKey` Map 串行 + 跨进程文件锁 `~/.chatlog-viewer/locks/<sha256(key)>.lock`（`open(wx)` 独占创建）。锁记录 `{key, ownerId, pid, hostname, createdAt}`，持有者每 10s 心跳刷新 mtime。
- **自愈设计**：等待方发现锁 mtime 超 120s（LOCK_STALE_AFTER_MS）→ 读记录 → 本机且 pid 仍活=真持有（不清）；pid 死=安全删除（verify mtime/size 后 rm）。等待 30s 超时抛 MutationConflictError。
- **死锁文件**：持有者进程死后遗留的 .lock。**无法自愈的陷阱**：Windows pid 复用使 `process.kill(pid,0)` 误判"活进程持有"→ 永不清除。69 个残留 = 测试进程被 safe-delete 钩子拦截后锁未删 + pid 复用。
- **集合漂移**：测试用固定 sessionId → key hash 固定 → 遗留锁命中与否取决于"该锁 mtime 是否已过 120s + 遗留 pid 是否被复用"，每轮时刻不同 → 命中集合不同 → 失败集合漂移。漂移本身即"非代码缺陷"的证据（代码路径固定则失败应稳定复现）。
- **为何手动清空而非绕过钩子**：①主机 safe-delete 钩子是用户环境对家目录批量删除的确认策略（SAFE_DELETE_BULK_CONFIRM_REQUIRED），绕过=越过用户安全边界；②锁文件是纯运行时数据，删除零信息损失；③机制本有自愈，手动清空只是加速；④CI 无此钩子，最终验证不受影响。

### Q2 七家迁移逐项核实（全部 ✅，含失败回退与一致性验证）

| Provider | 迁移内容完整性 | 失败回退 | 测试证据（全部通过） |
|---|---|---|---|
| claude-code | transcript + sessions-index 源删目增 + session 目录连带 | 先文件后索引；快照恢复双 index + 文件搬回；组合错误报"回滚失败" | claude-code.test.ts move ×3（越界拒绝/迁移成功/注入回滚）隔离跑 3/3 |
| codex | rollout 文件 + `session_meta.cwd` 重写 + state db `threads.cwd/rolloutPath` | 先文件后 DB；回滚写回原内容+搬回+双路径缓存清理 | provider-indexing 测试 27/28 |
| opencode | DB `session.directory/path`（消息全在 DB，无目录耦合、无文件搬移） | 单步原子 UPDATE | provider-indexing 测试 12 |
| iflow | jsonl 单文件（存储无附属概念，delete=unlink+清空目录佐证） | 单步原子 rename + 同名/越界/多副本防护 | provider-indexing 测试 31/32 |
| pi | 同 iflow | 同上 | new-providers 测试 3 |
| codebuddy | jsonl + `<sid>/` 附属子目录（含 subagents 子会话） | rename + 子目录连带；子目录失败回滚主文件再抛错 | new-providers 测试 6 + 10（多副本拒绝） |
| workbuddy | DB cwd + `projects/<编码目录>/<sid>.jsonl` | 先文件后 DB + 回滚 + 定位异常传播（上轮修复） | new-providers 测试 7/8/9 |

**"显示已迁移而实际未迁移"不可能复发的机制**：①list 为实时扫描 + 精确缓存失效（`invalidateConversationCaches` 含 list 缓存）；②前端 move 成功才 `refresh()` 重扫，失败仅 toast 不动列表（App.tsx:261-268）；③workbuddy 历史反例已修复并被 3 个测试锁定；④所有故障路径显式抛错，无静默降级。

**诚实边界**：①claude-code move 的 session 目录搬移有实现（claude-code.ts:702-736）但测试未构造该场景（覆盖缺口，小）；②"回滚也失败"的双重故障下 workbuddy 可能留下"列表显示旧文件夹 + 文件在新目录"状态——内容不丢、重试即愈（locate 通配可找到），文件系统无事务故无法承诺 100% 原子。

### Q3 架构与冗余调研（server 18489 行 / web 7577 行，非测试）

**抽象良好**：utils 基建层（jsonl 430 / message-actions 376 / mutation-queue 179 / cache 三模块 / provider-utils 206）被 5-6 家共享（normalizeUpdatedMessageContent、parseJsonlWithMeta、rewriteJsonlFileLine(s)、runKeyedMutation 等）；能力模型驱动前端自适应；codex 4 + claude-code 5 卫星模块先例；故障注入/回滚/越界/多副本测试文化。

**仍存的跨家模板重复（非架构性）**：
1. `resolveMessageLineNumbers` 5 家 × ~26 行逐字重复（仅类型泛型与错误前缀不同，约 130 行）→ **最高性价比收敛点**（抽 message-actions 泛型 helper）。
2. iflow/pi 的 `move` 22 行 × 2 逐字同、`findConversationFilePath` iflow/pi/codebuddy 三家同构 → 可抽 shared。
3. updateMessage/deleteMessages 的"resolve→rewrite→invalidate"编排 5 家重复（各家 entry/文本块类型不同，收敛需解析适配器，收益中等）。
4. `utils/cache.ts`、`utils/ai.ts` 双层兼容 re-export（迁移期产物）→ P5 后可收口。
5. 大文件盘点：provider-paths.ts 1176 行职责聚合（配置+路径+标题 CLI 配置+迁移写入，可拆）；codex.ts 1698 行主体为编排+解析（P4 评估中）；title-manager.ts 1060（独立 CLI）；ProviderPathsDialog.tsx 904（web 最大）。

**性能**：三层缓存（内存 LRU → meta-cache.sqlite TTL 30s → 原始解析）、mtime 签名增量解析、FTS5、GroupedVirtuoso 虚拟滚动、better-sqlite3 同步 IO（本地单用户正确选型）、keyed mutation 防并发写坏、bench/ 目录有基准意识。未发现反模式（无反复全量扫描/N+1）。

**结论**：架构健康。冗余为跨 provider 模板代码级（约 200-300 行可收敛），不是结构性重复；性能设计贴合本地单用户场景。

## 改进收敛批次（2026-10-05 用户批准执行，已完成）

### R1 锁目录清理 + 瞬态失败根因修正

**根因修正**（推翻此前「死锁文件/配额」归因）：`mutation-queue.ts` 的锁 key（如 `claude-move:<sessionId>`）跨运行共享；等待方仅在锁 mtime 超 120 秒后才做 pid 判死接管，否则最多等 30 秒即抛 `MutationConflictError`。而测试释放锁的 `rm` 被主机 safe-delete 钩子拦截 → 锁文件残留（mtime 冻结）。**背靠背连跑（间隔 <120 秒）时后一轮命中前一轮残留的"新鲜"锁 → 白等 30 秒超时**。死锁文件（pid 已死 + mtime 过期）其实无害（120 秒后自动接管清理）。所有"失败集合漂移"观察均由此解释。

**处置**：经用户批准，备份后清空 `~/.chatlog-viewer/locks/`（备份在 `~/.chatlog-viewer/locks-backup-20261005/`，纯运行时数据可删）；在 4 个测试文件（claude-code / provider-indexing / new-providers / conversations）顶部加 `CHATLOG_VIEWER_LOCK_DIR = <tmpdir>/chatlog-viewer-test-locks-<pid>`（mutation-queue 原生支持，mutation-queue.test.ts 已有先例），每进程独占锁目录，背靠背连跑不再争用。

**验证**：三文件连跑（此前必现瞬态失败的场景）10/10 + 33/33 + 10/10。

### R2 resolveMessageLineNumbers 六家收敛

claude-code/codebuddy/codex/iflow/pi/workbuddy 各自逐字重复的私有方法（约 27 行/家，workbuddy 为 `resolveTranscriptMessageLineNumbers`）收敛为 `utils/message-actions.ts` 的 `resolveMessageLineNumbers<TEntry>(filePath, mtimeMs, messageIds, buildRecords)`——构建 records 的差异以回调注入（codex 需额外 `{ filePath, mtimeMs }` options）。每家删除私有方法、改共享调用（每家 2 个调用点），`getMessageActionLineNumbers` 从各家 import 移除（`primeMessageActionIndex` 在 read 路径仍用，保留）。净删约 160 行。

### R3 iflow/pi move 抽取

两家 move 除 id 前缀外逐字相同，抽取为 `shared/provider-utils.ts` 的 `moveTranscriptFileToProject({ basePath, targetProjectKey, findSourceFile })`：单级目录名校验 → 建目录 → 目标同名拒绝 → 同路径返回 null → 原子 rename。语义与原实现一致（同路径不触发缓存失效）。codebuddy 的 move 含附属子目录逻辑，暂未并入（可后续复用该 helper）。

### R4 cache/ai 兼容层收口

删除 `utils/cache.ts`、`utils/ai.ts` 两个 `export *` 兼容入口（20 处消费方 import 全部直连 `utils/cache/index.js` / `utils/ai/index.js`），确立「目录 + index 直连」约定（不再保留双层 re-export）。工具教训：Git Bash sed 用 `|` 作 `s` 分隔符时 `\|` 是字面竖线而非交替，导致首次替换静默零匹配（exit 0 无告警）；改用 `#` 分隔符解决。

### R5 provider-paths.ts 拆分（1176 行 → 8 模块）

`utils/provider-paths/` 目录，依赖无环（update → {config, title-cli, migration, resolve}；migration → resolve → config；公共 path-style）：

| 模块 | 职责 |
|---|---|
| types.ts | 全部类型（原内部接口跨模块需要，改为导出） |
| path-style.ts | 跨平台路径风格工具（getPathKey/resolvePathValue/joinStyledPath 等） |
| config.ts | 配置加载/写入（configLoadCache、getProviderConfigPath、loadAppConfig、writeJsonFileAtomically） |
| title-cli.ts | 标题生成 CLI 配置（常量 + normalize/get 七函数） |
| resolve.ts | 存储路径解析（providerPathCache、resolveProviderPaths、候选探测、resolveOpenCodeCliDbPath） |
| migration.ts | 路径迁移（staging/commit/rollback + 安全检查 + sqlite 独占锁探测/backup） |
| update.ts | updateProviderConfigs 编排 |
| index.ts | 显式 re-export（对外公共面不变；loadAppConfig 等内部函数不外露） |

原 `providerPathCache`/`configLoadCache` 双缓存拆属两模块，`clearProviderPathCache` 经 `clearConfigLoadCache` 保持原有"清两层"语义。20 个消费方 import 全部更新为 `provider-paths/index.js`。

### 本批验证记录

- typecheck ✅（每步后跑）/ eslint ✅（全部触及文件）
- 五个核心测试文件连跑：claude-code 10/10 + provider-indexing 33/33 + new-providers 10/10 + cache 13/13 + conversations 42/42 = **108/108 全过**
- provider-paths.test.ts 18/18（覆盖 resolve/config/update/migration 链路）、ai.test.ts 16/16

### 变更清单增补（本批，全部未提交）

- M `utils/message-actions.ts`（+resolveMessageLineNumbers，+jsonl import）
- M `providers/{claude-code,codebuddy,codex,iflow,pi,workbuddy}.ts`（R2 收敛 + iflow/pi R3 + import 更新）
- M `providers/shared/provider-utils.ts`（+moveTranscriptFileToProject、fs import）
- M `providers/new-providers.test.ts`、`provider-indexing.test.ts`、`claude-code.test.ts`（LOCK_DIR 隔离 + cache import 直连）
- D `utils/cache.ts`、`utils/ai.ts`；M 20 处 import 直连（providers/routes/services/cli/utils）
- ?? `utils/provider-paths/`（8 模块）；D `utils/provider-paths.ts`；M 20 处消费方 import
- M `routes/__tests__/conversations.test.ts`（LOCK_DIR 隔离 + cache import 直连）

提交切分建议更新：R2-R5 可并入 ① 同批提交，或独立 `refactor(server): 收敛 provider 重复与拆分 provider-paths`；R1 测试隔离改动随 ①。
