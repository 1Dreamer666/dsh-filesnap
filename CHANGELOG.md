# Changelog

## Unreleased

- 兼容两代持久化接口读取冷会话、枚举迁移日志和定位原始文件，修复 0.2.x 下 `persistence.inspect is not a function`（#17，修复 #16）。
- Read cold sessions, list migration logs and locate raw artifacts through either persistence generation, fixing `persistence.inspect is not a function` on 0.2.x (#17, fixes #16).
- 子代理克隆使用原始会话 ID 的稳定标识，避免同毫秒创建的不同子代理被误去重；冷加载后连续回退仍继承最新克隆，旧运行时也递归携带切点之前的后代。
- Identify carried subagents by their original session ID so siblings created in the same millisecond stay distinct. Repeated rewinds after cold reloads extend the latest clone, and legacy runtimes also carry descendants recursively at the fork point.

- 回退后的分支现在携带被保留轮次中派生的子智能体信息：在分支下克隆每个子会话并重写血缘（创建时间、工作目录、预设与深度保持不变），子智能体因此在分支中可见、可继续；不具备 catalog 词汇表的运行时只克隆、不写入其读不懂的事件，单个子会话失败仅告警、回退本身不受影响。
- A rewound branch now carries the subagents spawned in its retained turns: every child session is cloned under the branch with its lineage rewritten (creation time, workspace, preset and depth preserved), so it is both visible and continuable there. Runtimes without the catalog vocabulary clone without writing events they cannot read, and one child's failure only warns — the rewind itself never fails.
- 回退分支携带的子智能体现在按回退切点级联截断：切点之后出生的孙代理不再带入，被携带的子孙代理各自回到切点时刻的状态；撤销回退（redo）回到原件时完整家族原样在位。
- Carried subagents are now cut recursively at the fork point: descendants born after the cut are left behind, carried ones return to their state at the cut, and redoing the rewind lands back on the untouched original with its full family intact.
- 首次 points 读取失败后允许重新打开会话重试，并为仍显示的会话安排一次延迟重试；新请求取消过期重试，同一 revision 的消费者共享正在进行的自动重试，避免恢复后的回退按钮再次消失（#14，修复 #13）。
- Retry failed initial points reads on reopening, with one delayed retry while the view remains visible. New requests cancel stale retries, and consumers of the same revision share an in-flight automatic retry so recovered rewind buttons stay available (#14, fixes #13).

## 0.4.1

- 当 Connection 服务注册通道时访问不到 `webServer`（桌面端的 0.2.0-rc.2 构建），UI 通道改为直接挂载到宿主 web server 上的同一前缀路由；准入、信封校验与请求体上限不变，浏览器操作不再落到 405。
- Mount the UI channel directly on the host web server when the Connection service cannot reach `webServer` while registering a channel (the Desktop app's 0.2.0-rc.2 build). Admission, envelope validation and the body cap are unchanged, and browser actions no longer meet the 405.
- 兼容新旧客户端的会话导航和输入框附件字段，修复回退完成后新分支不打开、提示词不回填的问题；不覆盖已有草稿或附件（#11，修复 #9）。
- Resolve session navigation and composer attachment fields across client generations so a completed rewind opens its branch and refills an empty composer without replacing drafts or attachments (#11, fixes #9).
- 按运行中客户端导出的新旧名称选择图标，缺失时使用空图标兜底，避免回退、撤销回退及快照控件因 React 元素类型错误而崩溃（#12，修复 #10）。
- Resolve icons from the running client's current or legacy exports, with an empty glyph fallback, so rewind, redo and snapshot controls do not crash on missing icon exports (#12, fixes #10).
- 本版包含 #7、#11、#12，感谢 @1Dreamer666 的报告和修复。依赖及引擎版本要求不变。
- Includes #7, #11 and #12. Thanks to @1Dreamer666 for the reports and fixes. Dependencies and engine requirements are unchanged.

Known limitations / 已知限制：

- 首次 points 读取失败后的重试问题（#13）、回退分支携带子代理（#6）以及持久化 0.2.x 的冷分支读取和迁移兼容问题（#16）尚未修复；本版不代表全面兼容 harness 0.2.x。
- Failed initial points reads (#13), carrying subagents into rewind branches (#6), and cold branch reads and migration compatibility with persistence 0.2.x (#16) remain unresolved. This release does not establish full harness 0.2.x compatibility.

## 0.4.0

- 新增「设置 → FileSnap → 中断恢复」：预览继续或回滚未完成的回退与 redo，确认时重新检查文件，冲突时停止。
- 修改文件前持久化命名救援点及独立恢复状态；完成状态和 redo 栈一起提交，避免结果丢失后重复消费。必要元数据不写入对话，卸载不影响原生会话读取。
- 复用已发布的 FileSnap 0.5.1+，本次无需引擎更新。新恢复流程覆盖本版创建的回退及其 redo；旧版回退保留兼容路径。
- Add an independent interrupted-restore panel, durable host recovery metadata, repeatable rescue targets and conflict-checked confirmation. Block new Agent work in a workspace awaiting recovery.
- Verify actual host process termination before/after applying files, partial application, interrupted rollback, redo preservation and fresh-process conversation loading.

Limits: local workspace, one DSH process, no concurrent external writes. Changed ignore rules must be restored before recovery preview. This does not promise multi-file atomicity across machine power loss.

## 0.3.2

- Treat a missing or consumed undo record as a normal empty state in the redo dialog, command menu and headless command. Remove misleading engine-upgrade hints and restore/retry controls for this state; preserve actual engine errors.
- After a successful redo, check for remaining undo records and archive only an exhausted fork through the host's public archive API. Preserve conversations and snapshots; keep branches visible after file failures, remaining undo records or archive errors.
- Return to the original conversation after automatic archiving, including when the host archive update unmounts the old branch before the RPC returns.
- Engine requirement remains FileSnap 0.5.1+. No engine release is needed for this patch.

## 0.3.1

- Require file preview and single-use confirmation for `/redo` and the header redo button; recheck workspace, target and ignore rules before applying. Requires FileSnap 0.5.1.
- Mark branches `🟢 Active ·` / `🔴 Inactive ·` after successful rewind or redo; recognize legacy prefixes.
- Run versioned migrations automatically on plugin load (configurable with `autoMigrate`). Back up unloaded legacy logs and append native title revisions for old markers. Show startup results and keep manual retries in Settings.
- Host compatibility remains tested against DSH 0.1.2-rc.1. Source review of 0.1.5-rc.1/master finds session forks and archive APIs, but no message branch pager or public unarchive API.

Publish engine 0.5.1 before installing/publishing plugin 0.3.1.

## 0.3.0

- Bare `/rewind` opens the native searchable turn picker in the web UI, then the file preview and confirmation dialog.

- Preview the complete file impact list and require confirmation before browser or command rewinds. Recheck workspace state and ignore rules before restoring.
- Move browser actions from chat commands to independent authenticated RPC. No new `filesnap/*` session events, operation journals or command-result cards from buttons.
- Resolve snapshots using the engine index and DSH native fork lineage, including cold ancestors. New conversations reopen without the plugin installed.
- Add an independent workspace snapshot panel with records/shared content usage, per-session snapshot counts and excluded files.
- Add confirmed collection of unreferenced snapshot data; retain snapshots and redo recovery data.
- Add Settings → FileSnap → Data migrations, with a versioned task catalogue, read-only scan, confirmation, backup, stale-file checks and per-session results. The first task makes legacy session events ignorable. An offline tool is included for installations whose UI cannot start.
- Refill the complete original prompt only when the destination composer is empty; preserve drafts and images. Redo results provide an action to open the original conversation.
- Refresh bilingual documentation and the website. Historical performance/comparison evidence retains its original version labels.

Compatibility: validated with DSH 0.1.2-rc.1 and FileSnap 0.5.0. Loaded sessions are skipped by migration. Stop other DSH processes sharing the same session directory before migration. Legacy conversations need migration before opening without the old event registration. Keep ancestor conversations and snapshot data for inherited recovery points.

Integration changes: `filesnap` projection now contains structural anchors only; browser results use RPC. Custom event declarations and outcome `eventSeq` fields have been removed.
