# 屏幕视野 · dsh-bundle-screen-view

一个 [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-screen-view)（DSH）插件：
给智能体装上**眼睛和手** —— 截取本地桌面、列出窗口，并驱动真实的鼠标与键盘。

> [English](README.en.md) · 简体中文

---

## ⚠️ 先读这段

这个插件注册的 7 个工具里，**有 5 个会真的操作你的电脑**：

| 工具 | 会不会动你的机器 |
| --- | --- |
| `window_list`、`screenshot` | **不会** —— 只读，绝不移动、打开或触碰任何窗口 |
| `window_activate`、`mouse_click`、`type_text`、`key`、`scroll` | **会** —— 真的移动光标、真的按键、真的打字 |

也就是说，一个被授予这些工具的智能体**可以对你的桌面做任何你能做的事**：点按按钮、
往任意窗口输入文字、按下 `alt+f4`、在终端里敲命令。

安装前请确认：

- 你清楚这个插件的能力范围，并且**只在你自己控制的机器上使用**；
- 你接受智能体在会话里可能调用它们（这取决于你的权限预设，见下面「怎么降低风险」）；
- 不要把一个带这些工具的会话，交给一个你不信任的提示词或不可信的网页内容去驱动。

## 它能做什么

七个工具，分两类：

### 只读（安全）

| 工具 | 说明 |
| --- | --- |
| `window_list` | 列出可见的顶层窗口，前台优先：`hwnd`、标题、屏幕矩形。用来找窗口，或者判断用户正在看什么。 |
| `screenshot` | 截取整个主屏或某个窗口，返回一张**你能看见的图片**加一段文字摘要。支持 `window`（标题子串，不区分大小写）和 `maxWidth`（默认 2560，超出会等比缩小）。 |

### 会操作桌面（请谨慎）

| 工具 | 说明 |
| --- | --- |
| `window_activate` | 把某个窗口带到前台（最小化的会先还原）。在 `type_text` / `key` 之前用它，输入才会落到对的窗口。 |
| `mouse_click` | 把光标移到虚拟屏幕坐标 `(x, y)` 并点击。`button`：`left` / `right` / `middle`；`clicks`：1–3（2 = 双击）。 |
| `type_text` | 往当前焦点窗口输入文字（Unicode 输入事件，**任何语言都行**，可含换行）。 |
| `key` | 按一个键或组合键：`enter`、`tab`、`ctrl+a`、`ctrl+shift+t`、`alt+f4`、`f5` 等。支持 `a-z`、`0-9`、`f1-f24`、`enter`、`tab`、`esc`、`backspace`、`delete`、`insert`、`home`、`end`、`pageup`、`pagedown`、`left`、`up`、`right`、`down`、`space`、`shift`、`ctrl`、`alt`、`win`。修饰键按顺序按下、逆序松开。 |
| `scroll` | 在鼠标所在位置滚动。给 `x,y` 会先把光标移过去；省略则在当前位置滚。`deltaY`：120 = 一格，向上为正。 |

四个输入类工具的说明文字里都带了同一句提醒：

> This tool drives the real desktop — use it only when the user asked you to operate the UI,
> and prefer targeting one specific window.

## 安装

**设置 → 插件 → 添加插件**，填入：

```
https://github.com/OraSkyC/dsh-bundle-screen-view
```

或命令行：

```bash
dsh plugin --profile desktop add https://github.com/OraSkyC/dsh-bundle-screen-view
```

装完**重启 DSH**。

## 要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅 Windows**（`user32.dll` / `gdi32.dll` / `kernel32.dll`） |
| DSH | `web` 或任何带 Host `tools` 服务的 profile |
| Node | `>= 22.19.0` |
| npm 依赖 | **无** —— 见下面「koffi 是怎么来的」 |
| 构建步骤 | **无** |

插件只依赖 Host 提供的 `tools` 和 `attachments` 两个服务（`inject = ['tools', 'attachments']`），
没有浏览器半侧，因此**插件页里不会出现配置卡** —— 它是纯 Host 能力，装上就有工具。

## 怎么降低风险

插件本身不提供开关，但有三层现成的控制手段：

1. **权限预设**：DSH 的权限预设（`read-only` / `workspace-write` / `danger-full-access`）
   决定会话能做什么，是主要闸门。
2. **不装即无**：这些工具只有在插件被加载时才存在。做完自动化的事之后卸载或停用它即可。
3. **提示词层面**：工具说明里已经写明「只应在用户要求操作 UI 时使用，并优先针对单个窗口」，
   这是给模型的约束，不是技术强制。

**请注意：这个插件没有实现「确认后才执行」的机制。** 一旦工具可用且权限允许，
智能体调用 `mouse_click` 不会弹窗征求你同意。

## 实现要点

### 截图的两种策略

1. **首选：屏幕 DC + `BitBlt`**（2560×1440 大约 37 ms）。
   窗口截图的做法是**从 DWM 合成后的屏幕 DC 里裁出窗口矩形** ——
   这是 GPU 合成窗口（Chromium / Electron 那类）唯一可靠的来源，
   因为它们的窗口 DC 表面是一张空白的白底。
2. **兜底：逐窗口 `PrintWindow`**（`PW_RENDERFULLCONTENT`）。用于完全在屏幕外的窗口，
   或者屏幕 DC 不可用时（例如会话已锁定）。

这也解释了一个使用上的坑：**窗口截图拿到的是「窗口矩形位置上可见的像素」**，
所以如果别的窗口盖住了它，截出来的就是盖住它的那个。
正确做法是先 `window_activate` 把它带到前台，再截图。

### koffi 是怎么来的

Win32 调用走 [koffi](https://koffi.dev/)（FFI）。但插件**没有把 koffi 列为依赖**，而是：

1. 先从 **DSH Desktop 安装目录**里那份 koffi 加载 ——
   路径是 `<exe 所在目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/node_modules/koffi`，
   这正是 Desktop host 自己用的那份；
2. 失败则退回普通的 `createRequire(import.meta.url)('koffi')`；
3. 两者都失败才抛错，错误信息里带上两次失败的原因。

这么做的原因是：profile 里安装的 bundle，其裸模块说明符是从 **profile 的 `node_modules`** 解析的，
而那里并没有 Desktop 安装自带的包。写成依赖就得让每个用户各自装一份 koffi（含原生二进制），
直接复用安装目录里已有的那份更省事，也让 `dsh plugin add` 不需要任何编译。

### PNG 编码

`lib/png.js` 是自己写的（zlib + CRC32 + 分块），不依赖任何图像库 ——
GDI 给出的 BGRA 缓冲直接编码成 PNG 交给 Host 的 attachments 服务。

### 图片回传

`screenshot` 的 `execute()` 把 PNG 存进 Host 的 attachments 服务，拿到一个 `attachmentId`，
再放进一个有界 LRU（64 张）里；随后 `render()` 从这个 LRU 取出引用，
发出一个 `type: 'image'` 的内容块，模型才真正「看见」像素。这样避免了大图在内存里反复搬运。

## 目录结构

```
dsh-bundle-screen-view/
├── package.json         # 清单：dsh.bundle.patch / files / os: win32
├── cordis.patch.yml     # 注册 entry（id: screen-view）
├── index.js             # 7 个工具的注册、参数校验、结果渲染
├── lib/
│   ├── capture.js       # GDI 截图（BitBlt 主路径 + PrintWindow 兜底）、窗口枚举、koffi 解析
│   ├── input.js         # SendInput 输入合成（鼠标 / 键盘 / 滚轮 / 激活窗口）
│   └── png.js           # 无依赖 PNG 编码
├── icon.svg
├── locale/zh.json       # meta.title / meta.description
├── locale/en.json
├── README.md            # 本文件
├── README.en.md         # 英文版
├── CHANGELOG.md
└── LICENSE
```

## 开发

```bash
npm run check     # 四个文件的语法检查
```

没有测试套件 —— 这些工具的效果只能在真实桌面上验证。

## 许可证

[MIT](./LICENSE)
