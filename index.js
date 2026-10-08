// Screen View: desktop screenshot, window-list, and desktop input-control
// tools for the DSH Host.
//
// Self-contained by design: no @deepseek-ai imports (a profile-installed
// bundle resolves bare specifiers from the profile's node_modules, which does
// not carry the Desktop installation's packages). Win32 capture and input go
// through the koffi copy the Desktop host itself ships inside its asar tree.
import {
	capturePrimaryScreen,
	captureWindow,
	downscale,
	findWindow,
	getApi,
	listWindows,
} from './lib/capture.js';
import { activateWindow, clickAt, pressKey, scrollAt, typeText } from './lib/input.js';
import { encodePng } from './lib/png.js';

const name = 'screen-view';
const inject = ['tools', 'attachments'];

/**
 * Recent image attachment refs, so render() can emit the ImageBlock that gets
 * the pixels to the model after execute() has committed them. Bounded LRU.
 */
const imageCache = new Map();
const IMAGE_CACHE_MAX = 64;

function rememberImage(ref) {
	if (imageCache.size >= IMAGE_CACHE_MAX) {
		const oldest = imageCache.keys().next().value;
		imageCache.delete(oldest);
	}
	imageCache.delete(ref.attachmentId);
	imageCache.set(ref.attachmentId, ref);
}

function presentRead(title) {
	return { card: 'generic', kind: 'read', title };
}

function presentAct(title) {
	return { card: 'generic', kind: 'act', title };
}

const INPUT_NOTICE =
	' This tool drives the real desktop — use it only when the user asked you to operate the UI, and prefer targeting one specific window.';

/**
 * Register the desktop tools: two read-only (window_list, screenshot) and
 * five input-control (mouse_click, type_text, key, scroll, window_activate).
 * @param ctx - Agent-scoped registration context (tools, attachments).
 * @returns cleanup that unregisters the tools.
 */
function apply(ctx) {
	const unregisters = [];
	unregisters.push(
		ctx.tools.register({
			name: 'window_list',
			description:
				'List the visible top-level windows on the local machine, frontmost first: hwnd, title, and screen rectangle. Use it to find a window to capture with screenshot (pass a substring of its title) or to reason about what the user is looking at. Read-only; it never moves, opens, or touches any window.',
			parameters: {
				type: 'object',
				properties: {},
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{
						type: 'text',
						text: (Array.isArray(value) ? value : [])
							.map((w) => `hwnd=${w.hwnd}  x=${w.x},y=${w.y}  ${w.w}x${w.h}  "${w.title}"`)
							.join('\n'),
					},
				],
			},
			presentCall: () => presentRead('List desktop windows'),
			timeoutMs: 15000,
			execute() {
				const api = getApi();
				return Promise.resolve(listWindows(api));
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'screenshot',
			description:
				'Capture a screenshot of the local desktop and return it as an image you can see, plus a text summary. Omit "window" for the full primary screen; pass a case-insensitive substring of a window title to capture just that window (frontmost wins when several match). Set maxWidth to cap the output width in pixels (default 2560); larger captures are downscaled. Window captures show the pixels visible at the window rectangle, so bring the window to the front with window_activate first or occluding windows appear in its place; minimized windows are rejected (window_activate restores them first), and fully off-screen windows fall back to PrintWindow and may come back blank. The returned attachment id identifies the saved image. Read-only: it never clicks, types, or moves anything.',
			parameters: {
				type: 'object',
				properties: {
					window: {
						type: 'string',
						description:
							'Optional case-insensitive substring of a window title; omit to capture the full primary screen.',
					},
					maxWidth: {
						type: 'integer',
						description:
							'Optional maximum output width in pixels (default 2560). Larger captures are downscaled to fit.',
					},
				},
			},
			output: {
				schema: {},
				render: (_args, value) => {
					const ref = value?.id ? imageCache.get(value.id) : undefined;
					const blocks = [];
					if (ref) blocks.push({ type: 'image', attachment: ref });
					const scope = value?.windowTitle
						? `window "${value.windowTitle}"`
						: 'the primary screen';
					blocks.push({
						type: 'text',
						text: `Screenshot of ${scope}: ${value?.width}x${value?.height} px (${Math.ceil((value?.pngBytes ?? 0) / 1024)} KiB PNG). Attachment id ${value?.id ?? 'unknown'}.`,
					});
					return blocks;
				},
			},
			presentCall: (args) =>
				typeof args?.window === 'string' && args.window.trim()
					? presentRead(`Screenshot window "${args.window.trim()}"`)
					: presentRead('Screenshot primary screen'),
			timeoutMs: 30000,
			async execute(args) {
				const needle = typeof args?.window === 'string' ? args.window.trim() : '';
				const maxW = Number.isInteger(args?.maxWidth) && args.maxWidth >= 64 ? args.maxWidth : 2560;
				const api = getApi();
				let shot;
				let title = '';
				if (needle) {
					const win = findWindow(api, needle);
					if (!win) {
						const candidates = listWindows(api)
							.slice(0, 20)
							.map((w) => `"${w.title}"`)
							.join(', ');
						throw new Error(
							`No visible window whose title contains "${needle}". Visible windows: ${candidates || '(none)'}`,
						);
					}
					title = win.title;
					shot = captureWindow(api, win.hwnd);
				} else {
					shot = capturePrimaryScreen(api);
				}
				const factor = Math.max(1, Math.floor(shot.width / maxW));
				if (factor > 1) shot = downscale(shot.bgra, shot.width, shot.height, factor);
				const png = encodePng(shot.bgra, shot.width, shot.height);
				const safeName = title
					? title.replace(/[^\p{L}\p{N} ]/gu, '').trim()
					: '';
				const ref = await ctx.attachments.saveImage({
					data: png,
					mediaType: 'image/png',
					name: `${safeName ? safeName.replace(/ +/g, ' ') : 'screen'}-${Date.now()}.png`.slice(0, 200),
				});
				rememberImage(ref);
				return {
					id: ref.attachmentId,
					width: ref.width ?? shot.width,
					height: ref.height ?? shot.height,
					pngBytes: png.length,
					windowTitle: title,
				};
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'window_activate',
			description:
				'Bring a window to the foreground on the local machine, given a case-insensitive substring of its title (restoring it first if minimized). Use it before type_text or key so input lands in the right window, or when the user asks you to focus a window. Frontmost title match wins.' + INPUT_NOTICE,
			parameters: {
				type: 'object',
				properties: {
					window: {
						type: 'string',
						description: 'Case-insensitive substring of the target window title.',
					},
				},
				required: ['window'],
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{ type: 'text', text: `Activated window "${value?.title ?? '?'}" (hwnd ${value?.hwnd ?? '?'})` },
				],
			},
			presentCall: (args) => presentAct(`Activate window "${args?.window ?? '?'}"`),
			timeoutMs: 10000,
			execute(args) {
				const needle = typeof args?.window === 'string' ? args.window.trim() : '';
				if (!needle) throw new Error('window_activate requires a "window" title substring');
				const api = getApi();
				const win = findWindow(api, needle);
				if (!win) {
					const candidates = listWindows(api)
						.slice(0, 20)
						.map((w) => `"${w.title}"`)
						.join(', ');
					throw new Error(`No visible window whose title contains "${needle}". Visible windows: ${candidates || '(none)'}`);
				}
				activateWindow(win.hwnd);
				return { hwnd: win.hwnd, title: win.title };
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'mouse_click',
			description:
				'Move the mouse to (x, y) in virtual-screen pixels (0,0 = top-left of the primary monitor) and click. button: left | right | middle (default left); clicks 1-3 (2 = double-click, default 1). Find coordinates from screenshot output and window_list rectangles. This really moves the user\'s cursor and clicks.' + INPUT_NOTICE,
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'integer', description: 'Virtual-screen X coordinate in pixels.' },
					y: { type: 'integer', description: 'Virtual-screen Y coordinate in pixels.' },
					button: {
						type: 'string',
						enum: ['left', 'right', 'middle'],
						description: 'Mouse button (default left).',
					},
					clicks: {
						type: 'integer',
						description: '1 = click, 2 = double-click, 3 = triple-click (default 1).',
					},
				},
				required: ['x', 'y'],
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{ type: 'text', text: `Clicked ${value?.button ?? 'left'} x${value?.clicks ?? 1} at (${value?.x}, ${value?.y})` },
				],
			},
			presentCall: (args) =>
				presentAct(`Click ${args?.button ?? 'left'} at (${args?.x}, ${args?.y})`),
			timeoutMs: 10000,
			execute(args) {
				const x = args?.x;
				const y = args?.y;
				if (!Number.isInteger(x) || !Number.isInteger(y)) {
					throw new Error('mouse_click requires integer x and y');
				}
				const button = args?.button ?? 'left';
				const clicks = Number.isInteger(args?.clicks) ? args.clicks : 1;
				clickAt(x, y, button, clicks);
				return { x, y, button, clicks };
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'type_text',
			description:
				'Type the given text into the currently focused window (Unicode input events, any language). Activate the target window with window_activate first if input must land somewhere specific. This really types on the user\'s desktop.' + INPUT_NOTICE,
			parameters: {
				type: 'object',
				properties: {
					text: { type: 'string', description: 'Text to type (may contain newlines and any Unicode).' },
				},
				required: ['text'],
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{ type: 'text', text: `Typed ${value?.chars} characters` },
				],
			},
			presentCall: (args) => {
				const t = typeof args?.text === 'string' ? args.text : '';
				const short = t.length > 32 ? `${t.slice(0, 32)}…` : t.replace(/\n/g, '↵');
				return presentAct(`Type "${short}"`);
			},
			timeoutMs: 15000,
			execute(args) {
				const text = args?.text;
				if (typeof text !== 'string' || text.length === 0) {
					throw new Error('type_text requires a non-empty "text" string');
				}
				typeText(text);
				return { chars: text.length };
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'key',
			description:
				'Press a key or key combination on the local desktop, e.g. "enter", "tab", "ctrl+a", "ctrl+shift+t", "alt+f4", "f5". Supported keys: a-z, 0-9, f1-f24, enter, tab, esc, backspace, delete, insert, home, end, pageup, pagedown, left, up, right, down, space, shift, ctrl, alt, win. Modifiers go down in order, up in reverse. This really presses keys on the user\'s desktop.' + INPUT_NOTICE,
			parameters: {
				type: 'object',
				properties: {
					combo: { type: 'string', description: 'Key or combo, e.g. "ctrl+shift+t".' },
				},
				required: ['combo'],
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{ type: 'text', text: `Pressed ${value?.combo}` },
				],
			},
			presentCall: (args) => presentAct(`Press ${args?.combo ?? '?'}`),
			timeoutMs: 10000,
			execute(args) {
				const combo = typeof args?.combo === 'string' ? args.combo.trim() : '';
				if (!combo) throw new Error('key requires a "combo" like "ctrl+a"');
				pressKey(combo);
				return { combo };
			},
		}),
	);
	unregisters.push(
		ctx.tools.register({
			name: 'scroll',
			description:
				'Scroll the page or window under the mouse cursor. Give x,y (virtual-screen pixels) to move the cursor there first; omit them to scroll at the current cursor position. deltaY: wheel units, +120 = one notch up, negative = down (e.g. -240 = two notches down). This really scrolls the user\'s desktop.' + INPUT_NOTICE,
			parameters: {
				type: 'object',
				properties: {
					x: { type: 'integer', description: 'Optional X to move the cursor to before scrolling.' },
					y: { type: 'integer', description: 'Optional Y to move the cursor to before scrolling.' },
					deltaY: { type: 'integer', description: 'Wheel units; 120 per notch, positive up, negative down.' },
				},
				required: ['deltaY'],
			},
			output: {
				schema: {},
				render: (_args, value) => [
					{
						type: 'text',
						text: value?.moved
							? `Scrolled ${value.deltaY} at (${value.x}, ${value.y})`
							: `Scrolled ${value.deltaY} at current cursor position`,
					},
				],
			},
			presentCall: (args) =>
				presentAct(
					Number.isInteger(args?.x)
						? `Scroll ${args.deltaY} at (${args.x}, ${args.y})`
						: `Scroll ${args?.deltaY ?? '?'} at cursor`,
				),
			timeoutMs: 10000,
			execute(args) {
				const deltaY = args?.deltaY;
				if (!Number.isInteger(deltaY) || deltaY === 0) {
					throw new Error('scroll requires a non-zero integer deltaY (120 = one notch)');
				}
				const x = Number.isInteger(args?.x) ? args.x : undefined;
				const y = Number.isInteger(args?.y) ? args.y : undefined;
				if ((x === undefined) !== (y === undefined)) {
					throw new Error('scroll: provide both x and y, or neither');
				}
				scrollAt(x, y, deltaY);
				return { x, y, deltaY, moved: x !== undefined };
			},
		}),
	);
	return () => {
		imageCache.clear();
		for (const unregister of unregisters) {
			if (typeof unregister === 'function') unregister();
		}
	};
}

export { apply, inject, name };
