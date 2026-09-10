# DSH Rewind & Redo — by FileSnap

[![npm](https://img.shields.io/npm/v/dsh-filesnap?color=cb3837&logo=npm&logoColor=white)](https://www.npmjs.com/package/dsh-filesnap)
[![CI](https://github.com/extracurricular-ai/dsh-filesnap/actions/workflows/ci.yml/badge.svg)](https://github.com/extracurricular-ai/dsh-filesnap/actions/workflows/ci.yml)
[![许可证](https://img.shields.io/npm/l/dsh-filesnap?color=1f6feb)](LICENSE)

[English](README.md) | 中文

**dsh-filesnap 是 DeepSeek Harness（DSH）的对话与文件回退插件。** 先查看将写回、恢复或删除的文件，确认后一起回退对话和已跟踪文件。原对话保留为分支，选错了可以用 `/redo` 撤销回退，无需 Git。

**0.3.0：独立文件预览、磁盘占用与清理面板，以及多版本数据迁移入口。** 按钮通过独立 RPC 获取结果，不往对话历史写操作日志。新会话卸载插件后仍可打开；旧版会话可在设置中扫描并迁移。

![dsh-filesnap：对话与工作区一起回退](assets/social-preview-whale-girl.jpg)

[完整中文演示（旧版）· 2:24](https://www.bilibili.com/video/BV1BiYT6qEjs/) · [English walkthrough（旧版）· 2:29](https://youtu.be/WPEXKesR_EM)

## 安装

```console
dsh plugin --profile web add dsh-filesnap
```

需要 DeepSeek Harness（本版集成验证使用 **0.1.2-rc.1**）、Node.js `^22.19` 或 `>=24`。支持 Linux、macOS、Windows 的 x64/arm64；FileSnap 0.5.0+ 引擎随插件安装。headless 用户把 profile 改为 `headless`。

重启对应 profile 即可，不需要手动添加 loader。若从 0.2.1 或更早升级，先删除 `~/.dsh/profiles/<profile>/cordis.patch.yml` 中手写的 `id: filesnap` 条目，避免与内置 bundle 重复。

## 回退与撤销

1. 让 DSH 完成至少两轮任务。已有可恢复快照时，assistant 回复的操作行会显示回退按钮。
2. 点击按钮，检查目标轮次与文件变更清单；取消或 Esc 关闭不会创建分支或恢复工作区文件。
3. 确认后创建分支并恢复文件，再打开新分支。原始提示词会回填到空输入框，不覆盖已有草稿或图片。
4. 选错了回退点，在新分支点击“撤销回退”或执行 `/redo`。结果在独立面板展示。

文件状态、忽略规则或轮次在预览后改变时，需要重新预览；确认令牌五分钟过期且只能使用一次。部分恢复失败会列出受影响路径，不会显示为无事发生。[完整流程与边界](docs/rewind-preview.zh.md)。

## 工作区快照与空间清理

点击会话头部的 **“查看快照状态”**，打开独立的“工作区快照”面板：

- **当前工作区索引**和**共享文件内容**分别展示，避免把跨工作区共享内容误算成当前项目独占空间。
- 查看各会话持有的快照轮次数，以及未受保护文件及原因。
- 在面板内点击空间清理，核对范围后确认。只回收未被引用的数据，保留现有快照、redo 救援数据和工作区文件。
- 清理完成后刷新占用。显示的是当前用量，不是预计释放量；仍被快照引用的内容不会释放。

不自动删除旧会话或过期快照，自动清理策略尚未提供。按钮结果不会追加到聊天记录。

## 数据迁移与卸载

打开 **DSH 设置 → FileSnap → 数据迁移**。这是今后各版本迁移共用的入口：选择迁移任务，扫描旧版数据，核对逐会话清单，再确认迁移。

本版任务为 **旧版会话兼容迁移 → 0.3.0+**：将旧 `filesnap/*` 事件标为宿主可忽略，保留消息内容、序号与分支边界。每份修改过的日志旁都会保存原始备份；已兼容的数据自动跳过。已加载的会话会被跳过，关闭后重新扫描；若仍显示占用，重启 DSH 后先进入设置，不要打开目标会话。

**新会话不再写自定义事件，卸载插件后仍可打开。旧会话需完成迁移。** 当前迁移支持 DSH JSONL 与 Zstd 压缩日志，不修改其他插件的事件。[迁移说明与离线修复](docs/migrations.zh.md)。

## 命令

| 命令 | 结果 |
|---|---|
| `/rewind` | 列出当前对话可恢复的轮次。 |
| `/rewind <turn>` | 预览回退到该轮之前会改变的文件。 |
| `/rewind <turn> --confirm <token>` | 使用预览令牌确认恢复。 |
| `/redo` | 撤销当前分支承接的回退。 |
| `/rewind status` | 输出工作区保护范围和磁盘占用。 |
| `/rewind cleanup` | 预览空间清理范围，返回确认令牌。 |
| `/rewind cleanup --confirm <token>` | 回收未引用数据。 |

手动输入的命令仍由 DSH 展示标准命令结果，不触发模型轮次；浏览器按钮直接调用 RPC。headless 回退返回新分支 id，需要自行打开。

## 与 dsh-rewind-plugin 怎么选

双方都支持对话与文件联动恢复和 Web 操作。SiriLee 的方案强调同窗口原地回退、仅对话模式与快捷键；本插件强调**保留原对话分支、`/redo` 撤销回退、跨路径和快照的内容去重复用**。

不要只按名称判断，也没有经过验证的“公认最好”排名。参见[源码对比](docs/comparison.zh.md)、[界面 FAQ](docs/faq.zh.md)。原存储实验基线为插件 **0.2.2** 和引擎 **0.4.0**，不能当作本版重新测量的结果：[7 组去重实验](docs/dedup-comparison.zh.md)。

## 覆盖范围与限制

- 恢复依赖事先捕获；支持二进制、Git 忽略文件，以及经 `ctx.fs` 观察到的项目外编辑。忽略规则、大小限制和捕获时机仍影响覆盖。
- 快照先于工具执行保存；写入/编辑前观察旧内容。它不是整台电脑的备份。
- 分支共享同一工作区；切换对话本身不切换文件副本。继承快照通过原生分支来源定位，需要保留祖先会话及对应快照数据。
- 第一个轮次前没有可保留的完整轮次，因此不提供该处的浏览器回退按钮。
- 预览不是工作区锁；外部编辑器与最终写入仍可能并发。文件恢复被拒后，已创建的空分支可能留在会话列表中。
- 尚无仅回退对话模式、逐文件勾选恢复、逐行 diff 和新的全局快捷键。

## 配置

| 字段 | 默认值 | 用途 |
|---|---|---|
| `command` | 自动解析 | 可选的引擎可执行文件。 |
| `dataDir` | 平台数据目录 | 独立快照存储位置，不写进项目。 |
| `timeoutMs` | `120000` | 单次引擎调用时限。 |
| `graceMs` | `2000` | 取消/超时后的终止宽限时间。 |
| `maxOutputBytes` | `1048576` | 每条输出流的内存上限。 |
| `declareEdits` | `true` | 通过文件系统接口观察写入前的内容。 |

## 更多文档

[工作原理](docs/architecture.zh.md) · [迁移](docs/migrations.zh.md) · [排障](docs/troubleshooting.zh.md) · [路线图](docs/roadmap.zh.md) · [基准测试](docs/benchmarks.zh.md) · [跨助手实践](docs/cross-assistant.zh.md) · [贡献指南](CONTRIBUTING.zh.md)

[讨论](https://github.com/extracurricular-ai/dsh-filesnap/discussions) · [报告问题](https://github.com/extracurricular-ai/dsh-filesnap/issues) · [许可证](LICENSE)
