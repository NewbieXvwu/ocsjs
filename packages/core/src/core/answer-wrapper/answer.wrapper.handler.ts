import { AnswererWrapper, SearchInformation, Result } from './interface';
import { request } from '../utils/request';
import { $ } from '../../utils';

export const AnswerWrapperHandlerConfig = {
	// 超时时间，单位毫秒
	timeout_seconds: 60
};

/**
 * 旧版 OCS OpenAI 请求体只有一段 input_text + 若干 input_image。
 * 当题库仍使用这种结构时，把它升级为按题目顺序排列的 rich_content，
 * 其他服务商的请求结构保持原样，已保存的用户配置不会被覆盖。
 */
export function upgradeLegacyOpenAIMediaRequest(endpoint: string, data: any, env: any) {
	if (
		!/(?:^|\/)responses(?:\?.*)?$/i.test(endpoint || '') ||
		!Array.isArray(env.rich_content) ||
		!Array.isArray(env.images)
	) {
		return data;
	}
	const input = data && data.input;
	if (!Array.isArray(input) || !input.length || !Array.isArray(input[0].content)) return data;
	const blocks = input[0].content;
	if (
		blocks.length !== env.images.length + 1 ||
		blocks[0].type !== 'input_text' ||
		!blocks
			.slice(1)
			.every((block: any, index: number) => block.type === 'input_image' && block.image_url === env.images[index])
	) {
		return data;
	}
	const title = env.suggestion_title || env.title;
	const startOfQuestion = blocks[0].text.indexOf('问题：' + title);
	if (startOfQuestion < 0) return data;
	const intro = blocks[0].text.slice(0, startOfQuestion);
	const first = {
		...input[0],
		content: [...(intro ? [{ type: 'input_text', text: intro }] : []), ...env.rich_content]
	};
	return { ...data, input: [first, ...input.slice(1)] };
}

/** 官方 OpenAI Responses 接口 */
export function isOfficialOpenAIResponses(url: string) {
	return /^https:\/\/api\.openai\.com\/v1\/responses(?:\?|$)/i.test(String(url || ''));
}

/** Gemini 原生 generateContent 接口 */
export function isGeminiNativeEndpoint(url: string) {
	return /\/v1beta\/models\/[^/?]+:generateContent(?:\?|$)/i.test(String(url || ''));
}

/** 是否会返回图像引用依据的接口 */
export function isImageEvidenceEndpoint(url: string) {
	return isOfficialOpenAIResponses(url) || isGeminiNativeEndpoint(url);
}

/**
 * OpenAI Responses 与 Gemini 原生接口都把回答放在 JSON 里，但位置不同。
 * 图像依据校验和解析器只需要文本。
 */
export function readAnswererResponseText(endpoint: string, response: any): string {
	if (!response || typeof response !== 'object') return '';
	if (isGeminiNativeEndpoint(endpoint)) {
		const candidate = Array.isArray(response.candidates) ? response.candidates[0] : null;
		const parts = candidate && candidate.content && candidate.content.parts;
		return Array.isArray(parts)
			? parts.map((p: any) => (p && typeof p.text === 'string' ? p.text : '')).join('\n')
			: '';
	}
	const outputs = Array.isArray(response.output) ? response.output : [];
	const content = outputs
		.filter((o: any) => o.type === 'message')
		.flatMap((m: any) => (Array.isArray(m.content) ? m.content : []));
	return typeof response.output_text === 'string' && response.output_text
		? response.output_text
		: content
				.filter((c: any) => c.type === 'output_text')
				.map((c: any) => c.text)
				.join('\n');
}

/**
 * 旧版保存的 OpenAI 题库可能没有要求模型返回图像引用信息。
 * 仅当用户仍使用官方 Responses 接口、且 schema 仍是 OCS 的选择题结构时，
 * 在发往模型的指令中补充说明，不修改用户本地保存的配置。
 */
export function upgradeSavedChoiceInstructions(endpoint: string, data: any, env: any) {
	if (
		!env ||
		!env.images ||
		!env.images.length ||
		!env.choice_ids ||
		!env.choice_ids.length ||
		!isOfficialOpenAIResponses(endpoint)
	) {
		return data;
	}
	const input = data && data.input;
	if (!Array.isArray(input)) return data;
	let changed = false;
	const guidance =
		'选择题请按唯一选项代号作答。若为图片题，请在 used_image_ids 中逐项列出用于判断的图像ID（例如 Q-1、A-1），图片对应关系以图像前的ID和所属选项边界为准。如有任何图无法对应或看不清，设置 ambiguous=true；否则 false。只引用实际存在的图像ID，勿臆造。';
	const mappedInput = input.map((message: any) => {
		if (message.role !== 'user' || !Array.isArray(message.content)) return message;
		const blocks = message.content;
		const first = blocks.findIndex((block: any) => block.type === 'input_text' && typeof block.text === 'string');
		if (first < 0 || /used_image_ids/.test(blocks[first].text)) return message;
		const updated = blocks.slice();
		updated[first] = { ...blocks[first], text: guidance + '\n' + blocks[first].text };
		changed = true;
		return { ...message, content: updated };
	});
	const result = changed ? { ...data, input: mappedInput } : data;
	const format = result && result.text && result.text.format;
	const schema = format && format.schema;
	if (
		!format ||
		format.name !== 'ocs_quiz_response' ||
		!schema ||
		schema.type !== 'object' ||
		!schema.properties ||
		!schema.properties.answers
	) {
		return result;
	}
	const original = schema.properties;
	const originalDescription = original.answers && original.answers.items && original.answers.items.description;
	const answers =
		typeof originalDescription === 'string' && /正确选项的完整文本/.test(originalDescription)
			? {
					...original.answers,
					items: {
						...original.answers.items,
						description: '选择题答案数组必须写选项代号（如 A、C），图片选项同样如此；填空题写文字。'
					}
			  }
			: original.answers;
	const properties = {
		...original,
		answers,
		used_image_ids: {
			type: 'array',
			items: { type: 'string' },
			description: '实际用于识别并判断本题的图片ID，例如 Q-1、A-1。无图片时返回空数组。不能编造。'
		},
		ambiguous: { type: 'boolean', description: '任一必要图片模糊、归属不明、不能确定答案时为 true。' }
	};
	const required = [...new Set([...(schema.required || Object.keys(original)), 'used_image_ids', 'ambiguous'])];
	return {
		...result,
		text: {
			...result.text,
			format: { ...format, schema: { ...schema, properties, required } }
		}
	};
}

/** 从原始响应中读取模型输出的图像引用依据 */
export function readAnswererImageEvidence(endpoint: string, response: any) {
	try {
		const raw = readAnswererResponseText(endpoint, response);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return null;
		const ids = parsed.used_image_ids;
		const answers = parsed.answers;
		return {
			complete:
				Array.isArray(ids) &&
				ids.every((i: any) => typeof i === 'string') &&
				typeof parsed.ambiguous === 'boolean' &&
				Array.isArray(answers),
			ids: Array.isArray(ids) ? ids : [],
			ambiguous: parsed.ambiguous,
			answers: Array.isArray(answers) ? answers.map((v: any) => String(v).trim()) : []
		};
	} catch {
		return null;
	}
}

/** 校验 OpenAI 请求体确实携带了全部图片，避免发送“缺图”的题目 */
export function assertOpenAIImagesDelivered(endpoint: string, data: any, env: any) {
	if (!env || !env.images || !env.images.length || !isOfficialOpenAIResponses(endpoint)) return;
	const content = Array.isArray(data && data.input)
		? data.input.flatMap((message: any) => (Array.isArray(message.content) ? message.content : []))
		: [];
	const images = content
		.filter((block: any) => block && block.type === 'input_image')
		.map((block: any) => block.image_url);
	if (images.length !== env.images.length || images.some((image: any, i: number) => image !== env.images[i])) {
		throw new Error(`OpenAI 图片请求不完整：应有 ${env.images.length} 张，实际 ${images.length} 张。已停止答题。`);
	}
}

function dataUrlBase64(dataUrl: string) {
	const comma = String(dataUrl || '').indexOf(',');
	return comma < 0 ? '' : String(dataUrl).slice(comma + 1);
}

/** 校验 Gemini 请求体确实携带了全部图片 */
export function assertGeminiImagesDelivered(endpoint: string, data: any, env: any) {
	if (!env || !env.images || !env.images.length || !isGeminiNativeEndpoint(endpoint)) return;
	const parts = Array.isArray(data && data.contents)
		? data.contents.flatMap((content: any) => (Array.isArray(content.parts) ? content.parts : []))
		: [];
	const images = parts.filter((part: any) => part && part.inlineData).map((part: any) => part.inlineData.data);
	if (
		images.length !== env.images.length ||
		images.some((payload: any, i: number) => payload !== dataUrlBase64(env.images[i]))
	) {
		throw new Error(`Gemini 图片请求不完整：应有 ${env.images.length} 张，实际 ${images.length} 张。已停止答题。`);
	}
}

/**
 *
 * 默认题库配置解析器
 *
 * @example
 *
 * ```js
 *
 * // 假设有一个接口 : https://example.com/search?title=1+2,2+3
 * // 此接口返回 {code: 1, data: { answers: [3 , 5] , title:'1+2' }, msg:'成功'}
 *
 * defaultAnswerWrapperHandler({
 *      titleElements: Array.from(document.querySelector('.title'))
 * },
 * [
 *  // 可以有多个构造器，最终通过 answerPath 一起合并到一个列表并返回
 *  {
 *      url: 'https://example.com/search',
 *      method: 'get',
 *      answerPath: 'data.answers',
 *      data:{
 *          title: 'titleElements[0]' // 1+2,2+3
 *      }
 *  }
 * ]) // [3 , 5]
 *
 *
 * ```
 *
 * @param elements 题目元素
 * @param answererWrappers 题库配置器数组
 * @returns
 */
export async function defaultAnswerWrapperHandler(
	answererWrappers: AnswererWrapper[],
	// 上下文解析环境
	env: {
		title?: string;
		options?: string;
		type?: string;
		/**
		 * 图片题优化：base64 图片数组（顺序对应 [图片1]、[图片2]…）。
		 * 仅在开启图片题优化且题目/选项含图片时由 buildAnswererEnv 注入。
		 */
		images?: string[];
		/**
		 * 图片题优化：原题标题中图片 URL 替换为 [图片N] 占位符后的文本。
		 * 未注入时默认为空字符串。
		 */
		suggestion_title?: string;
		/**
		 * 图片题优化：原选项中图片 URL 替换为 [图片N] 占位符后的文本。
		 * 未注入时默认为空字符串。
		 */
		suggestion_options?: string;
		[x: string]: any;
	}
): Promise<SearchInformation[]> {
	const searchInfos: SearchInformation[] = [];
	const temp: AnswererWrapper[] = JSON.parse(JSON.stringify(answererWrappers));
	if (temp.length === 0) {
		throw new Error('题库配置不能为空，请配置后重新开始自动答题。');
	}

	// 上下文环境字段默认值：防止题库配置中 ${title} / ${options} / ${type} /
	// ${images} / ${suggestion_title} / ${suggestion_options} 等占位符因字段缺失
	// 被替换为 'undefined' 字面量。
	if (env.title === undefined) env.title = '';
	if (env.options === undefined) env.options = '';
	if (env.type === undefined) env.type = 'unknown';
	if (env.images === undefined) env.images = [];
	if (env.suggestion_title === undefined) env.suggestion_title = '';
	if (env.suggestion_options === undefined) env.suggestion_options = '';
	// 多线程请求
	await Promise.all(
		temp.map(async (wrapper) => {
			// 解构数据，并赋初始值
			const {
				name = '未知题库',
				homepage = '#',
				method = 'get',
				type = 'fetch',
				contentType = 'json',
				responseType = 'json',
				headers = {},
				data: wrapperData = {},
				handler = 'return (res)=> [JSON.stringify(res), undefined]'
			} = wrapper;
			// POST 请求若未显式提供 Content-Type，默认按 JSON 提交
			if (method.toLocaleLowerCase() === 'post') {
				if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
					headers['Content-Type'] = 'application/json';
				}
			}
			try {
				// 答案列表
				let results: Result[] = [];
				// 请求数据
				let requestData;
				// 请求地址
				let url: URL;
				if (method.toLocaleLowerCase() === 'get') {
					url = new URL(resolvePlaceHolder(wrapper.url, { encodeURI: true }));
					/**
					 * 如果 data 存在数据并且 method 为 get，则将 data 数据拼接到 url 上，覆盖原有的  url 同名参数
					 * data 参数的优先级高于 url 参数
					 */
					Object.keys(wrapperData).forEach((key) => {
						// searchParams.set 方法会自动编码，所以不需要 encodeURI: true
						url.searchParams.set(key, resolvePlaceHolder(wrapperData[key]));
					});
					// get 的请求数据为空
					requestData = {};
				} else if (method.toLocaleLowerCase() === 'post') {
					url = new URL(wrapper.url);
					// 构造请求数据
					const data: Record<string, string> = Object.create({});
					/** 构造一个请求数据 */
					Object.keys(wrapperData).forEach((key) => {
						// 如果存在字段解析器
						if (typeof (wrapperData as any)[key] === 'object' && Reflect.has((wrapperData as any)[key], 'handler')) {
							// eslint-disable-next-line no-new-func
							const handler = Function(Reflect.get((wrapperData as any)[key], 'handler'))();
							if (typeof handler !== 'function') {
								throw new Error('data 字段解析器必须返回一个函数');
							}
							const result = handler(env);
							Reflect.set(data, key, result);
						} else {
							// 解析data数据
							Reflect.set(data, key, resolvePlaceHolder(wrapperData[key]));
						}
					});

					requestData = data;
					requestData = upgradeLegacyOpenAIMediaRequest(wrapper.url, requestData, env);
					requestData = upgradeSavedChoiceInstructions(wrapper.url, requestData, env);
					assertOpenAIImagesDelivered(wrapper.url, requestData, env);
					assertGeminiImagesDelivered(wrapper.url, requestData, env);
				} else {
					throw new Error('不支持的请求方式');
				}

				// 发送请求
				const responseData = await Promise.race([
					request(url.toString(), {
						method,
						// contentType: 历史遗留的命名问题
						responseType: responseType || contentType,
						data: requestData,
						type,
						// 请求头同样支持 ${openaiApiKey} / ${geminiApiKey} 等占位符，
						// 避免用户把密钥直接写进题库配置（配置可能被导出或分享）。
						headers: resolvePlaceHolder(JSON.parse(JSON.stringify(headers || {})))
					}),
					$.sleep((AnswerWrapperHandlerConfig.timeout_seconds ?? 60) * 1000)
				]);
				if (responseData === undefined) {
					throw new Error('题库请求超时，可能是题库问题，或者请检查网络或者重试。');
				}

				/** 从 handler 获取搜索到的题目和回答 */

				// eslint-disable-next-line no-new-func
				const responseHandler = Function(handler)();
				if (typeof responseHandler !== 'function') {
					throw new Error('handler 响应处理器必须返回一个函数');
				}
				const info = responseHandler(responseData);
				if (info && Array.isArray(info)) {
					/** 如果返回一个二维数组 */
					if (info.every((item: any) => Array.isArray(item))) {
						results = results.concat(
							info.map((item: any) => ({
								question: item[0],
								answer: item[1],
								extra_data: item[2] || {}
							}))
						);
					} else {
						results.push({
							question: info[0],
							answer: info[1],
							extra_data: info[2] || {}
						});
					}
				}

				// 图片题：把原始响应中的图像引用依据挂到每条结果上，
				// 供 question.resolver 在真正点击选项前做一致性校验。
				if (env.image_ids && env.image_ids.length && isImageEvidenceEndpoint(wrapper.url)) {
					const evidence = readAnswererImageEvidence(wrapper.url, responseData);
					for (const res of results) {
						res.extra_data = { ...(res.extra_data || {}), image_evidence: evidence };
					}
				}

				searchInfos.push({
					url: wrapper.url,
					name,
					homepage,
					results,
					response: responseData,
					data: requestData
				});
			} catch (error) {
				console.error(error);
				searchInfos.push({
					url: wrapper.url,
					name,
					homepage,
					results: [],
					response: undefined,
					data: undefined,
					error: (error as any)?.message || '题库连接失败'
				});
			}
		})
	);

	// 替换占位符
	function resolvePlaceHolder(data: any, options?: { encodeURI?: boolean }) {
		if (typeof data === 'string') {
			const matches = data.match(/\${(.*?)}/g) || [];
			matches.forEach((placeHolder) => {
				/** 获取占位符的值 */
				const value: any = env[placeHolder.replace(/\${(.*)}/, '$1')];
				data = data.replace(placeHolder, options?.encodeURI ? encodeURIComponent(value) : value);
			});
		} else if (data !== null && typeof data === 'object') {
			// 递归替换
			const keys = Object.keys(data);
			for (const key of keys) {
				data[key] = resolvePlaceHolder(data[key], options);
			}
		}
		return data;
	}

	return searchInfos;
}
