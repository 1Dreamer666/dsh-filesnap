# DSH Rewind & Redo — by FileSnap：宣传素材包

[English](PROMOTION.md)

本文供维护者统一仓库元数据、演示和发布文案。公开结论应与当前 README 和带日期的审计一致。

## 产品名称

- 对外展示名：**DSH Rewind & Redo — by FileSnap**。
- npm 包名和仓库名：`dsh-filesnap`。
- 安装命令：`dsh plugin --profile web add dsh-filesnap`。
- 引擎：FileSnap（npm 包名 `filesnap`）。
- 首次介绍时同时写展示名和包名，后文可简称 `dsh-filesnap`；链接、命令和包标识保持原样。
- 小红书等短标题优先写用户问题，完整展示名放正文，不挤占标题字数。
- 本次只更新展示名称，用户不需要迁移或重新安装。

## GitHub 仓库元数据

**About 描述**

> DSH Rewind & Redo — by FileSnap. A DeepSeek Harness plugin that restores conversations and tracked files together, preserves the original conversation in a branch, and lets /redo reverse the rewind. No Git required.

GitHub About 与 `package.json` 使用上面同一段英文。中文目录使用：

> DSH Rewind & Redo — by FileSnap（dsh-filesnap）：同步回退 DeepSeek Harness 对话与已跟踪文件，保留原对话，在新分支继续；/redo 可撤销回退。无需 Git 仓库。

**Website**

> https://www.npmjs.com/package/dsh-filesnap

**Topics**

```text
deepseek-harness
dsh-plugin
coding-agent
ai-agent
rewind
redo
workspace-snapshot
agent-safety
git-free
rust
```

**Social preview**

在仓库 Settings → Social preview 上传
[`assets/social-preview-whale-girl.jpg`](../assets/social-preview-whale-girl.jpg)。源图为 1280×640、低于 1 MB；
它保留在 Git 仓库中，但刻意不进入 npm tarball。

## 信息顺序与比较依据

1. **空间：** 相同内容跨保留版本、路径或共享存储内的会话重现时，FileSnap 可复用正文；7 组存储实验中 4 组正文副本更少，3 组相同。
2. **回退：** 对话与已跟踪文件联动；原对话保留，`/redo` 可撤销回退。
3. **跨助手经验：** 设计源自 Codex 回退实践，独立引擎已接入 DSH 和 Pi。
4. **实现：** TypeScript 接入宿主，Rust 实现存储引擎。去重优势来自内容寻址设计，语言本身不构成性能结论。
5. **边界：** 覆盖已知路径、观察到的写入与有界近期扫描。卸载不删除对话记录或工作区文件；含插件记录的会话需要重装后重新打开。

可以直接比较 SiriLee 的 `dsh-rewind-plugin 0.9.1`，标明本方 `dsh-filesnap 0.2.2` / `filesnap 0.4.0`、日期和[复现证据](../docs/dedup-comparison.zh.md)。正文副本不能替代总磁盘占用；不要把对方自述的去重功能归因为作者对 FileSnap 的负面评价。

## 跨助手应用：所有文章共用

FileSnap 的快照设计源自我们已发布的 [codex-rewind](https://github.com/extracurricular-ai/codex-rewind)（`codexr`）实践，独立引擎已用于 DSH 的 `dsh-filesnap` 和 Pi 的 [pi-better-rewind-redo](https://github.com/extracurricular-ai/pi-better-rewind-redo)。截至 2026-09-10，DSH 插件发布版为 0.2.2，依赖 `filesnap ^0.4.0`；Pi 扩展发布版为 0.1.1，依赖 `filesnap 0.5.0`；Codex 增强发行版为 0.151.0-rewind.0，保留同源的内置快照模块。

这套设计已积累 Codex、DSH 和 Pi 的轮次接入、文件恢复与 redo 实践，是我们说明工程成熟度的具体依据。Codex 保留内置实现，DSH 与 Pi 使用不同版本的独立引擎；各自的兼容性与验证范围见项目文档。

[公开版本、源码与验证范围](../docs/cross-assistant.zh.md)。用具体的接入经验说明成熟度；未经同条件验证，不写比竞品更稳定或所有助手同步共享修复。

## 当前演示素材

使用已发布的完整横屏演示：中文 [B 站](https://www.bilibili.com/video/BV1BiYT6qEjs/) 2:24，英文 [YouTube](https://youtu.be/WPEXKesR_EM) 2:29。音画同步 1.5 倍速，保留删文件、恢复和 redo 的过程。20 秒剪辑不再作为主素材。

## 短发布文案

> DSH Rewind & Redo — by FileSnap（dsh-filesnap）：把 DeepSeek Harness 对话和已跟踪文件
> 一起恢复，保留原对话，在新分支继续。回退点选错了？`/redo` 撤销这次回退。无需 Git 仓库。

附仓库链接；平台支持视频时优先附功能演示，而不是静态卡片。

## 长发布文案

> Coding agent 的一次回退有两半：对话，以及它改过的文件。只恢复其中一半，会留下一个
> 从未真实存在过的状态。
>
> dsh-filesnap 在每个 DeepSeek Harness 轮次前捕获工作区，在明确 point 处 fork 对话，把
> 文件还原进同一个 fork，并且在写入前先创建救援点。`/redo` 可以撤销这次回退。它不要求
> Git 仓库，也不会修改 commit、branch、stash 或 worktree 状态。
>
> 快照引擎 filesnap 是一个内容寻址 Rust 二进制。当前 warm-cache 初步测量：本插件仓库
> 重复捕获 8 ms；在拥有 70,918 个文件的 harness checkout 中捕获 7,995 个相关文件为
> 268 ms。测量方法和限制均公开在仓库中。
>
> 卸载插件不会删除对话记录或工作区文件；包含插件记录的会话需要重装插件后才能在 DSH 中重新打开。

## Release note 模板

```md
## 改了什么

<一句话描述用户可见的结果。>

## 为什么重要

- <移除了什么问题，或缩短了什么流程>
- <安全/性能影响；相关时附证据>

## 升级

<无需操作，或准确步骤。>

## 已知限制

<只写本次 release 影响的限制，并链接完整列表。>

## 验证

- tests：<数量/结果>
- 实际验证的 profile/platform：<列表>
```

每个 release 附一张截图或短视频，直接展示最主要的变化。

## 宣传结论规范

- 竞品对比必须带日期和准确包版本。
- 性能结论必须链接机器元数据和复现步骤。
- 区分“设计/测试支持”与“在某个部署观察到”。
- 卸载限制必须紧邻安装步骤。
- 仍需 profile row 时不要宣称“zero config”。
- 重复使用“唯一”或“最快”之前重新核对对比审计。
