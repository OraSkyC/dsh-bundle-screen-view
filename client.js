/**
 * dsh-bundle-screen-view —— 浏览器半侧。
 *
 * 在「设置 → 插件 → 桌面操控」页里渲染一张配置卡。
 * 与宿主之间只有两个端点：
 *   GET  /api/dsh-bundle-screen-view/state     读状态（只读）
 *   POST /api/dsh-bundle-screen-view/settings  写一个字段（null = 删除覆盖，回落部署默认值）
 *
 * 写法约定（与仓库里其它 DSH 插件一致，务必保留）：
 *   - 整个文件是一个 IIFE，返回一个模块对象；
 *   - REGISTRATION = { id, factory } 通过 window.__ModuleLoader__.load() 注册；
 *   - React 不是依赖，而是由 factory 收到的 loaderRequire("react") 交进来；
 *   - 同时在 CommonJS 下导出 REGISTRATION，方便 Node 侧测试直接加载。
 *
 * 样式只用 @deepseek-ai/dsh-client-ui-theme 里**真实存在**的 --dsw-* 变量：
 * 写错一个变量名会让整条 CSS 声明被判非法、静默失效（界面上不会有任何报错）。
 *
 * @module dsh-bundle-screen-view/client
 */
var dsh_bundle_screen_view_client = (function () {

	const NS = "dsh-bundle-screen-view";
	const STATE_PATH = "/api/" + NS + "/state";
	const SETTINGS_PATH = "/api/" + NS + "/settings";

	/* ------------------------------------------------------------------ */
	/* 文案                                                                 */
	/* ------------------------------------------------------------------ */
	const zh = {
		"panel.title": "桌面操控",
		"panel.subtitle": "让智能体看见并操作你的真实桌面。",
		"panel.loading": "读取中…",
		"panel.error": "读取失败：{error}",
		"panel.updated": "更新于 {time}",
		"panel.refresh": "刷新",
		"panel.configError": "配置有误：{error}",
		"panel.disabled": "插件已停用：一个工具都不会注册。",
		"section.status": "状态",
		"section.safety": "安全闸门",
		"section.behavior": "行为",
		"section.expand": "展开",
		"section.collapse": "收起",
		"status.platform": "平台",
		"status.platformWin": "Windows",
		"status.platformOther": "{name}（本插件仅支持 Windows，工具会调用失败）",
		"status.tools": "已注册的工具",
		"status.toolsNone": "无",
		"status.cache": "图片缓存",
		"status.cacheValue": "{count} / {max} 张",
		"status.entry": "宿主 entry",
		"field.enabled": "启用插件",
		"field.enabledHint": "关闭后不注册任何工具，面板仍可打开。",
		"field.allowCapture": "允许截屏与列窗口",
		"field.allowCaptureHint": "注册 window_list 与 screenshot。这两个工具只读，不会移动鼠标或按键，但会把屏幕内容交给模型 —— 涉密屏幕上请关掉。",
		"field.allowInput": "允许操作鼠标与键盘",
		"field.allowInputHint": "注册 window_activate、mouse_click、type_text、key、scroll。这五个工具会真的移动光标、按键、打字。",
		"field.captureMaxWidth": "截图最大宽度（像素）",
		"field.captureMaxWidthHint": "超出这个宽度会等比缩小，取值范围 {min}–{max}。模型仍可用 maxWidth 参数临时覆盖。",
		"field.imageCacheSize": "图片缓存条数",
		"field.imageCacheSizeHint": "已截图的引用保留多少张，取值范围 {min}–{max}。太小会导致较早的截图无法回传给模型。",
		"field.excludeWindowTitles": "排除的窗口标题",
		"field.excludeWindowTitlesHint": "逗号分隔，大小写不敏感。标题命中的窗口不会出现在 window_list 里，也不能被截图或操作 —— 用来挡住密码管理器、网银这类窗口。留空则不排除。",
		"warn.inputOn": "输入控制已开启：智能体可以真的移动你的鼠标、按键、打字。本插件**没有**「确认后执行」机制 —— 权限允许时不会弹窗征求同意。",
		"warn.inputOff": "输入控制已关闭：智能体只能看，不能动。",
		"warn.nonWindows": "当前系统不是 Windows，这些工具依赖 user32.dll / gdi32.dll，调用会失败。",
		"action.save": "保存",
		"action.saving": "保存中…",
		"action.reset": "恢复默认",
		"action.resetting": "恢复中…",
		"action.saved": "已保存",
		"action.saveError": "保存失败：{error}",
		"action.dirty": "未保存",
		"switch.on": "已开启",
		"switch.off": "已关闭"
	};
	const en = {
		"panel.title": "Desktop Control",
		"panel.subtitle": "Let the agent see and operate your real desktop.",
		"panel.loading": "Loading…",
		"panel.error": "Failed to load: {error}",
		"panel.updated": "Updated {time}",
		"panel.refresh": "Refresh",
		"panel.configError": "Invalid config: {error}",
		"panel.disabled": "Plugin disabled: no tools are registered.",
		"section.status": "Status",
		"section.safety": "Safety gates",
		"section.behavior": "Behaviour",
		"section.expand": "Expand",
		"section.collapse": "Collapse",
		"status.platform": "Platform",
		"status.platformWin": "Windows",
		"status.platformOther": "{name} (Windows only; tool calls will fail)",
		"status.tools": "Registered tools",
		"status.toolsNone": "none",
		"status.cache": "Image cache",
		"status.cacheValue": "{count} / {max} images",
		"status.entry": "Host entry",
		"field.enabled": "Enable plugin",
		"field.enabledHint": "When off, no tools are registered; the panel still opens.",
		"field.allowCapture": "Allow capture and window listing",
		"field.allowCaptureHint": "Registers window_list and screenshot. Both are read-only and never move the mouse, but they do hand screen contents to the model — turn this off on sensitive screens.",
		"field.allowInput": "Allow mouse and keyboard control",
		"field.allowInputHint": "Registers window_activate, mouse_click, type_text, key and scroll. These five really move the cursor, press keys and type.",
		"field.captureMaxWidth": "Max capture width (px)",
		"field.captureMaxWidthHint": "Wider captures are downscaled. Range {min}–{max}. The model can still override per call with maxWidth.",
		"field.imageCacheSize": "Image cache entries",
		"field.imageCacheSizeHint": "How many screenshot references to keep, {min}–{max}. Too small and older screenshots cannot be handed back to the model.",
		"field.excludeWindowTitles": "Excluded window titles",
		"field.excludeWindowTitlesHint": "Comma separated, case-insensitive. Matching windows are hidden from window_list and cannot be captured or operated — use it to keep password managers and banking windows out. Empty means no exclusions.",
		"warn.inputOn": "Input control is ON: the agent can really move your mouse, press keys and type. This plugin has **no** confirmation step — it will not ask before acting.",
		"warn.inputOff": "Input control is OFF: the agent can look but not touch.",
		"warn.nonWindows": "This is not Windows. These tools rely on user32.dll / gdi32.dll and will fail.",
		"action.save": "Save",
		"action.saving": "Saving…",
		"action.reset": "Reset",
		"action.resetting": "Resetting…",
		"action.saved": "Saved",
		"action.saveError": "Save failed: {error}",
		"action.dirty": "Unsaved",
		"switch.on": "On",
		"switch.off": "Off"
	};

	/* ------------------------------------------------------------------ */
	/* HTTP                                                                 */
	/* ------------------------------------------------------------------ */
	async function getJson(path) {
		const response = await fetch(path, { headers: { accept: "application/json" }, cache: "no-store" });
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	async function postJson(path, payload) {
		const response = await fetch(path, {
			method: "POST",
			headers: { "content-type": "application/json", accept: "application/json" },
			cache: "no-store",
			body: JSON.stringify(payload)
		});
		const body = await response.json().catch(() => null);
		return { status: response.status, body };
	}
	async function postJsonOrThrow(path, payload) {
		const { status, body } = await postJson(path, payload);
		if (body === null || body.ok !== true) {
			throw new Error(typeof body?.error === "string" ? body.error : "HTTP " + status);
		}
		return body;
	}

	/* ------------------------------------------------------------------ */
	/* React（由 loader 注入，不是依赖）                                     */
	/* ------------------------------------------------------------------ */
	let api = null;
	function provideClientReact(value) {
		if (typeof value !== "object" || value === null) {
			throw new Error("client: the loader did not hand over a react module");
		}
		api = value;
	}
	function reactApi() {
		if (api === null) throw new Error("client: react used before clientFactory ran");
		return api;
	}
	const h = (type, props, ...children) => reactApi().createElement(type, props, ...children);
	const useState = (initial) => reactApi().useState(initial);
	const useEffect = (effect, deps) => reactApi().useEffect(effect, deps);
	const useCallback = (callback, deps) => reactApi().useCallback(callback, deps);
	const useRef = (initial) => reactApi().useRef(initial);

	/* ------------------------------------------------------------------ */
	/* 样式（只用真实存在的 --dsw-* token）                                  */
	/* ------------------------------------------------------------------ */
	const CONTROL_HEIGHT = 32;
	const BUTTON = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: 6,
		height: CONTROL_HEIGHT,
		padding: "0 12px",
		borderRadius: "var(--dsw-radius-md, 8px)",
		border: "1px solid var(--dsw-alias-border-l2)",
		background: "var(--dsw-alias-bg-layer-2)",
		color: "var(--dsw-alias-label-primary)",
		fontSize: 13,
		fontWeight: 500,
		fontFamily: "inherit",
		lineHeight: 1,
		whiteSpace: "nowrap",
		cursor: "pointer",
		transition: "background .12s ease, border-color .12s ease, opacity .12s ease"
	};
	const S = {
		page: {
			flex: "1 1 auto",
			height: "100%",
			minHeight: 0,
			display: "flex",
			flexDirection: "column",
			overflow: "hidden",
			color: "var(--dsw-alias-label-primary)",
			fontSize: 14,
			lineHeight: "22px"
		},
		header: { flex: "none", display: "flex", alignItems: "flex-start", gap: 12, padding: "16px 0 12px" },
		titleBlock: { flex: 1, minHeight: 0 },
		title: { margin: 0, fontSize: 20, fontWeight: 600, lineHeight: "28px" },
		subtitle: { margin: "2px 0 0", fontSize: 13, color: "var(--dsw-alias-label-secondary)" },
		updated: { color: "var(--dsw-alias-label-secondary)", fontSize: 12, whiteSpace: "nowrap" },
		versionChip: {
			display: "inline-block",
			marginLeft: 8,
			padding: "0 7px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)",
			fontSize: 12,
			fontWeight: 400,
			lineHeight: "19px",
			verticalAlign: "middle",
			cursor: "help"
		},
		scroll: { flex: 1, minHeight: 0, overflowY: "auto", overflowX: "hidden" },
		content: { padding: "6px 0 56px" },
		cluster: { display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" },

		button: BUTTON,
		buttonHover: {
			background: "var(--dsw-alias-interactive-bg-hover)",
			borderColor: "var(--dsw-alias-border-l3)"
		},
		buttonPrimary: {
			...BUTTON,
			background: "var(--dsw-alias-button-primary-fill)",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-primary-foreground)",
			fontWeight: 600
		},
		buttonPrimaryHover: { background: "var(--dsw-alias-button-primary-hover)" },
		buttonGhost: {
			...BUTTON,
			background: "transparent",
			borderColor: "transparent",
			color: "var(--dsw-alias-label-secondary)"
		},
		buttonGhostHover: {
			background: "var(--dsw-alias-interactive-bg-hover)",
			color: "var(--dsw-alias-label-primary)"
		},
		buttonDisabled: { opacity: 0.45, cursor: "default" },

		notice: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)"
		},
		noticeBad: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-error-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-state-error-primary)"
		},
		noticeWarn: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-warn-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-state-warn-label)"
		},
		noticeOk: {
			display: "flex",
			alignItems: "flex-start",
			gap: 8,
			margin: "0 0 14px",
			padding: "10px 14px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			fontSize: 13,
			lineHeight: "20px",
			border: "1px solid var(--dsw-alias-state-success-primary)",
			background: "var(--dsw-alias-bg-layer-2)",
			color: "var(--dsw-alias-label-secondary)"
		},

		sectionCard: {
			border: "1px solid var(--dsw-alias-border-l1)",
			borderRadius: "var(--dsw-radius-lg, 12px)",
			background: "var(--dsw-alias-bg-layer-1)",
			overflow: "hidden",
			marginTop: 16
		},
		sectionHead: {
			display: "flex",
			alignItems: "center",
			gap: 10,
			width: "100%",
			padding: "12px 16px",
			background: "none",
			border: "none",
			cursor: "pointer",
			textAlign: "left",
			font: "inherit",
			color: "inherit"
		},
		sectionHeadTitle: { flex: 1, minWidth: 0, fontSize: 15, fontWeight: 600 },
		sectionBody: { padding: "4px 16px 16px" },

		fieldGrid: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 190px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "14px 0",
			borderTop: "1px solid var(--dsw-alias-border-l1)"
		},
		fieldGridFirst: {
			display: "grid",
			gridTemplateColumns: "minmax(110px, 190px) minmax(0, 1fr)",
			gap: "4px 20px",
			alignItems: "start",
			padding: "6px 0 14px"
		},
		fieldLabel: { fontSize: 13, fontWeight: 600, lineHeight: "20px", color: "var(--dsw-alias-label-primary)" },
		fieldHint: { marginTop: 3, fontSize: 12, lineHeight: "17px", color: "var(--dsw-alias-label-tertiary)" },
		fieldControl: { minWidth: 0 },
		fieldActions: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginTop: 8 },
		value: { fontSize: 13, lineHeight: "20px", overflowWrap: "anywhere", wordBreak: "break-word" },
		valueMuted: {
			fontSize: 13,
			lineHeight: "20px",
			color: "var(--dsw-alias-label-secondary)",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		code: {
			display: "inline",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)",
			fontSize: 12,
			padding: "1px 6px",
			borderRadius: "var(--dsw-radius-xs, 4px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-markdown-inline-code, var(--dsw-alias-bg-layer-2))",
			overflowWrap: "anywhere",
			wordBreak: "break-word"
		},
		input: {
			width: "100%",
			minWidth: 0,
			height: CONTROL_HEIGHT,
			padding: "0 10px",
			borderRadius: "var(--dsw-radius-md, 8px)",
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-base)",
			color: "var(--dsw-alias-label-primary)",
			fontFamily: "inherit",
			fontSize: 13,
			outline: "none",
			transition: "border-color .12s ease"
		},
		inputFocus: { borderColor: "var(--dsw-alias-brand-primary)" },

		// 与 DSH 自带开关组件（web-frontend 的 ._switch_1ik0f_5）完全一致：
		// 36x20、padding 2、无边框；关态轨道 border-l3、开态 brand-primary；
		// 滑块 16x16 圆，开态 label-primary-foreground 位移 16px、关态 switch-thumb。
		switchTrack: {
			boxSizing: "border-box",
			position: "relative",
			flex: "0 0 auto",
			width: 36,
			height: 20,
			padding: 2,
			border: 0,
			borderRadius: 999,
			cursor: "pointer",
			transition: "background .12s ease"
		},
		switchTrackOn: { background: "var(--dsw-alias-brand-primary)" },
		switchTrackOff: { background: "var(--dsw-alias-border-l3)" },
		switchTrackFocus: {
			outline: "var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary))",
			outlineOffset: 2
		},
		switchThumb: {
			display: "block",
			width: 16,
			height: 16,
			borderRadius: "50%",
			background: "var(--dsw-alias-label-primary-foreground)",
			transition: "transform .12s ease, background .12s ease"
		},
		switchThumbOn: { transform: "translateX(16px)" },
		switchThumbOff: { background: "var(--dsw-alias-switch-thumb)" },
		switchTextOn: { fontSize: 13, color: "var(--dsw-alias-label-primary)" },
		switchTextOff: { fontSize: 13, color: "var(--dsw-alias-label-tertiary)" },

		dirty: { fontSize: 12, color: "var(--dsw-alias-state-warn-label)", whiteSpace: "nowrap" },
		saved: { fontSize: 12, color: "var(--dsw-alias-state-success-primary)", whiteSpace: "nowrap" },
		error: { fontSize: 12, color: "var(--dsw-alias-state-error-primary)", overflowWrap: "anywhere" },
		toolChip: {
			display: "inline-block",
			margin: "0 6px 6px 0",
			padding: "0 8px",
			borderRadius: 999,
			border: "1px solid var(--dsw-alias-border-l2)",
			background: "var(--dsw-alias-bg-layer-2)",
			fontFamily: "var(--dsw-font-markdown-code-font-family, ui-monospace, monospace)",
			fontSize: 12,
			lineHeight: "20px"
		}
	};

	/* ------------------------------------------------------------------ */
	/* 小组件                                                               */
	/* ------------------------------------------------------------------ */
	function Button({ variant = "secondary", disabled, onClick, children, title, label }) {
		const [hover, setHover] = useState(false);
		const base = variant === "primary" ? S.buttonPrimary : variant === "ghost" ? S.buttonGhost : S.button;
		const hoverStyle = variant === "primary"
			? S.buttonPrimaryHover
			: variant === "ghost" ? S.buttonGhostHover : S.buttonHover;
		const off = disabled === true;
		return h("button", {
			type: "button",
			style: off ? { ...base, ...S.buttonDisabled } : hover ? { ...base, ...hoverStyle } : base,
			disabled: off,
			title,
			"aria-label": label,
			onClick: off ? undefined : onClick,
			onMouseEnter: () => setHover(true),
			onMouseLeave: () => setHover(false)
		}, children);
	}

	function SectionCard({ title, open, onToggle, children, tt }) {
		return h("div", { style: S.sectionCard },
			h("button", {
				type: "button",
				style: S.sectionHead,
				"aria-expanded": open,
				"aria-label": tt(open ? "section.collapse" : "section.expand") + ": " + title,
				onClick: onToggle
			},
				h("span", { style: S.sectionHeadTitle }, title),
				h("svg", {
					viewBox: "0 0 16 16",
					width: 14,
					height: 14,
					fill: "none",
					stroke: "currentColor",
					strokeWidth: 1.5,
					strokeLinecap: "round",
					strokeLinejoin: "round",
					"aria-hidden": "true",
					style: { transition: "transform .15s ease", transform: open ? "rotate(180deg)" : "none" }
				}, h("path", { d: "M4 6l4 4 4-4" }))
			),
			open ? h("div", { style: S.sectionBody }, children) : null
		);
	}

	function StatusRow({ label, value, muted, first, children }) {
		return h("div", { style: first ? S.fieldGridFirst : S.fieldGrid },
			h("div", { style: S.fieldLabel }, label),
			h("div", { style: S.fieldControl },
				children !== undefined
					? children
					: h("div", { style: muted ? S.valueMuted : S.value }, value))
		);
	}

	function clock(ms) {
		if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
		const date = new Date(ms);
		const pad = (n) => String(n).padStart(2, "0");
		return pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
	}

	/** 布尔开关字段：切换即提交。 */
	function BoolField({ name, label, hint, value, disabled, danger, tt }) {
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		const [focused, setFocused] = useState(false);
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};
		const toggle = useCallback(async (next) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: next });
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		const on = value === true;
		const locked = busy === true || disabled === true;
		return h("div", { style: S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("div", { style: S.fieldActions },
					h("button", {
						type: "button",
						role: "switch",
						"aria-checked": on,
						"aria-label": label,
						disabled: locked,
						style: {
							...S.switchTrack,
							...(on ? S.switchTrackOn : S.switchTrackOff),
							...(focused ? S.switchTrackFocus : null),
							...(locked ? S.buttonDisabled : null)
						},
						onClick: () => toggle(!on),
						onFocus: () => setFocused(true),
						onBlur: () => setFocused(false)
					},
						h("span", { style: { ...S.switchThumb, ...(on ? S.switchThumbOn : S.switchThumbOff) } })
					),
					h("span", { style: on ? S.switchTextOn : S.switchTextOff }, tt(on ? "switch.on" : "switch.off")),
					busy ? h("span", { style: S.saved }, tt("action.saving")) : null,
					notice ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	/** 可编辑字段：草稿 + 保存/恢复默认。只有 draft !== value 时才允许保存。 */
	function Field({ name, label, hint, value, kind, placeholder, disabled, emptyMeansDefault, tt }) {
		const asText = (v) => (v === undefined || v === null ? "" : String(v));
		const [draft, setDraft] = useState(asText(value));
		const [busy, setBusy] = useState(false);
		const [error, setError] = useState(null);
		const [notice, setNotice] = useState(null);
		const [focused, setFocused] = useState(false);
		useEffect(() => { setDraft(asText(value)); }, [value]);
		const dirty = draft !== asText(value);
		const flash = (kind, message) => {
			setNotice({ kind, message });
			setTimeout(() => setNotice(null), 2200);
		};
		const commit = useCallback(async (payloadValue) => {
			if (busy) return;
			setBusy(true);
			setError(null);
			setNotice(null);
			try {
				await postJsonOrThrow(SETTINGS_PATH, { field: name, value: payloadValue });
				if (payloadValue === null) setDraft("");
				flash("ok", tt("action.saved"));
			} catch (reason) {
				setError(tt("action.saveError").replace("{error}", reason instanceof Error ? reason.message : String(reason)));
			} finally {
				setBusy(false);
			}
		}, [name, busy, tt]);
		return h("div", { style: S.fieldGrid },
			h("div", null,
				h("div", { style: S.fieldLabel }, label),
				hint ? h("div", { style: S.fieldHint }, hint) : null
			),
			h("div", { style: S.fieldControl },
				h("input", {
					style: focused && !disabled ? { ...S.input, ...S.inputFocus } : S.input,
					type: kind === "number" ? "number" : "text",
					value: draft,
					placeholder,
					disabled: disabled || busy,
					"aria-label": label,
					onChange: (event) => setDraft(event.target.value),
					onFocus: () => setFocused(true),
					onBlur: () => setFocused(false)
				}),
				h("div", { style: S.fieldActions },
					h(Button, {
						variant: dirty ? "primary" : "secondary",
						disabled: busy || !dirty,
						onClick: () => commit(draft),
						label: tt("action.save") + " " + label
					}, busy ? tt("action.saving") : tt("action.save")),
					emptyMeansDefault
						? h(Button, {
							variant: "ghost",
							disabled: busy || draft === "",
							onClick: () => commit(null),
							label: tt("action.reset") + " " + label
						}, busy ? tt("action.resetting") : tt("action.reset"))
						: null,
					dirty ? h("span", { style: S.dirty }, tt("action.dirty")) : null,
					notice ? h("span", { style: S.saved }, notice.message) : null
				),
				error ? h("div", { style: { ...S.error, marginTop: 6 }, role: "alert" }, error) : null
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* 面板主体                                                             */
	/* ------------------------------------------------------------------ */
	function PanelPage({ tt, localeSubscribe }) {
		const [data, setData] = useState(null);
		const [error, setError] = useState(null);
		const [loadedOnce, setLoadedOnce] = useState(false);
		const [updatedAt, setUpdatedAt] = useState(0);
		const [, setLocaleRevision] = useState(0);
		const [openSections, setOpenSections] = useState({ status: true, safety: true, behavior: true });
		const generation = useRef(0);
		const inFlight = useRef(null);

		useEffect(() => {
			if (typeof localeSubscribe !== "function") return undefined;
			return localeSubscribe(() => setLocaleRevision((revision) => revision + 1));
		}, [localeSubscribe]);

		const load = useCallback(async () => {
			generation.current += 1;
			const mine = generation.current;
			const isCurrent = () => generation.current === mine;
			inFlight.current?.abort?.();
			const controller = typeof AbortController === "function" ? new AbortController() : null;
			inFlight.current = controller;
			try {
				const { status, body } = await getJson(STATE_PATH);
				if (!isCurrent()) return;
				if (body === null || body.ok !== true) {
					setData(null);
					setError(typeof body?.error === "string" ? body.error : "HTTP " + status);
					return;
				}
				setData(body);
				setError(null);
				setUpdatedAt(Date.now());
			} catch (reason) {
				if (!isCurrent()) return;
				setError(reason instanceof Error ? reason.message : String(reason));
			} finally {
				if (isCurrent()) setLoadedOnce(true);
				if (inFlight.current === controller) inFlight.current = null;
			}
		}, []);

		useEffect(() => {
			let alive = true;
			let timer = null;
			const run = () => { if (alive) load(); };
			const start = () => { if (timer === null) timer = setInterval(run, 30000); };
			const stop = () => { if (timer !== null) { clearInterval(timer); timer = null; } };
			run();
			start();
			const onVisibility = () => {
				if (!alive) return;
				if (document.visibilityState === "hidden") stop();
				else { run(); start(); }
			};
			document.addEventListener("visibilitychange", onVisibility);
			return () => {
				alive = false;
				stop();
				document.removeEventListener("visibilitychange", onVisibility);
			};
		}, [load]);

		const toggleSection = useCallback((key) => {
			setOpenSections((current) => ({ ...current, [key]: !current[key] }));
		}, []);

		const effective = data?.effective ?? {};
		const defaults = data?.defaults ?? {};
		const registered = Array.isArray(data?.registeredTools) ? data.registeredTools : [];
		const disabled = effective.enabled === false;
		const isWindows = data?.platform === "win32";

		if (loadedOnce === false) {
			return h("div", { style: S.page },
				h("div", { style: S.header }, h("span", { style: S.subtitle }, tt("panel.loading"))));
		}

		return h("div", { style: S.page },
			h("div", { style: S.header },
				h("div", { style: S.titleBlock },
					h("h2", { style: S.title }, tt("panel.title")),
					h("p", { style: S.subtitle }, tt("panel.subtitle"))
				),
				h("div", { style: S.cluster },
					updatedAt ? h("span", { style: S.updated }, tt("panel.updated").replace("{time}", clock(updatedAt))) : null,
					h(Button, { onClick: () => load(), label: tt("panel.refresh") }, tt("panel.refresh"))
				)
			),
			h("div", { style: S.scroll },
				h("div", { style: S.content },
					error ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.error").replace("{error}", error)) : null,
					data && data.configError ? h("div", { style: S.noticeBad, role: "alert" },
						tt("panel.configError").replace("{error}", data.configError)) : null,
					disabled ? h("div", { style: S.notice }, tt("panel.disabled")) : null,
					isWindows ? null : h("div", { style: S.noticeWarn },
						tt("warn.nonWindows").replace("{name}", String(data?.platform ?? "?"))),

					data && openSections.status ? h(SectionCard, {
						title: tt("section.status"),
						open: true,
						onToggle: () => toggleSection("status"),
						tt
					},
						h(StatusRow, {
							label: tt("status.platform"),
							first: true,
							muted: !isWindows,
							value: isWindows ? tt("status.platformWin") : String(data?.platform ?? "?")
						}),
						h(StatusRow, { label: tt("status.entry"), muted: true, value: String(data?.plugin?.entry ?? "") }),
						h(StatusRow, {
							label: tt("status.tools"),
							children: registered.length === 0
								? h("div", { style: S.valueMuted }, tt("status.toolsNone"))
								: h("div", null, registered.map((tool) =>
									h("code", { key: tool, style: S.toolChip }, tool)))
						}),
						h(StatusRow, {
							label: tt("status.cache"),
							muted: true,
							value: tt("status.cacheValue")
								.replace("{count}", String(data?.imageCacheSize ?? 0))
								.replace("{max}", String(effective.imageCacheSize ?? defaults.imageCacheSize ?? ""))
						})
					) : null,

					data && openSections.safety ? h(SectionCard, {
						title: tt("section.safety"),
						open: true,
						onToggle: () => toggleSection("safety"),
						tt
					},
						h(BoolField, {
							name: "enabled",
							label: tt("field.enabled"),
							hint: tt("field.enabledHint"),
							value: effective.enabled,
							tt
						}),
						h(BoolField, {
							name: "allowCapture",
							label: tt("field.allowCapture"),
							hint: tt("field.allowCaptureHint"),
							value: effective.allowCapture,
							disabled: disabled,
							tt
						}),
						h(BoolField, {
							name: "allowInput",
							label: tt("field.allowInput"),
							hint: tt("field.allowInputHint"),
							value: effective.allowInput,
							disabled: disabled,
							tt
						}),
						disabled ? null : (effective.allowInput === true
							? h("div", { style: S.noticeWarn, role: "status" }, tt("warn.inputOn"))
							: h("div", { style: S.noticeOk, role: "status" }, tt("warn.inputOff")))
					) : null,

					data && openSections.behavior ? h(SectionCard, {
						title: tt("section.behavior"),
						open: true,
						onToggle: () => toggleSection("behavior"),
						tt
					},
						h(Field, {
							name: "captureMaxWidth",
							label: tt("field.captureMaxWidth"),
							hint: tt("field.captureMaxWidthHint")
								.replace("{min}", "320").replace("{max}", "8192"),
							value: effective.captureMaxWidth,
							kind: "number",
							disabled: disabled,
							tt
						}),
						h(Field, {
							name: "imageCacheSize",
							label: tt("field.imageCacheSize"),
							hint: tt("field.imageCacheSizeHint")
								.replace("{min}", "4").replace("{max}", "512"),
							value: effective.imageCacheSize,
							kind: "number",
							disabled: disabled,
							tt
						}),
						h(Field, {
							name: "excludeWindowTitles",
							label: tt("field.excludeWindowTitles"),
							hint: tt("field.excludeWindowTitlesHint"),
							value: Array.isArray(effective.excludeWindowTitles)
								? effective.excludeWindowTitles.join(", ")
								: "",
							kind: "text",
							placeholder: "1Password, 银行",
							disabled: disabled,
							emptyMeansDefault: true,
							tt
						})
					) : null
				)
			)
		);
	}

	/* ------------------------------------------------------------------ */
	/* 挂载                                                                 */
	/* ------------------------------------------------------------------ */
	function apply(ctx) {
		ctx.effect(() => {
			try {
				return ctx.locale.register(NS, { zh, en });
			} catch {
				return () => {};
			}
		}, NS + ": dictionaries");

		let translate = (key) => key;
		try {
			translate = ctx.locale.bind(NS);
		} catch { /* locale 服务不可用时按原文渲染 */ }
		const tt = (key) => {
			try {
				return translate(key);
			} catch {
				return key;
			}
		};

		const disposers = [];
		try {
			disposers.push(ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
				name: "plugins.bundle.config",
				key: NS,
				locale: NS,
				inject: () => ({
					tt,
					localeSubscribe: ctx.locale.subscribe.bind(ctx.locale)
				})
			}, PanelPage)));
		} catch (error) {
			console.warn("[" + NS + "] config card registration failed:", error);
		}
		ctx.effect(() => () => {
			for (const dispose of disposers.splice(0)) try { dispose(); } catch { /* 宿主可能已拆除 */ }
		}, NS + ": ui mounts");
	}

	const inject = ["slots", "locale"];

	function clientFactory(loaderRequire) {
		provideClientReact(loaderRequire("react"));
		return {
			inject,
			apply,
			/** Node 侧测试面：宿主只读 inject/apply。 */
			panel: Object.freeze({
				dictionaries: Object.freeze({ zh, en }),
				styles: S,
				paths: Object.freeze({ NS, STATE_PATH, SETTINGS_PATH }),
				helpers: Object.freeze({ clock }),
				components: Object.freeze({ PanelPage, SectionCard, StatusRow, Field, BoolField, Button })
			})
		};
	}

	const REGISTRATION = { id: NS, factory: clientFactory };
	if (typeof window !== "undefined") {
		const loader = window.__ModuleLoader__;
		if (loader !== undefined) loader.load(REGISTRATION);
	}
	if (typeof module !== "undefined" && module !== null && module.exports !== undefined) {
		module.exports = REGISTRATION;
	}

	return REGISTRATION;
})();
