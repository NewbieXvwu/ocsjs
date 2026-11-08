import type {
	QuestionBox,
	QuestionChoice,
	QuestionDocument,
	QuestionIR,
	QuestionLayout,
	QuestionPart,
	QuestionRelativeBox,
	QuestionTypes
} from '@ocsjs/core';
import { canonicalImageUrl, imageUrlMatches } from './image-url';

/** 题目文本片段（相邻且无坐标的文本会在 appendQuestionPart 中合并） */
export function questionTextPart(text: string | null | undefined, box?: QuestionBox | null): QuestionPart {
	return { kind: 'text', text: String(text || ''), ...(box ? { box } : {}) };
}

/** 追加片段：相邻无坐标文本自动合并，空文本直接丢弃 */
export function appendQuestionPart(parts: QuestionPart[], part: QuestionPart | null | undefined) {
	if (!part) return;
	if (part.kind === 'text') {
		if (!part.text) return;
		const last = parts[parts.length - 1];
		if (last && last.kind === 'text' && !last.box && !part.box) {
			last.text += part.text;
		} else {
			parts.push(questionTextPart(part.text, part.box));
		}
	} else {
		parts.push(part);
	}
}

/** 旧版纯文本表示：图片输出 URL，缺失图片输出提示占位 */
export function renderLegacyQuestionText(parts: QuestionPart[]) {
	return parts
		.map((part) => (part.kind === 'text' ? part.text : part.kind === 'image' ? ` ${part.url} ` : ` [图片尚未加载] `))
		.join('');
}

/** 汇总片段为题目文档 */
export function summarizeQuestionParts(parts: QuestionPart[]): QuestionDocument {
	return {
		parts,
		text: renderLegacyQuestionText(parts),
		images: parts
			.filter((part): part is Extract<QuestionPart, { kind: 'image' }> => part.kind === 'image')
			.map((part) => part.url),
		missingImages: parts.filter((part) => part.kind === 'missing-image').length
	};
}

/**
 * 只接受可信的页面坐标：有限数值、正尺寸、合理范围。
 * 任何异常（隐藏元素、跨页 iframe、缩放为 0）都返回 null，避免发送猜测坐标。
 */
export function finiteQuestionBox(
	rect:
		| DOMRect
		| { left?: number; top?: number; x?: number; y?: number; width?: number; height?: number }
		| null
		| undefined
): QuestionBox | null {
	if (!rect) return null;
	const x = Number((rect as any).left ?? (rect as any).x);
	const y = Number((rect as any).top ?? (rect as any).y);
	const width = Number(rect.width);
	const height = Number(rect.height);
	if (
		![x, y, width, height].every(Number.isFinite) ||
		width < 3 ||
		height < 3 ||
		width > 12000 ||
		height > 16000 ||
		Math.abs(x) > 1e6 ||
		Math.abs(y) > 1e6
	) {
		return null;
	}
	return { x, y, width, height };
}

export function questionElementBox(el: Element | null | undefined): QuestionBox | null {
	try {
		return finiteQuestionBox(el && typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null);
	} catch {
		return null;
	}
}

export function questionTextNodeBox(node: Node | null | undefined): QuestionBox | null {
	try {
		const doc = node && node.ownerDocument;
		if (!doc || typeof doc.createRange !== 'function') return null;
		const range = doc.createRange();
		range.selectNodeContents(node as Node);
		const box = finiteQuestionBox(range.getBoundingClientRect());
		if (typeof (range as any).detach === 'function') (range as any).detach();
		return box;
	} catch {
		return null;
	}
}

export function unionQuestionBoxes(boxes: (QuestionBox | null | undefined)[]): QuestionBox | null {
	const valid = boxes.filter((box): box is QuestionBox => !!box);
	if (!valid.length) return null;
	const x = Math.min(...valid.map((b) => b.x));
	const y = Math.min(...valid.map((b) => b.y));
	const right = Math.max(...valid.map((b) => b.x + b.width));
	const bottom = Math.max(...valid.map((b) => b.y + b.height));
	return finiteQuestionBox({ left: x, top: y, width: right - x, height: bottom - y });
}

/** 为题干/选项内的图片分配稳定 ID（Q-1、A-1…），并记录局部序号 */
export function annotateQuestionImageIds(doc: QuestionDocument, ownerId: string): QuestionDocument {
	let n = 0;
	doc.parts = doc.parts.map((part) =>
		part.kind !== 'image'
			? part
			: {
					...part,
					imageId: `${ownerId}-${++n}`,
					localIndex: n
			  }
	);
	return summarizeQuestionParts(doc.parts);
}

export function normalizedQuestionBox(
	box: QuestionBox | null | undefined,
	scene: QuestionBox | null
): QuestionRelativeBox | null {
	if (!box || !scene || scene.width <= 0 || scene.height <= 0) return null;
	const clamp = (n: number) => Math.round(Math.max(0, Math.min(1000, n)));
	return {
		x: clamp(((box.x - scene.x) / scene.width) * 1000),
		y: clamp(((box.y - scene.y) / scene.height) * 1000),
		w: clamp((box.width / scene.width) * 1000),
		h: clamp((box.height / scene.height) * 1000)
	};
}

/**
 * 根据真实 DOM 坐标构建题目布局。
 * 坐标不可靠时 geometryReady=false，且不产生 relative 坐标。
 */
export function buildQuestionLayout(ir: QuestionIR): QuestionLayout {
	const sections = [
		{
			id: 'Q',
			box: ir.stem.box || unionQuestionBoxes(ir.stem.parts.map((p) => p.box)),
			document: ir.stem
		},
		...ir.choices.map((c) => ({
			id: c.id,
			box: c.box || unionQuestionBoxes(c.document.parts.map((p) => p.box)),
			document: c.document
		}))
	];
	const present = sections.filter((section) => section.box);
	const scene = unionQuestionBoxes(present.map((section) => section.box));
	const images = sections.flatMap((section) =>
		section.document.parts
			.filter((p): p is Extract<QuestionPart, { kind: 'image' }> => p.kind === 'image')
			.map((p) => ({ id: p.imageId, section: section.id, box: p.box || null }))
	);
	// 如果 DOM 无法提供有意义的视觉坐标，不要用文本/数组顺序推测位置。
	const distinct = present.some((a, i) =>
		present.slice(i + 1).some((b) => Math.abs(a.box!.x - b.box!.x) + Math.abs(a.box!.y - b.box!.y) > 16)
	);
	const geometryReady = !!(
		scene &&
		scene.width <= 3200 &&
		scene.height <= 4500 &&
		present.length >= 2 &&
		distinct &&
		images.filter((im) => im.box).length >= 2
	);
	const perChoice = ir.choices.map((c) => c.document.parts.filter((p) => p.kind === 'image').length);
	const complex =
		images.length >= 3 ||
		perChoice.some((n) => n >= 2) ||
		(images.length >= 2 && /左图|右图|上图|下图|并排|位置|方位/.test(ir.stem.text));
	return {
		scene,
		geometryReady,
		complex,
		sections: sections.map((s) => ({
			id: s.id,
			box: s.box,
			relative: geometryReady ? normalizedQuestionBox(s.box, scene) : null
		})),
		images: images.map((im) => ({
			...im,
			relative: geometryReady ? normalizedQuestionBox(im.box, scene) : null
		}))
	};
}

/** 仅比较同一区域内的图片，跨选项的位置关系没有语义 */
export function questionImageSpatialRelations(layout: QuestionLayout | null | undefined): string[] {
	if (!layout || !layout.geometryReady) return [];
	const relations: string[] = [];
	for (const a of layout.images) {
		for (const b of layout.images) {
			if (!a.box || !b.box || a.section !== b.section || String(a.id) >= String(b.id)) continue;
			const acx = a.box.x + a.box.width / 2;
			const bcx = b.box.x + b.box.width / 2;
			const acy = a.box.y + a.box.height / 2;
			const bcy = b.box.y + b.box.height / 2;
			const sameRow = Math.abs(acy - bcy) <= Math.min(a.box.height, b.box.height) * 0.3;
			const sameCol = Math.abs(acx - bcx) <= Math.min(a.box.width, b.box.width) * 0.3;
			if (sameRow && a.box.x + a.box.width + 2 < b.box.x) relations.push(`${a.id} 在 ${b.id} 左侧`);
			else if (sameRow && b.box.x + b.box.width + 2 < a.box.x) relations.push(`${b.id} 在 ${a.id} 左侧`);
			else if (sameCol && a.box.y + a.box.height + 2 < b.box.y) relations.push(`${a.id} 在 ${b.id} 上方`);
			else if (sameCol && b.box.y + b.box.height + 2 < a.box.y) relations.push(`${b.id} 在 ${a.id} 上方`);
		}
	}
	return relations;
}

export interface QuestionImageDetailEntry {
	kind: 'detail';
	id: string;
	index: number;
	section: string;
	localIndex?: number;
	choiceId: string | null;
	relative: QuestionRelativeBox | null;
}

export function questionImageManifestText(detailEntries: QuestionImageDetailEntry[], layout: QuestionLayout): string {
	const lines = ['图像索引（每张原图均位于其唯一标识之后；选项归属由 ID 决定）：'];
	for (const e of detailEntries) {
		const section = e.section === 'stem' ? '题干' : `选项 ${e.choiceId}`;
		lines.push(
			`${e.id}：${section}第${e.localIndex}张` +
				(e.relative
					? `；原网页归一化坐标(x=${e.relative.x},y=${e.relative.y},w=${e.relative.w},h=${e.relative.h})/1000`
					: '')
		);
	}
	const spatial = questionImageSpatialRelations(layout);
	if (spatial.length) lines.push('网页中已测得的同区域空间关系：' + spatial.join('；'));
	return lines.join('\n') + '\n';
}

const LEGACY_IMAGE_MARKER = /\[(?:图片尚未加载|画布图片无法读取|SVG 图片无法读取)\]/g;

/**
 * 把旧版平台返回的字符串（可能内嵌图片 URL）切分为文本/图片片段。
 * 显式 images 中未出现在文本里的资源追加到末尾，不猜测位置。
 */
export function splitLegacyQuestionText(text: string, explicitImages?: string[]): QuestionDocument {
	text = String(text || '');
	const parts: QuestionPart[] = [];
	const sources: string[] = [];
	const images = Array.isArray(explicitImages) ? explicitImages : [];
	for (const url of images) {
		const clean = canonicalImageUrl(url);
		if (clean) sources.push(clean);
	}
	for (const url of imageUrlMatches(text)) {
		const clean = canonicalImageUrl(url);
		if (clean) sources.push(clean);
	}
	const matches: { at: number; length: number; url: string }[] = [];
	const candidates = [...new Set(sources)];
	for (const url of candidates) {
		const forms = url.includes('&') ? [url, url.replace(/&/g, '&amp;')] : [url];
		for (const form of forms) {
			let position = 0;
			for (;;) {
				const at = text.indexOf(form, position);
				if (at < 0) break;
				matches.push({ at, length: form.length, url });
				position = at + form.length;
				if (matches.length >= 256) break;
			}
		}
	}
	matches.sort((a, b) => a.at - b.at || b.length - a.length);
	let cursor = 0;
	for (const match of matches) {
		if (match.at < cursor) continue;
		appendQuestionPart(parts, questionTextPart(text.slice(cursor, match.at)));
		appendQuestionPart(parts, { kind: 'image', url: match.url });
		cursor = match.at + match.length;
	}
	appendQuestionPart(parts, questionTextPart(text.slice(cursor)));

	// 保留旧版自定义平台单独返回、未出现在文本中的图片，但不推断它们的顺序。
	const presentCounts = new Map<string, number>();
	const expectedCounts = new Map<string, number>();
	for (const part of parts) {
		if (part.kind === 'image') presentCounts.set(part.url, (presentCounts.get(part.url) || 0) + 1);
	}
	for (const raw of images) {
		const url = canonicalImageUrl(raw);
		if (url) expectedCounts.set(url, (expectedCounts.get(url) || 0) + 1);
	}
	for (const [url, required] of expectedCounts) {
		const extra = required - (presentCounts.get(url) || 0);
		for (let i = 0; i < extra; i++) appendQuestionPart(parts, { kind: 'image', url });
	}
	if (!parts.length && text) appendQuestionPart(parts, questionTextPart(text));

	const normalized: QuestionPart[] = [];
	for (const part of parts) {
		if (part.kind !== 'text') {
			appendQuestionPart(normalized, part);
			continue;
		}
		let cursor = 0;
		for (const match of part.text.matchAll(LEGACY_IMAGE_MARKER)) {
			appendQuestionPart(normalized, questionTextPart(part.text.slice(cursor, match.index)));
			appendQuestionPart(normalized, { kind: 'missing-image', reason: match[0] });
			cursor = (match.index || 0) + match[0].length;
		}
		appendQuestionPart(normalized, questionTextPart(part.text.slice(cursor)));
	}
	return summarizeQuestionParts(normalized);
}

/** 统一平台返回值：string / {text,images} / {parts} */
export function normalizeQuestionTransform(result: any): QuestionDocument {
	if (result == null) return summarizeQuestionParts([]);
	if (typeof result === 'string') return splitLegacyQuestionText(result, []);
	if (Array.isArray(result.parts)) {
		const parts: QuestionPart[] = [];
		for (const part of result.parts) {
			if (part.kind === 'text') {
				appendQuestionPart(
					parts,
					questionTextPart(
						part.text,
						finiteQuestionBox(
							part.box && { left: part.box.x, top: part.box.y, width: part.box.width, height: part.box.height }
						)
					)
				);
			} else if (part.kind === 'image') {
				const url = canonicalImageUrl(part.url);
				appendQuestionPart(
					parts,
					url
						? {
								...part,
								kind: 'image',
								url,
								box: finiteQuestionBox(
									part.box && { left: part.box.x, top: part.box.y, width: part.box.width, height: part.box.height }
								)
						  }
						: { kind: 'missing-image', reason: '无效图片地址' }
				);
			} else if (part.kind === 'missing-image') {
				appendQuestionPart(parts, { kind: 'missing-image', reason: part.reason || '未知原因' });
			}
		}
		return summarizeQuestionParts(parts);
	}
	const parsed = splitLegacyQuestionText(result.text, result.images || []);
	// 旧版平台实现可能已生成文字警告标记。
	const originalMissing = (String(result.text || '').match(LEGACY_IMAGE_MARKER) || []).length;
	const extraMissing = Math.max(0, Number(result.missingImages || 0), originalMissing);
	for (let i = 0; i < extraMissing; i++) {
		appendQuestionPart(parsed.parts, { kind: 'missing-image', reason: '图片节点没有成功加载' });
	}
	return summarizeQuestionParts(parsed.parts);
}

export function hasQuestionMedia(doc: QuestionDocument | null | undefined) {
	return !!(doc && doc.parts && doc.parts.some((p) => p.kind !== 'text'));
}

export function normalizeQuestionWords(text: string | null | undefined) {
	return String(text || '').replace(/[^\p{L}\p{N}]/gu, '');
}

export function choiceLetter(index: number) {
	let value = index + 1;
	let result = '';
	while (value > 0) {
		value--;
		result = String.fromCharCode(65 + (value % 26)) + result;
		value = Math.floor(value / 26);
	}
	return result;
}

/** 去掉选项前缀（A. / ①. 等），保留图片与剩余文本 */
export function removeChoiceLabel(doc: QuestionDocument): QuestionDocument {
	const parts = doc.parts.map((part) => ({ ...part })) as QuestionPart[];
	const first = parts.find((p): p is Extract<QuestionPart, { kind: 'text' }> => p.kind === 'text' && !!p.text.trim());
	if (first && parts.slice(0, parts.indexOf(first)).every((p) => p.kind === 'text')) {
		first.text = first.text.replace(/^\s*(?:[A-Z]{1,2}|[①②③④⑤⑥⑦⑧])\s*[.．、:：)）]\s*/i, '');
	}
	return summarizeQuestionParts(parts);
}

export interface MakeQuestionIROptions {
	type?: QuestionTypes;
	stem: QuestionDocument;
	choices: QuestionDocument[];
	optionNodes: (HTMLElement | null | undefined)[];
	stemNodes?: (HTMLElement | null | undefined)[];
}

/** 构建 QuestionIR v3（题干 Q-n / 选项 A-n 图片 ID、布局、图片总数） */
export function makeQuestionIR(options: MakeQuestionIROptions): QuestionIR {
	const stem = annotateQuestionImageIds(normalizeQuestionTransform(options.stem), 'Q');
	const stemBoxes = (Array.isArray(options.stemNodes) ? options.stemNodes : [options.stemNodes])
		.map((node) => questionElementBox(node))
		.filter((box): box is QuestionBox => !!box);
	stem.box = unionQuestionBoxes(stemBoxes) || unionQuestionBoxes(stem.parts.map((p) => p.box));
	const choices: QuestionChoice[] = options.choices.map((doc, index) => {
		const id = choiceLetter(index);
		const node = options.optionNodes[index] || undefined;
		return {
			id,
			index,
			node,
			box: questionElementBox(node),
			document: annotateQuestionImageIds(removeChoiceLabel(normalizeQuestionTransform(doc)), id)
		};
	});
	const allDocs = [stem, ...choices.map((o) => o.document)];
	const question: QuestionIR = {
		version: 3,
		type: options.type,
		stem,
		choices,
		imageIds: allDocs.flatMap((doc) =>
			doc.parts.filter((p): p is Extract<QuestionPart, { kind: 'image' }> => p.kind === 'image').map((p) => p.imageId!)
		),
		hasMedia: allDocs.some(hasQuestionMedia),
		missingImages: allDocs.reduce((sum, doc) => sum + doc.missingImages, 0)
	};
	question.layout = buildQuestionLayout(question);
	return question;
}
