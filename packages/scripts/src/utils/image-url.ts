/**
 * 图片 URL 的文本级解析工具。
 * 独立成模块以避免 answerer-env（下载/编码）与 question-ir（文档结构）互相依赖。
 */

/**
 * 文本场景的图片 URL 匹配。DOM 提取的图片不依赖此正则，
 * 因此没有扩展名的签名 URL 也能正常传输。
 */
export const IMAGE_URL_REGEX =
	// eslint-disable-next-line max-len
	/https?:\/\/[^\s<>"'`，。、：；！？（）【】\p{Script=Han}\uff00-\uffef]+?\.(?:png|jpe?g|gif|bmp|webp|svg)(?:\?[^\s<>"'`，。、：；！？（）【】\p{Script=Han}\uff00-\uffef]*)?(?:#[^\s<>"'`，。、：；！？（）【】\p{Script=Han}\uff00-\uffef]*)?/giu;

/**
 * 提取文本中的图片 URL。
 * 处理 HTML 实体：URL 后的 `&amp;` 如果紧跟 `key=` 则仍属于查询参数，
 * 否则视为文本边界，避免把后续正文拼进 URL。
 */
export function imageUrlMatches(text: string): string[] {
	const matches: string[] = [];
	if (typeof text !== 'string') return matches;
	const re = new RegExp(IMAGE_URL_REGEX.source, IMAGE_URL_REGEX.flags);
	for (const match of text.matchAll(re)) {
		const entity = /&(?:#(?:\d+|x[\da-f]+)|[a-z][\da-z]*);/gi;
		let cutoff = -1;
		for (const found of match[0].matchAll(entity)) {
			const suffix = match[0].slice(found.index! + found[0].length);
			if (/^&amp;$/i.test(found[0]) && /^[\w-]+=/.test(suffix)) continue;
			cutoff = found.index!;
			break;
		}
		const candidate = (cutoff < 0 ? match[0] : match[0].slice(0, cutoff)).replace(/[.,;!?]+$/g, '');
		if (candidate) matches.push(candidate);
	}
	return matches;
}

/** 规范化图片地址：实体解码、相对地址转绝对、仅接受 http/data:image/blob */
export function canonicalImageUrl(url: string | null | undefined): string {
	if (typeof url !== 'string') return '';
	const value = url.trim().replace(/&amp;/gi, '&');
	if (!value) return '';
	if (/^(https?:|data:image\/|blob:)/i.test(value)) return value;
	if (/^(\/|\.\/|\.\.\/)/.test(value) && typeof document !== 'undefined') {
		try {
			return new URL(value, document.baseURI).href;
		} catch {
			return '';
		}
	}
	return '';
}
