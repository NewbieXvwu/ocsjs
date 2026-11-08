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

/** 官方 DeepSeek 模型端点（Chat Completions 无内置搜索，Responses 支持 web_search） */
export function isOfficialDeepSeekEndpoint(url: string) {
	return /^https:\/\/api\.deepseek\.com\/v1\/(?:chat\/completions|responses|beta\/chat\/completions)(?:\?|$)/i.test(
		String(url || '')
	);
}

/** 官方 DeepSeek Responses 端点（支持内置 web_search 工具） */
export function isOfficialDeepSeekResponsesEndpoint(url: string) {
	return /^https:\/\/api\.deepseek\.com\/v1\/responses(?:\?|$)/i.test(String(url || ''));
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

/** 官方端点的内置搜索工具注入 */
export function applyBuiltinSearch(endpoint: string, data: any) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return data;
	if (isOfficialOpenAIEndpoint(endpoint) || isOfficialDeepSeekResponsesEndpoint(endpoint)) {
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

/**
 * 自定义搜索使用的函数工具。
 *
 * 和“先把搜索结果拼进题干”不同，这里只向模型声明一个可调用的搜索工具；
 * 模型自己决定是否搜索、用什么关键词搜索，结果通过 tool/function 角色回传，
 * 不会把搜索结果伪装成题目内容。DeepSeek 官方 Chat Completions 没有内置搜索，
 * 也复用这个工具，由 DeepSeek Search API 执行。
 */
export const ANSWERER_SEARCH_TOOL_NAME = 'ocs_web_search';

const ANSWERER_SEARCH_TOOL_DESCRIPTION =
	'搜索互联网。当题目涉及最新事实、实时信息，或你不确定答案时调用；参数 query 是简洁的搜索关键词。搜索结果仅供参考，仍应以题目和你的知识判断。';

const ANSWERER_SEARCH_TOOL_PARAMETERS = {
	type: 'object',
	properties: {
		query: { type: 'string', description: '搜索关键词，尽量包含题目中的关键实体与限定词' }
	},
	required: ['query'],
	additionalProperties: false
};

export type AnswererSearchToolProtocol = 'openai-chat' | 'openai-responses' | 'gemini';

/** 根据端点判断函数调用协议；无法识别时不注入工具 */
export function detectSearchToolProtocol(endpoint: string): AnswererSearchToolProtocol | null {
	const url = String(endpoint || '');
	if (/\/v1beta\/models\/[^/?]+:generateContent(?:\?|$)/i.test(url)) return 'gemini';
	if (/\/responses(?:\?|$)/i.test(url)) return 'openai-responses';
	if (/\/chat\/completions(?:\?|$)/i.test(url)) return 'openai-chat';
	return null;
}

/** 只有请求体本身能追加消息时才允许工具循环 */
export function supportsSearchToolData(protocol: AnswererSearchToolProtocol, data: any) {
	if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
	if (protocol === 'openai-chat') return Array.isArray(data.messages);
	if (protocol === 'openai-responses') return Array.isArray(data.input);
	return Array.isArray(data.contents);
}

/** 向请求体注入函数工具定义（不改动已有同名工具） */
export function injectSearchTool(protocol: AnswererSearchToolProtocol, data: any) {
	if (!supportsSearchToolData(protocol, data)) return data;
	const tools = Array.isArray(data.tools) ? data.tools.slice() : [];
	if (protocol === 'openai-chat') {
		if (
			!tools.some(
				(tool: any) => tool?.type === 'function' && tool?.function && tool.function.name === ANSWERER_SEARCH_TOOL_NAME
			)
		) {
			tools.push({
				type: 'function',
				function: {
					name: ANSWERER_SEARCH_TOOL_NAME,
					description: ANSWERER_SEARCH_TOOL_DESCRIPTION,
					parameters: ANSWERER_SEARCH_TOOL_PARAMETERS
				}
			});
		}
		return { ...data, tools, tool_choice: data.tool_choice ?? 'auto' };
	}
	if (protocol === 'openai-responses') {
		if (!tools.some((tool: any) => tool?.type === 'function' && tool?.name === ANSWERER_SEARCH_TOOL_NAME)) {
			tools.push({
				type: 'function',
				name: ANSWERER_SEARCH_TOOL_NAME,
				description: ANSWERER_SEARCH_TOOL_DESCRIPTION,
				parameters: ANSWERER_SEARCH_TOOL_PARAMETERS,
				strict: false
			});
		}
		return { ...data, tools };
	}
	const declarations = tools.find((tool: any) => Array.isArray(tool?.functionDeclarations));
	if (declarations) {
		const exists = declarations.functionDeclarations.some(
			(declaration: any) => declaration?.name === ANSWERER_SEARCH_TOOL_NAME
		);
		if (exists) return { ...data, tools };
		const updated = tools.slice();
		const index = updated.indexOf(declarations);
		updated[index] = {
			...declarations,
			functionDeclarations: [
				...declarations.functionDeclarations,
				{
					name: ANSWERER_SEARCH_TOOL_NAME,
					description: ANSWERER_SEARCH_TOOL_DESCRIPTION,
					parameters: {
						type: 'OBJECT',
						properties: {
							query: { type: 'STRING', description: '搜索关键词，尽量包含题目中的关键实体与限定词' }
						},
						required: ['query']
					}
				}
			]
		};
		return { ...data, tools: updated };
	}
	tools.push({
		functionDeclarations: [
			{
				name: ANSWERER_SEARCH_TOOL_NAME,
				description: ANSWERER_SEARCH_TOOL_DESCRIPTION,
				parameters: {
					type: 'OBJECT',
					properties: {
						query: { type: 'STRING', description: '搜索关键词，尽量包含题目中的关键实体与限定词' }
					},
					required: ['query']
				}
			}
		]
	});
	return { ...data, tools };
}

export interface AnswererSearchToolCall {
	/** OpenAI Chat / Responses 的调用 ID；Gemini 没有 ID，使用序号 */
	id: string;
	query: string;
	/** 原始调用项，用于按原协议回传 */
	raw?: any;
}

function parseSearchQuery(value: any) {
	if (typeof value === 'string') {
		try {
			const parsed = JSON.parse(value);
			return typeof parsed?.query === 'string' ? parsed.query.trim() : '';
		} catch {
			return '';
		}
	}
	return typeof value?.query === 'string' ? value.query.trim() : '';
}

/** 从模型响应中提取搜索工具调用 */
export function extractSearchToolCalls(protocol: AnswererSearchToolProtocol, response: any): AnswererSearchToolCall[] {
	try {
		if (protocol === 'openai-chat') {
			const calls = response?.choices?.[0]?.message?.tool_calls;
			if (!Array.isArray(calls)) return [];
			return calls
				.filter((call: any) => call?.type === 'function' && call?.function?.name === ANSWERER_SEARCH_TOOL_NAME)
				.map((call: any) => ({
					id: String(call.id || ''),
					query: parseSearchQuery(call.function?.arguments),
					raw: call
				}))
				.filter((call: AnswererSearchToolCall) => call.query);
		}
		if (protocol === 'openai-responses') {
			const output = Array.isArray(response?.output) ? response.output : [];
			return output
				.filter((item: any) => item?.type === 'function_call' && item?.name === ANSWERER_SEARCH_TOOL_NAME)
				.map((item: any) => ({
					id: String(item.call_id || item.id || ''),
					query: parseSearchQuery(item.arguments),
					raw: item
				}))
				.filter((call: AnswererSearchToolCall) => call.query);
		}
		const parts = response?.candidates?.[0]?.content?.parts;
		if (!Array.isArray(parts)) return [];
		return parts
			.filter((part: any) => part?.functionCall?.name === ANSWERER_SEARCH_TOOL_NAME)
			.map((part: any, index: number) => ({
				id: `gemini-${index}`,
				query: parseSearchQuery(part.functionCall?.args),
				raw: part
			}))
			.filter((call: AnswererSearchToolCall) => call.query);
	} catch {
		return [];
	}
}

/** 把搜索结果按原协议回传，然后由调用方重新发送请求 */
export function appendSearchToolResults(
	protocol: AnswererSearchToolProtocol,
	data: any,
	calls: AnswererSearchToolCall[],
	results: string[]
) {
	if (!calls.length) return data;
	if (protocol === 'openai-chat') {
		const messages = Array.isArray(data.messages) ? data.messages.slice() : [];
		messages.push({
			role: 'assistant',
			content: null,
			tool_calls: calls.map((call) => call.raw)
		});
		calls.forEach((call, index) => {
			messages.push({
				role: 'tool',
				tool_call_id: call.id,
				content: results[index] || '搜索没有返回结果。'
			});
		});
		return { ...data, messages };
	}
	if (protocol === 'openai-responses') {
		const input = Array.isArray(data.input) ? data.input.slice() : [];
		// 使用 previous_response_id 时，服务端已经保存了上一轮输出；
		// 再回传 function_call 项会造成重复。
		if (!data.previous_response_id) {
			calls.forEach((call) => {
				if (call.raw) input.push(call.raw);
			});
		}
		calls.forEach((call, index) => {
			input.push({
				type: 'function_call_output',
				call_id: call.id,
				output: results[index] || '搜索没有返回结果。'
			});
		});
		return { ...data, input };
	}
	const contents = Array.isArray(data.contents) ? data.contents.slice() : [];
	contents.push({
		role: 'model',
		parts: calls.map((call) => ({
			functionCall: { name: ANSWERER_SEARCH_TOOL_NAME, args: { query: call.query } }
		}))
	});
	contents.push({
		role: 'user',
		parts: calls.map((call, index) => ({
			functionResponse: {
				name: ANSWERER_SEARCH_TOOL_NAME,
				response: { result: results[index] || '搜索没有返回结果。' }
			}
		}))
	});
	return { ...data, contents };
}

/** 执行一次工具搜索；失败时返回说明文本，让模型可以继续作答 */
export async function runSearchToolQuery(
	options: AnswererSearchOptions,
	provider: AnswererSearchProvider,
	query: string
): Promise<string> {
	const label = SEARCH_PROVIDER_LABELS[provider];
	const apiKey = String(options.keys?.[provider] || '').trim();
	if (!apiKey) return `搜索不可用：没有配置 ${label} 的 API Key。`;
	try {
		const maxResults = options.max_results || DEFAULT_MAX_RESULTS;
		const body =
			provider === 'exa'
				? await searchExa(query, apiKey, maxResults)
				: provider === 'tavily'
				? await searchTavily(query, apiKey, maxResults)
				: await searchDeepSeek(query, apiKey, maxResults);
		return (body || '搜索没有返回结果。').slice(0, MAX_CONTEXT_CHARS);
	} catch (error: any) {
		return `搜索失败：${error?.message || error}`.slice(0, MAX_CONTEXT_CHARS);
	}
}
