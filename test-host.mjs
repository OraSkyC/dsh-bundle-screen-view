// 宿主半侧验证：用假的宿主 context 驱动 apply()，再走配置、路由与工具注册。
// 跑完可删。
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "dsh-sv-test-"));
process.env.DSH_HOME = ROOT;

const {
	CONFIRM_TIMEOUT_SLACK_MS,
	CONFIRM_WAIT_FOREVER_MS,
	CONSENT_ALLOW_ONCE,
	CONSENT_ALLOW_SESSION,
	CONSENT_DENY,
	FileStore,
	describeGrantGap,
	grantList,
	shortSessionId,
	VERSION,
	apply,
	describeInputCall,
	inject,
	isAdmitted,
	isExcludedTitle,
	isSessionGranted,
	name,
	pkg,
	readConsentChoice,
	registerRoutes,
	registerTools,
	resolveSettings,
	sessionGrants,
	stateDirectory,
	toolNames,
	buildState,
	withConsent
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

	// 版本号必须来自 package.json：面板的版本小标就是靠它确认新构建有没有被加载
	// （宿主把客户端 bundle 在激活时读进内存，写死一处会漂移，那个信号就废了）。
	const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
	assert.equal(VERSION, manifest.version, `VERSION(${VERSION}) 应与 package.json(${manifest.version}) 一致`);
	assert.notEqual(VERSION, "0.0.0", "VERSION 不该是读取失败的回落值");
	ok(`VERSION 与 package.json 一致: ${VERSION}`);
}

// ---- 1. 配置归一化 ---------------------------------------------------
console.log("\n[1] 配置归一化");
{
	const d = resolveSettings({}).settings;
	assert.deepEqual(d, {
		enabled: true, allowCapture: true, allowInput: true, confirmInput: false,
		confirmTimeoutSeconds: 300, confirmAllowOnTimeout: false,
		captureMaxWidth: 2560, imageCacheSize: 64, excludeWindowTitles: []
	});
	ok("空配置 → 默认值（confirmInput 默认关；超时默认拒绝）");

	// 超时相关的三个字段
	assert.equal(resolveSettings({ confirmTimeoutSeconds: 0 }).settings.confirmTimeoutSeconds, 0, "0 = 不超时，要保留");
	assert.equal(resolveSettings({ confirmTimeoutSeconds: -5 }).settings.confirmTimeoutSeconds, 0);
	assert.equal(resolveSettings({ confirmTimeoutSeconds: 999999 }).settings.confirmTimeoutSeconds, 86400);
	assert.equal(resolveSettings({ confirmTimeoutSeconds: 12.6 }).settings.confirmTimeoutSeconds, 13, "取整");
	assert.equal(resolveSettings({ confirmTimeoutSeconds: "abc" }).settings.confirmTimeoutSeconds, 300);
	assert.equal(resolveSettings({ confirmAllowOnTimeout: true }).settings.confirmAllowOnTimeout, true);
	// 默认是 false，所以非布尔必须回落到 false —— 这个开关绝不能被一个意外值打开
	assert.equal(resolveSettings({ confirmAllowOnTimeout: "yes" }).settings.confirmAllowOnTimeout, false);
	assert.equal(resolveSettings({ confirmAllowOnTimeout: 1 }).settings.confirmAllowOnTimeout, false);
	ok("超时字段：秒数夹取到 0–86400（0=不超时），放行开关非布尔一律回落 false");

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

	assert.equal(resolveSettings({ confirmInput: true }).settings.confirmInput, true);
	assert.equal(resolveSettings({ confirmInput: false }).settings.confirmInput, false);
	// 默认是 false，所以非布尔值必须回落到 false（而不是像另外三个那样落到 true）
	assert.equal(resolveSettings({ confirmInput: "yes" }).settings.confirmInput, false);
	assert.equal(resolveSettings({ confirmInput: 1 }).settings.confirmInput, false);
	ok("confirmInput：非布尔一律回落 false —— 闸门绝不能被一个意外值打开");

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
	await until(() => host.routes.length === 3 && host.tools.length === 7);

	assert.equal(host.routes.length, 3);
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
	assert.equal(state.plugin.version, VERSION, "状态里要带上版本号，面板据此显示新构建有没有加载");
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
	await until(() => host.routes.length === 3);
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

// ---- 10. 操作前征求同意 ----------------------------------------------
console.log("\n[10] 操作前征求同意");
{
	/**
	 * 用一个假的 run 驱动闸门。
	 *
	 * 关键安全约束：这一节**绝不能**让「允许」的判定落到真实的输入工具上 ——
	 * 那会真的去动鼠标键盘。所以允许路径一律用假 run 验证，
	 * 真实注册的工具只在「拒绝」路径上被驱动（那时 run 根本不会被调用）。
	 */
	const wiringWith = (confirmInput, ask) => ({
		ctx: { get: (n) => (n === "userQuestions" && ask !== undefined ? { ask } : undefined) },
		settings: resolveSettings({ confirmInput }).settings,
		userQuestions: null
	});
	const answerWith = (selected, custom) => ({
		answers: [{ id: "desktop-input-consent", selected, ...(custom === undefined ? {} : { custom }) }]
	});
	const execFor = (header) => ({
		agent: header === undefined ? undefined : { session: { header } },
		callId: "call-1",
		signal: undefined
	});

	// ── 关掉时完全透传 ──
	{
		sessionGrants.clear();
		let asked = 0;
		const calls = [];
		const wired = withConsent(
			wiringWith(false, async () => { asked += 1; return answerWith([CONSENT_DENY]); }),
			"type_text",
			(args) => { calls.push(args); return "ran"; }
		);
		assert.equal(await wired({ text: "hi" }, execFor({ id: "s1" })), "ran");
		assert.deepEqual(calls, [{ text: "hi" }]);
		assert.equal(asked, 0, "关闭时一次都不该问");
		ok("confirmInput=false → 直接透传，一次都不问");
	}

	// ── 打开但没有 userQuestions 服务 → fail closed ──
	{
		sessionGrants.clear();
		let ran = 0;
		const wired = withConsent(wiringWith(true, undefined), "type_text", () => { ran += 1; });
		await assert.rejects(() => wired({ text: "hi" }, execFor({ id: "s1" })), /没有可用的 userQuestions 服务/);
		assert.equal(ran, 0);
		ok("开着闸门但宿主没有 userQuestions → 拒绝且不执行（fail closed）");
	}

	// ── 允许本次操作 ──
	{
		sessionGrants.clear();
		let asked = 0;
		const wired = withConsent(
			wiringWith(true, async () => { asked += 1; return answerWith([CONSENT_ALLOW_ONCE]); }),
			"type_text",
			() => "ran"
		);
		assert.equal(await wired({ text: "hi" }, execFor({ id: "s1" })), "ran");
		assert.equal(asked, 1);
		assert.equal(sessionGrants.size, 0, "「本次操作」不该留下会话授权");
		ok("允许本次操作 → 执行，但不留会话授权（下次还会问）");
	}

	// ── 不允许 ──
	{
		sessionGrants.clear();
		let ran = 0;
		const wired = withConsent(wiringWith(true, async () => answerWith([CONSENT_DENY])), "mouse_click", () => { ran += 1; });
		await assert.rejects(() => wired({ x: 1, y: 2 }, execFor({ id: "s1" })), /被用户拒绝/);
		assert.equal(ran, 0, "拒绝之后绝对不能执行");
		ok("不允许 → 抛错且绝不执行");
	}

	// ── 允许本次会话所有操作 ──
	{
		sessionGrants.clear();
		let asked = 0;
		const wired = withConsent(
			wiringWith(true, async () => { asked += 1; return answerWith([CONSENT_ALLOW_SESSION]); }),
			"key",
			() => "ran"
		);
		assert.equal(await wired({ combo: "ctrl+a" }, execFor({ id: "s1" })), "ran");
		assert.equal(sessionGrants.has("s1"), true, "应记下这个会话的授权");
		assert.equal(await wired({ combo: "ctrl+b" }, execFor({ id: "s1" })), "ran");
		assert.equal(asked, 1, "会话授权之后不该再问");
		assert.equal(sessionGrants.has("s2"), false, "别的会话不该被连带授权");
		ok("允许本次会话所有操作 → 本会话不再问，但不影响其它会话");
	}

	// ── 认不出来的一律当拒绝 ──
	{
		for (const [label, reply] of [
			["未知标签", answerWith(["随便点的"])],
			["空选择", answerWith([])],
			["只填了自定义文本", answerWith([], "我自己打的字")],
			["答案缺 answers", {}],
			["答案是 null", null]
		]) {
			sessionGrants.clear();
			let ran = 0;
			const wired = withConsent(wiringWith(true, async () => reply), "scroll", () => { ran += 1; });
			await assert.rejects(() => wired({ deltaY: -120 }, execFor({ id: "s1" })), /被用户拒绝/, label);
			assert.equal(ran, 0, `${label} 不该执行`);
		}
		ok("认不出的回答一律拒绝，绝不「看不明白就放行」");
	}

	// ── 问不到人（子智能体 / 没有 answerer）→ 拒绝 ──
	{
		sessionGrants.clear();
		let ran = 0;
		const boom = async () => { throw new Error("human interaction is unavailable while the calling agent is owned by another live agent"); };
		const wired = withConsent(wiringWith(true, boom), "type_text", () => { ran += 1; });
		await assert.rejects(() => wired({ text: "x" }, execFor({ id: "child-1" })), /无法向人类征求同意/);
		assert.equal(ran, 0);
		ok("ask() 抛错（子智能体 / 无 answerer）→ 拒绝且不执行");
	}

	// ── 等待超时：默认拒绝，配成放行时才放行 ──
	{
		/** 一个永远不回答、但尊重 signal 的 answerer —— 模拟「人不在」。 */
		const silentAnswerer = (onAsk) => ({
			ask(request) {
				if (typeof onAsk === "function") onAsk(request);
				return new Promise((_resolve, reject) => {
					const signal = request.signal;
					if (signal === undefined) return;       // 没有 signal 就永远挂着
					if (signal.aborted === true) { reject(new Error("ASK_ABORTED")); return; }
					signal.addEventListener("abort", () => reject(new Error("ASK_ABORTED")), { once: true });
				});
			}
		});

		// ① 超时 + 默认（拒绝）→ 不执行
		{
			sessionGrants.clear();
			let ran = 0;
			let sawSignal = null;
			const wiring = {
				ctx: { get: (n) => (n === "userQuestions" ? silentAnswerer((req) => { sawSignal = req.signal; }) : undefined) },
				settings: resolveSettings({ confirmInput: true, confirmTimeoutSeconds: 1 }).settings,
				userQuestions: null
			};
			const started = Date.now();
			const wired = withConsent(wiring, "type_text", () => { ran += 1; return "ran"; });
			await assert.rejects(() => wired({ text: "hi" }, execFor({ id: "s-timeout" })), /等待同意超时/, "超时应拒绝");
			const elapsed = Date.now() - started;
			assert.ok(elapsed >= 900, `应该真的等满 1 秒，实际 ${elapsed}ms`);
			assert.ok(elapsed < 4000, `不该等太久，实际 ${elapsed}ms`);
			assert.equal(ran, 0, "超时拒绝时绝不能执行");
			// 必须把问题撤回：否则弹窗会一直挂在界面上，而这边早已按超时给了结论
			assert.ok(sawSignal !== null, "应把 signal 交给 answerer");
			assert.equal(sawSignal.aborted, true, "超时后必须撤回问题（abort signal）");
			assert.equal(sessionGrants.size, 0, "超时不该留下会话授权");
			ok("等待超时 + 默认设置 → 拒绝，且真的等满了窗口、撤回了问题");
		}

		// ② 超时 + 放行 → 执行
		{
			sessionGrants.clear();
			let ran = 0;
			const wiring = {
				ctx: { get: (n) => (n === "userQuestions" ? silentAnswerer() : undefined) },
				settings: resolveSettings({
					confirmInput: true, confirmTimeoutSeconds: 1, confirmAllowOnTimeout: true
				}).settings,
				userQuestions: null
			};
			const wired = withConsent(wiring, "mouse_click", () => { ran += 1; return "ran"; });
			assert.equal(await wired({ x: 1, y: 2 }, execFor({ id: "s-timeout" })), "ran");
			assert.equal(ran, 1, "配置成放行时应当执行");
			// 关键：没有人同意过，绝不能留下会话授权
			assert.equal(sessionGrants.size, 0, "超时放行也绝不能留下会话授权");
			// 面板要能看到「我不在时它自己动过手」的次数
			const state = buildState({
				settings: wiring.settings, registeredTools: [], ctx: wiring.ctx, configError: null
			});
			assert.equal(state.consent.allowOnTimeout, true);
			assert.equal(state.consent.timeoutAllows, 1, "超时放行必须计数，否则事后毫无痕迹");
			ok("等待超时 + 「超时后放行」→ 执行，且计数可见（但绝不记会话授权）");
		}

		// ③ 等待秒数 = 0 → 不超时，绝不按超时策略自作主张
		{
			sessionGrants.clear();
			let ran = 0;
			const wiring = {
				ctx: { get: (n) => (n === "userQuestions"
					? { async ask() { return { answers: [{ id: "x", selected: [CONSENT_DENY] }] }; } }
					: undefined) },
				settings: resolveSettings({ confirmInput: true, confirmTimeoutSeconds: 0 }).settings,
				userQuestions: null
			};
			const wired = withConsent(wiring, "key", () => { ran += 1; return "ran"; });
			await assert.rejects(() => wired({ combo: "ctrl+a" }, execFor({ id: "s1" })), /被用户拒绝/);
			assert.equal(ran, 0);
			ok("等待秒数 = 0 → 不超时（结论仍来自回答本身）");
		}

		// ④ 调用方中止（工具超时 / 用户取消）不能被当成「等待超时」
		{
			sessionGrants.clear();
			let ran = 0;
			const controller = new AbortController();
			const wiring = {
				ctx: { get: (n) => (n === "userQuestions" ? silentAnswerer() : undefined) },
				// 故意配成「超时放行」：如果实现把调用方中止误当成等待超时，这里就会执行
				settings: resolveSettings({
					confirmInput: true, confirmTimeoutSeconds: 60, confirmAllowOnTimeout: true
				}).settings,
				userQuestions: null
			};
			const wired = withConsent(wiring, "scroll", () => { ran += 1; return "ran"; });
			const pending = wired(
				{ deltaY: -120 },
				{ agent: { session: { header: { id: "s1" } } }, callId: "c", signal: controller.signal }
			);
			setTimeout(() => controller.abort(), 30);
			await assert.rejects(() => pending, /无法向人类征求同意/,
				"调用方中止应走「问不到人」那条，而不是超时策略");
			assert.equal(ran, 0, "调用方中止时绝不能执行 —— 否则工具超时就成了绕过闸门的后门");
			ok("调用方中止 ≠ 等待超时：不会被误当成「超时后放行」");
		}
	}

	// ── 会话 id 的展示短名：真机验证时测出来的 bug ──
	{
		// 真实会话 id 形如 session-<uuid>。直接截前 8 位只会得到 "session-" 这个
		// 每条都一样的固定前缀，面板上所有授权会显示成同一个东西 —— 这是在真机上
		// 看到的（面板显示 "session-…"，分不清哪条是哪条）。
		assert.equal(shortSessionId("session-85555e38-17f8-4cd3-8a4a-9d13c88315a9"), "85555e38");
		// 子智能体的会话 id 没有前缀（实测如此），要原样取前 8 位
		assert.equal(shortSessionId("83fe953e-3768-41d1-b699-15786868584f"), "83fe953e");
		assert.equal(shortSessionId("abcdef1234567890"), "abcdef12");
		assert.equal(shortSessionId(""), "");
		assert.equal(shortSessionId(undefined), "");
		ok("shortSessionId：剥掉 session- 前缀再截，两种真实形状都能区分");

		sessionGrants.clear();
		sessionGrants.set("session-85555e38-17f8-4cd3-8a4a-9d13c88315a9", { at: Date.now() });
		assert.equal(grantList()[0].short, "85555e38");
		assert.notEqual(grantList()[0].short, "session-", "短名绝不能只是那个固定前缀");
		ok("grantList 用短名展示授权");
	}

	// ── 问不到人时的提示必须指向**父会话**，而不是子会话 ──
	{
		// 真机实测：子智能体收到的原文写着「会话 83fe953e 还没拿到授权」，
		// 但该去授权的是父会话 —— 照着这句话行动会走错方向。
		const childGap = describeGrantGap(
			"83fe953e-3768-41d1-b699-15786868584f",
			"session-85555e38-17f8-4cd3-8a4a-9d13c88315a9"
		);
		assert.match(childGap, /83fe953e/, "要点明子会话");
		assert.match(childGap, /85555e38/, "更要紧的是点明父会话");
		assert.match(childGap, /在主会话里授权/, "要给出可操作的出路");
		assert.doesNotMatch(childGap, /session-…/, "不该出现无区分度的前缀");

		const selfGap = describeGrantGap("session-85555e38-17f8-4cd3-8a4a-9d13c88315a9", "");
		assert.match(selfGap, /85555e38/);
		assert.doesNotMatch(selfGap, /父会话/, "没有父会话时不该提父会话");

		assert.match(describeGrantGap("", ""), /没有会话身份/);
		ok("describeGrantGap：子智能体的提示指向父会话并给出出路");
	}

	// ── readConsentChoice 直接驱动 ──
	{
		assert.equal(readConsentChoice(answerWith([CONSENT_ALLOW_ONCE])), "once");
		assert.equal(readConsentChoice(answerWith([CONSENT_ALLOW_SESSION])), "session");
		assert.equal(readConsentChoice(answerWith([CONSENT_DENY])), "deny");
		assert.equal(readConsentChoice(answerWith(["  允许本次操作  "])), "once", "前后空白要能容忍");
		assert.equal(readConsentChoice(undefined), "deny");
		assert.equal(readConsentChoice({ answers: [] }), "deny");
		ok("readConsentChoice：三态可辨、容忍空白、缺答案即拒绝");
	}

	// ── describeInputCall：弹窗里必须看得到「要做什么」 ──
	{
		assert.match(describeInputCall("type_text", { text: "hello" }), /hello/);
		assert.match(describeInputCall("type_text", { text: "hello" }), /5 个字符/);
		assert.match(describeInputCall("mouse_click", { x: 10, y: 20 }), /\(10, 20\)/);
		assert.match(describeInputCall("mouse_click", { x: 1, y: 2, button: "right", clicks: 2 }), /right ×2/);
		assert.match(describeInputCall("key", { combo: "ctrl+a" }), /ctrl\+a/);
		assert.match(describeInputCall("window_activate", { window: "记事本" }), /记事本/);
		assert.match(describeInputCall("scroll", { deltaY: -240 }), /-240/);
		assert.match(describeInputCall("scroll", { deltaY: 120, x: 3, y: 4 }), /3, 4/);
		const shown = describeInputCall("type_text", { text: "字".repeat(2000) });
		assert.match(shown, /共 2000 字符/);
		assert.ok(shown.length < 700, `预览应被截断，实际 ${shown.length} 字`);
		assert.match(describeInputCall("type_text", { text: "a\nb" }), /a\n {2}b/);
		ok("describeInputCall：具体到「打什么字、点哪里」，超长截断、换行缩进");
	}

	// ── isSessionGranted：子智能体靠 parentSession 继承 ──
	{
		sessionGrants.clear();
		sessionGrants.set("main", { at: Date.now() });
		assert.equal(isSessionGranted({ id: "main" }), true);
		assert.equal(isSessionGranted({ id: "other" }), false);
		assert.equal(isSessionGranted({ id: "child", origin: "subagent", parentSession: "main" }), true,
			"子智能体应继承主会话的授权");
		assert.equal(isSessionGranted({ id: "child", origin: "subagent", parentSession: "nope" }), false);
		assert.equal(isSessionGranted({ id: "grand", origin: "subagent", parentSession: "child" }), false,
			"只往上认一层：更深的后代 fail closed");
		assert.equal(isSessionGranted(undefined), false);
		assert.equal(isSessionGranted({}), false);
		ok("会话授权：本人命中、子智能体继承一层、更深的后代 fail closed");
	}

	// ── 子智能体走完整闸门 ──
	{
		sessionGrants.clear();
		let asked = 0;
		const childExec = execFor({ id: "child", origin: "subagent", parentSession: "main" });
		const boomWiring = wiringWith(true, async () => { asked += 1; throw new Error("DELEGATED_CALLER"); });
		await assert.rejects(
			() => withConsent(boomWiring, "mouse_click", () => "ran")({ x: 1, y: 1 }, childExec),
			/无法向人类征求同意/
		);
		assert.equal(asked, 1);
		sessionGrants.set("main", { at: Date.now() });
		const askedBefore = asked;
		const okWiring = wiringWith(true, async () => { asked += 1; return answerWith([CONSENT_ALLOW_ONCE]); });
		assert.equal(await withConsent(okWiring, "mouse_click", () => "ran")({ x: 1, y: 1 }, childExec), "ran");
		assert.equal(asked, askedBefore, "已授权时连问都不该问");
		ok("子智能体：主会话已授权直接放行，否则拒绝（不给闸门留后门）");
	}
}

// ---- 11. 注册出来的工具确实带闸门（只在拒绝路径上驱动）----------------
console.log("\n[11] 注册态：工具真的带了闸门");
{
	const host = makeHost();
	host.ctx.userQuestions = { async ask() { return { answers: [{ id: "x", selected: [CONSENT_DENY] }] }; } };
	host.ctx.get = (n) => {
		if (n === "tools") return host.ctx.tools;
		if (n === "webServer") return host.ctx.webServer;
		if (n === "userQuestions") return host.ctx.userQuestions;
		return undefined;
	};
	sessionGrants.clear();
	apply(host.ctx, { confirmInput: true });
	await until(() => host.routes.length === 3 && host.tools.length === 7);

	const byName = (n) => host.tools.find((t) => t.name === n);
	const exec = { agent: { session: { header: { id: "s1" } } }, callId: "c1", signal: undefined };

	// 开着闸门时，工具超时必须**长于**闸门的等待窗口 —— 否则工具先被掐断，
	// 「超时后放行」这个策略永远轮不到执行机会。
	const WAIT_S = resolveSettings({}).settings.confirmTimeoutSeconds;
	for (const n of ["window_activate", "mouse_click", "type_text", "key", "scroll"]) {
		assert.equal(
			byName(n).timeoutMs,
			WAIT_S * 1000 + CONFIRM_TIMEOUT_SLACK_MS,
			`${n} 的 timeoutMs 应为「等待窗口 + 余量」`
		);
	}
	for (const n of ["window_list", "screenshot"]) {
		assert.notEqual(byName(n).timeoutMs, WAIT_S * 1000 + CONFIRM_TIMEOUT_SLACK_MS,
			`${n} 是只读的，不该被改动`);
	}
	ok(`开着闸门：五个输入工具的超时 = 等待窗口(${WAIT_S}s) + 余量，只读两个不受影响`);

	// 「不超时」：等待秒数填 0，要给一个「一直等」的量
	{
		const host2 = makeHost();
		host2.ctx.userQuestions = { async ask() { return { answers: [{ id: "x", selected: [CONSENT_DENY] }] }; } };
		host2.ctx.get = (n) => {
			if (n === "tools") return host2.ctx.tools;
			if (n === "webServer") return host2.ctx.webServer;
			if (n === "userQuestions") return host2.ctx.userQuestions;
			return undefined;
		};
		apply(host2.ctx, { confirmInput: true, confirmTimeoutSeconds: 0 });
		await until(() => host2.routes.length === 3 && host2.tools.length === 7);
		const t = (n) => host2.tools.find((x) => x.name === n);
		assert.equal(t("type_text").timeoutMs, CONFIRM_WAIT_FOREVER_MS, "0 = 不超时，给「一直等」的量");
		assert.ok(CONFIRM_WAIT_FOREVER_MS > 3600 * 1000, "「一直等」至少得是一小时量级");
		ok("等待秒数 = 0（不超时）→ 工具超时变成「一直等」");
		for (const d of host2.disposers) if (typeof d === "function") d();
	}

	// 关掉闸门时超时必须回到各工具原本的值，一个字节都不多
	{
		const host3 = makeHost();
		apply(host3.ctx, { confirmInput: false });
		await until(() => host3.routes.length === 3 && host3.tools.length === 7);
		const t = (n) => host3.tools.find((x) => x.name === n);
		assert.equal(t("type_text").timeoutMs, 15000);
		assert.equal(t("mouse_click").timeoutMs, 10000);
		assert.equal(t("key").timeoutMs, 10000);
		assert.equal(t("scroll").timeoutMs, 10000);
		assert.equal(t("window_activate").timeoutMs, 10000);
		ok("闸门关闭 → 超时回到各工具原本的值（无额外行为）");
		for (const d of host3.disposers) if (typeof d === "function") d();
	}

	assert.match(byName("type_text").description, /pauses for the user's approval/);
	assert.doesNotMatch(byName("screenshot").description, /pauses for the user's approval/);
	ok("输入工具描述里写明了会先征求同意，只读工具没有");

	// 安全哨兵：用 window_activate + 一个不存在的窗口标题驱动注册态工具。
	// 闸门生效 → 抛「被用户拒绝」；闸门若失效 → 会走到 findWindow 抛「No visible window」。
	// 两条路都不会真的动到桌面，所以这个断言本身是零风险的。
	await assert.rejects(
		() => byName("window_activate").execute({ window: "絶対に存在しない窓" }, exec),
		/被用户拒绝/
	);
	ok("注册态工具确实先过闸门（拒绝时走不到真正的输入代码）");
	for (const d of host.disposers) if (typeof d === "function") d();
}

// ---- 12. 会话授权的可见性与撤销 --------------------------------------
console.log("\n[12] 会话授权的可见性与撤销");
{
	const host = makeHost();
	host.ctx.userQuestions = {
		async ask() { return { answers: [{ id: "x", selected: [CONSENT_ALLOW_SESSION] }] }; }
	};
	host.ctx.get = (n) => {
		if (n === "tools") return host.ctx.tools;
		if (n === "webServer") return host.ctx.webServer;
		if (n === "userQuestions") return host.ctx.userQuestions;
		return undefined;
	};
	sessionGrants.clear();
	apply(host.ctx, { confirmInput: true });
	await until(() => host.routes.length === 3 && host.tools.length === 7);

	const stateRoute = host.routes.find((r) => r.path.endsWith("/state"));
	const settingsRoute = host.routes.find((r) => r.path.endsWith("/settings"));
	const consentRoute = host.routes.find((r) => r.path.endsWith("/consent"));
	const readState = async () => {
		const res = makeResponse();
		await stateRoute.handler(makeRequest("GET", { host: "localhost" }), res);
		return JSON.parse(res.body);
	};

	let state = await readState();
	assert.equal(state.consent.confirmInput, true);
	assert.equal(state.consent.service, true, "状态里要能看出宿主有没有 userQuestions");
	assert.deepEqual(state.consent.grants, []);
	assert.deepEqual(state.consent.tools, ["window_activate", "mouse_click", "type_text", "key", "scroll"]);
	ok("state.consent：开关、服务可用性、受闸门工具、当前授权都可见");

	// 「允许本会话」已经生效时，工具会一路走进真正的实现。测试环境下 koffi 加载不到
	// （它由运行时从 DSH 的 asar 树里解析），所以这里一定会报错 —— 但**报哪个错**很关键：
	// 只要不是「被用户拒绝」，就说明闸门确实放行了，而桌面毫发无损。
	const exec = { agent: { session: { header: { id: "abcdef1234567890" } } }, callId: "c1", signal: undefined };
	const failure = await host.tools
		.find((t) => t.name === "window_activate")
		.execute({ window: "存在しない窓" }, exec)
		.then(() => null, (error) => error);
	assert.ok(failure !== null, "应报错（测试环境里 koffi 不可用）");
	assert.doesNotMatch(String(failure.message), /被用户拒绝/, "已授权就不该再被闸门拦下");
	state = await readState();
	assert.equal(state.consent.grants.length, 1);
	assert.equal(state.consent.grants[0].id, "abcdef1234567890");
	assert.equal(state.consent.grants[0].short, "abcdef12", "面板只显示短 id");
	ok("走完「允许本会话」后授权出现在 state.consent.grants 里，并给出短 id");

	const revoke = makeResponse();
	await consentRoute.handler(makeRequest("POST", { host: "localhost" }, {}), revoke);
	const revokeBody = JSON.parse(revoke.body);
	assert.equal(revokeBody.ok, true);
	assert.equal(revokeBody.revoked, 1);
	assert.deepEqual(revokeBody.grants, []);
	assert.equal((await readState()).consent.grants.length, 0);
	ok("POST /consent → 撤销全部授权");

	sessionGrants.set("aaa", { at: Date.now() });
	sessionGrants.set("bbb", { at: Date.now() });
	const one = makeResponse();
	await consentRoute.handler(makeRequest("POST", { host: "localhost" }, { sessionId: "aaa" }), one);
	assert.equal(JSON.parse(one.body).revoked, 1);
	assert.deepEqual(grantList().map((g) => g.id), ["bbb"]);
	ok("POST /consent {sessionId} → 只撤那一个");

	// 改 confirmInput 必须清掉旧授权：关掉再打开不能悄悄继承上一次的许可
	sessionGrants.set("ccc", { at: Date.now() });
	const off = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "confirmInput", value: false }), off);
	assert.equal(sessionGrants.size, 0, "关掉闸门应清空授权");
	assert.equal(JSON.parse(off.body).consent.confirmInput, false);
	sessionGrants.set("ddd", { at: Date.now() });
	const on = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "confirmInput", value: true }), on);
	assert.equal(sessionGrants.size, 0, "再打开也应从零开始");
	ok("confirmInput 一关一开 → 旧授权被清空，不会悄悄接着生效");

	sessionGrants.set("eee", { at: Date.now() });
	const other = makeResponse();
	await settingsRoute.handler(makeRequest("POST", { host: "localhost" }, { field: "captureMaxWidth", value: 1280 }), other);
	assert.equal(sessionGrants.size, 1, "改无关字段不该清掉授权");
	ok("改无关字段不触碰授权");

	{
		const bare = makeHost();
		bare.ctx.get = (n) => (n === "tools" ? bare.ctx.tools : n === "webServer" ? bare.ctx.webServer : undefined);
		apply(bare.ctx, { confirmInput: true });
		await until(() => bare.routes.length === 3);
		const res = makeResponse();
		await bare.routes.find((r) => r.path.endsWith("/state")).handler(makeRequest("GET", { host: "localhost" }), res);
		assert.equal(JSON.parse(res.body).consent.service, false);
		ok("没有 userQuestions 时 state.consent.service = false（面板据此警告）");
		for (const d of bare.disposers) if (typeof d === "function") d();
	}

	const bad = makeResponse();
	await consentRoute.handler(makeRequest("POST", { host: "evil.example" }, {}), bad);
	assert.equal(bad.status, 403);
	const badMethod = makeResponse();
	await consentRoute.handler(makeRequest("GET", { host: "localhost" }), badMethod);
	assert.equal(badMethod.status, 405);
	ok("/consent 同样受来源与方法校验");

	sessionGrants.clear();
	for (const d of host.disposers) if (typeof d === "function") d();
}

await rm(ROOT, { recursive: true, force: true });
console.log(`\n宿主全部通过（${passed} 项断言组）`);
