# 完成第一次回退

恢复已捕获的文件，保留完整原对话；如果选错了点，再撤销这次回退。本教程使用 Web UI，基于 **dsh-filesnap 0.2.2**。

## 安装插件

准备 Node.js **^22.19 或 >=24** 和 DSH Web UI profile。安装包支持 Linux、macOS、Windows 的 x64 或 arm64，内置 Rust 原生引擎，无需安装 Rust 工具链或创建 Git 仓库。

```sh
dsh plugin --profile web add dsh-filesnap
```

安装后重启对应 Web UI profile。0.2.2 自带 bundle，不需要手动添加 loader。若要复现本教程版本，改为安装 `dsh-filesnap@0.2.2`。

**从旧的手动配置升级？** 启动 0.2.2 前，在 profile 的 `cordis.patch.yml` 中删除旧的手动 `id: filesnap` 加载项，保留其他条目。具体操作见 [安装排障](../../docs/troubleshooting.zh.md)。

## 1. 先留下可以恢复的状态

从测试工作区开始。分别在几个完整轮次中，让 agent 创建 `data.txt`、修改内容，再删除文件。FileSnap 必须提前捕获状态才能恢复，安装前已丢失、从未捕获的内容无法凭空恢复。

悬停在已完成的 assistant 轮次旁，找到回退控件。读取提示中的实际目标轮次和文件覆盖范围。

![回退控件提示目标轮次和已捕获文件](../../assets/shot-1-turn-control.png)

## 2. 选择正确的回退点

点击按钮，或在对话中列出已捕获的恢复点：

```text
/rewind
```

选择删除发生之前的恢复点。只有当你自己的会话中第 2 轮就是目标时，才使用：

```text
/rewind 2
```

数字表示**明确的第 2 轮之前**，不是“往前退两轮”。恢复前先等待 agent 停止工作。

![回退结果显示已恢复文件和子会话](../../assets/shot-3-rewound.png)

浏览器按钮会打开子会话；手动命令返回子会话 ID，如果界面仍停在原会话，请打开对应子会话，并检查磁盘文件。

**原对话仍完整保留，两个会话共用同一个物理工作区。** 分支不会为项目创建第二份文件副本，切换会话也不会自动切换独立的文件版本。

## 3. 用 redo 撤销这次回退

在继续编辑之前，在子会话执行：

```text
/redo
```

FileSnap 使用回退前保存的救援状态反转这次操作；根据返回结果打开原会话继续。

![redo 返回撤销结果和原会话继续目标](../../assets/shot-6-redo.png)

在这个删文件的练习里，redo 会再次删除文件，因为它恢复的是 rewind 发生前的状态。每一步都检查磁盘内容和当前所在会话。

## 检查覆盖范围与存储

```text
/rewind status
```

捕获合并已知路径、观察到的 `ctx.fs` 写入与编辑，以及有界的近期变化扫描。忽略规则、文件大小和捕获时机都会影响覆盖。这不是全盘备份，也不保证捕获任意 shell 改动；当前 status 不能证明某个历史点一定包含某个文件。

![status 显示工作区记录与共享内容存储](../../assets/shot-4-status.png)

具体边界见 [捕获架构](../../docs/architecture.zh.md)，相同内容如何复用见 [去重实验](../../docs/dedup-comparison.zh.md)。

## 卸载与重新打开会话

卸载插件**不会删除对话记录或工作区文件**。含插件记录的会话，目前需要重装插件后才能在 DSH 中重新打开。源码 checkout 使用 `pnpm dsh` 启动也可能遇到事件注册问题；使用构建版或 npm 安装的 CLI，详情见 [排障指南](../../docs/troubleshooting.zh.md)。

## 观看完整演示

演示以 1.5 倍速展示完整操作。中文 2:24，英文 2:29；这是操作演示，不是性能测试。

<div data-video></div>

[中文演示 · Bilibili](https://www.bilibili.com/video/BV1BiYT6qEjs/) · [English walkthrough · YouTube](https://youtu.be/WPEXKesR_EM)

接下来可以阅读 [版本化插件对比](../../docs/comparison.zh.md) 或 [后续功能计划](../../docs/roadmap.zh.md)。
