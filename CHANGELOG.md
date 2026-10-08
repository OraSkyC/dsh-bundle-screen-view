# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的 git 历史从 `1.1.0` 开始发布，更早的内部版本没有对应的 git tag。

## [未发布]

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
