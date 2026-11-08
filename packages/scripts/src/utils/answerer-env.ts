/* global GM_xmlhttpRequest */
import type { AnswererWrapper, QuestionIR } from '@ocsjs/core';
import { getImageSize, upscalePngDataUrl } from './png-upscaler';
import { IMAGE_URL_REGEX, canonicalImageUrl, imageUrlMatches } from './image-url';
import { normalizedQuestionBox, questionImageManifestText, questionImageSpatialRelations } from './question-ir';
import { getAnswererApiKeyEnv } from './answerer-api-keys';

export { IMAGE_URL_REGEX, canonicalImageUrl, imageUrlMatches };

export interface ImageSuggestionResult {
	/** base64 图片数组，顺序对应 [图片1]、[图片2]… */
	images: string[];
	/** 与 images 严格同序的图片原始 URL（[图片N] 还原的单一数据源，已跳过转换失败项） */
	urls: string[];
	/** 原题标题中图片 URL 替换为 [图片N] 占位符后的文本（不含 base64） */
	suggestion_title: string;
	/** 原选项中图片 URL 替换为 [图片N] 占位符后的文本（不含 base64），无图片时为 undefined */
	suggestion_options?: string;
}

/** 是否运行在 Node 环境（非浏览器 / 非油猴脚本） */
function isNodeEnv(): boolean {
	return (
		typeof process !== 'undefined' &&
		!!(process as any).versions?.node &&
		(globalThis as any).GM_xmlhttpRequest === undefined
	);
}

/** Node 下用 node-fetch 拉取图片并转为 data URL（base64） */
async function nodeFetchToBase64(url: string): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-var-requires
	const fet: typeof fetch = require('node-fetch').default || require('node-fetch');
	// 携带 Referer / User-Agent 绕过防盗链（如 chaoxing 403）
	let referer = '';
	try {
		referer = new URL(url).origin + '/';
	} catch {
		// 非 URL，忽略
	}
	const res = await fet(url, {
		headers: {
			Referer: referer,
			'User-Agent':
				'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
		}
	});
	if (!res.ok) {
		throw new Error(`图片下载失败 ${res.status}`);
	}
	// node-fetch v2 支持 .buffer()
	const buffer = (res as any).buffer ? (res as any).buffer() : res.arrayBuffer();
	const buf: Buffer = buffer instanceof Promise ? await buffer : buffer;
	const contentType = res.headers.get('content-type') || 'image/png';
	return `data:${contentType};base64,${buf.toString('base64')}`;
}

/** 单题图片传输限制（多模态题库） */
const QUESTION_MEDIA = Object.freeze({
	timeoutMs: 15_000,
	maxImageBytes: 20 * 1024 * 1024,
	maxTotalBytes: 40 * 1024 * 1024,
	maxImages: 32,
	concurrency: 3
});

/** 仅共享进行中的下载，避免课程复用 URL 时拿到过期像素 */
const QUESTION_IMAGE_PENDING = new Map<string, Promise<string>>();

/** 通过文件头识别真实图片类型，绝不根据 URL 或响应头猜测 */
function mimeFromImageBytes(bytes: Uint8Array): string {
	if (
		bytes.length >= 24 &&
		bytes[0] === 137 &&
		bytes[1] === 80 &&
		bytes[2] === 78 &&
		bytes[3] === 71 &&
		bytes[4] === 13 &&
		bytes[5] === 10 &&
		bytes[6] === 26 &&
		bytes[7] === 10
	)
		return 'image/png';
	if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
	if (
		bytes.length >= 12 &&
		String.fromCharCode(...Array.from(bytes.subarray(0, 4))) === 'RIFF' &&
		String.fromCharCode(...Array.from(bytes.subarray(8, 12))) === 'WEBP'
	)
		return 'image/webp';
	if (
		bytes.length >= 10 &&
		(String.fromCharCode(...Array.from(bytes.subarray(0, 6))) === 'GIF87a' ||
			String.fromCharCode(...Array.from(bytes.subarray(0, 6))) === 'GIF89a')
	)
		return 'image/gif';
	if (bytes.length >= 26 && bytes[0] === 66 && bytes[1] === 77) return 'image/bmp';
	if (bytes.length >= 5) {
		const start = new TextDecoder('utf-8')
			.decode(bytes.subarray(0, Math.min(2048, bytes.length)))
			.replace(/^\uFEFF/, '')
			.trimStart();
		if (/^(?:<\?xml\b[\s\S]*?\?>\s*)?<svg[\s>]/i.test(start)) return 'image/svg+xml';
	}
	return '';
}

const DATA_IMAGE_PREFIX = /^data:([^,]*?),(.*)$/is;

function imageBytesToDataUrl(bytes: Uint8Array, mime: string): string {
	let bin = '';
	for (let at = 0; at < bytes.length; at += 32768) {
		bin += String.fromCharCode(...Array.from(bytes.subarray(at, at + 32768)));
	}
	return `data:${mime};base64,${btoa(bin)}`;
}

function dataUrlToImageBytes(url: string): Uint8Array {
	const parsed = DATA_IMAGE_PREFIX.exec(url);
	if (!parsed) throw new Error('图片数据地址格式错误');
	const [, meta, payload] = parsed;
	if (payload.length > QUESTION_MEDIA.maxImageBytes * 2.8) throw new Error('图片数据过大');
	if (/;base64(?:;|$)/i.test(meta)) {
		const clean = payload.replace(/\s+/g, '');
		if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) {
			throw new Error('图片 Base64 格式损坏');
		}
		const decoded = atob(clean);
		const bytes = new Uint8Array(decoded.length);
		for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
		return bytes;
	}
	// SVG data URI 常见 percent-encoding，而非 base64。
	return new TextEncoder().encode(decodeURIComponent(payload));
}

async function rasterizeImage(bytes: Uint8Array, mime: string): Promise<string> {
	if (typeof document === 'undefined' || typeof Image === 'undefined') {
		throw new Error('当前环境无法转换 SVG/BMP 图片');
	}
	const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('图片解码超时')), QUESTION_MEDIA.timeoutMs);
			img.onload = () => {
				clearTimeout(timer);
				resolve();
			};
			img.onerror = () => {
				clearTimeout(timer);
				reject(new Error('浏览器无法解码此图片'));
			};
			img.src = objectUrl;
		});
		const width = img.naturalWidth || img.width;
		const height = img.naturalHeight || img.height;
		if (!width || !height || width * height > 40_000_000) throw new Error('图片尺寸无效或过大');
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas 初始化失败');
		ctx.drawImage(img, 0, 0);
		return canvas.toDataURL('image/png');
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

async function validateImageDecode(bytes: Uint8Array, mime: string): Promise<void> {
	// 浏览器解码可捕获“文件头有效但内容截断”的 JPEG/PNG/WebP。
	if (typeof Image === 'undefined' || typeof document === 'undefined') return;
	const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
	try {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('图片解码校验超时')), QUESTION_MEDIA.timeoutMs);
			img.onload = () => {
				clearTimeout(timer);
				resolve();
			};
			img.onerror = () => {
				clearTimeout(timer);
				reject(new Error('文件头有效，但图片内容损坏'));
			};
			img.src = objectUrl;
		});
		if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片尺寸无效');
	} finally {
		URL.revokeObjectURL(objectUrl);
	}
}

async function normalizeImageBytes(input: Uint8Array | ArrayBuffer): Promise<string> {
	const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
	if (bytes.length === 0) throw new Error('图片内容为空');
	if (bytes.length > QUESTION_MEDIA.maxImageBytes) throw new Error('图片超过 20 MiB，未发送给模型');
	const mime = mimeFromImageBytes(bytes);
	if (!mime) throw new Error('返回内容不是受支持的图片（可能是登录页或错误页）');
	if (mime === 'image/svg+xml' || mime === 'image/bmp') return rasterizeImage(bytes, mime);
	// GIF 转 PNG，保证模型拿到稳定的首帧。
	if (mime === 'image/gif' && typeof document !== 'undefined') return rasterizeImage(bytes, mime);
	await validateImageDecode(bytes, mime);
	return imageBytesToDataUrl(bytes, mime);
}

function gmReadImageBytes(url: string): Promise<Uint8Array> {
	if (typeof GM_xmlhttpRequest !== 'function') {
		return Promise.reject(new Error('脚本管理器未提供跨域图片下载能力'));
	}
	return new Promise((resolve, reject) => {
		let finished = false;
		let req: any;
		const settle = (error: Error | null, value?: Uint8Array) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			error ? reject(error) : resolve(value!);
		};
		const timer = setTimeout(() => {
			try {
				req && req.abort && req.abort();
			} catch {
				/* ignored */
			}
			settle(new Error('图片下载超时'));
		}, QUESTION_MEDIA.timeoutMs + 250);
		try {
			req = GM_xmlhttpRequest({
				method: 'GET',
				url,
				responseType: 'arraybuffer',
				timeout: QUESTION_MEDIA.timeoutMs,
				onload: async (response: any) => {
					try {
						if (response.status < 200 || response.status >= 300) {
							throw new Error(`HTTP ${response.status}`);
						}
						let raw = response.response;
						if (typeof Blob !== 'undefined' && raw instanceof Blob) raw = await raw.arrayBuffer();
						const isArrayBuffer = Object.prototype.toString.call(raw) === '[object ArrayBuffer]';
						if (!isArrayBuffer && !ArrayBuffer.isView(raw)) {
							throw new Error('请求没有返回二进制图片数据');
						}
						settle(
							null,
							ArrayBuffer.isView(raw)
								? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
								: new Uint8Array(raw as ArrayBuffer)
						);
					} catch (e: any) {
						settle(e);
					}
				},
				onerror: () => settle(new Error('图片下载网络错误')),
				ontimeout: () => settle(new Error('图片下载超时')),
				onabort: () => settle(new Error('图片下载被终止'))
			});
		} catch (e: any) {
			settle(e);
		}
	});
}

async function fetchReadImageBytes(url: string): Promise<Uint8Array> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), QUESTION_MEDIA.timeoutMs);
	try {
		const response = await fetch(url, { credentials: 'include', signal: controller.signal });
		if (!response.ok) throw new Error(`HTTP ${response.status}`);
		const len = Number(response.headers.get('content-length') || 0);
		if (len > QUESTION_MEDIA.maxImageBytes) throw new Error('图片超过 20 MiB');
		return new Uint8Array(await response.arrayBuffer());
	} finally {
		clearTimeout(timer);
	}
}

async function canvasReadImage(url: string): Promise<string> {
	if (typeof Image === 'undefined') throw new Error('无可用图像解码器');
	const image = new Image();
	image.crossOrigin = 'anonymous';
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('图片解码超时')), QUESTION_MEDIA.timeoutMs);
		image.onload = () => {
			clearTimeout(timer);
			resolve();
		};
		image.onerror = () => {
			clearTimeout(timer);
			reject(new Error('图片无法载入'));
		};
		image.src = url;
	});
	const width = image.naturalWidth || image.width;
	const height = image.naturalHeight || image.height;
	if (!width || !height || width * height > 40_000_000) throw new Error('图片尺寸无效或过大');
	const canvas = document.createElement('canvas');
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Canvas 不可用');
	ctx.drawImage(image, 0, 0, width, height);
	const result = canvas.toDataURL('image/png');
	// 某些运行时即使图片损坏，Canvas 仍会产出 data URL。
	return normalizeImageBytes(dataUrlToImageBytes(result));
}

async function downloadImageDataUrl(rawUrl: string): Promise<string> {
	const url = canonicalImageUrl(rawUrl);
	if (!url) throw new Error('图片地址无效');
	if (url.startsWith('data:')) return normalizeImageBytes(dataUrlToImageBytes(url));
	if (url.startsWith('blob:')) return normalizeImageBytes(await fetchReadImageBytes(url));
	if (isNodeEnv()) {
		return normalizeImageBytes(dataUrlToImageBytes(await nodeFetchToBase64(url)));
	}
	let firstError: Error | undefined;
	try {
		// 同源 fetch 保留课程登录 Cookie；跨域由 GM 分支处理。
		if (typeof location !== 'undefined' && new URL(url).origin === location.origin) {
			return await normalizeImageBytes(await fetchReadImageBytes(url));
		}
	} catch (e: any) {
		firstError = e;
	}
	try {
		return await normalizeImageBytes(await gmReadImageBytes(url));
	} catch (e: any) {
		firstError = firstError || e;
	}
	try {
		return await canvasReadImage(url);
	} catch (e: any) {
		throw new Error(`${firstError ? firstError.message + '；' : ''}${e.message}`);
	}
}

/** 图片最小边长阈值：低于此值的图片会被题库/模型（如豆包 14px）拒绝，需放大后再提交 */
const MIN_IMAGE_DIMENSION = 14;

const IMAGE_BASE64_CACHE_MAX = 200;
const imageBase64Cache = new Map<string, string>();

/** 读取任意格式图片的尺寸（浏览器解码） */
async function decodedImageSize(dataUrl: string): Promise<{ width: number; height: number } | undefined> {
	if (typeof Image === 'undefined' || typeof document === 'undefined') return undefined;
	return new Promise((resolve) => {
		const img = new Image();
		const timer = setTimeout(() => resolve(undefined), QUESTION_MEDIA.timeoutMs);
		img.onload = () => {
			clearTimeout(timer);
			resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
		};
		img.onerror = () => {
			clearTimeout(timer);
			resolve(undefined);
		};
		img.src = dataUrl;
	});
}

/** 小图放大：仅 PNG 可直接放大，其他格式先转为 PNG */
async function prepareImageForAnswerer(dataUrl: string): Promise<string> {
	try {
		const pngSize = getImageSize(dataUrl);
		if (pngSize) {
			if (pngSize.width < MIN_IMAGE_DIMENSION || pngSize.height < MIN_IMAGE_DIMENSION) {
				return await upscalePngDataUrl(dataUrl, MIN_IMAGE_DIMENSION);
			}
			return dataUrl;
		}
		const size = await decodedImageSize(dataUrl);
		if (size && (size.width < MIN_IMAGE_DIMENSION || size.height < MIN_IMAGE_DIMENSION)) {
			if (typeof document === 'undefined') return dataUrl;
			const img = new Image();
			await new Promise<void>((resolve, reject) => {
				img.onload = () => resolve();
				img.onerror = () => reject(new Error('图片无法解码'));
				img.src = dataUrl;
			});
			const canvas = document.createElement('canvas');
			canvas.width = img.naturalWidth || img.width;
			canvas.height = img.naturalHeight || img.height;
			const ctx = canvas.getContext('2d');
			if (!ctx) return dataUrl;
			ctx.drawImage(img, 0, 0);
			return await upscalePngDataUrl(canvas.toDataURL('image/png'), MIN_IMAGE_DIMENSION);
		}
	} catch {
		/* 放大失败时按原图提交 */
	}
	return dataUrl;
}

/**
 * 将图片转换为 base64 data URL。
 * 会话级 LRU 缓存避免同一试卷/重试时重复下载；同 URL 的并发请求共享一次下载。
 */
export async function imageToBase64(source: string | HTMLImageElement): Promise<string> {
	const raw = typeof source === 'string' ? source : source && (source.currentSrc || source.src);
	const url = canonicalImageUrl(raw);
	if (!url) throw new Error('缺少有效图片地址');
	if (url.startsWith('data:')) return prepareImageForAnswerer(await normalizeImageBytes(dataUrlToImageBytes(url)));

	const cached = imageBase64Cache.get(url);
	if (cached) {
		imageBase64Cache.delete(url);
		imageBase64Cache.set(url, cached);
		return cached;
	}
	const pending = QUESTION_IMAGE_PENDING.get(url);
	if (pending) return pending;
	const task = downloadImageDataUrl(url)
		.then(prepareImageForAnswerer)
		.then((dataUrl) => {
			if (imageBase64Cache.size >= IMAGE_BASE64_CACHE_MAX) {
				imageBase64Cache.delete(imageBase64Cache.keys().next().value!);
			}
			imageBase64Cache.set(url, dataUrl);
			return dataUrl;
		})
		.finally(() => {
			if (QUESTION_IMAGE_PENDING.get(url) === task) QUESTION_IMAGE_PENDING.delete(url);
		});
	QUESTION_IMAGE_PENDING.set(url, task);
	return task;
}

export async function createImageSuggestion(
	title: string,
	options?: string,
	/** DOM 调用方可直接传入按文档顺序的标题图片 URL，跳过正则提取 */
	titleImages?: string[],
	/** DOM 调用方可直接传入按文档顺序的选项图片 URL，跳过正则提取 */
	optionImages?: string[]
): Promise<ImageSuggestionResult | undefined> {
	const titleUrls = titleImages && titleImages.length ? titleImages.slice() : imageUrlMatches(title);
	const optionUrls = optionImages && optionImages.length ? optionImages.slice() : imageUrlMatches(options || '');

	if (titleUrls.length === 0 && optionUrls.length === 0) return undefined;

	const allUrls: string[] = [];
	const seen = new Set<string>();
	for (const url of [...titleUrls, ...optionUrls]) {
		const normalized = canonicalImageUrl(url);
		if (normalized && !seen.has(normalized)) {
			seen.add(normalized);
			allUrls.push(normalized);
		}
	}

	const base64Map = new Map<string, string>();
	await Promise.all(
		allUrls.map(async (url) => {
			try {
				base64Map.set(url, await imageToBase64(url));
			} catch {
				// 转换失败的图片跳过
			}
		})
	);

	if (base64Map.size === 0) return undefined;

	const images: string[] = [];
	const urls: string[] = [];
	const placeholderMap = new Map<string, string>();
	for (const url of allUrls) {
		const base64 = base64Map.get(url);
		if (!base64) continue;
		try {
			// imageToBase64 已完成格式校验与 14px 放大，这里直接使用，避免重复解码。
			images.push(base64);
			urls.push(url);
			placeholderMap.set(url, ` [图片${images.length}] `);
		} catch (e: any) {
			console.warn(`[imageOptimize] 图片处理失败，已跳过：${url}（${e?.message}）`);
		}
	}

	if (images.length === 0) return undefined;

	let suggestionTitle = title;
	for (const [url, placeholder] of placeholderMap) {
		suggestionTitle = suggestionTitle.split(url).join(placeholder);
	}

	let suggestionOptions: string | undefined;
	if (options) {
		const hasOptionImages = optionUrls.some((url) => base64Map.has(canonicalImageUrl(url)));
		if (hasOptionImages) {
			suggestionOptions = options;
			for (const [url, placeholder] of placeholderMap) {
				suggestionOptions = suggestionOptions!.split(url).join(placeholder);
			}
		}
	}

	return {
		images,
		urls,
		suggestion_title: suggestionTitle,
		...(suggestionOptions !== undefined ? { suggestion_options: suggestionOptions } : {})
	};
}

/** 按行去重字符串，保持首次出现的顺序 */
function dedupeLines(str: string): string {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const line of str.split('\n')) {
		if (!seen.has(line)) {
			seen.add(line);
			result.push(line);
		}
	}
	return result.join('\n');
}

interface LegacyAnswererEnvParams {
	type?: string;
	title: string;
	/** 选项文本，支持字符串或字符串数组（数组会按行拼接为字符串） */
	options?: string | string[];
	/** DOM 调用方传入的标题图片 URL（跳过正则提取） */
	titleImages?: string[];
	/** DOM 调用方传入的选项图片 URL（跳过正则提取） */
	optionsImages?: string[];
	enableImageOptimize?: boolean;
}

interface QuestionAnswererEnvParams {
	question: QuestionIR;
	enableImageOptimize?: boolean;
}

/**
 * 构建题库请求环境。
 *
 * - 传入 `question`：使用 QuestionIR v3 的有序文本/图片、图片 ID 与布局信息，
 *   图片按原始顺序写入 `images` 与 `rich_content`（OpenAI Responses / Gemini 原生格式）。
 * - 传入旧参数：保留 5.3.1 的 [图片N] 占位符行为，供在线搜题测试等旧调用方使用。
 */
export async function buildAnswererEnv(params: LegacyAnswererEnvParams): Promise<{
	env: Record<string, any>;
	imageUrls: string[];
}>;
export async function buildAnswererEnv(params: QuestionAnswererEnvParams): Promise<{
	env: Record<string, any>;
	imageUrls: string[];
}>;
export async function buildAnswererEnv(params: LegacyAnswererEnvParams | QuestionAnswererEnvParams): Promise<{
	env: Record<string, any>;
	imageUrls: string[];
}> {
	if ('question' in params && params.question) {
		return buildAnswererEnvFromQuestion(params.question, params.enableImageOptimize);
	}
	return buildLegacyAnswererEnv(params as LegacyAnswererEnvParams);
}

async function buildLegacyAnswererEnv(params: LegacyAnswererEnvParams) {
	const rawOptions = Array.isArray(params.options)
		? params.options.filter((o) => o != null && o !== '').join('\n')
		: params.options ?? '';
	const options = dedupeLines(rawOptions);
	const env: Record<string, any> = {
		type: params.type || 'unknown',
		title: params.title,
		options,
		...getAnswererApiKeyEnv()
	};
	let imageUrls: string[] = [];
	if (params.enableImageOptimize) {
		const suggestion = await createImageSuggestion(params.title, options, params.titleImages, params.optionsImages);
		if (suggestion) {
			env.images = suggestion.images;
			imageUrls = suggestion.urls;
			env.suggestion_title = suggestion.suggestion_title;
			if (suggestion.suggestion_options !== undefined) {
				env.suggestion_options = dedupeLines(suggestion.suggestion_options);
			}
		}
	}
	return { env, imageUrls };
}

/** 判断题目是否含图片（含缺失图片），供调用方给出明确错误 */
function questionHasMedia(question: QuestionIR) {
	return !!(
		question.hasMedia ||
		question.missingImages ||
		question.stem.parts.some((p) => p.kind !== 'text') ||
		question.choices.some((c) => c.document.parts.some((p) => p.kind !== 'text'))
	);
}

async function buildAnswererEnvFromQuestion(question: QuestionIR, enableImageOptimize?: boolean) {
	if (!question || question.version !== 3) throw new Error('题目结构尚未建立');
	if (question.missingImages) {
		throw new Error(`题目有 ${question.missingImages} 个图片节点无法读取，已停止本题以防误答`);
	}
	if (questionHasMedia(question) && !enableImageOptimize) {
		throw new Error('这道题含有图片，请开启「图片题优化」，不能降级成纯文本作答');
	}

	const occurrences: {
		id: string;
		localIndex?: number;
		url: string;
		section: string;
		box: any;
	}[] = [];
	const sections = [
		{ label: 'stem', document: question.stem },
		...question.choices.map((c) => ({ label: `option:${c.id}`, document: c.document }))
	];
	for (const section of sections) {
		for (const part of section.document.parts) {
			if (part.kind === 'image') {
				occurrences.push({
					id: part.imageId!,
					localIndex: part.localIndex,
					url: part.url,
					section: section.label,
					box: part.box || null
				});
			}
		}
	}
	if (
		occurrences.some((item) => typeof item.id !== 'string' || !/^(?:Q|[A-Z]{1,3})-\d+$/.test(item.id)) ||
		new Set(occurrences.map((item) => item.id)).size !== occurrences.length
	) {
		throw new Error('图片标识不唯一，无法安全进行多图答题');
	}
	if (occurrences.length > QUESTION_MEDIA.maxImages) {
		throw new Error(`单题含 ${occurrences.length} 处图片，超过可安全发送的 ${QUESTION_MEDIA.maxImages} 处`);
	}

	const urlToData = new Map<string, string>();
	const urls = [...new Set(occurrences.map((o) => o.url))];
	const failures: { url: string; error: Error }[] = [];
	let cursor = 0;
	await Promise.all(
		Array.from({ length: Math.min(QUESTION_MEDIA.concurrency, urls.length) }, async () => {
			for (;;) {
				const index = cursor++;
				if (index >= urls.length) return;
				try {
					urlToData.set(urls[index], await imageToBase64(urls[index]));
				} catch (error: any) {
					failures.push({ url: urls[index], error });
				}
			}
		})
	);
	if (failures.length) {
		const descriptions = failures.slice(0, 4).map((f) => {
			const where = [
				...new Set(
					occurrences
						.filter((o) => o.url === f.url)
						.map((o) => o.section.replace('option:', '选项 ').replace('stem', '题干'))
				)
			].join('、');
			return `${where}: ${f.error.message}`;
		});
		throw new Error(`图片读取失败（${failures.length}/${urls.length} 个资源），${descriptions.join('；')}`);
	}

	const idToData = new Map(occurrences.map((part) => [part.id, urlToData.get(part.url)!]));
	const layout: NonNullable<QuestionIR['layout']> =
		question.layout ||
		({
			scene: null,
			geometryReady: false,
			complex: false,
			sections: [],
			images: []
		} as NonNullable<QuestionIR['layout']>);
	const rich: ({ type: 'input_text'; text: string } | { type: 'input_image'; image_url: string })[] = [];
	const images: string[] = [];
	const imageUrls: string[] = [];
	const manifest: any[] = [];
	let textBuffer = '';
	let nextOccurrence = 0;
	const flush = () => {
		if (textBuffer) {
			rich.push({ type: 'input_text', text: textBuffer });
			textBuffer = '';
		}
	};
	const beginText = (text: string) => {
		textBuffer += text;
	};
	const detailManifest = occurrences.map((part, i) => ({
		kind: 'detail' as const,
		id: part.id,
		index: i,
		section: part.section,
		localIndex: part.localIndex,
		choiceId: part.section.startsWith('option:') ? part.section.slice(7) : null,
		relative:
			layout && layout.geometryReady && part.box && layout.scene ? normalizedQuestionBox(part.box, layout.scene) : null
	}));
	if (occurrences.length && layout) {
		beginText(questionImageManifestText(detailManifest, layout));
	}
	const renderSection = (heading: string, doc: QuestionIR['stem'], sectionId: string) => {
		beginText(heading);
		let summary = '';
		for (const part of doc.parts) {
			if (part.kind === 'text') {
				beginText(part.text);
				summary += part.text;
			} else if (part.kind === 'image') {
				const index = nextOccurrence++;
				const item = occurrences[index];
				if (!item || item.id !== part.imageId || item.section !== sectionId) {
					throw new Error('图片顺序与选项身份不一致，已取消请求');
				}
				const label = `[图片${index + 1}](${part.imageId})`;
				beginText(`\n[图 ${part.imageId} 开始]\n`);
				summary += label;
				const dataUrl = idToData.get(part.imageId!);
				if (!dataUrl) throw new Error('图片准备状态不一致，已取消请求');
				flush();
				rich.push({ type: 'input_image', image_url: dataUrl });
				beginText(`\n[图 ${part.imageId} 结束]\n`);
				images.push(dataUrl);
				imageUrls.push(part.url);
				manifest.push(detailManifest[index]);
			} else if (part.kind === 'missing-image') {
				throw new Error('题目仍包含未读取的图片');
			}
		}
		return summary;
	};
	renderSection('题干：\n', question.stem, 'stem');
	if (question.choices.length) {
		beginText('\n选项（以下代号是唯一的答题标识）：\n');
		for (const choice of question.choices) {
			renderSection(`\n[选项 ${choice.id} 开始]\n`, choice.document, `option:${choice.id}`);
			beginText(`\n[选项 ${choice.id} 结束]\n`);
		}
	}
	flush();
	// 旧题库仍读取 title / options：这里保持与 5.3.1 一致的纯文本格式（图片以 URL 内联），
	// 增强后的顺序、图片 ID 与布局只放在 rich_content / image_* 新字段中，避免破坏旧题库检索。
	const titleText = question.stem.text;
	const optionLines = question.choices.map((choice) => `${choice.id}. ${choice.document.text.trim()}`);
	// 兼容 5.3.1 的 [图片N] 约定：suggestion_* 与 images 严格同序，
	// 旧题库即使只引用 ${suggestion_title} / ${suggestion_options} 也能继续工作。
	const placeholderIndex = new Map(detailManifest.map((item, index) => [item.id, index + 1]));
	const suggestionText = (doc: QuestionIR['stem']) =>
		doc.parts
			.map((part) => {
				if (part.kind === 'text') return part.text;
				if (part.kind === 'image') return ` [图片${placeholderIndex.get(part.imageId!) ?? ''}] `;
				return ' [图片尚未加载] ';
			})
			.join('');
	const suggestionTitle = suggestionText(question.stem);
	const suggestionOptions = question.choices
		.map((choice) => `${choice.id}. ${suggestionText(choice.document).trim()}`)
		.join('\n');
	if (
		nextOccurrence !== occurrences.length ||
		images.length !== occurrences.length ||
		manifest.length !== images.length
	) {
		throw new Error('图片序列无法和题目选项一一对应');
	}

	const totalPayloadSize = images.reduce((size, data) => size + data.length * 0.75, 0);
	if (totalPayloadSize > QUESTION_MEDIA.maxTotalBytes) {
		throw new Error('题目图片传输总量超过 40 MiB，未发送不完整请求');
	}

	const env: Record<string, any> = {
		type: question.type,
		title: titleText,
		...getAnswererApiKeyEnv(),
		options: optionLines.join('\n'),
		suggestion_title: suggestionTitle,
		suggestion_options: suggestionOptions,
		images,
		rich_content: rich,
		choice_ids: question.choices.map((c) => c.id),
		image_ids: occurrences.map((p) => p.id),
		image_manifest: manifest,
		image_layout: {
			scene_valid: !!layout.geometryReady,
			relations: layout.geometryReady ? questionImageSpatialRelations(layout) : [],
			map: detailManifest.map(({ id, section, choiceId, relative }) => ({ id, section, choiceId, relative }))
		}
	};
	return { env, imageUrls };
}

/** 在解析器内引用这些字段才视为支持图片题（${images} 或 env.rich_content 等） */
const IMAGE_OPTIMIZE_PLACEHOLDERS = [`\${images}`] as const;

const IMAGE_ENV_REF_PATTERN = /(^|[^\w$])(images|rich_content)(?![\w$])/;

export function isAnswererWrapperSupportImageOptimize(wrapper: AnswererWrapper): boolean {
	if (!wrapper || String(wrapper.method || 'get').toLowerCase() !== 'post') {
		return false;
	}
	for (const value of Object.values(wrapper.data || {})) {
		if (typeof value === 'string') {
			if (IMAGE_OPTIMIZE_PLACEHOLDERS.some((placeholder) => value.includes(placeholder))) {
				return true;
			}
		} else if (value && typeof value === 'object' && typeof (value as any).handler === 'string') {
			if (IMAGE_ENV_REF_PATTERN.test((value as any).handler)) {
				return true;
			}
		}
	}
	return false;
}

export function isAnswererWrappersSupportImageOptimize(wrappers: AnswererWrapper[]): boolean {
	return wrappers.some(isAnswererWrapperSupportImageOptimize);
}

export function createAnswererWrappersSignature(wrappers: AnswererWrapper[]): string {
	const content = JSON.stringify(wrappers);
	let hash = 0x811c9dc5;
	for (let i = 0; i < content.length; i++) {
		hash ^= content.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0).toString(16);
}
