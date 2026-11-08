import type { AnswererSearchMode, AnswererSearchOptions, AnswererSearchProvider } from '@ocsjs/core';
import { readAnswererApiKeys } from './answerer-api-keys';

export interface AnswererSearchConfig {
	mode: AnswererSearchMode;
	provider: AnswererSearchProvider;
}

const STORAGE_KEY = 'ocs.answerer.search';

const DEFAULT_CONFIG: AnswererSearchConfig = {
	mode: 'off',
	provider: 'exa'
};

export function readAnswererSearchConfig(): AnswererSearchConfig {
	try {
		if (typeof localStorage === 'undefined') return { ...DEFAULT_CONFIG };
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_CONFIG };
		const parsed = JSON.parse(raw) || {};
		const mode: AnswererSearchMode = parsed.mode === 'builtin' || parsed.mode === 'custom' ? parsed.mode : 'off';
		const provider: AnswererSearchProvider =
			parsed.provider === 'tavily' || parsed.provider === 'deepseek' ? parsed.provider : 'exa';
		return { mode, provider };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

export function saveAnswererSearchConfig(patch: Partial<AnswererSearchConfig>) {
	try {
		if (typeof localStorage === 'undefined') return;
		const next = { ...readAnswererSearchConfig(), ...patch };
		localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
	} catch {
		// 隐私模式 / 存储不可用时静默失败
	}
}

/** 注入 buildAnswererEnv 的搜索配置（密钥嵌套存放，避免顶层占位符误用） */
export function getAnswererSearchOptions(): AnswererSearchOptions {
	const config = readAnswererSearchConfig();
	const keys = readAnswererApiKeys();
	return {
		mode: config.mode,
		provider: config.provider,
		max_results: 5,
		keys: {
			exa: keys.exa,
			tavily: keys.tavily,
			deepseek: keys.deepseek
		}
	};
}
