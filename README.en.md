# Desktop Control · dsh-bundle-screen-view

A [DeepSeek Harness](https://github.com/OraSkyC/dsh-bundle-screen-view) (DSH) plugin that lets the
agent **see and operate your real desktop**: capture the screen, list windows, and drive the mouse
and keyboard.

> English · [简体中文](README.md)

> **On the name**: this plugin used to be called "Screen View", but that only described the *seeing*
> half. Five of its tools actually *act*, so it is now called **Desktop Control**.

---

## ⚠️ Read this first

Of the seven tools this plugin registers, **five really operate your computer**:

| Tool | Does it touch your machine? |
| --- | --- |
| `window_list`, `screenshot` | **No** — read-only; they never move, open, or touch any window |
| `window_activate`, `mouse_click`, `type_text`, `key`, `scroll` | **Yes** — they really move the cursor, press keys, and type |

Which means an agent granted these tools **can do anything on your desktop that you can**: click
buttons, type into any window, press `alt+f4`, run commands in a terminal.

Before installing, make sure that:

- you understand the capability and use this **only on a machine you control**;
- you accept that the agent may call these during a session (this depends on your permission preset —
  see "Reducing the risk" below);
- you do not hand a session with these tools to an untrusted prompt or untrusted page content.

**The plugin itself has no confirmation step** — it will not ask before acting. It does, however,
provide three **safety gates that take effect immediately** (see "Settings" below). The most
important one lets you keep the *seeing* and drop the *acting*.

## What it does

Seven tools, in two groups:

### Read-only (safe)

| Tool | Notes |
| --- | --- |
| `window_list` | Lists visible top-level windows, frontmost first: `hwnd`, title, screen rectangle. Use it to find a window or to reason about what the user is looking at. |
| `screenshot` | Captures the full primary screen or one window, returning an **image you can see** plus a text summary. Supports `window` (case-insensitive title substring) and `maxWidth` (default 2560; larger captures are downscaled). |

### Drives the desktop (be careful)

| Tool | Notes |
| --- | --- |
| `window_activate` | Brings a window to the foreground (restoring it first if minimized). Use it before `type_text` / `key` so input lands in the right place. |
| `mouse_click` | Moves the cursor to virtual-screen `(x, y)` and clicks. `button`: `left` / `right` / `middle`; `clicks`: 1–3 (2 = double-click). |
| `type_text` | Types text into the focused window (Unicode input events, **any language**, newlines allowed). |
| `key` | Presses a key or combo: `enter`, `tab`, `ctrl+a`, `ctrl+shift+t`, `alt+f4`, `f5`, … Supported: `a-z`, `0-9`, `f1-f24`, `enter`, `tab`, `esc`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, `left`, `up`, `right`, `down`, `space`, `shift`, `ctrl`, `alt`, `win`. Modifiers go down in order and up in reverse. |
| `scroll` | Scrolls at the cursor. Pass `x,y` to move the cursor there first; omit both to scroll in place. `deltaY`: 120 = one notch, positive is up. |

All four input tools carry the same reminder in their descriptions:

> This tool drives the real desktop — use it only when the user asked you to operate the UI,
> and prefer targeting one specific window.

## Installation

**Settings → Plugins → Add plugin**, and enter:

```
https://github.com/OraSkyC/dsh-bundle-screen-view
```

Or on the command line:

```bash
dsh plugin --profile desktop add https://github.com/OraSkyC/dsh-bundle-screen-view
```

**Restart DSH** afterwards.

## Settings

**Settings → Plugins → Desktop Control.** Changes take effect **immediately, with no restart** —
turning the input group off makes those five tools disappear from the session on the spot.

Two layers, lowest priority first:

| Layer | Location | Takes effect |
| --- | --- | --- |
| Deploy defaults | [`cordis.patch.yml`](./cordis.patch.yml) in this package | after a **DSH restart** |
| User overrides | `%USERPROFILE%\.dsh\state\dsh-bundle-screen-view\settings.json` | **immediately** |

The user layer is **sparse**: it only stores what you actually changed. "Reset" **deletes** the key
rather than writing the default back, so the field falls through to the deploy defaults again.

### Safety gates

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When off, **no tools are registered at all**; the panel still opens. |
| `allowCapture` | `true` | Registers `window_list` + `screenshot`. They never touch your mouse, but they do hand screen contents to the model — turn this off on sensitive screens. |
| `allowInput` | `true` | Registers `window_activate` / `mouse_click` / `type_text` / `key` / `scroll`. **Turn this off to let the agent look but not touch.** |

### Behaviour

| Key | Default | Range | Meaning |
| --- | --- | --- | --- |
| `captureMaxWidth` | `2560` | 320–8192 | Default max capture width; wider captures are downscaled. The model can still override per call with `maxWidth`. |
| `imageCacheSize` | `64` | 4–512 | How many screenshot references to keep. Too small and older screenshots cannot be handed back to the model. |
| `excludeWindowTitles` | `[]` | — | Comma separated, case-insensitive. Matching windows **are hidden from `window_list` and cannot be captured or operated** — use it to keep password managers and banking windows out. |

`excludeWindowTitles` is the one privacy-oriented setting, and it applies on **both paths** (listing
and acting), so an excluded window cannot leak through the other entry point.

## Requirements

| Item | Requirement |
| --- | --- |
| OS | **Windows only** (`user32.dll` / `gdi32.dll` / `kernel32.dll`) |
| DSH | a `web` or any profile whose Host provides the `tools` service |
| Node | `>= 22.19.0` |
| npm dependencies | **none** — see "Where koffi comes from" |
| Build step | **none** |

The plugin depends on the Host's `tools`, `attachments` and `webServer` services
(`inject = ['tools', 'attachments', 'webServer']`). `webServer` is a **hard** dependency: Cordis's
`ctx` is a restricted proxy, so reading a property that was not declared in `inject` **throws**
rather than returning `undefined`. Missing it fails the whole `apply()` and the plugin shows as
"error" in the Plugins page.

## Reducing the risk

There are now four layers of control:

1. **The plugin's own safety gates** (recommended): turn `allowInput` off in the Plugins page and the
   agent is left with seeing only. This is the most direct layer, and it needs no restart.
2. **Permission presets** — DSH's presets (`read-only` / `workspace-write` / `danger-full-access`)
   decide what a session may do.
3. **Not installed means not present** — the tools only exist while the plugin is loaded. Uninstall
   or disable it once your automation is done.
4. **Prompt level** — the tool descriptions state "use it only when the user asked you to operate the
   UI, and prefer targeting one specific window". That constrains the model; it is not enforcement.

**Remember that the plugin has no confirmation step.** Once the tools are available and permissions
allow it, an agent calling `mouse_click` will not pop up a dialog asking you first.

## Implementation notes

### Two capture strategies

1. **Primary: screen DC + `BitBlt`** (~37 ms for 2560×1440). Window captures **crop the window
   rectangle out of the DWM-composited screen DC** — the only reliable source for GPU-composited
   windows (Chromium / Electron), whose window-DC surface is a blank white background.
2. **Fallback: per-window `PrintWindow`** (`PW_RENDERFULLCONTENT`) for fully off-screen windows, or
   when the screen DC is unavailable (e.g. a locked session).

This explains a practical gotcha: **a window capture shows the pixels visible at the window
rectangle**, so if something covers it, that is what you get. Bring the window forward with
`window_activate` first.

### Where koffi comes from

Win32 calls go through [koffi](https://koffi.dev/) (FFI). The plugin deliberately does **not** list
koffi as a dependency. Instead it:

1. loads the koffi copy inside the **DSH Desktop installation** —
   `<dir of exe>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/node_modules/koffi`,
   the very copy the Desktop host itself uses;
2. falls back to a plain `createRequire(import.meta.url)('koffi')`;
3. throws only if both fail, with both reasons in the message.

The reason: a profile-installed bundle resolves bare specifiers from the **profile's `node_modules`**,
which does not carry the Desktop installation's packages. Declaring the dependency would make every
user install their own copy (native binaries included); reusing the one already on disk keeps
`dsh plugin add` free of any compilation.

### PNG encoding

`lib/png.js` is hand-written (zlib + CRC32 + chunks) with no image library — the BGRA buffer GDI
hands back is encoded straight to PNG and passed to the Host's attachments service.

### Getting pixels back to the model

`screenshot`'s `execute()` saves the PNG through the Host's attachments service and gets an
`attachmentId`, which goes into a bounded LRU (64 images). `render()` then pulls the reference from
that LRU and emits a `type: 'image'` content block, which is what actually lets the model see the
pixels — avoiding repeated copies of large images in memory.

## Layout

```
dsh-bundle-screen-view/
├── package.json         # manifest: dsh.bundle.patch / dsh.client / files / os: win32
├── cordis.patch.yml     # registers the entry (id: screen-view) + deploy default config
├── index.js             # config contract, the seven tools and their gates, panel routes
├── client.js            # browser half: the settings card (React injected by the loader)
├── lib/
│   ├── capture.js       # GDI capture (BitBlt primary + PrintWindow fallback), window enumeration, koffi resolution
│   ├── input.js         # SendInput synthesis (mouse / keyboard / wheel / activate)
│   └── png.js           # dependency-free PNG encoder
├── icon.svg
├── locale/zh.json       # meta.title / meta.description
├── locale/en.json
├── README.md            # Chinese
├── README.en.md         # this file
├── CHANGELOG.md
├── LICENSE
├── test-host.mjs        # host side: config, gates, routes, tool registration
└── test-client.mjs      # browser side: registration, component rendering, CSS token validity
```

## Development

```bash
npm run check     # syntax-check all five files
npm test          # 27 host assertion groups + 20 client assertion groups
```

The tests cover config normalisation, the three safety gates, window exclusion, the sparse override
layer and the panel routes, plus panel rendering — including two regression classes that fail
**silently** in a browser (**are the field labels visible**, and **do the CSS variables actually
exist**) and therefore can only be caught by an assertion.

What these tools do on a **real desktop** (is the capture correct, does the click land on the right
coordinate) still has to be verified by hand.

## License

[MIT](./LICENSE)
