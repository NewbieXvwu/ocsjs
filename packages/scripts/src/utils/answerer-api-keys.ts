/**
 * 多模态题库 / 搜索增强 API 密钥的本地存放处。
 *
 * 设计目的：
 * - 密钥不写入题库配置（避免用户分享/导出题库配置时泄露，也避免提交到上游默认配置）。
 * - 仅保存在当前浏览器的 localStorage 中，由用户在「题库配置」弹窗里填写。
 * - 题库配置可通过 `${openaiApiKey}` 等占位符引用，
 *   例如 headers: { "Authorization": "Bearer ${openaiApiKey}" }。
 */
export type AnswererApiKeyKind = 'openai' | 'gemini' | 'opencodeGo' | 'deepseek' | 'exa' | 'tavily';

const STORAGE_KEY = 'ocs.answerer.apiKeys';

const EMPTY_KEYS: Record<AnswererApiKeyKind, string> = {
	openai: '',
	gemini: '',
	opencodeGo: '',
	deepseek: '',
	exa: '',
	tavily: ''
};

function readAll(): Record<AnswererApiKeyKind, string> {
	try {
		if (typeof localStorage === 'undefined') return { ...EMPTY_KEYS };
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...EMPTY_KEYS };
		const parsed = JSON.parse(raw) || {};
		const result = { ...EMPTY_KEYS };
		(Object.keys(EMPTY_KEYS) as AnswererApiKeyKind[]).forEach((kind) => {
			result[kind] = typeof parsed[kind] === 'string' ? parsed[kind] : '';
		});
		return result;
	} catch {
		return { ...EMPTY_KEYS };
	}
}

export function readAnswererApiKeys() {
	return readAll();
}

export function readAnswererApiKey(kind: AnswererApiKeyKind) {
	return readAll()[kind];
}

export function saveAnswererApiKey(kind: AnswererApiKeyKind, value: string) {
	try {
		if (typeof localStorage === 'undefined') return;
		const all = readAll();
		all[kind] = String(value || '');
		localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
	} catch {
		// 隐私模式/存储配额不足时静默失败：密钥字段不是答题的必需功能
	}
}

/** 注入 buildAnswererEnv 的占位符字段 */
export function getAnswererApiKeyEnv() {
	const keys = readAll();
	return {
		openaiApiKey: keys.openai,
		geminiApiKey: keys.gemini,
		opencodeGoApiKey: keys.opencodeGo,
		deepseekApiKey: keys.deepseek,
		exaApiKey: keys.exa,
		tavilyApiKey: keys.tavily
	};
}
