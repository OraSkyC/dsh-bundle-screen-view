// Win32 screen and window capture over koffi (GDI), resolved from the Desktop
// installation's asar tree so this bundle stays dependency-free.
//
// Capture strategy:
//  1. Primary: screen DC + BitBlt (fast, ~37 ms for 2560x1440). Window
//     captures crop the window rectangle out of the DWM-composited screen
//     DC — the only reliable source for GPU-composited (Chromium/Electron)
//     windows, whose window-DC surface is a blank white background.
//  2. Fallback: per-window PrintWindow (fully off-screen windows, or when
//     the screen DC is unavailable, e.g. a locked session).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const SRCCOPY = 0x00cc0020;
const BLACKNESS = 0x00000042;
const PW_RENDERFULLCONTENT = 0x00000002;
const MAX_CANVAS_DIM = 8192;

/**
 * Resolve koffi the same way the Desktop host does: from the asar tree next to
 * the executable, with a plain require as a fallback for non-Desktop hosts.
 * @returns the koffi module.
 */
export function loadKoffi() {
	const errors = [];
	try {
		const base = path.join(
			path.dirname(process.execPath),
			'resources', 'app.asar', 'dsh', 'node_modules',
			'@deepseek-ai', 'dsh-desktop-host', 'node_modules', 'koffi', 'package.json',
		);
		if (fs.existsSync(base)) return createRequire(base)('koffi');
	} catch (error) {
		errors.push(String(error?.message ?? error));
	}
	try {
		return createRequire(import.meta.url)('koffi');
	} catch (error) {
		errors.push(String(error?.message ?? error));
	}
	throw new Error(`Cannot load koffi for screen capture: ${errors.join(' | ')}`);
}

let cached = null;

/** Lazily build and cache the user32/gdi32/kernel32 function surface. */
export function getApi() {
	if (cached) return cached;
	const koffi = loadKoffi();
	const user32 = koffi.load('user32.dll');
	const gdi32 = koffi.load('gdi32.dll');
	const kernel32 = koffi.load('kernel32.dll');
	cached = {
		koffi,
		GetSystemMetrics: user32.func('int __stdcall GetSystemMetrics(int index)'),
		GetDC: user32.func('void* __stdcall GetDC(void* hWnd)'),
		GetForegroundWindow: user32.func('void* __stdcall GetForegroundWindow(void)'),
		ReleaseDC: user32.func('int __stdcall ReleaseDC(void* hWnd, void* hdc)'),
		GetWindowDC: user32.func('void* __stdcall GetWindowDC(void* hWnd)'),
		EnumWindows: user32.func('int __stdcall EnumWindows(void* proc, void* lparam)'),
		GetWindowTextW: user32.func('int __stdcall GetWindowTextW(void* hwnd, void* buf, int maxCount)'),
		GetWindowRect: user32.func('int __stdcall GetWindowRect(void* hwnd, void* rect)'),
		IsWindowVisible: user32.func('int __stdcall IsWindowVisible(void* hwnd)'),
		IsIconic: user32.func('int __stdcall IsIconic(void* hwnd)'),
		PrintWindow: user32.func('int __stdcall PrintWindow(void* hwnd, void* hdc, uint32_t flags)'),
		CreateCompatibleDC: gdi32.func('void* __stdcall CreateCompatibleDC(void* hdc)'),
		CreateCompatibleBitmap: gdi32.func('void* __stdcall CreateCompatibleBitmap(void* hdc, int width, int height)'),
		SelectObject: gdi32.func('void* __stdcall SelectObject(void* hdc, void* handle)'),
		CreateSolidBrush: gdi32.func('void* __stdcall CreateSolidBrush(uint32_t color)'),
		PatBlt: gdi32.func('int __stdcall PatBlt(void* hdc, int x, int y, int cx, int cy, uint32_t rop)'),
		BitBlt: gdi32.func('int __stdcall BitBlt(void* hdcDst, int x, int y, int cx, int cy, void* hdcSrc, int sx, int sy, uint32_t rop)'),
		GetDIBits: gdi32.func('int __stdcall GetDIBits(void* hdc, void* hbm, uint32_t start, uint32_t cLines, void* bits, void* info, uint32_t usage)'),
		DeleteObject: gdi32.func('int __stdcall DeleteObject(void* handle)'),
		DeleteDC: gdi32.func('int __stdcall DeleteDC(void* hdc)'),
		GetLastError: kernel32.func('uint32_t __stdcall GetLastError(void)'),
	};
	return cached;
}

/** 40-byte BITMAPINFOHEADER: BI_RGB, 32bpp, top-down (negative height). */
function dibInfo(w, h) {
	const info = Buffer.alloc(40);
	info.writeUInt32LE(40, 0);
	info.writeInt32LE(w, 4);
	info.writeInt32LE(-h, 8);
	info.writeUInt16LE(1, 12);
	info.writeUInt16LE(32, 14);
	info.writeUInt32LE(0, 16); // BI_RGB
	return info;
}

/**
 * BitBlt a source DC into a fresh memory bitmap, then pull BGRA via GetDIBits.
 * @returns `{ bgra, width, height }`.
 */
function captureInto(api, hdcSrc, w, h, sx, sy) {
	const hdcMem = api.CreateCompatibleDC(hdcSrc);
	if (!hdcMem) throw new Error(`CreateCompatibleDC failed (Win32 ${api.GetLastError()}, src=${String(hdcSrc)})`);
	const hbm = api.CreateCompatibleBitmap(hdcSrc, w, h);
	if (!hbm) throw new Error(`CreateCompatibleBitmap failed (Win32 ${api.GetLastError()}, src=${String(hdcSrc)}, ${w}x${h})`);
	try {
		const prev = api.SelectObject(hdcMem, hbm);
		if (!api.BitBlt(hdcMem, 0, 0, w, h, hdcSrc, sx, sy, SRCCOPY)) {
			throw new Error(
				`BitBlt failed (Win32 ${api.GetLastError()}) `
				+ `src=${String(hdcSrc)} mem=${String(hdcMem)} bmp=${String(hbm)} prevSel=${String(prev)} `
				+ `dstSize=${w}x${h} srcPos=${sx},${sy}`,
			);
		}
		const bits = Buffer.alloc(w * h * 4);
		const lines = api.GetDIBits(hdcMem, hbm, 0, h, bits, dibInfo(w, h), 0);
		if (lines <= 0) throw new Error(`GetDIBits failed (${lines}, Win32 ${api.GetLastError()})`);
		return { bgra: bits, width: w, height: h };
	} finally {
		api.DeleteObject(hbm);
		api.DeleteDC(hdcMem);
	}
}

/**
 * Render one window into a memory DC via PrintWindow (PW_RENDERFULLCONTENT)
 * and pull BGRA. Works for DWM-rendered windows even when the window DC path
 * fails (verified to pull real Chromium content from occluded windows when
 * the memory DC is created from the SCREEN DC reference); secure/exclusive
 * windows come back blank.
 * @returns `{ bgra, width, height }`.
 */
function captureWindowPrint(api, hwnd, w, h) {
	// Screen-DC reference: a NULL-reference memory DC comes back all-black
	// under DWM (see captureWindow's note).
	const hdcScreen = api.GetDC(null);
	if (!hdcScreen) throw new Error(`GetDC(NULL) failed (Win32 ${api.GetLastError()})`);
	const hdcMem = api.CreateCompatibleDC(hdcScreen);
	if (!hdcMem) {
		api.ReleaseDC(null, hdcScreen);
		throw new Error(`CreateCompatibleDC failed (Win32 ${api.GetLastError()})`);
	}
	const hbm = api.CreateCompatibleBitmap(hdcScreen, w, h);
	if (!hbm) {
		api.DeleteDC(hdcMem);
		api.ReleaseDC(null, hdcScreen);
		throw new Error(`CreateCompatibleBitmap failed (Win32 ${api.GetLastError()}, ${w}x${h})`);
	}
	try {
		api.SelectObject(hdcMem, hbm);
		if (!api.PrintWindow(hwnd, hdcMem, PW_RENDERFULLCONTENT)) {
			throw new Error(`PrintWindow failed for hwnd ${hwnd} (Win32 ${api.GetLastError()})`);
		}
		const bits = Buffer.alloc(w * h * 4);
		const lines = api.GetDIBits(hdcMem, hbm, 0, h, bits, dibInfo(w, h), 0);
		if (lines <= 0) throw new Error(`GetDIBits failed after PrintWindow (${lines}, Win32 ${api.GetLastError()})`);
		return { bgra: bits, width: w, height: h };
	} finally {
		api.DeleteObject(hbm);
		api.DeleteDC(hdcMem);
		api.ReleaseDC(null, hdcScreen);
	}
}

/**
 * Composite the visible top-level windows (back-to-front) onto a full-screen
 * canvas via per-window PrintWindow. Used when the screen-DC BitBlt path is
 * unavailable. The canvas starts transparent-black; the desktop window
 * (Progman) contributes the wallpaper when it renders.
 * @returns `{ bgra, width, height, composite: true }`.
 */
function captureCompositeScreen(api, w, h) {
	const windows = listWindows(api);
	// Screen-DC reference for the canvas (a NULL-reference canvas comes back
	// all-black under DWM; see captureWindow's note).
	const hdcScreen = api.GetDC(null);
	if (!hdcScreen) throw new Error(`GetDC(NULL) failed (Win32 ${api.GetLastError()})`);
	const canvas = api.CreateCompatibleDC(hdcScreen);
	if (!canvas) {
		api.ReleaseDC(null, hdcScreen);
		throw new Error(`CreateCompatibleDC failed (Win32 ${api.GetLastError()})`);
	}
	const hbm = api.CreateCompatibleBitmap(hdcScreen, w, h);
	if (!hbm) {
		api.DeleteDC(canvas);
		api.ReleaseDC(null, hdcScreen);
		throw new Error(`CreateCompatibleBitmap failed for canvas (Win32 ${api.GetLastError()}, ${w}x${h})`);
	}
	try {
		api.SelectObject(canvas, hbm);
		let painted = 0;
		// EnumWindows yields Z order top-to-bottom; draw bottom-up so the
		// frontmost window is painted last.
		for (let i = windows.length - 1; i >= 0; i--) {
			const win = windows[i];
			const ww = win.w;
			const wh = win.h;
			if (ww <= 0 || wh <= 0) continue;
			// Skip windows that do not intersect the screen at all.
			if (win.x >= w || win.y >= h || win.x + ww <= 0 || win.y + wh <= 0) continue;
			const capW = Math.min(ww, MAX_CANVAS_DIM);
			const capH = Math.min(wh, MAX_CANVAS_DIM);
			const wdc = api.CreateCompatibleDC(hdcScreen);
			const wbm = api.CreateCompatibleBitmap(hdcScreen, capW, capH);
			if (!wdc || !wbm) {
				if (wdc) api.DeleteDC(wdc);
				if (wbm) api.DeleteObject(wbm);
				continue;
			}
			api.SelectObject(wdc, wbm);
			try {
				if (!api.PrintWindow(win.hwnd, wdc, PW_RENDERFULLCONTENT)) continue;
				// Blit the intersecting part onto the canvas (manual clip so
				// negative window offsets stay safe).
				const dx = win.x < 0 ? -win.x : 0;
				const dy = win.y < 0 ? -win.y : 0;
				const cw = capW - dx;
				const ch = capH - dy;
				if (cw <= 0 || ch <= 0) continue;
				api.BitBlt(canvas, Math.max(win.x, 0), Math.max(win.y, 0), cw, ch, wdc, dx, dy, SRCCOPY);
				painted++;
			} finally {
				api.DeleteObject(wbm);
				api.DeleteDC(wdc);
			}
		}
		const bits = Buffer.alloc(w * h * 4);
		const lines = api.GetDIBits(canvas, hbm, 0, h, bits, dibInfo(w, h), 0);
		if (lines <= 0) throw new Error(`GetDIBits failed in composite (${lines}, Win32 ${api.GetLastError()})`);
		if (painted === 0) {
			throw new Error('Composite capture painted no windows; screen is probably empty of visible top-level windows');
		}
		return { bgra: bits, width: w, height: h, composite: true };
	} finally {
		api.DeleteObject(hbm);
		api.DeleteDC(canvas);
		api.ReleaseDC(null, hdcScreen);
	}
}

/**
 * Capture the primary screen as a top-down BGRA raster.
 * @returns `{ bgra, width, height, composite? }`.
 */
export function capturePrimaryScreen(api) {
	const w = api.GetSystemMetrics(0); // SM_CXSCREEN
	const h = api.GetSystemMetrics(1); // SM_CYSCREEN
	if (w <= 0 || h <= 0) throw new Error(`Unexpected screen size ${w}x${h}`);
	const hdcScreen = api.GetDC(null);
	if (!hdcScreen) throw new Error(`GetDC failed (Win32 ${api.GetLastError()})`);
	try {
		return captureInto(api, hdcScreen, w, h, 0, 0);
	} catch (error) {
		const msg = String(error?.message ?? error);
		if (msg.startsWith('BitBlt failed')) {
			// No foreground window plus a dead screen DC means the interactive
			// desktop is inactive (locked session or display off); compositing
			// would fail the same way, so fail fast with an actionable hint.
			if (!api.GetForegroundWindow()) {
				throw new Error(
					`Screen capture unavailable: ${msg}. No foreground window is visible; `
					+ 'the workstation is probably locked or the display is off. '
					+ 'Unlock the session / power on the display and retry.',
				);
			}
			// Screen-DC path is unavailable in this process context; fall back
			// to per-window compositing.
			const shot = captureCompositeScreen(api, w, h);
			shot.compositeReason = msg;
			return shot;
		}
		throw error;
	} finally {
		api.ReleaseDC(null, hdcScreen);
	}
}

/**
 * Capture one window (frame rect, per GetWindowRect) as top-down BGRA.
 *
 * On-screen windows are cropped out of the DWM-composited screen DC: that is
 * the ground truth of what the user sees at the window rectangle, and the
 * only reliable source for GPU-composited (Chromium/Electron) windows, whose
 * window-DC surface is a blank white background (BitBlt "succeeds" into
 * white). Occluded windows show whatever is in front of them — bring the
 * window to the front (window_activate) before capturing. Minimized windows
 * are rejected with an actionable error (their GetWindowRect is a 237x39
 * thumbnail parked at -32000,-32000 — PrintWindow of it would be blank);
 * restore them with window_activate first. Windows parked beyond the virtual
 * desktop fall back to PrintWindow, which may come back blank for
 * GPU-composited windows.
 * @param hwnd - target window handle.
 * @returns `{ bgra, width, height, offscreen?, printWindow? }`.
 */
export function captureWindow(api, hwnd) {
	const rect = Buffer.alloc(16); // RECT as four little-endian i32
	if (!api.GetWindowRect(hwnd, rect)) throw new Error(`GetWindowRect failed for hwnd ${hwnd}`);
	const x = rect.readInt32LE(0);
	const y = rect.readInt32LE(4);
	const w = rect.readInt32LE(8) - x;
	const h = rect.readInt32LE(12) - y;
	if (api.IsIconic(hwnd)) {
		throw new Error(`Window ${hwnd} is minimized; restore it first (window_activate), then capture`);
	}
	if (w <= 0 || h <= 0) {
		throw new Error(`Window ${hwnd} has an empty rectangle (${w}x${h}); it may be off-screen`);
	}
	const vx = api.GetSystemMetrics(76); // SM_XVIRTUALSCREEN
	const vy = api.GetSystemMetrics(77); // SM_YVIRTUALSCREEN
	const vw = api.GetSystemMetrics(78); // SM_CXVIRTUALSCREEN
	const vh = api.GetSystemMetrics(79); // SM_CYVIRTUALSCREEN
	const ix = Math.max(x, vx);
	const iy = Math.max(y, vy);
	const iw = Math.min(x + w, vx + vw) - ix;
	const ih = Math.min(y + h, vy + vh) - iy;
	if (iw <= 0 || ih <= 0) {
		// Fully off the virtual desktop: best-effort PrintWindow.
		const shot = captureWindowPrint(api, hwnd, w, h);
		shot.offscreen = true;
		shot.printWindow = true;
		return shot;
	}
	// Memory DCs must be created with the SCREEN DC as reference: on this
	// machine a NULL-reference memory DC silently yields an all-black canvas
	// when BitBlt/PrintWindow renders into it under DWM (empirically verified
	// 2026-10-02 — the screen-reference variant returns real pixels).
	const hdcScreen = api.GetDC(null);
	if (!hdcScreen) throw new Error(`GetDC(NULL) failed (Win32 ${api.GetLastError()})`);
	let canvas = null;
	let hbm = null;
	try {
		canvas = api.CreateCompatibleDC(hdcScreen);
		hbm = api.CreateCompatibleBitmap(hdcScreen, w, h);
		if (!canvas || !hbm) {
			if (canvas) api.DeleteDC(canvas);
			if (hbm) api.DeleteObject(hbm);
			throw new Error(`CreateCompatibleDC/Bitmap failed for hwnd ${hwnd} (${w}x${h}, Win32 ${api.GetLastError()})`);
		}
		api.SelectObject(canvas, hbm);
		// Black-fill first so off-screen margins (maximized windows extend
		// ~11px past the virtual desktop) are never uninitialized memory.
		const brush = api.CreateSolidBrush(0);
		if (brush) {
			api.SelectObject(canvas, brush);
			api.PatBlt(canvas, 0, 0, w, h, BLACKNESS);
			api.SelectObject(canvas, hbm);
			api.DeleteObject(brush);
		}
		if (!api.BitBlt(canvas, ix - x, iy - y, iw, ih, hdcScreen, ix, iy, SRCCOPY)) {
			throw new Error(`BitBlt from screen DC failed for hwnd ${hwnd} (Win32 ${api.GetLastError()})`);
		}
		const bits = Buffer.alloc(w * h * 4);
		const lines = api.GetDIBits(canvas, hbm, 0, h, bits, dibInfo(w, h), 0);
		if (lines <= 0) throw new Error(`GetDIBits failed for hwnd ${hwnd} (${lines}, Win32 ${api.GetLastError()})`);
		return { bgra: bits, width: w, height: h };
	} catch (error) {
		// Screen DC unavailable (locked session, display off) — PrintWindow
		// is the last resort and may be blank.
		const msg = String(error?.message ?? error);
		if (msg.startsWith('BitBlt from screen DC failed') || msg.startsWith('GetDC(NULL) failed')
			|| msg.startsWith('CreateCompatibleDC/Bitmap failed')) {
			const shot = captureWindowPrint(api, hwnd, w, h);
			shot.printWindow = true;
			shot.printWindowReason = msg;
			return shot;
		}
		throw error;
	} finally {
		if (hbm) api.DeleteObject(hbm);
		if (canvas) api.DeleteDC(canvas);
		api.ReleaseDC(null, hdcScreen);
	}
}

/**
 * Enumerate visible, titled top-level windows in Z order (frontmost first).
 * @returns `{ hwnd, title, x, y, w, h }` per window.
 */
// koffi registers a named proto once per process; re-registering it throws
// "Duplicate type name". Build it lazily exactly once.
let wndProcType = null;
function getWndProcType(koffi) {
	if (!wndProcType) wndProcType = koffi.proto('int __stdcall WndProc(uintptr_t hwnd, intptr_t lparam)');
	return wndProcType;
}

export function listWindows(api) {
	const out = [];
	const cbType = getWndProcType(api.koffi);
	const cb = api.koffi.register((hwnd) => {
		try {
			if (!api.IsWindowVisible(hwnd)) return 1;
			const buf = Buffer.alloc(512 * 2);
			const n = api.GetWindowTextW(hwnd, buf, 256);
			if (n > 0) {
				const title = buf.toString('utf16le', 0, n * 2).trim();
				if (title) {
					const rect = Buffer.alloc(16);
					api.GetWindowRect(hwnd, rect);
					out.push({
						hwnd: Number(hwnd),
						title,
						x: rect.readInt32LE(0),
						y: rect.readInt32LE(4),
						w: rect.readInt32LE(8) - rect.readInt32LE(0),
						h: rect.readInt32LE(12) - rect.readInt32LE(4),
					});
				}
			}
		} catch {
			// keep the enumeration going
		}
		return 1;
	}, api.koffi.pointer(cbType));
	try {
		api.EnumWindows(cb, null);
	} finally {
		api.koffi.unregister(cb);
	}
	return out;
}

/**
 * Find the first (frontmost) visible window whose title contains needle.
 * @param needle - case-insensitive title substring.
 * @returns the matching window entry, or null.
 */
export function findWindow(api, needle) {
	const n = needle.toLowerCase();
	return listWindows(api).find((w) => w.title.toLowerCase().includes(n)) ?? null;
}

/**
 * Box-filter downscale of a BGRA raster by an integer factor.
 * @returns the shrunk raster `{ bgra, width, height }`.
 */
export function downscale(bgra, w, h, factor) {
	if (factor <= 1) return { bgra, width: w, height: h };
	const ow = Math.floor(w / factor);
	const oh = Math.floor(h / factor);
	const out = Buffer.alloc(ow * oh * 4);
	for (let oy = 0; oy < oh; oy++) {
		const sy0 = oy * factor;
		for (let ox = 0; ox < ow; ox++) {
			const sx0 = ox * factor;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			for (let dy = 0; dy < factor; dy++) {
				const row = (sy0 + dy) * w * 4;
				for (let dx = 0; dx < factor; dx++) {
					const s = row + (sx0 + dx) * 4;
					b += bgra[s];
					g += bgra[s + 1];
					r += bgra[s + 2];
					a += bgra[s + 3];
				}
			}
			const n = factor * factor;
			const d = (oy * ow + ox) * 4;
			out[d] = Math.round(b / n);
			out[d + 1] = Math.round(g / n);
			out[d + 2] = Math.round(r / n);
			out[d + 3] = Math.round(a / n);
		}
	}
	return { bgra: out, width: ow, height: oh };
}
