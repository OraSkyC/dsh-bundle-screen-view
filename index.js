// 桌面操控 (Desktop Control): desktop screenshot, window-list, and desktop
// input-control tools for the DSH Host.
//
// Self-contained by design: no @deepseek-ai imports (a profile-installed
// bundle resolves bare specifiers from the profile's node_modules, which does
// not carry the Desktop installation's packages). Win32 capture and input go
// through the koffi copy the Desktop host itself ships inside its asar tree.
//
// Configuration is two-layered, same shape as dsh-bundle-default-workspace:
//   cordis.patch.yml config  →  deploy defaults (needs a DSH restart)
//   $DSH_HOME/state/<pkg>/settings.json → sparse user overrides (immediate)
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Entry name: `cordis.patch.yml` inserts this row under this id. */
const name = 'screen-view';
/** Package name: the state directory and the panel routes are rooted at it. */
const pkg = 'dsh-bundle-screen-view';
/**
 * 硬依赖声明。
 *
 * 关键：Cordis 的 ctx 是受限代理 —— 读一个没声明在 inject 里的属性会**抛错**
 * （`cannot get property "webServer" without inject`），而不是返回 undefined。
 * 面板路由要 webServer，漏声明会让整个 apply() 失败、插件在插件页显示「异常」。
 */
const inject = ['tools', 'attachments', 'webServer'];

/**
 * 版本号。从 package.json 读，**不要在代码里再写一遍**。
 *
 * 面板标题右边那颗版本小标就是靠它确认「新构建到底有没有被宿主加载」——
 * 宿主把客户端 bundle 在激活时读进内存，改完 client.js 不重启 DSH 看不到新东西。
 * 写死就会和 package.json 漂移，那个信号也就废了。
 */
const VERSION = (() => {
	try {
		const manifest = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
		return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
})();

/* ------------------------------------------------------------------ */
/* 配置契约                                                            */
/* ------------------------------------------------------------------ */

/**
 * 每个字段的部署默认值；面板写入的覆盖层里缺省的字段回落到这里。
 *
 * 前三项是**安全闸门**，其余是行为调优：
 *   enabled      总开关，关掉后一个工具都不注册
 *   allowCapture 只读组：window_list + screenshot
 *   allowInput   输入组：window_activate / mouse_click / type_text / key / scroll
 */
const DEFAULTS = {
	enabled: true,
	allowCapture: true,
	allowInput: true,
	/**
	 * 输入类操作前是否征求同意。默认关闭 = 保持原有「权限允许就直接执行」的行为。
	 *
	 * 打开后，五个输入工具每次调用都会先用 ctx.userQuestions 弹一个三选一：
	 * 允许本次操作 / 允许本次会话所有操作 / 不允许。这是插件自己的一层闸门，
	 * 与 DSH 的审批策略（ask / never）无关，因此不受本会话 policy: never 的影响。
	 */
	confirmInput: false,
	/**
	 * 等待用户回答的秒数。0 = 不超时（一直等）。
	 *
	 * 注意这不是「工具超时」，而是**闸门自己的等待窗口**。开着闸门时工具超时会被
	 * 自动设成比它更长 —— 否则工具先被掐断，「超时后怎么处理」这个策略永远轮不到生效。
	 */
	confirmTimeoutSeconds: 300,
	/**
	 * 等待超时后是否放行。默认 false = 拒绝（fail closed）。
	 *
	 * 设成 true 意味着：**你不回话，智能体就自己动你的键鼠。**
	 * 这是明显的 fail-open，只适合「我可能不在，但信得过它」的场景；
	 * 面板会为此给一条显眼的警告。它只在 confirmTimeoutSeconds > 0 时有意义。
	 */
	confirmAllowOnTimeout: false,
	/** 截图默认最大宽度（像素）；超出等比缩小。 */
	captureMaxWidth: 2560,
	/** 图片引用 LRU 上限：render() 靠它把像素交给模型。 */
	imageCacheSize: 64,
	/** 标题包含这些子串的窗口会被隐藏且不可被操作（隐私用，空数组 = 不限制）。 */
	excludeWindowTitles: [],
};

const CAPTURE_WIDTH_MIN = 320;
const CAPTURE_WIDTH_MAX = 8192;
const IMAGE_CACHE_MIN = 4;
const IMAGE_CACHE_MAX_LIMIT = 512;
const EXCLUDE_MAX = 64;

/* ------------------------------------------------------------------ */
/* 操作前征求同意                                                      */
/* ------------------------------------------------------------------ */

/**
 * 受闸门保护的五个输入工具。
 *
 * 只盖输入：window_activate 会改焦点（把窗口提到最前也是一次真实的状态改变，
 * 所以算输入）；screenshot 是只读的，不在这里。
 */
const CONFIRM_TOOLS = ['window_activate', 'mouse_click', 'type_text', 'key', 'scroll'];

/**
 * 三个选项的标签就是**协议**：answerer 会把标签原样回传，我们按标签判定结果。
 * 认不出的标签一律当拒绝（fail closed），绝不「看不明白就放行」。
 */
const CONSENT_ALLOW_ONCE = '允许本次操作';
const CONSENT_ALLOW_SESSION = '允许本次会话所有操作';
const CONSENT_DENY = '不允许';
const CONSENT_QUESTION_ID = 'desktop-input-consent';

/**
 * 等待秒数为 0（不超时）时给工具的 timeoutMs：相当于「一直等」。
 *
 * 好消息是工具超时**没有全局上限** —— `dsh-tool-call-timeout-policy` 的文档写着
 * 「Each tool supplies its own limit; the package has no configuration」。
 * 所以我早先抄 run_code schema 里的 600000 并不是宿主限制，24 小时是真的等得起。
 * 它只是兜底，免得真出现一个永远挂着、白白占住会话的调用。
 */
const CONFIRM_WAIT_FOREVER_MS = 24 * 60 * 60 * 1000;

/**
 * 工具超时相对「同意等待窗口」多出来的余量。
 *
 * 必须让**闸门自己先决定**（按配置放行或拒绝），而不是让工具超时抢先生效 ——
 * 否则「超时后放行」这个策略永远轮不到执行机会。
 */
const CONFIRM_TIMEOUT_SLACK_MS = 60000;

/** 同意等待秒数的上下界。 */
const CONFIRM_WAIT_MIN_S = 0;
const CONFIRM_WAIT_MAX_S = 86400;

/** 确认弹窗里展示调用参数时的截断长度。 */
const CONFIRM_PREVIEW_MAX = 400;

/**
 * 会话级授权：sessionId → { at }。
 *
 * 只放内存，故意不落盘 —— 「本会话」的语义就该随进程结束而消失，
 * 一个能跨重启活下来的鼠标键盘授权不是用户点那个按钮时想要的东西。
 */
const sessionGrants = new Map();

/**
 * 因等待超时而被放行的次数（进程内累计）。
 *
 * 「超时后放行」最危险的地方在于**它是静默的**：人不回话，事情照样发生，
 * 事后没有任何痕迹能看出来「这次没人看过」。所以面板上给一个计数，
 * 让用户回来时至少能看到「我不在的时候它自己走了几次」。
 * 不落盘：重启即清零，与「本会话」的记忆语义一致。
 */
let timeoutAllows = 0;

/** 只允许标题包含这些子串的窗口被操作（空数组 = 不限制）。 */
const trimString = (value, fallback = '') => (typeof value === 'string' ? value.trim() : fallback);

/**
 * 归一化配置：默认值 → 部署配置 → 面板覆盖层，逐字段校验。
 * 无效值就地回落，绝不抛错 —— 面板要能继续读，宿主不能因为一次误写崩掉。
 * @param {object} raw - 合并后的原始配置。
 * @returns {{settings: object, configError: string|null}}
 */
function resolveSettings(raw = {}) {
	const source = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
	const out = {};
	let configError = null;

	out.enabled = typeof source.enabled === 'boolean' ? source.enabled : DEFAULTS.enabled;
	out.allowCapture = typeof source.allowCapture === 'boolean' ? source.allowCapture : DEFAULTS.allowCapture;
	out.allowInput = typeof source.allowInput === 'boolean' ? source.allowInput : DEFAULTS.allowInput;
	out.confirmInput = typeof source.confirmInput === 'boolean' ? source.confirmInput : DEFAULTS.confirmInput;

	const clampInt = (value, fallback, min, max) => {
		const parsed = typeof value === 'number' && Number.isFinite(value) ? value : Number(value);
		if (!Number.isFinite(parsed)) return fallback;
		return Math.min(Math.max(Math.round(parsed), min), max);
	};
	// 必须放在 clampInt 之后：它是 const 箭头函数，提前用会踩 TDZ
	out.confirmTimeoutSeconds = clampInt(
		source.confirmTimeoutSeconds,
		DEFAULTS.confirmTimeoutSeconds,
		CONFIRM_WAIT_MIN_S,
		CONFIRM_WAIT_MAX_S
	);
	out.confirmAllowOnTimeout = typeof source.confirmAllowOnTimeout === 'boolean'
		? source.confirmAllowOnTimeout
		: DEFAULTS.confirmAllowOnTimeout;
	out.captureMaxWidth = clampInt(source.captureMaxWidth, DEFAULTS.captureMaxWidth, CAPTURE_WIDTH_MIN, CAPTURE_WIDTH_MAX);
	out.imageCacheSize = clampInt(source.imageCacheSize, DEFAULTS.imageCacheSize, IMAGE_CACHE_MIN, IMAGE_CACHE_MAX_LIMIT);

	if (Array.isArray(source.excludeWindowTitles)) {
		out.excludeWindowTitles = source.excludeWindowTitles
			.map((entry) => trimString(entry))
			.filter((entry) => entry !== '')
			.slice(0, EXCLUDE_MAX);
	} else if (typeof source.excludeWindowTitles === 'string') {
		// 面板里是一个逗号分隔的输入框
		out.excludeWindowTitles = source.excludeWindowTitles
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '')
			.slice(0, EXCLUDE_MAX);
	} else {
		out.excludeWindowTitles = [];
	}

	return { settings: out, configError };
}

/** 标题是否被排除名单命中（大小写不敏感）。 */
function isExcludedTitle(title, excludeWindowTitles) {
	if (!Array.isArray(excludeWindowTitles) || excludeWindowTitles.length === 0) return false;
	const lowered = String(title ?? '').toLowerCase();
	return excludeWindowTitles.some((needle) => lowered.includes(String(needle).toLowerCase()));
}

/** 状态目录：$DSH_HOME/state/<pkg>，与其它插件同级。 */
function stateDirectory() {
	const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
		? process.env.DSH_HOME.trim()
		: join(homedir(), '.dsh');
	return join(home, 'state', pkg);
}

/**
 * 稀疏覆盖层：只存用户显式改过的字段，缺省字段回落到部署配置。
 * 读-改-写在同一条 promise 链上串行，两个并发改动不会互相覆盖。
 */
class FileStore {
	constructor(location) {
		this.location = location;
		this.pending = Promise.resolve();
		this.latest = null;
	}
	get file() {
		return join(this.location.dir, this.location.file);
	}
	/** 读当前覆盖层；任何异常都回落为空对象，绝不抛。 */
	read() {
		const run = this.pending.then(async () => {
			if (this.latest !== null) return this.latest;
			const value = await this.readRaw();
			this.latest = value;
			return value;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
	async readRaw() {
		try {
			const parsed = JSON.parse(await readFile(this.file, 'utf8'));
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}
	mutate(mutator) {
		const run = this.pending.then(async () => {
			const current = this.latest ?? (await this.readRaw());
			const next = mutator(current) ?? current;
			await mkdir(this.location.dir, { recursive: true });
			await writeFile(this.file, JSON.stringify(next, null, 2) + '\n', 'utf8');
			this.latest = next;
			return next;
		});
		this.pending = run.then(() => undefined, () => undefined);
		return run;
	}
}

/**
 * Recent image attachment refs, so render() can emit the ImageBlock that gets
 * the pixels to the model after execute() has committed them. Bounded LRU whose
 * cap comes from the live settings.
 */
const imageCache = new Map();

function rememberImage(ref, max) {
	while (imageCache.size >= max) {
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

/* ------------------------------------------------------------------ */
/* 同意闸门的实现                                                      */
/* ------------------------------------------------------------------ */

/**
 * 惰性解析 `userQuestions` 服务。
 *
 * 故意**不**声明进 inject：精简宿主上可能没有它，声明成硬依赖会让整个 apply() 失败。
 * 而 ctx 是受限代理 —— 读一个未声明的属性会抛错而不是返回 undefined，所以必须包 try。
 * 解析失败不缓存，下次再试（服务可能在 apply() 之后才挂上）。
 * @returns {object|null} 带 ask() 的服务，或 null。
 */
function resolveUserQuestions(wiring) {
	if (wiring.userQuestions !== null) return wiring.userQuestions;
	let service = null;
	try {
		service = wiring.ctx.get?.('userQuestions') ?? null;
	} catch {
		service = null;
	}
	if (service === null || service === undefined || typeof service.ask !== 'function') return null;
	wiring.userQuestions = service;
	return service;
}

/**
 * 这个会话是否已经被授权「本会话所有操作」。
 *
 * 子智能体自己问不了人（宿主的 assertLiveRoot 会拒绝被拥有的 agent 发起人类交互），
 * 所以它靠 parentSession 继承主会话的授权 —— 人已经为本会话点过授权，
 * 子智能体在这个范围内行动是合理的。没授权的子智能体一律被拒绝（fail closed）。
 *
 * 已知边界：只往上认一层。delegationDepth 更深的后代不在覆盖范围内，会被拒绝 ——
 * 宁可拒绝也不能给闸门留一条绕过路径。要支持任意深度得沿 parentSession 链逐级解析。
 * @param {object|undefined} header - exec.agent.session.header
 * @returns {boolean}
 */
function isSessionGranted(header) {
	if (header === undefined || header === null) return false;
	const id = header.id === undefined || header.id === null ? '' : String(header.id);
	if (id !== '' && sessionGrants.has(id)) return true;
	if (header.origin === 'subagent' && header.parentSession !== undefined && header.parentSession !== null) {
		return sessionGrants.has(String(header.parentSession));
	}
	return false;
}

/** 从答案里读出三选一。认不出来的一律当拒绝 —— 绝不「看不明白就放行」。 */
function readConsentChoice(answer) {
	const first = Array.isArray(answer?.answers) ? answer.answers[0] : undefined;
	if (first === undefined || first === null) return 'deny';
	const selected = (Array.isArray(first.selected) ? first.selected : [])
		.map((entry) => String(entry).trim());
	if (selected.includes(CONSENT_ALLOW_SESSION)) return 'session';
	if (selected.includes(CONSENT_ALLOW_ONCE)) return 'once';
	// 用户在输入框里自己打字而不是点选项（custom），或直接跳过了这一问 → 不算同意
	return 'deny';
}

/**
 * 给人类看的调用摘要。
 *
 * 这是确认弹窗里唯一能让人做出判断的信息，所以必须具体到「要打什么字、点哪里」。
 * 模型看得见工具参数，人看不见 —— 只写一个工具名等于逼人盲签。
 * @param {string} toolName
 * @param {object} args
 * @returns {string}
 */
function describeInputCall(toolName, args) {
	const a = args !== null && typeof args === 'object' ? args : {};
	const clip = (value) => {
		const text = String(value ?? '');
		return text.length > CONFIRM_PREVIEW_MAX
			? `${text.slice(0, CONFIRM_PREVIEW_MAX)}…（共 ${text.length} 字符）`
			: text;
	};
	switch (toolName) {
		case 'window_activate':
			return `激活标题包含 "${clip(a.window)}" 的窗口（会把它提到最前）`;
		case 'mouse_click':
			return `把鼠标移到 (${a.x}, ${a.y}) 并点击：${a.button ?? 'left'} ×${a.clicks ?? 1}`;
		case 'type_text': {
			const text = typeof a.text === 'string' ? a.text : '';
			const shown = clip(text).replace(/\r/g, '').replace(/\n/g, '\n  ');
			return `向当前焦点窗口输入 ${text.length} 个字符：\n  ${shown}`;
		}
		case 'key':
			return `按下按键：${clip(a.combo)}`;
		case 'scroll':
			return Number.isInteger(a.x)
				? `滚动 deltaY=${a.deltaY}（先把光标移到 ${a.x}, ${a.y}）`
				: `在当前光标位置滚动 deltaY=${a.deltaY}`;
		default:
			return clip(JSON.stringify(a));
	}
}

/**
 * 问不到人时给模型的一句**可操作**说明。
 *
 * 子智能体自己弹不出窗，它唯一的出路是主会话先授权 —— 所以这句话必须点明
 * 「该去哪个会话授权」。早先只写「会话 <子会话> 没拿到授权」，其实是误导：
 * 照着它去给子会话授权是没用的（授权由人点，子智能体根本弹不出窗）。
 * @param {string} sessionId - 当前调用的会话 id。
 * @param {string} parentId - 它的父会话 id（非子智能体时为空）。
 * @returns {string}
 */
function describeGrantGap(sessionId, parentId) {
	if (sessionId === '') return ' 这次调用没有会话身份，拿不到已有授权，因此不执行。';
	if (parentId === '') {
		return ` 会话 ${shortSessionId(sessionId)} 还没拿到「${CONSENT_ALLOW_SESSION}」授权。`;
	}
	return ` 会话 ${shortSessionId(sessionId)} 与它的父会话 ${shortSessionId(parentId)} 都没有` +
		`「${CONSENT_ALLOW_SESSION}」授权，而子智能体自己弹不出窗问人 —— ` +
		'需要用户在主会话里授权，子智能体才能跟着用。';
}

/**
 * 等待超时后的结论。
 *
 * 默认**拒绝**（fail closed）：没人回答就不做。
 * 配成放行就是「你不回话，智能体就自己动你的键鼠」—— 明显的 fail-open，
 * 面板上会为此给一条显眼的警告，面板的状态区还会显示已经这样放行过几次。
 *
 * 两种结果都**不记会话授权**：没有任何人同意过，不该留下长期许可。
 * @param {object} settings - 已归一化的配置。
 * @param {string} toolName
 * @returns {{ok: boolean, via?: string, error?: string}}
 */
function timeoutVerdict(settings, toolName) {
	if (settings.confirmAllowOnTimeout === true) {
		timeoutAllows += 1;
		return { ok: true, via: 'timeout' };
	}
	return {
		ok: false,
		error:
			`${toolName} 被拒绝：等待同意超时（${settings.confirmTimeoutSeconds} 秒内没有人回答），` +
			'按当前设置视为不同意，没有执行任何操作。不要重试；' +
			'请让用户自己完成这一步，或让用户把面板里的「超时后放行」打开（那意味着你不回话它就自己做）。',
	};
}

/**
 * 征求一次同意，返回是否放行。
 *
 * 用 `ctx.userQuestions` 而不是 DSH 原生的 `ctx.approval`：原生那套的结果词汇表是
 * `allowed-once | rejected | cancelled | unavailable`，**没有**「允许本会话」，
 * 而且它受会话审批策略约束（policy 为 never 时一律确定性拒绝，闸门会变成废的）。
 * userQuestions 的文档明确它可用于权限流程，且支持任意选项列表。
 * @returns {Promise<{ok: boolean, via?: string, error?: string}>}
 */
async function requestInputConsent(wiring, exec, toolName, args) {
	const header = exec?.agent?.session?.header;
	if (isSessionGranted(header)) return { ok: true, via: 'session' };
	const sessionId = header === undefined || header.id === undefined ? '' : String(header.id);
	const parentId = header?.parentSession === undefined || header.parentSession === null
		? ''
		: String(header.parentSession);

	const userQuestions = resolveUserQuestions(wiring);
	if (userQuestions === null) {
		return {
			ok: false,
			error:
				`${toolName} 被拒绝：confirmInput 已开启，但宿主没有可用的 userQuestions 服务，无法征求同意。` +
				'拿不到同意就不执行（fail closed）。请在插件设置里确认，或关掉 confirmInput。',
		};
	}

	// 自己控制 signal：既能跟随调用方的中止（工具超时 / 用户取消），
	// 也能在等待超时后把问题撤回 —— 否则弹窗会一直挂在界面上，
	// 而这边早已按超时策略给出了结论，用户再点就成了「迟到的回答」。
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	const relayAbort = () => {
		try {
			controller?.abort();
		} catch {
			/* 已经中止过就算了 */
		}
	};
	if (controller !== null && exec?.signal !== undefined) {
		if (exec.signal.aborted === true) controller.abort();
		else exec.signal.addEventListener?.('abort', relayAbort, { once: true });
	}

	const waitSeconds = wiring.settings.confirmTimeoutSeconds;
	let timedOut = false;
	let timer = null;
	if (waitSeconds > 0) {
		timer = setTimeout(() => {
			timedOut = true;
			relayAbort();
		}, waitSeconds * 1000);
	}

	let answer;
	try {
		answer = await userQuestions.ask({
			questions: [{
				id: CONSENT_QUESTION_ID,
				header: '桌面操控 · 需要确认',
				question:
					'智能体要执行一次桌面输入操作：\n\n' +
					`${toolName}\n${describeInputCall(toolName, args)}\n\n` +
					`允许吗？（${waitSeconds > 0
						? `${waitSeconds} 秒内不回答按「${wiring.settings.confirmAllowOnTimeout === true ? '允许' : '不允许'}」处理`
						: '会一直等你回答'}）`,
				options: [
					{ label: CONSENT_ALLOW_ONCE, description: '只放行这一次，下次还会再问' },
					{ label: CONSENT_ALLOW_SESSION, description: '本会话内不再询问；可在插件设置里撤销' },
					{ label: CONSENT_DENY, description: '拒绝这次输入，不做任何操作' },
				],
			}],
			...(exec?.agent === undefined ? {} : { agent: exec.agent }),
			signal: controller === null ? exec?.signal : controller.signal,
			...(exec?.callId === undefined ? {} : { wait: { callId: exec.callId } }),
		});
	} catch (error) {
		// 是我们自己的定时器中止的 → 按「超时后怎么处理」的配置给结论
		if (timedOut) return timeoutVerdict(wiring.settings, toolName);
		// 真正问不到人：子智能体（被别的 agent 拥有）→ DELEGATED_CALLER；
		// 没有 answerer → NO_PROVIDER。两种都必须拒绝：问不到人就不做。
		const reason = error?.message ?? String(error);
		return {
			ok: false,
			error: `${toolName} 被拒绝：无法向人类征求同意（${reason}）。` +
				describeGrantGap(sessionId, parentId),
		};
	} finally {
		if (timer !== null) clearTimeout(timer);
		exec?.signal?.removeEventListener?.('abort', relayAbort);
	}

	const choice = readConsentChoice(answer);
	if (choice === 'once') return { ok: true, via: 'once' };
	if (choice === 'session') {
		if (sessionId !== '') sessionGrants.set(sessionId, { at: Date.now() });
		return { ok: true, via: 'session' };
	}
	return {
		ok: false,
		error:
			`${toolName} 被用户拒绝，没有执行任何操作。不要重试；` +
			'请让用户自己完成这一步，或先征得同意再调用。',
	};
}

/**
 * 把输入工具的 execute 包上同意闸门。
 * confirmInput 关闭时直接透传 —— 行为与没有这个功能时逐字节一致。
 * @param {object} wiring
 * @param {string} toolName
 * @param {Function} run - 原来的 execute(args, exec)
 * @returns {Function}
 */
function withConsent(wiring, toolName, run) {
	return async function execute(args, exec) {
		if (wiring.settings.confirmInput !== true) return run(args, exec);
		const verdict = await requestInputConsent(wiring, exec, toolName, args);
		if (verdict.ok !== true) throw new Error(verdict.error);
		return run(args, exec);
	};
}

/** 输入工具的 timeoutMs：开着闸门时按等待窗口算，并留出余量。 */
function inputTimeoutMs(wiring, base) {
	if (wiring.settings.confirmInput !== true) return base;
	const wait = wiring.settings.confirmTimeoutSeconds;
	// 不超时（0）就给一个「一直等」的量；否则等满等待窗口再留出余量，
	// 让闸门自己先按配置决定，而不是被工具超时抢先生效。
	return wait > 0 ? wait * 1000 + CONFIRM_TIMEOUT_SLACK_MS : CONFIRM_WAIT_FOREVER_MS;
}

/** 开着闸门时追加到输入工具描述后面的一句，让模型知道调用会先停下来等人。 */
function consentNotice(wiring) {
	if (wiring.settings.confirmInput !== true) return '';
	return ' This call pauses for the user\'s approval first (allow once / allow for this session / deny);'
		+ ' a denial means nothing happened — do not retry it.';
}

/**
 * Register the desktop tools the current settings allow: two read-only
 * (window_list, screenshot) behind `allowCapture`, five input-control
 * (window_activate, mouse_click, type_text, key, scroll) behind `allowInput`.
 * apply() re-runs this whenever settings change, so a toggle takes effect
 * immediately without a restart.
 * @param ctx - Agent-scoped registration context (tools, attachments).
 * @param wiring - the wiring record built by apply().
 * @returns cleanup that unregisters everything registered this round.
 */
function registerTools(ctx, wiring) {
	const unregisters = [];
	const wantCapture = wiring.settings.allowCapture === true;
	const wantInput = wiring.settings.allowInput === true;

	if (wantCapture) unregisters.push(
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
				// 排除名单同时作用于「列出」与「操作」两条路径，
				// 否则被排除的窗口会从别的入口泄露出去。
				return Promise.resolve(
					listWindows(api).filter(
						(w) => !isExcludedTitle(w.title, wiring.settings.excludeWindowTitles),
					),
				);
			},
		}),
	);
	if (wantCapture) unregisters.push(
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
				const maxW = Number.isInteger(args?.maxWidth) && args.maxWidth >= 64
					? args.maxWidth
					: wiring.settings.captureMaxWidth;
				const api = getApi();
				let shot;
				let title = '';
				if (needle) {
					const win = findWindow(api, needle);
					if (!win) {
						const candidates = listWindows(api)
							.filter((w) => !isExcludedTitle(w.title, wiring.settings.excludeWindowTitles))
							.slice(0, 20)
							.map((w) => `"${w.title}"`)
							.join(', ');
						throw new Error(
							`No visible window whose title contains "${needle}". Visible windows: ${candidates || '(none)'}`,
						);
					}
					if (isExcludedTitle(win.title, wiring.settings.excludeWindowTitles)) {
						throw new Error(
							`Window "${win.title}" is excluded by the excludeWindowTitles setting; remove it there to capture it.`,
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
				rememberImage(ref, wiring.settings.imageCacheSize);
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
	if (wantInput) unregisters.push(
		ctx.tools.register({
			name: 'window_activate',
			description:
				'Bring a window to the foreground on the local machine, given a case-insensitive substring of its title (restoring it first if minimized). Use it before type_text or key so input lands in the right window, or when the user asks you to focus a window. Frontmost title match wins.' + INPUT_NOTICE + consentNotice(wiring),
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
			timeoutMs: inputTimeoutMs(wiring, 10000),
			execute: withConsent(wiring, 'window_activate', (args) => {
				const needle = typeof args?.window === 'string' ? args.window.trim() : '';
				if (!needle) throw new Error('window_activate requires a "window" title substring');
				const api = getApi();
				const win = findWindow(api, needle);
				if (!win) {
					const candidates = listWindows(api)
						.filter((w) => !isExcludedTitle(w.title, wiring.settings.excludeWindowTitles))
						.slice(0, 20)
						.map((w) => `"${w.title}"`)
						.join(', ');
					throw new Error(`No visible window whose title contains "${needle}". Visible windows: ${candidates || '(none)'}`);
				}
				if (isExcludedTitle(win.title, wiring.settings.excludeWindowTitles)) {
					throw new Error(
						`Window "${win.title}" is excluded by the excludeWindowTitles setting; remove it there to operate it.`,
					);
				}
				activateWindow(win.hwnd);
				return { hwnd: win.hwnd, title: win.title };
			}),
		}),
	);
	if (wantInput) unregisters.push(
		ctx.tools.register({
			name: 'mouse_click',
			description:
				'Move the mouse to (x, y) in virtual-screen pixels (0,0 = top-left of the primary monitor) and click. button: left | right | middle (default left); clicks 1-3 (2 = double-click, default 1). Find coordinates from screenshot output and window_list rectangles. This really moves the user\'s cursor and clicks.' + INPUT_NOTICE + consentNotice(wiring),
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
			timeoutMs: inputTimeoutMs(wiring, 10000),
			execute: withConsent(wiring, 'mouse_click', (args) => {
				const x = args?.x;
				const y = args?.y;
				if (!Number.isInteger(x) || !Number.isInteger(y)) {
					throw new Error('mouse_click requires integer x and y');
				}
				const button = args?.button ?? 'left';
				const clicks = Number.isInteger(args?.clicks) ? args.clicks : 1;
				clickAt(x, y, button, clicks);
				return { x, y, button, clicks };
			}),
		}),
	);
	if (wantInput) unregisters.push(
		ctx.tools.register({
			name: 'type_text',
			description:
				'Type the given text into the currently focused window (Unicode input events, any language). Activate the target window with window_activate first if input must land somewhere specific. This really types on the user\'s desktop.' + INPUT_NOTICE + consentNotice(wiring),
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
			timeoutMs: inputTimeoutMs(wiring, 15000),
			execute: withConsent(wiring, 'type_text', (args) => {
				const text = args?.text;
				if (typeof text !== 'string' || text.length === 0) {
					throw new Error('type_text requires a non-empty "text" string');
				}
				typeText(text);
				return { chars: text.length };
			}),
		}),
	);
	if (wantInput) unregisters.push(
		ctx.tools.register({
			name: 'key',
			description:
				'Press a key or key combination on the local desktop, e.g. "enter", "tab", "ctrl+a", "ctrl+shift+t", "alt+f4", "f5". Supported keys: a-z, 0-9, f1-f24, enter, tab, esc, backspace, delete, insert, home, end, pageup, pagedown, left, up, right, down, space, shift, ctrl, alt, win. Modifiers go down in order, up in reverse. This really presses keys on the user\'s desktop.' + INPUT_NOTICE + consentNotice(wiring),
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
			timeoutMs: inputTimeoutMs(wiring, 10000),
			execute: withConsent(wiring, 'key', (args) => {
				const combo = typeof args?.combo === 'string' ? args.combo.trim() : '';
				if (!combo) throw new Error('key requires a "combo" like "ctrl+a"');
				pressKey(combo);
				return { combo };
			}),
		}),
	);
	if (wantInput) unregisters.push(
		ctx.tools.register({
			name: 'scroll',
			description:
				'Scroll the page or window under the mouse cursor. Give x,y (virtual-screen pixels) to move the cursor there first; omit them to scroll at the current cursor position. deltaY: wheel units, +120 = one notch up, negative = down (e.g. -240 = two notches down). This really scrolls the user\'s desktop.' + INPUT_NOTICE + consentNotice(wiring),
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
			timeoutMs: inputTimeoutMs(wiring, 10000),
			execute: withConsent(wiring, 'scroll', (args) => {
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
			}),
		}),
	);
	return () => {
		for (const unregister of unregisters) {
			if (typeof unregister === 'function') unregister();
		}
	};
}

/* ------------------------------------------------------------------ */
/* 面板 HTTP 路由                                                      */
/* ------------------------------------------------------------------ */

const STATE_PATH = `/api/${pkg}/state`;
const SETTINGS_PATH = `/api/${pkg}/settings`;
/** 撤销会话级授权。 */
const CONSENT_PATH = `/api/${pkg}/consent`;
const NO_CACHE = { 'cache-control': 'no-store' };
const MAX_BODY_BYTES = 8192;

/** 默认允许的回环主机名。 */
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Host 头里的裸主机名。裸 IPv6（两个及以上冒号）不按 host:port 剥端口，
 * 否则 ::1 的尾段会被当成端口切掉。
 */
function bareHost(host) {
	const text = String(host ?? '').split(',')[0]?.trim() ?? '';
	if (text === '') return '';
	const lower = text.toLowerCase();
	const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(lower);
	if (bracketed) return bracketed[1];
	if (/^[0-9a-f:]+$/.test(lower) && (lower.match(/:/g) ?? []).length >= 2) return lower;
	return lower.replace(/:\d+$/, '');
}

/** 面板请求是否来自本机回环。只校验 Host：跨源请求到不了回环 webserver。 */
function isAdmitted(request) {
	const host = bareHost(request?.headers?.host);
	if (host === '') return false;
	return LOOPBACK_HOSTS.some((entry) => host === entry);
}

function writeJson(res, status, body) {
	res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...NO_CACHE });
	res.end(JSON.stringify(body));
}

async function readJsonBody(request, limit = MAX_BODY_BYTES) {
	const chunks = [];
	let received = 0;
	try {
		for await (const chunk of request) {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			received += buffer.byteLength;
			if (received > limit) return { ok: false, error: '请求体过大' };
			chunks.push(buffer);
		}
	} catch {
		return { ok: false, error: '无法读取请求体' };
	}
	if (chunks.length === 0) return { ok: false, error: '需要一个 JSON 请求体' };
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
		return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
			? { ok: true, value: parsed }
			: { ok: false, error: '请求体必须是 JSON 对象' };
	} catch {
		return { ok: false, error: '请求体不是合法 JSON' };
	}
}

/** 归一化一份「当前生效的工具列表」，面板与状态响应共用。 */
function toolNames(settings) {
	if (settings.enabled !== true) return [];
	const names = [];
	if (settings.allowCapture) names.push('window_list', 'screenshot');
	if (settings.allowInput) names.push('window_activate', 'mouse_click', 'type_text', 'key', 'scroll');
	return names;
}

/**
 * 会话 id 的展示用短名。
 *
 * 真实会话 id 形如 `session-85555e38-17f8-4cd3-8a4a-9d13c88315a9`，
 * 所以**不能直接截前 8 位** —— 那只会得到 `session-` 这个每条都一样的固定前缀，
 * 面板上所有授权会显示成同一个东西。（这个 bug 是在真机上测出来的：
 * 面板显示 "session-…"，根本分不清哪条是哪条。）
 * 先剥掉前缀再截，才有区分度。
 * @param {string} id - 会话 id。
 * @returns {string} 适合面板展示的短名。
 */
function shortSessionId(id) {
	const text = String(id ?? '');
	const prefix = 'session-';
	const tail = text.startsWith(prefix) ? text.slice(prefix.length) : text;
	return tail.slice(0, 8);
}

/** 会话授权的可序列化视图，最新在前。 */
function grantList() {
	return [...sessionGrants.entries()]
		.map(([id, meta]) => ({ id, short: shortSessionId(id), at: meta.at }))
		.sort((left, right) => right.at - left.at);
}

/** 组装只读状态快照。面板与工具读同一份口径。 */
function buildState(wiring) {
	return {
		ok: true,
		now: Date.now(),
		plugin: { name: pkg, entry: name, version: VERSION },
		effective: { ...wiring.settings },
		defaults: { ...DEFAULTS },
		configError: wiring.configError,
		tools: toolNames(wiring.settings),
		registeredTools: wiring.registeredTools.slice(),
		imageCacheSize: imageCache.size,
		platform: process.platform,
		consent: {
			confirmInput: wiring.settings.confirmInput === true,
			/** 宿主有没有可用的 userQuestions：没有的话开着闸门会让输入工具全部失败。 */
			service: resolveUserQuestions(wiring) !== null,
			tools: CONFIRM_TOOLS.slice(),
			grants: grantList(),
			/** 等待窗口的秒数；0 = 不超时。 */
			timeoutSeconds: wiring.settings.confirmTimeoutSeconds,
			/** 超时后是否放行（fail-open，默认 false）。 */
			allowOnTimeout: wiring.settings.confirmAllowOnTimeout === true,
			/** 已经因为超时而放行过几次 —— 这是「我不在时它自己动过手」的唯一痕迹。 */
			timeoutAllows,
		},
	};
}

/**
 * 挂两条路由：读状态、改设置。每条都以 isAdmitted 开头。
 * @returns {Function|null} 反注册回调；宿主没有 webServer 时返回 null。
 */
function registerRoutes(ctx, wiring) {
	let webServer = null;
	try {
		webServer = ctx.webServer ?? ctx.get?.('webServer') ?? null;
	} catch {
		webServer = null;
	}
	if (webServer === null || typeof webServer.register !== 'function') return null;

	const register = (path, handler) => {
		try {
			return webServer.register({ kind: 'exact', path, handler });
		} catch (error) {
			wiring.logger?.warn?.(`${pkg}: 路由注册失败 ${path}: ${error?.message ?? error}`);
			return null;
		}
	};

	const onState = register(STATE_PATH, (request, response) => {
		if (!isAdmitted(request)) return writeJson(response, 403, { ok: false, error: '禁止：来源不匹配' });
		const method = request.method === undefined ? 'GET' : request.method;
		if (method !== 'GET' && method !== 'HEAD') return writeJson(response, 405, { ok: false, error: '方法不允许' });
		try {
			writeJson(response, 200, buildState(wiring));
		} catch (error) {
			writeJson(response, 200, { ok: false, error: error?.message ?? String(error) });
		}
	});

	const onSettings = register(SETTINGS_PATH, async (request, response) => {
		if (!isAdmitted(request)) return writeJson(response, 403, { ok: false, error: '禁止：来源不匹配' });
		if (request.method !== undefined && request.method !== 'POST') {
			return writeJson(response, 405, { ok: false, error: '方法不允许' });
		}
		const body = await readJsonBody(request);
		if (!body.ok) return writeJson(response, 400, { ok: false, error: body.error });
		const { field, value } = body.value;
		if (typeof field !== 'string' || field === '') {
			return writeJson(response, 400, { ok: false, error: '缺少 field' });
		}
		if (!(field in DEFAULTS)) {
			return writeJson(response, 400, { ok: false, error: `未知字段 '${field}'` });
		}
		try {
			const beforeConsent = wiring.settings.confirmInput === true;
			const next = await wiring.store.mutate((current) => {
				const copy = { ...current };
				if (value === null) delete copy[field];
				else copy[field] = value;
				return copy;
			});
			const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...next });
			wiring.settings = settings;
			wiring.configError = configError;
			// 闸门配置一变就清掉已有的会话授权：改配置 = 重新开始。
			// 不清的话，把 confirmInput 关掉再打开，上一次点的「本会话允许」会悄悄接着生效。
			if ((settings.confirmInput === true) !== beforeConsent) sessionGrants.clear();
			// 安全闸门改动后立刻重挂工具，不需要重启
			syncTools(wiring);
			// 回一份**完整状态快照**，让面板一次性替换本地状态。
			//
			// 以前这里只回 effective / defaults / tools / consent，客户端得逐字段合并；
			// 漏掉任何一个字段的症状都是「显示已保存但界面不动」，只能等下一次轮询
			// （硬编码 30 秒）。回整份快照既省掉了那份容易漏的合并逻辑，
			// 也让派生字段（图片缓存数、授权列表）一起刷新。
			writeJson(response, 200, buildState(wiring));
		} catch (error) {
			writeJson(response, 500, { ok: false, error: error?.message ?? String(error) });
		}
	});

	// 撤销会话级授权。默认撤销全部；给了 sessionId 就只撤那一个。
	const onConsent = register(CONSENT_PATH, async (request, response) => {
		if (!isAdmitted(request)) return writeJson(response, 403, { ok: false, error: '禁止：来源不匹配' });
		if (request.method !== undefined && request.method !== 'POST') {
			return writeJson(response, 405, { ok: false, error: '方法不允许' });
		}
		const body = await readJsonBody(request);
		if (!body.ok) return writeJson(response, 400, { ok: false, error: body.error });
		const sessionId = typeof body.value.sessionId === 'string' ? body.value.sessionId.trim() : '';
		try {
			const before = sessionGrants.size;
			if (sessionId === '') sessionGrants.clear();
			else sessionGrants.delete(sessionId);
			writeJson(response, 200, {
				ok: true,
				revoked: before - sessionGrants.size,
				grants: grantList(),
			});
		} catch (error) {
			writeJson(response, 500, { ok: false, error: error?.message ?? String(error) });
		}
	});

	return () => {
		for (const off of [onState, onSettings, onConsent]) {
			if (typeof off === 'function') {
				try {
					off();
				} catch {
					/* 宿主可能已拆除 */
				}
			}
		}
	};
}

/** 按当前设置重挂工具；先全部卸掉再按需注册，避免重复注册。 */
function syncTools(wiring) {
	if (wiring.disposed) return;
	if (typeof wiring.offTools === 'function') {
		try {
			wiring.offTools();
		} catch {
			/* ignore */
		}
		wiring.offTools = null;
	}
	wiring.registeredTools = [];
	if (wiring.settings.enabled !== true) return;
	if (typeof wiring.ctx.tools?.register !== 'function') return;
	try {
		wiring.offTools = registerTools(wiring.ctx, wiring);
		wiring.registeredTools = toolNames(wiring.settings);
	} catch (error) {
		wiring.logger?.warn?.(`${pkg}: 工具注册失败：${error?.message ?? error}`);
	}
}

/** 读状态文件并重算生效配置；被面板写入后调用。 */
async function refreshFromSettings(wiring) {
	if (wiring.disposed === true) return null;
	if (wiring.refreshing === true) return null;
	wiring.refreshing = true;
	try {
		const layer = await wiring.store.read();
		const { settings, configError } = resolveSettings({ ...wiring.patchConfig, ...layer });
		wiring.settings = settings;
		wiring.configError = configError;
		syncTools(wiring);
		return settings;
	} catch (error) {
		wiring.logger?.warn?.(`${pkg}: 读取设置失败：${error?.message ?? error}`);
		return null;
	} finally {
		wiring.refreshing = false;
	}
}

/* ------------------------------------------------------------------ */
/* 挂载                                                               */
/* ------------------------------------------------------------------ */

/**
 * 挂载：装配设置、按设置注册工具、挂面板路由，并在设置变化时重挂工具。
 * 任何一处拿不到服务都静默降级，绝不在挂载时抛错。
 * @param ctx - Host root context.
 * @param config - this entry's patch config (the deploy defaults).
 */
function apply(ctx, config = {}) {
	const logger = ctx.logger ?? null;
	const patchConfig = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) };
	const initial = resolveSettings(patchConfig);
	const wiring = {
		ctx,
		logger,
		store: new FileStore({ dir: stateDirectory(), file: 'settings.json' }),
		patchConfig,
		settings: initial.settings,
		configError: initial.configError,
		disposed: false,
		refreshing: false,
		offTools: null,
		registeredTools: [],
		/** 惰性解析出的 userQuestions 服务；null = 还没解析成功过。 */
		userQuestions: null,
	};

	const offRoutes = registerRoutes(ctx, wiring);
	syncTools(wiring);
	// 状态覆盖层可能在上一次会话里写过，异步读一次覆盖它
	void refreshFromSettings(wiring);

	const stop = () => {
		wiring.disposed = true;
		if (typeof wiring.offTools === 'function') {
			try {
				wiring.offTools();
			} catch {
				/* ignore */
			}
			wiring.offTools = null;
		}
		if (typeof offRoutes === 'function') {
			try {
				offRoutes();
			} catch {
				/* ignore */
			}
		}
		imageCache.clear();
		// 会话授权也一起丢掉：插件卸载/重载后重新开始问，不留一份没人看着的鼠标键盘许可。
		sessionGrants.clear();
	};
	if (typeof ctx.effect === 'function') {
		ctx.effect(() => () => stop(), `${pkg}: mount`);
	} else {
		ctx.once?.('disposed', stop);
	}
}

export {
	CONFIRM_TIMEOUT_SLACK_MS,
	CONFIRM_TOOLS,
	CONFIRM_WAIT_FOREVER_MS,
	CONFIRM_WAIT_MAX_S,
	CONFIRM_WAIT_MIN_S,
	CONSENT_ALLOW_ONCE,
	CONSENT_ALLOW_SESSION,
	CONSENT_DENY,
	CONSENT_PATH,
	CONSENT_QUESTION_ID,
	DEFAULTS,
	DEFAULTS as CONFIG_DEFAULTS,
	FileStore,
	VERSION,
	apply,
	buildState,
	describeInputCall,
	describeGrantGap,
	grantList,
	inject,
	inputTimeoutMs,
	isAdmitted,
	isExcludedTitle,
	isSessionGranted,
	name,
	pkg,
	readConsentChoice,
	registerRoutes,
	registerTools,
	requestInputConsent,
	resolveSettings,
	resolveUserQuestions,
	sessionGrants,
	shortSessionId,
	stateDirectory,
	timeoutVerdict,
	toolNames,
	withConsent,
};

