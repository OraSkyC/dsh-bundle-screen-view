// Win32 input synthesis over koffi: SendInput (user32) with hand-laid INPUT
// structs. Layout on x64 (sizeof INPUT == 40, the union 8-aligned at 8):
//
//   offset 0:  DWORD type            (0 = MOUSE, 1 = KEYBOARD)
//   offset 8:  union {
//     MOUSEINPUT: LONG dx@8, LONG dy@12, DWORD mouseData@16,
//                 DWORD dwFlags@20, DWORD time@24, ULONGLONG dwExtraInfo@28
//     KEYBDINPUT: WORD wVk@8, WORD wScan@10, DWORD dwFlags@12,
//                 DWORD time@16, ULONGLONG dwExtraInfo@20
//   }
//
// Absolute mouse coordinates are mapped onto the virtual screen (the union of
// all monitors) with the 0..65535 normalization SendInput expects.
import { getApi } from './capture.js';

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;
const SW_RESTORE = 9;

const INPUT_SIZE = 40;
const SEND_BATCH = 128;

const BUTTONS = {
	left: { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP },
	right: { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP },
	middle: { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP },
};

let inputApi = null;

/** getApi() plus the SendInput/focus functions. */
export function getInputApi() {
	if (inputApi) return inputApi;
	const base = getApi();
	const user32 = base.koffi.load('user32.dll');
	inputApi = {
		...base,
		SendInput: user32.func('uint32_t __stdcall SendInput(uint32_t nInputs, void* pInputs, int cbSize)'),
		SwitchToThisWindow: user32.func('int __stdcall SwitchToThisWindow(void* hwnd, int altTab)'),
		SetForegroundWindow: user32.func('void* __stdcall SetForegroundWindow(void* hwnd)'),
		ShowWindow: user32.func('int __stdcall ShowWindow(void* hwnd, int nCmdShow)'),
	};
	return inputApi;
}

function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

/** 40-byte INPUT for a mouse event. */
function mouseInput(x, y, mouseData, flags) {
	const buf = Buffer.alloc(INPUT_SIZE);
	buf.writeUInt32LE(INPUT_MOUSE, 0);
	buf.writeInt32LE(x, 8);
	buf.writeInt32LE(y, 12);
	buf.writeUInt32LE(mouseData >>> 0, 16);
	buf.writeUInt32LE(flags >>> 0, 20);
	buf.writeUInt32LE(0, 24); // time: 0 = system-supplied
	buf.writeBigUInt64LE(0n, 28); // dwExtraInfo
	return buf;
}

/** 40-byte INPUT for a keyboard event. */
function keyInput(wVk, wScan, flags) {
	const buf = Buffer.alloc(INPUT_SIZE);
	buf.writeUInt32LE(INPUT_KEYBOARD, 0);
	buf.writeUInt16LE(wVk & 0xffff, 8);
	buf.writeUInt16LE(wScan & 0xffff, 10);
	buf.writeUInt32LE(flags >>> 0, 12);
	buf.writeUInt32LE(0, 16); // time
	buf.writeBigUInt64LE(0n, 20); // dwExtraInfo
	return buf;
}

/** Send a list of INPUT buffers, in batches, verifying the sent count. */
function sendInputs(api, list) {
	for (let i = 0; i < list.length; i += SEND_BATCH) {
		const chunk = list.slice(i, i + SEND_BATCH);
		const buf = Buffer.concat(chunk);
		const sent = api.SendInput(chunk.length, buf, INPUT_SIZE);
		if (sent !== chunk.length) {
			const err = api.GetLastError();
			let hint = '';
			if (err === 5) {
				hint = ' — ACCESS_DENIED: the session is locked, or the foreground window is '
					+ 'running at a higher integrity level (e.g. elevated); unlock it or bring a '
					+ 'normal window to the foreground, then retry';
			} else if (err === 87) {
				hint = ' — invalid parameter (possible struct layout bug)';
			}
			throw new Error(`SendInput sent only ${sent}/${chunk.length} inputs (Win32 ${err})${hint}`);
		}
	}
}

/**
 * Map a virtual-screen coordinate to SendInput's absolute 0..65535 space.
 * @returns `[x, y]` in absolute units.
 */
export function toAbsolute(api, x, y) {
	const vx = api.GetSystemMetrics(SM_XVIRTUALSCREEN);
	const vy = api.GetSystemMetrics(SM_YVIRTUALSCREEN);
	const vw = api.GetSystemMetrics(SM_CXVIRTUALSCREEN);
	const vh = api.GetSystemMetrics(SM_CYVIRTUALSCREEN);
	if (vw <= 1 || vh <= 1) throw new Error(`Unexpected virtual screen ${vw}x${vh}`);
	const ax = Math.round(((x - vx) * 65535) / (vw - 1));
	const ay = Math.round(((y - vy) * 65535) / (vh - 1));
	return [clamp(ax, 0, 65535), clamp(ay, 0, 65535)];
}

/** Build the absolute-move INPUT for (x, y). */
export function moveInput(api, x, y) {
	const [ax, ay] = toAbsolute(api, x, y);
	return mouseInput(ax, ay, 0, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE);
}

/**
 * Move the cursor to (x, y) and click `clicks` times (2/3 = double/triple).
 * @param x - virtual-screen X.
 * @param y - virtual-screen Y.
 * @param button - 'left' | 'right' | 'middle' (default 'left').
 * @param clicks - 1..3 (default 1).
 */
export function clickAt(x, y, button = 'left', clicks = 1) {
	const api = getInputApi();
	const btn = BUTTONS[button];
	if (!btn) throw new Error(`Unknown button "${button}"; use left, right, or middle`);
	const n = Math.max(1, Math.min(3, Math.floor(clicks)));
	const inputs = [moveInput(api, x, y)];
	for (let i = 0; i < n; i++) {
		inputs.push(mouseInput(0, 0, 0, btn.down));
		inputs.push(mouseInput(0, 0, 0, btn.up));
	}
	sendInputs(api, inputs);
}

/**
 * Type text into the focused window via KEYEVENTF_UNICODE pairs.
 * UTF-16 surrogate pairs are emitted as their two code units.
 */
export function typeText(text) {
	if (typeof text !== 'string' || text.length === 0) {
		throw new Error('type_text requires a non-empty "text" string');
	}
	const api = getInputApi();
	const inputs = [];
	for (const cp of text) {
		for (let i = 0; i < cp.length; i++) {
			const u = cp.charCodeAt(i);
			inputs.push(keyInput(u, 0, KEYEVENTF_UNICODE));
			inputs.push(keyInput(u, 0, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
		}
	}
	sendInputs(api, inputs);
}

const VK_NAMES = {
	enter: 0x0d,
	return: 0x0d,
	tab: 0x09,
	esc: 0x1b,
	escape: 0x1b,
	backspace: 0x08,
	delete: 0x2e,
	del: 0x2e,
	insert: 0x2d,
	ins: 0x2d,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	pagedown: 0x22,
	left: 0x25,
	up: 0x26,
	right: 0x27,
	down: 0x28,
	space: 0x20,
	shift: 0x10,
	ctrl: 0x11,
	control: 0x11,
	alt: 0x12,
	win: 0x5b,
	windows: 0x5b,
	printscreen: 0x2c,
	scrolllock: 0x91,
	pause: 0x13,
	plus: 0xbb,
	minus: 0xbd,
	comma: 0xbc,
	period: 0xbe,
	slash: 0xbf,
	semicolon: 0xba,
	apostrophe: 0x27,
};
for (let i = 1; i <= 24; i++) VK_NAMES[`f${i}`] = 0x70 + (i - 1);

const VK_HINT =
	'supported: a-z, 0-9, f1-f24, enter, tab, esc, backspace, delete, insert, home, end, pageup, pagedown, left, up, right, down, space, shift, ctrl, alt, win';

function vkFor(token, combo) {
	const t = token.toLowerCase();
	if (VK_NAMES[t] !== undefined) return VK_NAMES[t];
	if (/^[a-z0-9]$/.test(t)) return t.toUpperCase().charCodeAt(0);
	throw new Error(`Unknown key "${token}" in combo "${combo}". ${VK_HINT}`);
}

/**
 * Press a key or combo like 'ctrl+shift+t', 'enter', 'alt+f4'.
 * Modifiers go down in order, up in reverse.
 */
export function pressKey(combo) {
	if (typeof combo !== 'string' || !combo.trim()) {
		throw new Error('key requires a non-empty "combo" like "ctrl+a" or "enter"');
	}
	const tokens = combo
		.toLowerCase()
		.split('+')
		.map((s) => s.trim())
		.filter(Boolean);
	if (tokens.length === 0) throw new Error(`Empty key combo "${combo}"`);
	const vks = tokens.map((t) => vkFor(t, combo));
	const inputs = vks.map((vk) => keyInput(vk, 0, 0));
	for (let i = vks.length - 1; i >= 0; i--) inputs.push(keyInput(vks[i], 0, KEYEVENTF_KEYUP));
	const api = getInputApi();
	sendInputs(api, inputs);
}

/**
 * Scroll at (x, y) — moving the cursor there first when given — or at the
 * current cursor position when x/y are omitted.
 * @param deltaY - wheel units; +120 = one notch up, negative = down.
 */
export function scrollAt(x, y, deltaY) {
	const api = getInputApi();
	const amount = Math.max(-100000, Math.min(100000, Math.floor(deltaY)));
	if (amount === 0) throw new Error('scroll requires a non-zero integer deltaY (120 = one notch)');
	const inputs =
		x !== undefined && y !== undefined ? [moveInput(api, x, y)] : [];
	inputs.push(mouseInput(0, 0, amount >>> 0, MOUSEEVENTF_WHEEL));
	sendInputs(api, inputs);
}

/**
 * Best-effort foreground switch for a window: restore it if minimized
 * (ShowWindow SW_RESTORE — SwitchToThisWindow alone cannot un-minimize),
 * then SwitchToThisWindow (which a background process may use without the
 * foreground-lock exemption) plus SetForegroundWindow.
 */
export function activateWindow(hwnd) {
	const api = getInputApi();
	if (api.IsIconic(hwnd)) api.ShowWindow(hwnd, SW_RESTORE);
	api.SwitchToThisWindow(hwnd, 1);
	api.SetForegroundWindow(hwnd);
}
