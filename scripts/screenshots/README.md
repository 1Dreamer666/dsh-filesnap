# 重拍产品截图

截图必须来自实际运行的插件 UI。演示文案可以手工编写；文件清单、磁盘占用和恢复状态必须由真实引擎生成，不修改 DOM 或模拟 RPC 来制造功能。脚本不会调用模型，不需要 API Key。

## 这次的版本

- 插件：0.4.0，代码基线 `eea49ea`。
- 引擎：0.5.1。
- DSH：0.1.2-rc.1，构建 `a66e470`。
- 中文界面，1440 × 1000，1× 像素密度，UTC。
- [当前图库](../../docs/screenshots.zh.md)，包含 10 张截图。

## 准备独立环境

先在本仓库安装依赖、链接并构建匹配的 Harness，再运行 `npm run build` 和 `npm run build:client`。已有 web profile 的 `node_modules/dsh-filesnap` 必须链接到当前仓库，确保浏览器加载的是当前构建。需要 Playwright 和 Chromium；可以独立安装到临时工具目录，避免把浏览器依赖带进发布包。

下面路径以当前开发工作区为例。每次重拍使用**新的临时目录**；seed 脚本拒绝覆盖已有目录。

```bash
cd /workspaces/patcomm/dsh-plugin-dev/file-snap-plugin
DSH_DEMO_MODULES=/home/node/.dsh/profiles/web/node_modules \
FILESNAP_BIN=/workspaces/patcomm/dsh-plugin-dev/filesnap/target/release/filesnap \
node scripts/screenshots/seed.mjs /tmp/filesnap-shoot-040
```

这会生成：

- 独立 `DSH_HOME`、会话存储、工作区、FileSnap 数据目录。
- 三轮购物车示例；新增文件先执行 `declare`，因此回退清单包含恢复和删除。
- 一个带旧 `↩` 标记的会话；该演示 profile 设置 `autoMigrate: false`，让手动扫描有可展示的数据。这不是插件的默认设置。
- 一个中断恢复样例：临时进程先写入真实恢复记录，然后在引擎写文件前退出（预期退出码 86）。原分支和目标分支都保留。

在单独终端启动截图服务，保留输出：

```bash
cd /tmp/filesnap-shoot-040/whale-shop
DSH_HOME=/tmp/filesnap-shoot-040/home \
node /workspaces/patcomm/dsh-plugin-dev/deepseek-harness/apps/cli/lib/bin.js \
  --profile web --host 127.0.0.1 --port 7789 --no-open \
  2>&1 | tee /tmp/filesnap-shoot-040/web.log
```

看到 `dsh web:` 地址后，运行截图：

```bash
cd /workspaces/patcomm/dsh-plugin-dev/file-snap-plugin
PLAYWRIGHT_MODULE=/absolute/path/to/node_modules/playwright \
node scripts/screenshots/capture.mjs /tmp/filesnap-shoot-040
```

默认输出到 `assets/screenshots/v<package.json 版本>/`。可在演示目录后再传一个临时输出目录，检查后再替换正式图片。脚本会真实执行一次回退、打开 redo 预览和清理确认、扫描旧标记，并展示中断恢复。冲突图通过修改临时项目中的文件生成，拍摄后恢复原内容。不要对日常工作会话运行这些脚本。

也可以打开 `web.log` 中的本地地址手动拍摄：消息旁回退 → `/rewind` 菜单 → 文件确认 → 分支和文本回填 → `/redo` 确认 → 顶栏快照按钮 → 清理确认 → 设置 / FileSnap 中的迁移与中断恢复。鉴权 token 留在本地，不写入仓库。

## 历史版本和商店登记

1. 保留旧图原始字节，按真实版本放入 `assets/screenshots/vX.Y.Z/`，不要把旧图标为新版本。
2. 新图使用新的版本路径。更新根目录 [screenshots.json](../../screenshots.json)，按展示顺序列出最多 8 张仓库相对路径。
3. 更新双语图库、README 入口、站点首页图片及说明。旧视频仍标原版本。
4. `assets/shot-*.png` 是原有 0.2.2 外部文章链接的兼容路径，保留旧内容；当前商店不再引用它们。
5. 检查所有新图中的文件清单、按钮状态和裁切，确认没有密钥或私有项目内容。

本地检视的 `awesome-dsh-plugin` 商店构建脚本会优先读取插件仓库根目录 `screenshots.json`，取最多 8 张图。只改本地文件不会更新在线商店：需要推送图片及登记文件到仓库默认分支，再等待商店下次抓取/构建。新的版本路径避免沿用旧 URL；具体抓取时间由商店控制。这个流程不需要修改插件安装 manifest 或发布 npm 才能更新图片。

```bash
npm run check:docs
npm --prefix site run build
npm --prefix site run check
```

结束后停止截图服务器。临时目录中的演示会话、浏览器状态和恢复记录可一起清理；不影响日常 web profile。
