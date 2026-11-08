import { QuestionChoice, QuestionDocument, QuestionIR, QuestionResolver, WorkContext } from './interface';
import { resolveSingle, resolveMultiple, resolveJudgement, resolveCompletion, isJudgementOptions } from './resolvers';
import { normalizeString, removeRedundant } from '../utils/string';
import { splitAnswer } from './utils';

function escapeQuestionRegExp(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 解析模型返回的选项代号。
 *
 * 支持 "A"、"A,C"、"AC"、"A 和 C"、JSON 数组，以及 "正确答案：A"。
 * 只接受与题目真实选项 ID 完全一致的代号，绝不猜测。
 */
function parseQuestionChoiceIds(value: unknown, choices: QuestionChoice[], isMultiple: boolean): string[] | null {
	const validIds = choices.map((choice) => choice.id);
	if (!validIds.length || typeof value !== 'string') return null;
	const supported = new Set(validIds);
	let answers: string[] | undefined;
	const raw = value.trim();
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) answers = parsed.map(String);
	} catch {
		/* 普通模型答案，不是 JSON */
	}
	if (!answers) answers = [raw];
	const collected: string[] = [];
	const escapedIds = validIds
		.slice()
		.sort((a, b) => b.length - a.length)
		.map(escapeQuestionRegExp)
		.join('|');
	const singlePattern = new RegExp(`^(?:选项\\s*)?\\(?\\s*(${escapedIds})\\s*\\)?(?:[.．、:]\\s*)?$`, 'i');
	const prefixed = /^(?:正确答案|答案|选项)\s*[:：是为]\s*/i;
	for (const answer of answers) {
		let cleaned = String(answer).trim().replace(prefixed, '').trim();
		// 多选常见格式："A、C"、"A,C"、"AC"、"A 和 C"
		cleaned = cleaned.replace(/\b(?:and|AND)\b|和|及|与|、|，|,|;|；|\+|\||\/|\s+/g, ' ').trim();
		let tokens: string[];
		const direct = singlePattern.exec(cleaned);
		if (direct) {
			tokens = [direct[1].toUpperCase()];
		} else {
			tokens = cleaned
				.split(' ')
				.filter(Boolean)
				.map((s) => s.replace(/^\(?([A-Z]+)\)?[.．、:]?$/i, '$1').toUpperCase());
			// "AC" 这类字母串只在多选且每个字母都是合法选项 ID 时才拆分。
			if (tokens.length === 1 && isMultiple && !supported.has(tokens[0]) && /^[A-Z]+$/.test(tokens[0])) {
				const split = tokens[0].split('');
				if (split.every((letter) => supported.has(letter))) tokens = split;
			}
		}
		if (!tokens.length || tokens.some((id) => !supported.has(id))) return null;
		collected.push(...tokens);
	}
	const unique = [...new Set(collected)];
	if (!unique.length || (!isMultiple && unique.length !== 1)) return null;
	return unique;
}

/** 选项的可比较文本描述（去掉选项代号；纯代号视为空，不能作为匹配依据） */
function normalizedOptionDescription(doc: QuestionDocument): string {
	const content = doc.parts
		.filter((part) => part.kind === 'text')
		.map((part) => (part as { text: string }).text)
		.join(' ')
		.trim();
	const stripped = content.replace(/^\s*(?:[A-Z]{1,2}|[①②③④⑤⑥⑦⑧])\s*[.．、:：)）]\s*/i, '').trim();
	return /^[A-Z]$/i.test(stripped) ? '' : stripped;
}

/**
 * 把模型答案解析为选项 ID。
 * 优先使用稳定的选项代号；旧题库返回选项文本时，只接受唯一完全相等的描述。
 */
function resolveQuestionIRAnswer(
	answers: string[],
	ir: QuestionIR,
	multiple: boolean
): { finish: boolean; ids?: string[]; source?: string; reason?: string } | null {
	if (!ir || !ir.choices.length) return null;
	// 某些集成会为每个选中项返回一条结果；只合并同一题库（同一 info）内的结果。
	if (multiple && answers.length > 1) {
		const packed = parseQuestionChoiceIds(JSON.stringify(answers), ir.choices, true);
		if (packed) return { finish: true, ids: packed, source: 'choice-id' };
	}
	for (const raw of answers) {
		const answerList = splitAnswer(String(raw || ''));
		const parsed =
			parseQuestionChoiceIds(raw, ir.choices, multiple) ||
			(answerList.length > 1 ? parseQuestionChoiceIds(JSON.stringify(answerList), ir.choices, multiple) : null);
		if (parsed) return { finish: true, ids: parsed, source: 'choice-id' };
	}
	// 返回纯文本的旧题库：只做唯一完全相等匹配，图片题绝不做模糊匹配。
	const descriptions = ir.choices.map((c) => normalizedOptionDescription(c.document));
	const resolved: string[] = [];
	for (const raw of answers) {
		for (const token of splitAnswer(String(raw || ''))) {
			const needle = normalizeString(removeRedundant(String(token)));
			if (!needle || needle.length < 2) continue;
			const hits = descriptions
				.map((text, i) => ({ i, text: normalizeString(removeRedundant(text)) }))
				.filter(({ text }) => text && text === needle);
			if (hits.length === 1) resolved.push(ir.choices[hits[0].i].id);
		}
	}
	const ids = [...new Set(resolved)];
	if (ids.length && (multiple || ids.length === 1)) {
		return { finish: true, ids, source: 'exact-text' };
	}
	return { finish: false, reason: '图片题的答案无法唯一对应选项代号；没有执行选择' };
}

/**
 * 校验图片引用依据。
 * 只验证“模型是否真的引用了它声称的图片”，不验证答案本身是否正确。
 */
function validateChoiceImageEvidence(
	ir: QuestionIR,
	chosenIds: string[],
	responses: { extra_data?: object }[],
	multiple: boolean
): { ok: boolean; reason?: string } {
	if (!ir || !ir.hasMedia) return { ok: true };
	const evidence = responses
		.map((res) => res && res.extra_data && (res.extra_data as any).image_evidence)
		.find((value) => value !== undefined && value !== null);
	if (!evidence) {
		return ir.imageIds.length > 1 ? { ok: false, reason: '多图题缺少图像引用依据，已停止自动选择' } : { ok: true };
	}
	if (evidence.complete !== true || !Array.isArray(evidence.ids) || !Array.isArray(evidence.answers)) {
		return { ok: false, reason: 'AI 未返回完整的图像引用信息' };
	}
	if (evidence.ambiguous !== false) return { ok: false, reason: 'AI 报告图片或答案存在歧义' };
	const known = new Set(ir.imageIds);
	const used = new Set(evidence.ids as string[]);
	if (used.size !== evidence.ids.length || (evidence.ids as string[]).some((id) => !known.has(id))) {
		return { ok: false, reason: 'AI 引用了不存在或重复的图片 ID' };
	}
	if (!used.size && ir.imageIds.length > 0) {
		return { ok: false, reason: 'AI 未标明实际参考的图片' };
	}
	const referencedAnswers = parseQuestionChoiceIds(JSON.stringify(evidence.answers), ir.choices, multiple);
	if (
		!referencedAnswers ||
		referencedAnswers.length !== chosenIds.length ||
		referencedAnswers.some((id) => !chosenIds.includes(id))
	) {
		return { ok: false, reason: '答案代号与图像引用信息不一致' };
	}
	// 所选选项内的所有图片，以及全部题干图片，都必须出现在引用依据中。
	const required = [
		...ir.stem.parts.filter((p) => p.kind === 'image').map((p) => (p as any).imageId),
		...ir.choices
			.filter((choice) => chosenIds.includes(choice.id))
			.flatMap((choice) => choice.document.parts.filter((p) => p.kind === 'image').map((p) => (p as any).imageId))
	];
	if (required.some((id) => !used.has(id))) {
		return { ok: false, reason: 'AI 未引用题干或正确选项中必需的图片' };
	}
	return { ok: true };
}

/** 答题期间选项 DOM 必须保持原顺序/身份；图片题错位会直接选错 */
function validateChoiceIdentity(ir: QuestionIR | undefined, options: HTMLElement[]): boolean {
	if (!ir || !ir.choices.length) return false;
	if (ir.choices.length !== options.length || ir.choices.some((choice, i) => choice.node !== options[i])) {
		if (ir.hasMedia) throw new Error('答题期间选项 DOM 顺序发生变化，已停止选择以防错位');
		return false;
	}
	return true;
}

/** 默认答案题目处理器 */
export function createDefaultQuestionResolver<E>(
	ctx: WorkContext<E>,
	/**
	 * 选项文本提供器：替代 `o.innerText`。
	 * 图片题等场景下 innerText 无法获取 img 的 URL，需由调用方通过 DOM 遍历提供。
	 * 不传则回退到 `o.innerText`，旧调用方零影响。
	 */
	optionText?: (el: HTMLElement, i: number) => string
): Record<'single' | 'multiple' | 'completion' | 'judgement', QuestionResolver<E>> {
	const toText = (o: HTMLElement, i: number) => (optionText ? optionText(o, i) : o.innerText);
	const collect = (infos: any[]) =>
		infos.flatMap((info) =>
			info.results.map((res: any) => res.answer).filter((answer: any) => typeof answer === 'string')
		);

	/**
	 * 优先使用 QuestionIR（选项代号/图片依据）。
	 * 返回 null 表示题目没有 IR 或答案无法按代号解析，调用方回退到旧文本逻辑。
	 */
	const runChoiceResolution = async (
		kind: 'single' | 'multiple' | 'judgement' | 'completion',
		infos: any[],
		options: HTMLElement[],
		handler: any
	) => {
		const ir = ctx.questionIR;
		if (!ir || kind === 'completion' || !validateChoiceIdentity(ir, options)) return null;
		let answer: { finish: boolean; ids?: string[]; source?: string; reason?: string } | null = null;
		for (const info of infos) {
			const rows = info.results || [];
			const group = rows.map((res: any) => res.answer).filter((a: any) => typeof a === 'string');
			const result = resolveQuestionIRAnswer(group, ir, kind === 'multiple');
			if (result && result.finish && result.ids) {
				const verified = validateChoiceImageEvidence(ir, result.ids, rows, kind === 'multiple');
				if (verified.ok) {
					answer = result;
					break;
				}
				if (!answer || !answer.finish) answer = { finish: false, reason: verified.reason };
			} else if (!answer) {
				answer = result;
			}
		}
		if (!answer || !answer.finish || !answer.ids) {
			if (ir.hasMedia) return answer || { finish: false };
			return null;
		}
		const ids = answer.ids;
		if (kind !== 'multiple' && ids.length !== 1) {
			return { finish: false, reason: '单选题返回了多个选项' };
		}
		for (const id of ids) {
			const choice = ir.choices.find((c) => c.id === id);
			if (!choice) throw new Error(`模型返回了未知选项 ${id}`);
			const node = choice.node || options[ir.choices.indexOf(choice)];
			if (!node) throw new Error(`选项 ${id} 已离开页面，已停止答题`);
			if (node.isConnected === false) throw new Error(`选项 ${id} 已离开页面，已停止答题`);
			await handler(kind, id, node, ctx);
		}
		return {
			finish: true,
			ids,
			source: answer.source,
			option: ids.length === 1 ? ids[0] : undefined,
			options: ids
		};
	};

	return {
		/**
		 * 单选题处理器
		 *
		 * 委托给 resolveSingle 纯函数，将 DOM 元素适配为字符串
		 */
		async single(infos, options, handler) {
			const irResult = await runChoiceResolution('single', infos, options, handler);
			if (irResult) return irResult;
			const optionTexts = options.map((o, i) => toText(o, i));

			// 选项具备判断题性质时，直接走判断题处理逻辑
			if (isJudgementOptions(optionTexts.map((o) => o.trim()))) {
				const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
				const result = resolveJudgement(answerGroups, optionTexts);
				if (result.finish && result.option !== undefined) {
					const matches = optionTexts.map((v, i) => (v === result.option ? i : -1)).filter((i) => i >= 0);
					if (matches.length !== 1) return { finish: false, reason: '判断题选项文字存在重复' };
					await handler('judgement', result.option, options[matches[0]], ctx);
				}
				return result;
			}

			const result = resolveSingle(collect(infos), optionTexts, ctx.answerSeparators);

			if (result.finish && result.option !== undefined) {
				const matches = optionTexts.map((v, i) => (v === result.option ? i : -1)).filter((i) => i >= 0);
				if (matches.length !== 1) return { finish: false, reason: '选项文字重复，无法唯一定位' };
				await handler('single', result.option, options[matches[0]], ctx);
			}

			return result;
		},
		/**
		 * 多选题处理器
		 *
		 * 委托给 resolveMultiple 纯函数，将 DOM 元素适配为字符串
		 */
		async multiple(infos, options, handler) {
			const irResult = await runChoiceResolution('multiple', infos, options, handler);
			if (irResult) return irResult;
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveMultiple(collect(infos), optionTexts, ctx.answerSeparators);

			// 纯 ABCD 答案兜底走 plainOptions，普通匹配走 options
			const resolvedOptions = result.finish ? result.options ?? result.plainOptions : undefined;

			if (resolvedOptions) {
				for (const optText of resolvedOptions) {
					const matches = optionTexts.map((v, i) => (v === optText ? i : -1)).filter((i) => i >= 0);
					if (matches.length !== 1) return { finish: false, reason: '多选题文字重复，无法唯一定位' };
					await handler('multiple', optText, options[matches[0]], ctx);
				}
			}

			return result;
		},
		/**
		 * 判断题处理器
		 *
		 * 委托给 resolveJudgement 纯函数
		 */
		async judgement(infos, options, handler) {
			const irResult = await runChoiceResolution('judgement', infos, options, handler);
			if (irResult) return irResult;
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));
			const optionTexts = options.map((o, i) => toText(o, i));

			const result = resolveJudgement(answerGroups, optionTexts);

			if (result.finish && result.option !== undefined) {
				const matches = optionTexts.map((v, i) => (v === result.option ? i : -1)).filter((i) => i >= 0);
				if (matches.length !== 1) return { finish: false, reason: '判断题选项重复' };
				await handler('judgement', result.option, options[matches[0]], ctx);
			}

			return result;
		},
		/**
		 * 填空题处理器
		 *
		 * 委托给 resolveCompletion 纯函数
		 */
		async completion(infos, options, handler) {
			const answerGroups = infos.map((info) => info.results.map((res) => res.answer));

			const result = resolveCompletion(answerGroups, options.length, ctx.answerSeparators);

			if (result.finish && result.answers) {
				for (let i = 0; i < result.answers.length; i++) {
					await handler('completion', result.answers[i], options[i], ctx);
				}
			}

			return result;
		}
	};
}
