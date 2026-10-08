// 宿主半侧验证：用假的宿主 context 驱动 apply()，再走配置、路由与工具注册。
// 跑完可删。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-sv-test-"));
process.env.DSH_HOME = ROOT;

const {
	FileStore,
	apply,
	inject,
	isAdmitted,
	isExcludedTitle,
	name,
	pkg,
	registerRoutes,
	registerTools,
	resolveSettings,
	stateDirectory,
	toolNames
} = await import("./index.js");

let passed = 0;
const ok = (label) => { passed += 1; console.log(`  ✓ ${label}`); };
const tick = () => new Promise((r) => setTimeout(r, 15));
async function until(predicate, timeoutMs = 3000, stepMs = 15) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error("until() 超时");
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

// ---- 假的宿主 context ------------------------------------------------
function makeHost() {
	const routes = [];
	const tools = [];
	const disposers = [];
	const ctx = {
		logger: { warn() {}, info() {}, error() {} },
		get(n) {
			if (n === "tools") return ctx.tools;
			if (n === "webServer") return ctx.webServer;
			return undefined;
		},
		webServer: { register(def) { routes.push(def); return () => { const i = routes.indexOf(def); if (i >= 0) routes.splice(i, 1); }; } },
		tools: { register(def) { tools.push(def); return () => { const i = tools.indexOf(def); if (i >= 0) tools.splice(i, 1); }; } },
		effect(fn) { disposers.push(fn()); return () => {}; },
		once() {}
	};
	return { ctx, routes, tools, disposers };
}
function makeResponse() {
	const res = { status: 0, headers: {}, body: "" };
	res.writeHead = (s, h) => { res.status = s; res.headers = h; };
	res.end = (b) => { res.body = b; };
	return res;
}
function makeRequest(method, headers = {}, body) {
	const req = { method, headers };
	if (body !== undefined) {
		const chunk = Buffer.from(JSON.stringify(body), "utf8");
		req[Symbol.asyncIterator] = async function* () { yield chunk; };
	}
	return req;
}

// ---- 0. 回归：inject 声明 --------------------------------------------
console.log("\n[0] inject 声明与受限代理");
{
	assert.ok(inject.includes("webServer"), `inject 应含 webServer，实际 ${JSON.stringify(inject)}`);
	assert.ok(inject.includes("tools"));
	assert.ok(inject.includes("attachments"));
	ok(`inject = ${JSON.stringify(inject)}`);

	// 受限代理：读未声明属性会抛错，apply() 必须静默降级
	const ctx = { logger: { warn() {} }, get() { return undefined; }, effect(fn) { return fn(); }, once() {} };
	Object.defineProperty(ctx, "webServer", {
		get() { throw new Error('cannot get property "webServer" without inject'); },
		configurable: true
	});
	let threw = null;
	try { apply(ctx, {}); } catch (e) { threw = e; }
	assert.equal(threw, null, `apply() 不应抛错: ${threw?.message}`);
	ok("ctx.webServer 抛受限代理错误 → apply() 静默降级");
}

// ---- 1. 配置归一化 ---------------------------------------------------
console.log("\n[1] 配置归一化");
{
	const d = resolveSettings({}).settings;
	assert.deepEqual(d, {
		enabled: true, allowCapture: true, allowInput: true,
		captureMaxWidth: 2560, imageCacheSize: 64, excludeWindowTitles: []
	});
	ok("空配置 → 默认值");

	assert.equal(resolveSettings({ captureMaxWidth: 999999 }).settings.captureMaxWidth, 8192);
	assert.equal(resolveSettings({ captureMaxWidth: 1 }).settings.captureMaxWidth, 320);
	assert.equal(resolveSettings({ captureMaxWidth: "abc" }).settings.captureMaxWidth, 2560);
	assert.equal(resolveSettings({ imageCacheSize: -5 }).settings.imageCacheSize, 4);
	assert.equal(resolveSettings({ imageCacheSize: 99999 }).settings.imageCacheSize, 512);
	ok("数值夹取与非法值回落");

	for (const field of ["enabled", "allowCapture", "allowInput"]) {
		assert.equal(resolveSettings({ [field]: false }).settings[field], false);
		assert.equal(resolveSettings({ [field]: "yes" }).settings[field], true, `${field} 非布尔应为默认 true`);
	}
	ok("布尔字段：false 生效，非布尔回落");

	assert.deepEqual(resolveSettings({ excludeWindowTitles: ["银行", " 密码 ", ""] }).settings.excludeWindowTitles, ["银行", "密码"]);
	assert.deepEqual(resolveSettings({ excludeWindowTitles: "1Password, 银行 , " }).settings.excludeWindowTitles, ["1Password", "银行"]);
	assert.deepEqual(resolveSettings({ excludeWindowTitles: 42 }).settings.excludeWindowTitles, []);
	ok("排除名单：列表 / 逗号串 / 非法值");
}

// ---- 2. 工具闸门 -----------------------------------------------------
console.log("\n[2] 工具闸门");
{
	const all = ["window_list", "screenshot", "window_activate", "mouse_click", "type_text", "key", "scroll"];
	assert.deepEqual(toolNames(resolveSettings({}).settings), all);
	ok(`默认注册全部 ${all.length} 个工具`);
	assert.deepEqual(toolNames(resolveSettings({ allowInput: false }).settings), ["window_list", "screenshot"]);
	ok("allowInput=false → 只剩只读两个（关键安全闸门）");
	assert.deepEqual(
		toolNames(resolveSettings({ allowCapture: false }).settings),
		["window_activate", "mouse_click", "type_text", "key", "scroll"]
	);
	ok("allowCapture=false → 只剩输入五个");
	assert.deepEqual(toolNames(resolveSettings({ enabled: false }).settings), []);
	ok("enabled=false → 一个都不注册");
}

// ---- 3. 窗口排除 -----------------------------------------------------
console.log("\n[3] 窗口排除名单");
{
	assert.equal(isExcludedTitle("1Password", ["1password"]), true, "应大小写不敏感");
	assert.equal(isExcludedTitle("我的银行 - Chrome", ["银行"]), true);
	assert.equal(isExcludedTitle("记事本", ["银行"]), false);
	assert.equal(isExcludedTitle("任意", []), false);
	assert.equal(isExcludedTitle(undefined, ["x"]), false);
	ok("命中判定：大小写不敏感、空名单不排除、undefined 安全");
}

// ---- 4. 状态覆盖层 ---------------------------------------------------
console.log("\n[4] 状态覆盖层");
{
	assert.ok(stateDirectory().endsWith(join("state", pkg)), stateDirectory());
	ok(`状态目录 → ${stateDirectory()}`);

	const store = new FileStore({ dir: join(ROOT, "store-probe"), file: "settings.json" });
	assert.deepEqual(await store.read(), {});
	await store.mutate((c) => ({ ...c, allowInput: false }));
	assert.deepEqual(await store.read(), { allowInput: false });
	await store.mutate((c) => { const n = { ...c }; delete n.allowInput; return n; });
	assert.deepEqual(await store.read(), {}, "删除覆盖 → 回落");
	ok("稀疏覆盖层：只存改过的字段，删除即回落");
}

// ---- 5. apply() 装配 + 路由 -----------------------------------------
console.log("\n[5] apply() 装配与路由");
{
	const host = makeHost();
	apply(host.ctx, {});
	await until(() => host.routes.length === 2 && host.tools.length === 7);

	assert.equal(host.routes.length, 2);
	ok(`路由: ${host.routes.map((r) => r.path).join(" | ")}`);
	assert.deepEqual(host.tools.map((t) => t.name).sort(),
		["key", "mouse_click", "screenshot", "scroll", "type_text", "window_activate", "window_list"].sort());
	ok("默认注册全部 7 个工具");

	const stateRoute = host.routes.find((r) => r.path.endsWith("/state"));
	const res = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "localhost" }), res);
	const state = JSON.parse(res.body);
	assert.equal(state.ok, true);
	assert.equal(state.plugin.name, pkg);
	assert.equal(state.plugin.entry, name);
	assert.equal(state.registeredTools.length, 7);
	assert.equal(state.effective.allowInput, true);
	ok("GET state → 只读快照，含已注册工具列表");

	// 403 / 405
	const refused = makeResponse();
	await stateRoute.handler(makeRequest("GET", { host: "evil.example" }), refused);
	assert.equal(refused.status, 403);
	const badMethod = makeResponse();
	await stateRoute.handler(makeRequest("DELETE", { host: "localhost" }), badMethod);
	assert.equal(badMethod.status, 405);
	ok("非回环 → 403；非 GET → 405");

	// POST settings：关掉输入组，工具必须立刻减到 2 个
	const settingsRoute = host.routes.find((r) => r.path.endsWith("/settings"));
	const put = makeResponse();
	await settingsRoute.handler(
		makeRequest("POST", { host: "localhost" }, { field: "allowInput", value: false }),
		put
	);
	const putBody = JSON.parse(put.body);
	assert.equal(putBody.ok, true);
	assert.deepEqual(putBody.registeredTools, ["window_list", "screenshot"]);
	assert.equal(host.tools.length, 2, "安全闸门改动后工具应立即重挂");
	ok("POST settings allowInput=false → 工具立即从 7 个减到 2 个（无需重启）");

	// 再开回来
	const put2 = makeResponse();
	await settingsRoute.handler(
		makeRequest("POST", { host: "localhost" }, { field: "allowInput", value: true }),
		put2
	);
	assert.equal(host.tools.length, 7);
	ok("再改回 true → 工具恢复 7 个");

	// 未知字段 / 空 field
	const bad = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "nope", value: 1 }), bad);
	assert.equal(bad.status, 400);
	const noField = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { value: 1 }), noField);
	assert.equal(noField.status, 400);
	ok("未知字段 / 缺 field → 400");

	// 排除名单写入后用逗号串
	const put3 = makeResponse();
	await settingsRoute.handler(
		makeRequest("POST", { host: "localhost" }, { field: "excludeWindowTitles", value: "1Password, 银行" }),
		put3
	);
	assert.deepEqual(JSON.parse(put3.body).effective.excludeWindowTitles, ["1Password", "银行"]);
	ok("排除名单可写成逗号串");

	// 恢复默认（value=null）
	const reset = makeResponse();
	await settingsRoute.handler(
		makeRequest("POST", { host: "localhost" }, { field: "excludeWindowTitles", value: null }),
		reset
	);
	assert.deepEqual(JSON.parse(reset.body).effective.excludeWindowTitles, []);
	ok("value=null → 删除覆盖，回落部署默认值");

	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 6. enabled=false 的装配 ----------------------------------------
console.log("\n[6] enabled=false");
{
	const host = makeHost();
	apply(host.ctx, { enabled: false });
	await until(() => host.routes.length === 2);
	assert.equal(host.tools.length, 0);
	ok("enabled=false → 路由仍在（面板能打开），但一个工具都不注册");
	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 7. 拿不到服务时降级 --------------------------------------------
console.log("\n[7] 拿不到服务时静默降级");
{
	const ctx = { logger: { warn() {} }, get() { return undefined; }, effect(fn) { return fn(); }, once() {} };
	let threw = null;
	try { apply(ctx, {}); } catch (e) { threw = e; }
	assert.equal(threw, null, `apply() 不应抛错: ${threw?.message}`);
	ok("无 webServer / tools → apply() 不抛错");

	// registerRoutes 单独调用：没有 webServer 时返回 null
	assert.equal(registerRoutes({ get() { return undefined; } }, { settings: {}, logger: null }), null);
	ok("registerRoutes 无 webServer → 返回 null");
}

// ---- 8. isAdmitted --------------------------------------------------
console.log("\n[8] 信任围栏");
{
	assert.equal(isAdmitted({ headers: { host: "localhost:8848" } }), true);
	assert.equal(isAdmitted({ headers: { host: "127.0.0.1" } }), true);
	assert.equal(isAdmitted({ headers: { host: "::1" } }), true);
	assert.equal(isAdmitted({ headers: { host: "[::1]:19387" } }), true);
	assert.equal(isAdmitted({ headers: { host: "example.com" } }), false);
	assert.equal(isAdmitted({ headers: {} }), false);
	assert.equal(isAdmitted(undefined), false);
	ok("只放行回环；IPv6 不被误剥端口");
}

// ---- 9. registerTools 直接驱动 --------------------------------------
console.log("\n[9] registerTools 直接驱动");
{
	const host = makeHost();
	const wiring = { ctx: host.ctx, settings: resolveSettings({ allowCapture: false }).settings, logger: null };
	const off = registerTools(host.ctx, wiring);
	assert.deepEqual(host.tools.map((t) => t.name).sort(),
		["key", "mouse_click", "scroll", "type_text", "window_activate"].sort());
	off();
	assert.equal(host.tools.length, 0, "清理回调应注销全部工具");
	ok("registerTools 按设置注册，清理回调注销干净");
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n宿主全部通过（${passed} 项断言组）`);
