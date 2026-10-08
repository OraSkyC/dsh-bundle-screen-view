# 桌面操控 · dsh-bundle-screen-view

一个 [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-screen-view)（DSH）插件：
让智能体**看见并操作你的真实桌面** —— 截取屏幕、列出窗口，并驱动鼠标与键盘。

> [English](README.en.md) · 简体中文

> **名字说明**：这个插件以前叫「屏幕视野」，但那个名字只描述了「看」。
> 它实际上有 5 个工具在「动手」，所以改名为**桌面操控**。

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

**默认不弹窗** —— `confirmInput` 默认关闭，权限允许时就直接执行。但它提供
**一道可选的操作前确认闸门**（打开后每次输入都先问你一次）和另外三道
**可即时生效的安全闸门**（见下面「设置」），其中最重要的一条是
**只保留「看」、关掉「动手」**。

> 版本 `1.3.0` 起有这道确认闸门。默认关闭是刻意的：开启它会给每一次点击都加一次打断，
> 适合「偶尔让智能体替你点几下」的场景；如果你本来就整天让它操作桌面，保持关闭并按
> 下面的「怎么降低风险」用权限预设来管，体验会好得多。

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

## 设置

**设置 → 插件 → 桌面操控**。改动**立即生效，不用重启** —— 关掉输入组后，那 5 个工具
会当场从会话里消失。

配置分两层，优先级从低到高：

| 层 | 位置 | 生效时机 |
| --- | --- | --- |
| 部署默认值 | 本包的 [`cordis.patch.yml`](./cordis.patch.yml) | 改完需**重启 DSH** |
| 用户覆盖 | `%USERPROFILE%\.dsh\state\dsh-bundle-screen-view\settings.json` | **立即生效** |

用户覆盖层是**稀疏**的：只存你在面板里真正改过的字段。点「恢复默认」是把那个键**删掉**，
于是自动回落到部署配置。

### 安全闸门

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关闭后**一个工具都不注册**，面板仍可打开。 |
| `allowCapture` | `true` | 注册 `window_list` + `screenshot`。它们不会动你的鼠标，但会把屏幕内容交给模型 —— 涉密屏幕上建议关掉。 |
| `allowInput` | `true` | 注册 `window_activate` / `mouse_click` / `type_text` / `key` / `scroll`。**只想让智能体「看」就把它关掉。** |
| `confirmInput` | `false` | 输入类操作前先征求同意（三选一）。默认关闭 = 权限允许就直接执行。见下面「操作前征求同意」。 |

### 行为

| 键 | 默认 | 范围 | 说明 |
| --- | --- | --- | --- |
| `captureMaxWidth` | `2560` | 320–8192 | 截图默认最大宽度，超出等比缩小。模型仍可在单次调用里用 `maxWidth` 覆盖。 |
| `imageCacheSize` | `64` | 4–512 | 截图引用保留多少张。太小会导致较早的截图无法回传给模型。 |
| `excludeWindowTitles` | `[]` | — | 逗号分隔，大小写不敏感。命中的窗口**不会出现在 `window_list` 里，也不能被截图或操作** —— 用来挡住密码管理器、网银这类窗口。 |

`excludeWindowTitles` 是唯一一个「隐私」性质的设置，它在**两条路径上都生效**
（列出与操作），所以被排除的窗口不会从别的入口泄露出去。

## 要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | **仅 Windows**（`user32.dll` / `gdi32.dll` / `kernel32.dll`） |
| DSH | `web` 或任何带 Host `tools` 服务的 profile |
| Node | `>= 22.19.0` |
| npm 依赖 | **无** —— 见下面「koffi 是怎么来的」 |
| 构建步骤 | **无** |

插件依赖 Host 提供的 `tools`、`attachments` 和 `webServer` 三个服务
（`inject = ['tools', 'attachments', 'webServer']`）。`webServer` 是**硬依赖**：
Cordis 的 `ctx` 是受限代理，读一个没声明在 `inject` 里的属性会**抛错**而不是返回
`undefined`，漏声明会让整个 `apply()` 失败、插件在插件页显示「异常」。

## 怎么降低风险

现在有五层控制手段：

1. **操作前征求同意**（`confirmInput`，默认关闭）：打开后，五个输入工具每次调用都会先停下来
   问你一次，可选「允许本次操作 / 允许本次会话所有操作 / 不允许」。见下面单独一节。
2. **插件自带的安全闸门**（推荐）：在插件页把 `allowInput` 关掉，智能体就只剩「看」的能力。
   这是最直接、也最不需要重启的一层。
3. **权限预设**：DSH 的权限预设（`read-only` / `workspace-write` / `danger-full-access`）
   决定会话能做什么。
4. **不装即无**：这些工具只有在插件被加载时才存在。做完自动化的事之后卸载或停用它即可。
5. **提示词层面**：工具说明里已经写明「只应在用户要求操作 UI 时使用，并优先针对单个窗口」，
   这是给模型的约束，不是技术强制。

**注意第 1 层默认是关的。** 没打开它的时候，只要工具可用且权限允许，
智能体调用 `mouse_click` 不会弹窗征求你的同意。

## 操作前征求同意

`confirmInput` 打开后，受保护的工具每次调用都会用 `ctx.userQuestions` 弹一个三选一：

| 选项 | 效果 |
| --- | --- |
| **允许本次操作** | 只放行这一次，下次还会问 |
| **允许本次会话所有操作** | 这个会话内不再询问；授权只放内存，可在面板里随时撤销，DSH 重启即失效 |
| **不允许** | 这次输入不做，工具返回一个错误 |

受保护的是五个输入工具：`window_activate`、`mouse_click`、`type_text`、`key`、`scroll`。
`screenshot` 与 `window_list` 是只读的，不在闸门内 —— 它们不改系统状态。

### 弹窗里会写清楚要做什么

人工确认的前提是人能做出判断，所以弹窗里带着**这次调用的具体内容**，
而不只是一个工具名：

```
智能体要执行一次桌面输入操作：

type_text
向当前焦点窗口输入 24 个字符：
  rm -rf ./build && pnpm run build

允许吗？
```

`mouse_click` 会写明坐标与按键、`key` 会写明组合键、`window_activate` 会写明目标窗口标题。
`type_text` 的文本超过 400 字会截断并注明原长度 —— 否则一整篇文章会把弹窗撑爆。

### 拿不到同意就不执行

闸门的所有失败路径都是**拒绝**，没有一条会「算了就放行」：

| 情况 | 结果 |
| --- | --- |
| 你点了「不允许」 | 拒绝，工具报错 |
| 答案认不出来（未知选项、跳过不答、只填了自定义文字） | 拒绝 |
| 宿主没有 `userQuestions` 服务 | 拒绝，并说明原因 |
| 弹出去了但没人答，直到工具超时 | 拒绝（超时上限 10 分钟） |
| 调用方是子智能体，而主会话没授权过 | 拒绝 |

最后一条要解释一下：**子智能体自己弹不出窗问人。** DSH 的 `userQuestions` 明确只允许
「runtime root」发起人类交互，被父智能体拥有的子智能体没有人类应答方，硬问会永远挂住。
所以子智能体走的是**继承**：主会话已经点过「允许本次会话所有操作」，子智能体就直接放行；
没授权就拒绝。这样既不给人留一条「让子智能体绕过闸门」的路，也不至于让主会话授权之后
子智能体还是动不了。

> 已知边界：继承只往上认一层（`parentSession`）。更深层的后代拿不到授权，会被拒绝 ——
> 宁可拒绝，也不给闸门留绕过路径。

### 为什么不用 DSH 原生的 `ctx.approval`

DSH 确实有一套审批接缝 `ctx.approval`，但它的结果词汇表是固定的：

```ts
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';
export type ApprovalPolicy  = 'ask' | 'never';
```

**只有「允许这一次」和「拒绝」，没有「允许本会话」。** 这不是没实现，而是官方明确列为延期：
「the outcome vocabulary has `allowed-once` but no `allow-always`, remembered rule,
revocation, or grant store」。

而且它受会话审批策略约束：策略为 `never` 时，任何审批请求都会被**确定性拒绝**。
如果闸门接在它上面，那么在 `never` 策略下打开闸门会让五个输入工具全部失效 —— 闸门变成废的。

`ctx.userQuestions` 的文档写的是「Use `ctx.userQuestions` when a tool or **permission flow**
needs a structured answer from the user」，支持任意选项列表，所以三选一能落地，也不受审批策略影响。

代价要说清楚：走 `userQuestions` 就绕过了 `ctx.approval` 的审计事件（`approval/asked` /
`approval/decided`），决策不会进 DSH 的审批日志。本插件用面板上的授权列表与撤销入口
来做可见性补偿。

### 撤销授权

面板「安全闸门」区块会显示当前有几个会话被授权（带短 id 与时间）和一个「撤销全部授权」
按钮。另外：

- 改 `confirmInput`（无论开还是关）都会**清空全部授权** —— 关掉再打开不会悄悄继承上一次的许可；
- 改其它设置不会动授权；
- 插件被停用或卸载时授权一并清空；
- 授权只放内存，DSH 重启后从零开始。

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
├── package.json         # 清单：dsh.bundle.patch / dsh.client / files / os: win32
├── cordis.patch.yml     # 注册 entry（id: screen-view）+ 部署默认配置
├── index.js             # 配置契约、7 个工具的注册与闸门、同意闸门、面板路由
├── client.js            # 浏览器半侧：插件页里的设置卡（React 由 loader 注入）
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
├── LICENSE
├── test-host.mjs        # 宿主侧：配置、闸门、路由、工具注册
└── test-client.mjs      # 浏览器侧：注册路径、组件渲染、CSS 变量有效性
```

## 开发

```bash
npm run check     # 五个文件的语法检查
npm test          # 宿主 51 项断言组 + 客户端 25 项断言组
```

测试覆盖了配置归一化、四道安全闸门、窗口排除、状态覆盖层、面板路由（含 `/consent` 撤销），
**同意闸门的全部判定与失败路径**（三态可辨、认不出即拒绝、没有 `userQuestions` 即拒绝、
问不到人即拒绝、子智能体继承规则、`confirmInput` 一变就清授权），
以及面板组件的渲染（含**标签是否可见**和**用到的 CSS 变量是否真实存在**这两类回归 ——
它们出问题时界面不会报错，只能靠断言拦住）。

> 闸门相关的用例只用**假的 `run`** 驱动「允许」路径，真实注册的工具只在「拒绝」路径上被调用 ——
> 否则跑一次测试就真的会去动你的鼠标键盘。

工具在**真实桌面**上的效果（截图是否正确、点击是否落在对的坐标）仍然只能手工验证。

## 许可证

[MIT](./LICENSE)
