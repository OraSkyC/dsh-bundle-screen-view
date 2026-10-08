# 更新日志

本文件记录本插件的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> 说明：本仓库的 git 历史从 `1.1.0` 开始发布，更早的内部版本没有对应的 git tag。

## [未发布]

## [1.3.0] - 2026-10-09

### 新增

- **操作前征求同意（`confirmInput`，默认关闭）**。打开后，五个输入工具
  （`window_activate` / `mouse_click` / `type_text` / `key` / `scroll`）每次调用都先停下来问你一次，
  三选一：

  | 选项 | 效果 |
  | --- | --- |
  | 允许本次操作 | 只放行这一次 |
  | 允许本次会话所有操作 | 本会话不再询问；授权只放内存，可在面板撤销，重启即失效 |
  | 不允许 | 不做任何事，工具返回错误 |

  `screenshot` 与 `window_list` 是只读的，不在闸门内。

- **弹窗里带具体参数**。人工确认的前提是人能判断，所以 `type_text` 会显示要打的字
  （超 400 字截断并注明原长度）、`mouse_click` 显示坐标与按键、`key` 显示组合键、
  `window_activate` 显示目标窗口标题。只给一个工具名等于逼人盲签。

- **会话授权的可见性与撤销**。面板「安全闸门」区块显示已授权的会话（短 id + 时间）
  与「撤销全部授权」按钮；新增 `POST /api/dsh-bundle-screen-view/consent`
  （body 给 `sessionId` 则只撤那一个）。授权列表与超时上限也进 `/state`。

- **子智能体继承规则**。子智能体自己弹不出窗问人（DSH 的 `userQuestions` 只允许 runtime root
  发起人类交互），所以它靠 `parentSession` 继承主会话的授权：主会话授权过就放行，否则拒绝。
  这样既不给闸门留绕过路径，也不至于主会话授权后子智能体还是动不了。

- **面板显示版本号**（`v1.3.0`）。`versionChip` 样式其实一直都在，但从来没被渲染过，
  `buildState` 也不报版本 —— 宿主把客户端 bundle 缓存在内存里直到重启，
  没有这个信号就没法确认新构建到底有没有加载。

### 变更

- `state.consent` 新增：`confirmInput`、`service`（宿主有没有 `userQuestions`）、
  受闸门工具清单、当前授权、超时上限。`plugin` 新增 `version`。
- 开着闸门时，五个输入工具的 `timeoutMs` 顶到 600000（宿主上限）。原来的 10~15 秒
  会在人还没看清弹窗时就把调用掐掉。超时仍然等于「没拿到同意」，所以是 fail closed。
- 输入工具描述里追加一句「这次调用会先征求同意；被拒绝就是什么都没发生，不要重试」。

### 修复

- **面板上的风险提示是假话**。`warn.inputOn` 写死「本插件没有确认后执行机制 ——
  权限允许时不会弹窗征求同意」，加了闸门之后这句话就不成立了。现在文案跟着闸门状态走，
  分成「没开闸门」与「已开闸门」两条；另外补了一条 `warn.noService`：
  宿主没有 `userQuestions` 时开启闸门会让五个工具全部失败，必须显著警告。

### 设计说明

- **为什么不用 DSH 原生的 `ctx.approval`**：它的结果词汇表是固定的
  `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，**没有「允许本会话」** ——
  官方 README 明确把 allow-always / 授权存储列为延期工作。而且它受会话审批策略约束：
  策略为 `never` 时任何审批请求都被确定性拒绝，闸门接上去会变成废的。
  `ctx.userQuestions` 的文档写明适用于权限流程，支持任意选项列表，也不受审批策略影响。
  代价是绕过了 `approval/asked` / `approval/decided` 审计事件，用面板的授权列表做可见性补偿。
- **会话授权不落盘**：一个能跨重启活下来的鼠标键盘授权，不是用户点那个按钮时想要的东西。
- **改 `confirmInput` 就清空全部授权**：关掉再打开不能悄悄继承上一次的许可。

### 测试

- 宿主侧断言组从 27 增至 **51**，客户端从 20 增至 **25**。新增三节：
  - **[10] 操作前征求同意** —— 关闭时逐字节透传、没有 `userQuestions` 即拒绝、
    三种答案各自的后果、会话授权只对本次会话生效、**认不出的回答一律拒绝**
    （未知标签 / 空选择 / 只填自定义文字 / 缺 `answers` / `answers` 为 null）、
    `ask()` 抛错即拒绝、`readConsentChoice` 与 `describeInputCall` 的直接驱动
    （含超长截断与换行缩进）、`isSessionGranted` 的继承与「只认一层」边界。
  - **[11] 注册态：工具真的带了闸门** —— 五个输入工具的超时都顶到上限而只读两个不受影响、
    描述里写明了会先问、以及一个**零风险哨兵**：用 `window_activate` + 不存在的窗口标题驱动
    注册态工具，断言抛的是「被用户拒绝」而不是「找不到窗口」。
  - **[12] 会话授权的可见性与撤销** —— `/state` 带出授权、撤销全部与撤销单个、
    改 `confirmInput` 清空授权而改无关字段不清、没有 `userQuestions` 时 `service=false`、
    新路由同样受来源与方法校验。
- **闸门用例只用假的 `run` 驱动「允许」路径**。真实注册的工具只在「拒绝」路径上被调用 ——
  否则跑一次测试就真的会去动开发者的鼠标键盘。这条约束写进了测试注释。
- 新增回归：**`VERSION` 必须与 `package.json` 一致**（宿主与面板两侧）。

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
