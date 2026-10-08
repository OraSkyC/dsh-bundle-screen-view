# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的 git 历史从 `1.1.0` 开始发布，更早的内部版本没有对应的 git tag。

## [未发布]

## [1.2.1] - 2026-10-08

### 修复

- **面板里的风险提示显示了字面星号**。`warn.inputOn` 写成了
  「本插件**没有**「确认后执行」机制」，但面板把文案当**纯文本**渲染、不走 Markdown，
  所以界面上就是四个星号。已去掉标记。

### 测试

- 新增回归：**文案里不能出现 Markdown 标记**（`**` / `__`）。
  这一类问题不会报错、不会有异常，只能靠断言拦住。

## [1.2.0] - 2026-10-08

### 变更

- **改名：「屏幕视野」→「桌面操控」。** 旧名字只描述了「看」这一半，但插件有 5 个工具在
  「动手」（真的移动鼠标、按键、打字）。`displayName`、两个 locale 的 `meta.title`
  与两份 README 的标题都已更新。`package.json` 的 `name`、entry id 与仓库地址**保持不变**，
  以免破坏既有安装。

### 新增

- **插件页里的设置卡**（新增浏览器半侧 `client.js`，`package.json` 补 `dsh.client`）。
  改动**立即生效，无需重启**。
- **三道安全闸门**：
  - `enabled` —— 总开关，关闭后一个工具都不注册。
  - `allowCapture` —— 只读组（`window_list` + `screenshot`）。
  - `allowInput` —— 输入组（`window_activate` / `mouse_click` / `type_text` / `key` / `scroll`）。
    **只想让智能体「看」就关掉它**，那 5 个工具会当场从会话里消失。
- **`excludeWindowTitles`** —— 标题命中的窗口不会出现在 `window_list` 里，
  也不能被截图或操作。这是唯一一个隐私性质的设置，且刻意在**两条路径上都生效**，
  避免被排除的窗口从另一个入口泄露出去。
- **两个行为设置**：`captureMaxWidth`（截图默认最大宽度）与 `imageCacheSize`（图片引用 LRU 上限）。
- 配置分层与 `dsh-bundle-default-workspace` 一致：`cordis.patch.yml` 写部署默认值，
  用户覆盖落到 `$DSH_HOME/state/dsh-bundle-screen-view/settings.json` 的稀疏覆盖层。
- 面板「状态」区回显平台、宿主 entry、**当前已注册的工具列表**与图片缓存占用；
  `allowInput` 打开时显示醒目的风险提示，非 Windows 平台也会提示。

### 修复

- `inject` 补上 `webServer`。Cordis 的 `ctx` 是受限代理，读未声明在 `inject` 里的属性会
  **抛错**而不是返回 `undefined` —— 漏声明会让整个 `apply()` 失败、插件在插件页显示「异常」。
- `cordis.patch.yml` 的 `config` 段之前根本不存在，`apply(ctx)` 也从不读配置；
  现在两者都补齐了。

### 测试

- 新增 `test-host.mjs`（27 项断言组）与 `test-client.mjs`（20 项断言组），`npm test` 可跑。
- 覆盖：配置归一化与夹取、三道闸门的工具增减、**改闸门后工具立即重挂（无需重启）**、
  窗口排除的大小写与空名单、稀疏覆盖层、面板路由的 403/405/400、
  受限代理降级、以及面板组件的渲染。
- 包含两条「界面不会报错」的回归：**字段标签必须可见**、**用到的 CSS 变量必须真实存在**。

## [1.1.0] - 2026-10-08

首个公开发布版本。

### 包含

**只读工具**

- `window_list` —— 枚举可见顶层窗口（前台优先），返回 hwnd、标题、屏幕矩形。
- `screenshot` —— 截取主屏或单个窗口，经 Host 的 attachments 服务回传图片；
  支持标题子串匹配与 `maxWidth` 缩放。

**桌面操作工具**

- `window_activate` —— 将窗口带到前台，最小化的先还原。
- `mouse_click` —— 移动光标到虚拟屏幕坐标并点击（左/右/中键，1–3 次）。
- `type_text` —— 向焦点窗口输入 Unicode 文本（支持任意语言与换行）。
- `key` —— 按键或组合键（修饰键按序按下、逆序松开）。
- `scroll` —— 在光标处滚动，可先移动光标。

**实现**

- GDI 截图：屏幕 DC + `BitBlt` 为主路径，逐窗口 `PrintWindow` 为兜底；
  窗口截图从 DWM 合成后的屏幕 DC 裁剪，以正确处理 GPU 合成窗口。
- koffi 从 DSH Desktop 安装目录加载（带回退），因此**无需声明 npm 依赖、无需编译**。
- `lib/png.js` 为自写的无依赖 PNG 编码器。
- 图片经有界 LRU（64 张）引用，`render()` 发出 `type: 'image'` 块把像素交给模型。

### 变更

- 更新 `package.json` 的 `description` 与 `locale/{zh,en}.json` 的 `meta.description`：
  原文只提到「截图 + 列窗口」，遗漏了后来加入的五个输入控制工具。
- 补齐发布元数据：`displayName`、`keywords`、`repository` / `homepage` / `bugs`、
  `engines`、`os: ["win32"]`、`scripts.check`，以及 README / CHANGELOG / LICENSE 入库。
