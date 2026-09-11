export const pageDefinitions=[
 {slug:'',group:0,en:['Overview','dsh-filesnap adds rewind and redo controls to the DeepSeek Harness chat UI. Restore conversations and tracked files together.'],zh:['概览','dsh-filesnap 在 DeepSeek Harness 聊天界面提供回退与 redo 操作。对话和已跟踪文件一起恢复，原对话保留。']},
 {slug:'screenshots',group:0,en:['Screenshots & versions','Actual 0.4.0 screenshots, recovery and migration UI, and the preserved 0.2.2 gallery.'],zh:['截图与历史版本','0.4.0 真实界面、中断恢复与迁移面板，以及保留的 0.2.2 历史截图。'],doc:'screenshots'},
 {slug:'guide',group:0,en:['Quick start','Install dsh-filesnap and complete your first file recovery, conversation rewind and redo.'],zh:['快速开始','安装 dsh-filesnap，完成第一次文件恢复、对话回退与 redo。'],file:lang=>`site/content/guide.${lang}.md`},
 {slug:'faq',group:2,en:['UI & integration FAQ','Does dsh-filesnap have a Web UI? DSH turn integration, file deduplication, compatibility evidence and release process explained.'],zh:['界面与集成 FAQ','dsh-filesnap 的 Web UI、DSH 轮次接入、文件去重、兼容性证据与发布流程。'],doc:'faq'},
 {slug:'comparison',group:1,en:['Compare plugins','FileSnap vs dsh-rewind-plugin: content reuse, conversation preservation and reversing a rewind.'],zh:['插件对比','FileSnap 与 dsh-rewind-plugin 的去重、原对话保留和回退撤销对比。'],doc:'comparison'},
 {slug:'deduplication',group:1,en:['Deduplication evidence','Seven reproducible storage experiments with FileSnap 0.4.0 and dsh-rewind-plugin 0.9.1.'],zh:['去重实验与证据','FileSnap 0.4.0 与 dsh-rewind-plugin 0.9.1 的七组可复现存储实验。'],doc:'dedup-comparison'},
 {slug:'architecture',group:2,en:['How it works','Capture boundaries, content-addressed storage and the ordering of conversation and file recovery.'],zh:['工作原理','捕获边界、内容寻址存储，以及对话与文件恢复的执行顺序。'],doc:'architecture'},
 {slug:'ecosystem',group:1,en:['Across coding assistants','The FileSnap design’s Codex origins and standalone engine integrations in DSH and Pi.'],zh:['跨助手应用','FileSnap 的 Codex 设计来源，以及独立引擎在 DSH 与 Pi 中的接入。'],doc:'cross-assistant'},
 {slug:'recovery',group:2,en:['Interrupted restores','Preview and continue or roll back interrupted rewinds and redo without writing operation logs into conversations.'],zh:['中断恢复','在独立设置面板预览继续或回滚中断的回退和 redo，不向对话写操作日志。'],doc:'recovery'},
 {slug:'migrations',group:2,en:['Data migrations','Scan and migrate legacy conversation data with versioned tasks, confirmation and backups.'],zh:['数据迁移','多版本数据迁移入口：扫描旧会话，确认清单，保留原始备份。'],doc:'migrations'},
 {slug:'roadmap',group:2,en:['Roadmap','Implemented recovery features and planned retention, diffs and workflow improvements.'],zh:['路线图','已实现的恢复能力，以及保留策略、内容 diff 与操作改进计划。'],doc:'roadmap'},
 {slug:'troubleshooting',group:2,en:['Troubleshooting','Resolve installation, profile, session reopening and native-engine issues.'],zh:['排障指南','处理安装、profile、会话读取及原生引擎问题。'],doc:'troubleshooting'}
];
for(const p of pageDefinitions) if(p.doc)p.file=lang=>`docs/${p.doc}${lang==='zh'?'.zh':''}.md`;
