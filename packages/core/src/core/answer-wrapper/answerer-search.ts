import { $ } from '../../utils';
import { request } from '../utils/request';

/**
 * 搜题增强：可选的内置搜索与外部搜索。
 *
 * 设计原则：
 * - 搜索只是增强，失败不能阻断答题（记录警告后按无搜索结果继续）。
 * - 外部搜索按题目只执行一次（同一 env 下多个题库共享结果）。
 * - 官方端点可选择使用其内置搜索工具；其它端点使用 Exa / Tavily / DeepSeek。
 * - 所有密钥均由上层（scripts）通过 env.search.keys 传入，core 不读取浏览器存储。
 */
export type AnswererSearchMode = 'off' | 'builtin' | 'custom';
export type AnswererSearchProvider = 'exa' | 'tavily' | 'deepseek';

export interface AnswererSearchOptions {
	mode: AnswererSearchMode;
	provider: AnswererSearchProvider;
	keys?: Partial<Record<AnswererSearchProvider, string>>;
	max_results?: number;
}

const SEARCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESULTS = 5;
const MAX_CONTEXT_CHARS = 4000;

const SEARCH_PROVIDER_LABELS: Record<AnswererSearchProvider, string> = {
	exa: 'Exa',
	tavily: 'Tavily',
	deepseek: 'DeepSeek'
};

export function readAnswererSearchOptions(env: any): AnswererSearchOptions {
	const raw = env && typeof env.search === 'object' && env.search ? env.search : {};
	const mode: AnswererSearchMode = raw.mode === 'builtin' || raw.mode === 'custom' ? raw.mode : 'off';
	const provider: AnswererSearchProvider =
		raw.provider === 'tavily' || raw.provider === 'deepseek' ? raw.provider : 'exa';
	const keys = raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
	const maxResults = Number(raw.max_results);
	return {
		mode,
		provider,
		keys: {
			exa: typeof keys.exa === 'string' ? keys.exa : '',
			tavily: typeof keys.tavily === 'string' ? keys.tavily : '',
			deepseek: typeof keys.deepseek === 'string' ? keys.deepseek : ''
		},
		max_results:
			Number.isFinite(maxResults) && maxResults > 0 ? Math.min(Math.floor(maxResults), 20) : DEFAULT_MAX_RESULTS
	};
}

/** 官方 DeepSeek 模型端点（搜索使用其独立的 Search API） */
export function isOfficialDeepSeekEndpoint(url: string) {
	return /^https:\/\/api\.deepseek\.com\/v1\/(?:chat\/completions|responses|beta\/chat\/completions)(?:\?|$)/i.test(
		String(url || '')
	);
}

/** 官方 Gemini generateContent 端点（内置 Google Search grounding） */
export function isOfficialGeminiEndpoint(url: string) {
	return /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/?]+:generateContent(?:\?|$)/i.test(
		String(url || '')
	);
}

/** 官方 OpenAI Responses 端点（内置 web_search 工具） */
export function isOfficialOpenAIEndpoint(url: string) {
	return /^https:\/\/api\.openai\.com\/v1\/responses(?:\?|$)/i.test(String(url || ''));
}

/** OpenCode Go（OpenAI 兼容协议） */
export function isOpenCodeGoEndpoint(url: string) {
	return /^https:\/\/opencode\.ai\/(?:inference\/go\/openai|zen\/go)\/v1\//i.test(String(url || ''));
}

function createUuid() {
	const cryptoObject = (globalThis as any).crypto;
	if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
		return cryptoObject.randomUUID();
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
		const random = (Math.random() * 16) | 0;
		const value = char === 'x' ? random : (random & 0x3) | 0x8;
		return value.toString(16);
	});
}

const OPENCODE_SESSION_STORAGE_KEY = 'ocs.opencode.session';
let openCodeFallbackSession = '';

/**
 * OpenCode Go 要求每个会话使用固定 UUID（路由与 prompt cache 亲和）。
 * 同一标签页内保持不变；sessionStorage 不可用时退化为内存值。
 */
export function getOpenCodeSessionId() {
	try {
		const storage = (globalThis as any).sessionStorage;
		if (storage) {
			const existing = storage.getItem(OPENCODE_SESSION_STORAGE_KEY);
			if (existing) return existing;
			const created = createUuid();
			storage.setItem(OPENCODE_SESSION_STORAGE_KEY, created);
			return created;
		}
	} catch {
		// 隐私模式 / 禁用存储：使用内存会话
	}
	if (!openCodeFallbackSession) openCodeFallbackSession = createUuid();
	return openCodeFallbackSession;
}

/**
 * OpenCode Go 的请求头适配：
 * - Authorization: Bearer <key>
 * - x-opencode-session: 会话固定 UUID（必需）
 * - x-opencode-client: 客户端标识（可选）
 * - User-Agent: 可识别的客户端标识（文档要求，不能是通用 SDK/浏览器库名）
 *
 * 浏览器 fetch 会丢弃 User-Agent，因此调用方应把该请求升级为 GM_xmlhttpRequest。
 */
export function applyOpenCodeHeaders(headers: Record<string, string>, env: any) {
	const result: Record<string, string> = { ...(headers || {}) };
	const existing = new Set(Object.keys(result).map((key) => key.toLowerCase()));
	const setIfMissing = (name: string, value: string) => {
		if (!existing.has(name.toLowerCase())) {
			result[name] = value;
			existing.add(name.toLowerCase());
		}
	};
	setIfMissing('x-opencode-session', String(env?.opencodeGoSession || getOpenCodeSessionId()));
	setIfMissing('x-opencode-client', 'ocs');
	setIfMissing('User-Agent', 'OCS/5.3.1 (+https://github.com/ocsjs/ocsjs)');
	const apiKey = typeof env?.opencodeGoApiKey === 'string' ? env.opencodeGoApiKey.trim() : '';
	if (apiKey) {
		setIfMissing('Authorization', `Bearer ${apiKey}`);
	}
	return result;
}

/** 从题目文本构造搜索词：去掉图片 URL 与占位符，避免污染检索 */
function buildSearchQuery(env: any) {
	const clean = (value: any) =>
		String(value || '')
			.replace(/https?:\/\/[^\s"'<>]+/gi, ' ')
			.replace(/\[图片(?:\d+|尚未加载)?\]/g, ' ')
			.replace(/\[图 ID (?:开始|结束)\]/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();
	const title = clean(env?.title || env?.suggestion_title || '');
	if (!title) return '';
	const options = clean(env?.options || '')
		.split(/\n+/)
		.slice(0, 4)
		.join(' ')
		.slice(0, 120);
	return `${title}${options ? ' ' + options : ''}`.trim();
}

async function postSearchJson(url: string, apiKey: string, body: Record<string, any>) {
	const response = await Promise.race([
		request(url, {
			type: 'GM_xmlhttpRequest',
			method: 'post',
			responseType: 'json',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${apiKey}`
			},
			data: body
		}),
		$.sleep(SEARCH_TIMEOUT_MS)
	]);
	if (response === undefined) throw new Error('搜索请求超时');
	return response;
}

function truncate(value: any, length: number) {
	const text = String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > length ? text.slice(0, length) + '…' : text;
}

async function searchExa(query: string, apiKey: string, maxResults: number) {
	const response = await postSearchJson('https://api.exa.ai/search', apiKey, {
		query,
		numResults: maxResults,
		contents: { text: { maxCharacters: 1200 } }
	});
	const results = Array.isArray(response?.results) ? response.results : [];
	const lines = results.slice(0, maxResults).map((item: any, index: number) => {
		const description =
			item?.text || item?.summary || (Array.isArray(item?.highlights) ? item.highlights.join(' ') : '');
		return `${index + 1}. ${truncate(item?.title, 160) || '无标题'}\n${item?.url || ''}\n${truncate(description, 600)}`;
	});
	return lines.join('\n\n');
}

async function searchTavily(query: string, apiKey: string, maxResults: number) {
	const response = await postSearchJson('https://api.tavily.com/search', apiKey, {
		query,
		max_results: maxResults,
		include_answer: true,
		search_depth: 'basic'
	});
	const lines: string[] = [];
	if (response?.answer) lines.push(`搜索摘要：${truncate(response.answer, 800)}`);
	const results = Array.isArray(response?.results) ? response.results : [];
	results.slice(0, maxResults).forEach((item: any, index: number) => {
		lines.push(
			`${index + 1}. ${truncate(item?.title, 160) || '无标题'}\n${item?.url || ''}\n${truncate(item?.content, 600)}`
		);
	});
	return lines.join('\n\n');
}

async function searchDeepSeek(query: string, apiKey: string, maxResults: number) {
	const response = await postSearchJson('https://api.deepseek.com/v1/tools/search', apiKey, {
		query: query.slice(0, 128),
		count: maxResults,
		need_content: false
	});
	const results = Array.isArray(response?.results) ? response.results : [];
	const lines = results.slice(0, maxResults).map((item: any, index: number) => {
		const description = item?.summary || item?.snippet || item?.content || '';
		return `${index + 1}. ${truncate(item?.title, 160) || '无标题'}\n${item?.url || ''}\n${truncate(description, 600)}`;
	});
	return lines.join('\n\n');
}

const searchCache = new WeakMap<object, Map<string, Promise<string>>>();

/**
 * 执行一次外部搜索并返回可注入题目的文本。同一 env + provider 只请求一次。
 * 任何失败都只在控制台告警，返回空字符串，不影响答题。
 */
export function prepareExternalSearch(
	env: any,
	options: AnswererSearchOptions,
	providerOverride?: AnswererSearchProvider
): Promise<string> {
	const provider = providerOverride || options.provider;
	const envObject = env && typeof env === 'object' ? env : {};
	let cache = searchCache.get(envObject);
	if (!cache) {
		cache = new Map();
		searchCache.set(envObject, cache);
	}
	const cached = cache.get(provider);
	if (cached) return cached;
	const promise = (async () => {
		const query = buildSearchQuery(env);
		if (!query) return '';
		const apiKey = String(options.keys?.[provider] || '').trim();
		if (!apiKey) {
			console.warn(`[OCS] 已开启 ${SEARCH_PROVIDER_LABELS[provider]} 搜索，但没有填写对应的 API Key。`);
			return '';
		}
		try {
			const maxResults = options.max_results || DEFAULT_MAX_RESULTS;
			const body =
				provider === 'exa'
					? await searchExa(query, apiKey, maxResults)
					: provider === 'tavily'
					? await searchTavily(query, apiKey, maxResults)
					: await searchDeepSeek(query, apiKey, maxResults);
			if (!body) return '';
			const header = `【网络搜索结果（${SEARCH_PROVIDER_LABELS[provider]}，仅供参考；与题目无关时请忽略，不要凭此臆造答案）】`;
			return `${header}\n${body}`.slice(0, MAX_CONTEXT_CHARS);
		} catch (error: any) {
			console.warn(`[OCS] ${SEARCH_PROVIDER_LABELS[provider]} 搜索失败：`, error?.message || error);
			return '';
		}
	})();
	cache.set(provider, promise);
	return promise;
}

/** 把搜索结果附加到题目文本与 rich_content（旧题库读 ${title}，新题库读 rich_content） */
export function injectSearchContext(env: any, context: string) {
	if (!context || !env || env.__searchContextInjected) return;
	env.__searchContextInjected = true;
	env.search_context = context;
	if (typeof env.title === 'string') {
		env.title = `${env.title}\n\n${context}`;
	}
	// 旧版图片题库读取 suggestion_title（题干 + 选项 + [图片N]），也要带上搜索结果。
	if (typeof env.suggestion_title === 'string' && env.suggestion_title.trim()) {
		env.suggestion_title = `${env.suggestion_title}\n\n${context}`;
	}
	if (Array.isArray(env.rich_content)) {
		env.rich_content = [{ type: 'input_text', text: context }, ...env.rich_content];
	}
}

/** 官方端点的内置搜索工具注入 */
export function applyBuiltinSearch(endpoint: string, data: any) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
	if (isOfficialOpenAIEndpoint(endpoint)) {
		const tools = Array.isArray(data.tools) ? data.tools.slice() : [];
		if (!tools.some((tool: any) => tool?.type === 'web_search' || tool?.type === 'web_search_preview')) {
			tools.push({ type: 'web_search' });
		}
		return { ...data, tools };
	}
	if (isOfficialGeminiEndpoint(endpoint)) {
		const tools = Array.isArray(data.tools) ? data.tools.slice() : [];
		if (!tools.some((tool: any) => tool && typeof tool === 'object' && tool.google_search)) {
			tools.push({ google_search: {} });
		}
		return { ...data, tools };
	}
	return data;
}
