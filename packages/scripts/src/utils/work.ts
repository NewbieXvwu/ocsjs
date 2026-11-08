import {
	SimplifyWorkResult,
	WorkerEvents,
	WorkResult,
	defaultAnswerWrapperHandler,
	AnswererWrapper,
	SearchInformation,
	WorkContext,
	QuestionDocument,
	QuestionPart,
	$
} from '@ocsjs/core';
import { $ui, $message, MessageElement, Script, h, CommonEventEmitter, cors, $elements } from 'easy-us';
import { CommonEvents, CommonProject } from '../projects/common';
import { $console, BackgroundProject } from '../projects/background';
import { CommonWorkOptions } from '.';
import { createIframeControlSession } from './iframe-control-bar';
import {
	buildAnswererEnv,
	createAnswererWrappersSignature,
	createImageSuggestion,
	imageToBase64,
	ImageSuggestionResult,
	isAnswererWrapperSupportImageOptimize,
	isAnswererWrappersSupportImageOptimize
} from './answerer-env';
import {
	appendQuestionPart,
	hasQuestionMedia,
	makeQuestionIR,
	normalizeQuestionTransform,
	normalizeQuestionWords,
	questionElementBox,
	questionTextNodeBox,
	questionTextPart,
	splitLegacyQuestionText,
	summarizeQuestionParts
} from './question-ir';
import { canonicalImageUrl } from './image-url';

// 重新导出，保持对外 API 不变（common.ts / exploration.ts 等仍从本文件导入）
export {
	buildAnswererEnv,
	createAnswererWrappersSignature,
	createImageSuggestion,
	imageToBase64,
	isAnswererWrappersSupportImageOptimize
};
export type { ImageSuggestionResult };
// extractTextWithImages / ExtractTextOptions 已在下方直接 export

/** commonWork 单次调用的可变状态（render 处理器通过绑定引用读取，重复调用时替换引用避免串台） */
interface CommonWorkState {
	worker: CommonEventEmitter<WorkerEvents> | undefined;
	/** 是否已经按下了开始按钮 */
	startBtnPressed: boolean;
	/** 是否题库配置检查失败 */
	checkFailed: boolean;
	/** 是否正在运行 */
	running: boolean;
	/** 当前控制面板元素（start 后为 [暂停|重新答题] 运行态面板） */
	controlPanel: HTMLElement | null;
	/** 是否暂停中（提升到 state：面板重建后按钮状态与 worker 实际状态保持一致） */
	paused: boolean;
	/** 嵌入脚本面板的搜索结果区域（复用避免 createWorkResultsPanel 监听器累积） */
	resultPanel: HTMLElement | null;
}

/**
 * 各脚本的 render 处理器绑定。
 * 每个脚本仅注册一次处理器；重复调用 commonWork 时仅替换执行内容引用，
 * 避免处理器无限叠加、旧闭包持有失效状态互相覆盖面板。
 */
const commonWorkRenderBindings = new WeakMap<Script, { current: () => void }>();

/** 为脚本注册一次性的 render 处理器；已注册过时更新其执行内容 */
function bindCommonWorkRender(script: Script, render: () => void) {
	const binding = commonWorkRenderBindings.get(script);
	if (binding) {
		binding.current = render;
		return;
	}
	const created = { current: render };
	commonWorkRenderBindings.set(script, created);
	script.on('render', () => created.current());
}

/**
 * 通用作业考试工具方法
 * 子 iframe 中无法操作 top 层元素，可直接传递 script: undefined
 */
export function commonWork(options: {
	mount_script?: Script;
	/**
	 * 子 iframe 操控面板：开启后，若当前运行于子 iframe 中（self !== top），
	 * worker 创建后会在顶层窗口的 $elements.root 中渲染操控条（暂停/继续 + 重新答题），
	 * 共享顶层样式；按钮指令经 cors 跨窗口回传子帧执行（见 utils/iframe-control-bar.ts）。
	 */
	iframe_control?: boolean;
	start_delay_seconds?: number;
	workerProvider: (opts: CommonWorkOptions) => CommonEventEmitter<WorkerEvents> | undefined;
	beforeRunning?: () => void | Promise<void>;
	onRestart?: () => void | Promise<void>;
	onWorkerCreated?: (worker: CommonEventEmitter<WorkerEvents>) => void | Promise<void>;
}) {
	// 置顶当前脚本
	if (options.mount_script) BackgroundProject.scripts.render.methods.pin(options.mount_script);

	// worker 工作状态统一通过 CommonEvents.emitWorkerStateChange 广播：
	// 结果面板按钮显隐与搜题气泡均以该事件为唯一数据源

	CommonProject.scripts.settings.on('answerer-wrapper-change', async (curr, prev) => {
		$console.log('answerer-wrapper-change curr.length', curr.length);
		if (curr.length > 0) {
			state.checkFailed = false;
			state.startBtnPressed = false;
			await closeAnswerWrapperEmptyWarning();
			start();
		}
	});
	let workOptions = CommonProject.scripts.settings.methods.getWorkOptions();

	/** 本次调用的可变状态（实例隔离，不与其它 commonWork 调用共享） */
	const state: CommonWorkState = {
		worker: undefined,
		startBtnPressed: false,
		checkFailed: false,
		running: false,
		controlPanel: null,
		paused: false,
		resultPanel: null
	};

	/** 暂停状态访问器（顶层控制面板与子 iframe 操控会话共享） */
	const pausedAccessor = {
		get value() {
			return state.paused;
		},
		set value(v) {
			state.paused = v;
		}
	};

	/**
	 * 子 iframe 操控会话：封装子帧侧全部逻辑（顶层操控条渲染/指令监听/暂停提示/按钮状态同步）。
	 * 未开启 iframe_control 或不在子帧时为 undefined，生命周期中可选调用即可，
	 * 无需在各处重复判断 iframe_control && self !== top
	 */
	const iframeControl = createIframeControlSession({
		enabled: options.iframe_control,
		workerProvider: () => state.worker,
		paused: pausedAccessor
	});

	/** 显示答题控制按钮 */
	const createWorkControlPanel = () => {
		const { controlBtn, restartBtn, startBtn } = createWorkerControl({
			workerProvider: () => state.worker,
			paused: pausedAccessor,
			onStart: async () => {
				state.startBtnPressed = true;
				if (checkMessage instanceof MessageElement) {
					checkMessage.remove();
				}
				await closeAnswerWrapperEmptyWarning();
				start();
			},
			onRestart: async () => {
				state.worker?.emit('close');
				// 允许 start() 重入（start 内有 running 防重入守卫）
				state.running = false;
				await options.onRestart?.();
				start();
			}
		});

		startBtn.style.flex = '1';
		startBtn.style.padding = '4px';
		restartBtn.style.flex = '1';
		restartBtn.style.padding = '4px';
		controlBtn.style.flex = '1';
		controlBtn.style.padding = '4px';

		const container = h(
			'div',
			{ className: 'work-control-panel' },
			state.running ? [controlBtn, restartBtn] : [startBtn]
		);

		state.controlPanel = container;

		return { container, startBtn, restartBtn, controlBtn };
	};

	/** 渲染面板内容（render 事件与 start() 共用，保证两处内容一致） */
	const renderPanelBody = () => {
		const gotoSettingsBtn = $ui.button('👉 前往设置题库配置', {
			className: 'base-style-button',
			style: { flex: '1', padding: '4px' }
		});
		gotoSettingsBtn.onclick = () => {
			BackgroundProject.scripts.render.methods.pin(CommonProject.scripts.settings);
		};

		// 搜索结果区域复用：仅当被框架重建（detached）后才新建，
		// 避免 createWorkResultsPanel 每次调用都累积一组 config/store 监听器
		if (!state.resultPanel?.isConnected) {
			state.resultPanel = CommonProject.scripts.workResults.methods.createWorkResultsPanel();
		}

		options.mount_script?.panel?.body?.replaceChildren(
			h(
				'div',
				{ style: { marginTop: '12px' } },

				state.checkFailed
					? [h('hr'), h('div', { style: { display: 'flex' } }, [gotoSettingsBtn])]
					: [
							h('hr'),
							// 控制面板始终渲染：未开始时为"开始答题"按钮；
							// start() 后复用 state.controlPanel（暂停 | 重新答题），re-render 不会丢失
							state.controlPanel || createWorkControlPanel().container,
							state.resultPanel
					  ]
			)
		);
	};

	// 控制区域与搜索结果区域只嵌入当前（学校）脚本面板；
	// CommonProject 的"搜索结果"脚本面板保持其自身 onrender 的纯结果区，不显示控制按钮，
	// 也避免同一个 DOM 元素被两个面板互相"偷走"导致状态不同步
	if (options.mount_script) bindCommonWorkRender(options.mount_script, renderPanelBody);

	let checkMessage: MessageElement | Promise<void> | undefined;
	if (iframeControl) {
		// 子 iframe 操控模式：$message 经 cors 转发到顶层时无法执行交互回调（取消/倒计时结束），
		// 不能使用交互式预检；但自动答题必须触发，简化为直接校验题库配置 + 延迟自动开始
		if (workOptions.answererWrappers.length === 0) {
			state.checkFailed = true;
			answerWrapperEmptyWarning(0);
		} else {
			const delay = options.start_delay_seconds ?? 5;
			$message.info(`将在 ${delay} 秒后自动答题`);
			setTimeout(() => {
				// 与 workPreCheckMessage 的 onrun 语义一致：已通过其他方式开始时跳过
				if (state.startBtnPressed === false) {
					start();
				}
			}, delay * 1000);
		}
	} else {
		/**
		 * 检查题库是否配置，并询问是否开始答题
		 */
		checkMessage = workPreCheckMessage({
			onrun: () => state.startBtnPressed === false && start(),
			onclose: (_, closedMsg) => (checkMessage = closedMsg),
			onNoAnswererWrappers: () => {
				state.checkFailed = true;
			},
			...workOptions,
			start_delay_seconds: options.start_delay_seconds
		});
	}

	const start = async () => {
		// 防重入：运行中重复触发（如连点重新开始）直接忽略
		if (state.running) {
			return;
		}
		if (state.checkFailed) {
			return answerWrapperEmptyWarning(0);
		}
		// 重新获取题库配置（防止题库变化事件触发后无法获取到最新题库配置）
		workOptions = CommonProject.scripts.settings.methods.getWorkOptions();
		await options.beforeRunning?.();
		state.running = true;
		// 运行答题
		state.worker = options.workerProvider(workOptions);

		if (state.worker) {
			options.onWorkerCreated?.(state.worker);
		}

		const { controlBtn } = createWorkControlPanel();
		// 更新面板为运行态（与 render 事件共用同一渲染逻辑）
		renderPanelBody();

		// 子 iframe 操控会话：worker 创建后激活（渲染操控条到顶层 $elements.root）
		iframeControl?.activate();

		if (state.worker) {
			const emitState = CommonEvents.emitWorkerStateChange;
			emitState('start');
			state.worker.on('stop', () => emitState('stop'));
			// 恢复答题视为重新开始工作（isWorkerWorking=true，气泡重新显示）
			state.worker.on('continuate', () => emitState('start'));
			state.worker.once('close', () => {
				emitState('close');
				iframeControl?.dispose();
			});
			state.worker.once('done', () => {
				state.running = false;
				state.controlPanel = null;
				state.paused = false;
				controlBtn.disabled = true;
				emitState('done');
				iframeControl?.finish();
			});
		}
	};
}

/**
 * 动态答题器提示（一题一题动态作答的作业/考试）：
 * 常驻提示用户在答题过程中不要手动切换题目，防止答题与搜索结果错乱；
 * worker 完成（done）或被关闭（close）时自动移除。
 */
export function dynamicWorkTips(worker: CommonEventEmitter<WorkerEvents>) {
	const msg = $message.warn({
		content: '⚠️ 正在逐题自动答题，过程中请勿手动切换题目，防止答题与搜索结果错乱。',
		duration: 0
	});
	worker.once('done', () => msg?.remove());
	worker.once('close', () => msg?.remove());
}

/**
 * 答题控制
 */
export function createWorkerControl(options: {
	workerProvider: () => CommonEventEmitter<WorkerEvents> | undefined;
	onStart: () => void;
	onRestart: () => void;
	/** 暂停状态（外部托管）：面板重建后按钮状态与 worker 实际状态保持一致；不传则为内部状态 */
	paused?: { value: boolean };
}) {
	let stopMessage: MessageElement | undefined;
	const paused = options.paused ?? { value: false };
	const startBtn = $ui.button('▶️开始答题');
	const restartBtn = $ui.button('🔃重新答题');
	const controlBtn = $ui.button(paused.value ? '▶️继续' : '⏸暂停');

	startBtn.onclick = () => {
		startBtn.remove();
		options.onStart();
	};
	restartBtn.onclick = () => {
		// 重新答题时，清除暂停提示并重置暂停状态（新 worker 从非暂停开始）
		stopMessage?.remove();
		paused.value = false;
		options.onRestart();
	};
	controlBtn.onclick = () => {
		paused.value = !paused.value;
		const worker = options.workerProvider();
		worker?.emit?.(paused.value ? 'stop' : 'continuate');
		controlBtn.value = paused.value ? '▶️继续' : '⏸️暂停';
		if (paused.value) {
			stopMessage = $message.warn({ duration: 0, content: '暂停中...' });
		} else {
			stopMessage?.remove();
		}
	};

	return { startBtn, restartBtn, controlBtn };
}

/**
 * MathJax 特殊符号归一化表（NFKC 不覆盖的数学符号 → ASCII/去除）。
 * 见 .codebuddy/plans/zhs-mathjax-formula-plan.md 附录实测。
 */
const MATH_SYMBOL_MAP: Record<string, string> = {
	'′': "'",
	'″': "''",
	'⁡': '',
	'−': '-',
	'⋅': '*',
	'×': '*',
	'÷': '/'
};
const MATH_SYMBOL_RE = new RegExp(`[${Object.keys(MATH_SYMBOL_MAP).join('')}]`, 'g');

/**
 * 将 MathJax v3 SVG 公式（mjx-container）线性化为纯文本。
 *
 * 原理：SVG 输出保留了 MathML 结构镜像（`g[data-mml-node]`），
 * 每个字形为 `path[data-c="Unicode码位hex"]`（部分配置下为 `use[data-c]`）。
 * 产出形如 `H^{'}(x)=f(k(x))-f(h(x))`、`∫_{a}^{x}f(t)dt`，供题库文本模糊匹配。
 * 未知节点退化为子节点顺序拼接（fail-open）。
 */
export function extractMathJaxText(container: Element): string {
	const math = container.querySelector('g[data-mml-node="math"]');
	return math ? mmlNodeText(math) : '';
}

function mmlNodeText(node: Element): string {
	const type = node.getAttribute('data-mml-node');
	const kids = Array.from(node.children).filter((c) => c.hasAttribute('data-mml-node'));
	const at = (i: number) => (kids[i] ? mmlNodeText(kids[i]) : '');

	switch (type) {
		case 'mi':
		case 'mo':
		case 'mn':
		case 'mtext': {
			const chars: string[] = [];
			node.querySelectorAll('path[data-c],use[data-c]').forEach((p) => {
				chars.push(String.fromCodePoint(parseInt(p.getAttribute('data-c') || '0', 16)));
			});
			return chars
				.join('')
				.normalize('NFKC')
				.replace(MATH_SYMBOL_RE, (c) => MATH_SYMBOL_MAP[c] ?? c);
		}
		case 'msup':
			return `${at(0)}^{${at(1)}}`;
		case 'msub':
			return `${at(0)}_{${at(1)}}`;
		case 'msubsup':
			return `${at(0)}_{${at(1)}}^{${at(2)}}`;
		case 'mfrac':
			return `(${at(0)})/(${at(1)})`;
		case 'msqrt':
			return `√(${kids.map(mmlNodeText).join('')})`;
		case 'mroot':
			return `√[${at(1)}](${at(0)})`;
		case 'munder':
			return `${at(0)}_{${at(1)}}`;
		case 'mover':
			return `${at(0)}^{${at(1)}}`;
		case 'munderover':
			return `${at(0)}_{${at(1)}}^{${at(2)}}`;
		case 'mspace':
			return ' ';
		default:
			// math / mrow / mstyle / 未知节点：顺序拼接
			return kids.map(mmlNodeText).join('');
	}
}

/**
 * 结构化 DOM 遍历：提取文本与图片 URL。
 *
 * 替代旧的 `optimizationElementWithImage(...).innerText` 链路：
 * - 不改造 DOM、不读 innerText、不用正则。
 * - `text` 产出原始 URL 文本（URL 两侧加空格分隔，避免相邻 URL 拼接）。
 * - `images` 额外返回按文档顺序的 URL 数组，供 createImageSuggestion 跳过正则。
 * - 跳过 `display:none` 的元素（模拟 innerText 对非渲染节点的跳过）。
 * - 对 detached 元素（如 zhs 由 JSON HTML 构建的 div）同样适用。
 * - MathJax 公式（mjx-container）线性化为纯文本（见 {@link extractMathJaxText}）。
 */
export interface ExtractTextOptions {
	/** 仅收集满足条件的 img（如 zhs 选项需排除按钮图片） */
	imgFilter?: (img: HTMLImageElement) => boolean;
}

/** 解析 img 的真实地址，兼容懒加载属性与 srcset */
function resolveImageElementUrl(img: HTMLImageElement): string {
	const lazyAttrs = ['data-src', 'data-original', 'data-lazy-src', 'data-actualsrc', 'data-url'];
	const lazy = lazyAttrs.map((name) => canonicalImageUrl(img.getAttribute(name))).find(Boolean) || '';
	const loaded =
		img.complete && (img.naturalWidth > 0 || img.naturalHeight > 0) ? canonicalImageUrl(img.currentSrc || img.src) : '';
	if (loaded && (!lazy || img.naturalWidth > 2)) return loaded;
	if (lazy) return lazy;
	if (loaded) return loaded;
	const srcset = img.getAttribute('srcset') || '';
	for (const candidate of srcset.split(',')) {
		const url = canonicalImageUrl(candidate.trim().split(/\s+/)[0]);
		if (url && !url.startsWith('data:')) return url;
	}
	return canonicalImageUrl(img.getAttribute('src')) || loaded;
}

/** 只把有实际图形内容的 SVG 当作题目图片；图标/箭头等装饰性 SVG 跳过 */
function isMeaningfulQuestionSvg(svg: SVGElement): boolean {
	if (svg.closest('mjx-container, .MathJax, .katex, math')) return true;
	const classes = `${svg.getAttribute('class') || ''} ${svg.parentElement?.getAttribute('class') || ''}`;
	if (svg.getAttribute('aria-hidden') === 'true') return false;
	if (svg.getAttribute('role') === 'presentation') return false;
	if (/icon|arrow|check|radio|checkbox|chevron/i.test(classes)) return false;
	if (svg.getAttribute('role') === 'img') return true;
	const viewBox = (svg.getAttribute('viewBox') || '')
		.trim()
		.split(/[\s,]+/)
		.map(Number);
	if (viewBox.length === 4 && Number.isFinite(viewBox[2]) && Number.isFinite(viewBox[3])) {
		if (viewBox[2] <= 24 || viewBox[3] <= 24) return false;
	}
	return !!svg.querySelector('path,image,text,use,rect,circle,line,polyline,polygon');
}

function svgToDataUrl(svg: SVGElement): string {
	const clone = svg.cloneNode(true) as SVGElement;
	if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	const viewBox = svg.getAttribute('viewBox');
	if (viewBox && !clone.getAttribute('width') && !clone.getAttribute('height')) {
		const [, , w, h] = viewBox
			.trim()
			.split(/[\s,]+/)
			.map(Number);
		if (w > 0 && h > 0) {
			clone.setAttribute('width', String(w));
			clone.setAttribute('height', String(h));
		}
	}
	return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(clone))}`;
}

/**
 * 结构化 DOM 遍历：提取文本与图片节点，得到 QuestionDocument（parts/text/images/missingImages）。
 *
 * - 不改造 DOM、不读 innerText、不用正则提取图片。
 * - `text` 产出原始 URL 文本（URL 两侧加空格分隔，避免相邻 URL 拼接）。
 * - 图片保留文档顺序、坐标与来源，供 QuestionIR 分配 ID、布局与多模态传输。
 * - 跳过 `display:none` / `visibility:hidden` 的元素（模拟 innerText 对非渲染节点的跳过）。
 * - 对 detached 元素（如 zhs 由 JSON HTML 构建的 div）同样适用。
 * - MathJax 公式（mjx-container）线性化为纯文本（见 {@link extractMathJaxText}）。
 */
export function extractTextWithImages(root: HTMLElement, opts?: ExtractTextOptions): QuestionDocument {
	const parts: QuestionPart[] = [];
	const walk = (node: Node) => {
		if (node.nodeType === Node.TEXT_NODE) {
			appendQuestionPart(parts, questionTextPart(node.textContent || '', questionTextNodeBox(node)));
			return;
		}
		if (node.nodeType !== Node.ELEMENT_NODE) return;
		const el = node as HTMLElement;
		const tag = el.tagName;
		if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
		if (tag === 'IMG') {
			const img = el as HTMLImageElement;
			if (opts?.imgFilter && !opts.imgFilter(img)) return;
			const url = resolveImageElementUrl(img);
			if (url) {
				appendQuestionPart(parts, { kind: 'image', url, box: questionElementBox(img) ?? undefined, origin: 'img' });
			} else {
				appendQuestionPart(parts, {
					kind: 'missing-image',
					reason: 'IMG 缺少有效资源',
					box: questionElementBox(img) ?? undefined
				});
			}
			return;
		}
		// MathJax v3 SVG 公式（zhs 等平台公式题的新渲染方式）：线性化为纯文本，不再递归内部 SVG
		if (tag === 'MJX-CONTAINER') {
			const formula = extractMathJaxText(el);
			if (formula) appendQuestionPart(parts, questionTextPart(` ${formula} `));
			return;
		}
		if (tag === 'BR') {
			appendQuestionPart(parts, questionTextPart('\n'));
			return;
		}
		if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
		if (tag === 'CANVAS') {
			const canvas = el as HTMLCanvasElement;
			try {
				if (!canvas.width || !canvas.height) throw new Error('画布尺寸为空');
				appendQuestionPart(parts, {
					kind: 'image',
					url: canvas.toDataURL('image/png'),
					box: questionElementBox(canvas) ?? undefined,
					origin: 'canvas'
				});
			} catch {
				appendQuestionPart(parts, {
					kind: 'missing-image',
					reason: 'Canvas 无法截图',
					box: questionElementBox(canvas) ?? undefined
				});
			}
			return;
		}
		if (tag === 'SVG') {
			const svg = el as unknown as SVGElement;
			if (!isMeaningfulQuestionSvg(svg)) return;
			try {
				appendQuestionPart(parts, {
					kind: 'image',
					url: svgToDataUrl(svg),
					box: questionElementBox(svg) ?? undefined,
					origin: 'svg'
				});
			} catch {
				appendQuestionPart(parts, {
					kind: 'missing-image',
					reason: 'SVG 无法序列化',
					box: questionElementBox(svg) ?? undefined
				});
			}
			return;
		}
		// 跳过 display:none / visibility:hidden（仅对已挂载元素；detached 元素 getComputedStyle 返回空，不跳过）
		try {
			const view = el.ownerDocument?.defaultView;
			if (view && el.isConnected) {
				const style = view.getComputedStyle(el);
				if (style.display === 'none' || style.visibility === 'hidden') return;
			}
		} catch {
			// 忽略
		}
		for (const child of Array.from(el.childNodes)) walk(child);
	};
	walk(root);
	return summarizeQuestionParts(parts);
}

/** 选项仅剩标签（A./①）时可继续查找 CSS 背景图 */
const CHOICE_LABEL_ONLY = /^(?:[A-Z]{1,2}|[①②③④⑤⑥⑦⑧])\s*[.．、:：)）]?$/i;

function imageUrlFromCssBackground(el: HTMLElement): string {
	try {
		const view = el.ownerDocument?.defaultView;
		if (!view) return '';
		const style = view.getComputedStyle(el);
		if (style.display === 'none' || style.visibility === 'hidden') return '';
		const rect = el.getBoundingClientRect();
		if (rect.width < 24 || rect.height < 24) return '';
		const match = /url\((['"]?)(.*?)\1\)/i.exec(style.backgroundImage || '');
		return match ? canonicalImageUrl(match[2]) : '';
	} catch {
		return '';
	}
}

/**
 * 平台返回值（string / {text, images}）缺少图片节点时，用真实 DOM 补齐。
 * DOM 与平台文本一致时以 DOM 为准（这样图片才能拿到坐标与文档顺序）。
 */
function augmentMissingQuestionMedia(result: any, nodes: (HTMLElement | null | undefined)[]): QuestionDocument {
	const given = normalizeQuestionTransform(result);
	// 已带 parts / 显式 images 的结果由平台自行保证顺序，不再用 DOM 重新推断。
	if (result && typeof result === 'object' && (Array.isArray(result.parts) || Array.isArray(result.images))) {
		return given;
	}
	const domParts: QuestionPart[] = [];
	for (const node of nodes) {
		if (!node) continue;
		for (const part of extractTextWithImages(node).parts) appendQuestionPart(domParts, part);
	}
	const dom = summarizeQuestionParts(domParts);
	if (!hasQuestionMedia(dom)) return given;
	const recombined = splitLegacyQuestionText(given.text || '', dom.images);
	const givenWords = normalizeQuestionWords(recombined.text);
	if (!givenWords) return dom;
	const domWords = normalizeQuestionWords(dom.text);
	if (givenWords === domWords || domWords.includes(givenWords)) return dom;
	// 平台文本与 DOM 文本不一致：保留平台文本，仅补齐其中没有的图片。
	const parts: QuestionPart[] = [...recombined.parts];
	for (const part of dom.parts) {
		if (part.kind === 'image' && !recombined.images.includes(part.url)) appendQuestionPart(parts, part);
	}
	return summarizeQuestionParts(parts);
}

/** 提取单个选项文档；图片选项可能只有 CSS 背景图或空文本 */
function extractChoiceDocument(node: HTMLElement, override?: any): QuestionDocument {
	const doc = override === undefined ? extractTextWithImages(node) : augmentMissingQuestionMedia(override, [node]);
	if (hasQuestionMedia(doc)) return doc;
	const semantic = `${node.className || ''} ${node.getAttribute('role') || ''}`;
	if (!CHOICE_LABEL_ONLY.test(doc.text.trim()) && !/image|picture|photo|diagram|thumbnail|figure|pic/i.test(semantic)) {
		return doc;
	}
	const parts: QuestionPart[] = [...doc.parts];
	const candidates = [node, ...Array.from(node.querySelectorAll<HTMLElement>('*')).slice(0, 40)];
	for (const el of candidates) {
		const url = imageUrlFromCssBackground(el);
		if (url && !parts.some((p) => p.kind === 'image' && p.url === url)) {
			appendQuestionPart(parts, {
				kind: 'image',
				url,
				box: questionElementBox(el) ?? undefined,
				origin: 'css-background'
			});
		}
	}
	return summarizeQuestionParts(parts);
}

/**
 * 将 {@link WorkResult} 转换成 {@link SimplifyWorkResult}
 *
 * 仅支持单个结果转换；多个结果请使用 `[].map((r) => simplifyWorkResult(r, ...))`
 *
 * @param titleTransform 标题处理方法：在答题时使用相同的处理方法，可以使答题结果显示的题目与搜题的题目保持一致
 * @param index 题目序号（作为 titleTransform 的第二个参数），默认 0
 */
export function simplifyWorkResult(
	wr: WorkResult<any>,
	titleTransform?: (title: (HTMLElement | undefined)[], index: number) => string,
	index = 0
): SimplifyWorkResult {
	const question =
		titleTransform?.(wr.ctx?.elements.title || [], index) ||
		wr.ctx?.elements.title
			?.map((e) => e?.innerText.trim())
			.filter(Boolean)
			.join('<br>') ||
		'';
	return {
		requested: wr.requested,
		searching: wr.searching,
		resolved: wr.resolved,
		error: wr.error,
		type: wr.ctx?.type,
		question,
		finish: wr.result?.finish,
		searchInfos:
			wr.ctx?.searchInfos.map((sr) => ({
				error: sr.error,
				name: sr.name,
				homepage: sr.homepage,
				results: sr.results.map((ans) => [ans.question, ans.answer, ans.extra_data || {}])
			})) || []
	};
}

/**
 * 动态答题器结果 upsert：检测到题目即在结果面板占位（等待搜索中），
 * 随后每次状态推进（等待答题中→已答题/失败）原地更新。
 * 供动态流程（一题一题加载）的 onQuestionDetected 与 onResultsUpdate 共同调用，
 * 解决全部流程结束后才显示结果、用户对过程无感知的问题。
 */
export function updateDynamicResult(
	current: WorkResult<any>,
	titleTransform?: (title: (HTMLElement | undefined)[], index: number) => string
) {
	return CommonProject.scripts.workResults.methods.append(simplifyWorkResult(current, titleTransform));
}

/**
 * 从题目中移除指定的冗余词
 */
export function removeRedundantWords(str: string, words: string[]) {
	for (const word of words.map((w) => w.trim())) {
		str = str.replace(word, '');
	}
	return str;
}

let answererWrapperUnsetMessage: MessageElement | undefined;

export const answerWrapperEmptyWarning = cors.defineTopFunction((duration: number) => {
	const setting = h('button', { className: 'base-style-button-secondary' }, '通用-全局设置');
	setting.onclick = () => {
		BackgroundProject.scripts.render.methods.pin(CommonProject.scripts.settings);
		setTimeout(() => {
			$elements.root?.querySelector<HTMLElement>('[value="点击配置"]')?.click();
		}, 500);
	};

	answererWrapperUnsetMessage?.remove();
	answererWrapperUnsetMessage = $message.warn({
		content: h('span', {}, ['你还没设置题库，无法自动答题，请切换到 ', setting, ' 页面进行配置。']),
		duration: duration
	});
});

export const closeAnswerWrapperEmptyWarning = cors.defineTopFunction(() => {
	console.log(answererWrapperUnsetMessage);
	answererWrapperUnsetMessage?.remove();
	answererWrapperUnsetMessage = undefined;
});

/**
 * 创建通用的 answerer 回调，封装搜题缓存、延迟、QuestionIR 构建与多模态题库选择。
 *
 * - 题干/选项优先从真实 DOM 提取（含图片、坐标、顺序），平台自定义文本仅作补充。
 * - 图片题必须开启「图片题优化」且题库为支持图片的 POST 配置，否则直接报错，绝不静默降级。
 * - 图片题的缓存不可靠（不同图片可以同名），因此跳过缓存；纯文本题仍走缓存。
 *
 * @param options.titleTransform 标题转换函数，接收 (elements, ctx)，返回字符串或 {text, images}
 * @param options.optionsTransform 选项转换函数（可选），仅用于与选项 DOM 做一致性校验
 * @param options.choiceTransform 单个选项的转换函数（可选），返回字符串或 {text, images}
 * @param options.answererWrappers 题库配置
 * @param options.period 搜题间隔（秒），默认 3
 */
export function createCommonAnswerer(options: {
	titleTransform: (elements: any, ctx: WorkContext<any>) => string | { text: string; images?: string[] };
	optionsTransform?: (elements: any, ctx: WorkContext<any>) => string | { text: string; images?: string[] };
	choiceTransform?: (
		node: HTMLElement,
		index: number,
		ctx: WorkContext<any>
	) => string | { text: string; images?: string[] } | undefined;
	answererWrappers: AnswererWrapper[];
	period?: number;
}) {
	/** 同一脚本内图片错误只提示一次，避免逐题刷屏 */
	let mediaErrorWarned = false;
	const normalize = (
		v: string | { text: string; images?: string[] } | undefined
	): { text: string; images?: string[] } => {
		if (v == null) return { text: '' };
		return typeof v === 'string' ? { text: v } : v;
	};

	return async (elements: any, ctx: WorkContext<any>): Promise<SearchInformation[]> => {
		const titleNodes: HTMLElement[] = (elements.title ?? []).filter((node: any) => node && node.nodeType === 1);
		const stem = augmentMissingQuestionMedia(options.titleTransform(elements, ctx), titleNodes);
		if (!stem.text.trim() && !hasQuestionMedia(stem)) {
			throw new Error('题干没有文字或图片，无法继续答题');
		}

		const optionNodes: HTMLElement[] = (elements.options ?? []).filter((node: any) => node && node.nodeType === 1);
		const legacyOptions = normalize(
			options.optionsTransform
				? options.optionsTransform(elements, ctx)
				: optionNodes.map((node) => node.innerText).join('\n')
		);
		const choiceDocs = optionNodes.map((node, index) =>
			extractChoiceDocument(node, options.choiceTransform?.(node, index, ctx))
		);

		// 选项文本聚合后出现、但无法归属到具体选项的图片，不能猜测归属。
		const legacyDoc = normalizeQuestionTransform(legacyOptions);
		const legacyMediaCount = legacyDoc.parts.filter((part) => part.kind !== 'text').length;
		const optionMediaCount = choiceDocs.reduce(
			(sum, doc) => sum + doc.parts.filter((part) => part.kind !== 'text').length,
			0
		);
		if (legacyMediaCount > optionMediaCount) {
			throw new Error(`选项中有 ${legacyMediaCount - optionMediaCount} 张图片无法确定属于哪个选项，已停止答题`);
		}
		if (legacyDoc.missingImages > 0 && !choiceDocs.some((doc) => doc.missingImages > 0)) {
			throw new Error('平台解析到选项有图片未加载，已停止答题');
		}

		const ir = makeQuestionIR({
			type: ctx.type,
			stem,
			choices: choiceDocs,
			optionNodes,
			stemNodes: titleNodes
		});
		ctx.questionIR = ir;

		const imageOptimize = !!CommonProject.scripts.settings.cfg.imageOptimize;
		const hasMedia = ir.hasMedia || ir.missingImages > 0;
		if (hasMedia && !imageOptimize) {
			throw new Error('图片题必须开启全局设置中的「图片题优化」，本题已取消纯文本发送');
		}

		let wrappers = options.answererWrappers;
		if (hasMedia) {
			wrappers = wrappers.filter(isAnswererWrapperSupportImageOptimize);
			if (wrappers.length === 0) {
				throw new Error('当前题库配置没有上传图片，请配置支持 images 或 rich_content 的多模态 POST 请求');
			}
		}

		const search = async (): Promise<SearchInformation[]> => {
			await $.sleep((options.period ?? 3) * 1000);
			try {
				const { env } = await buildAnswererEnv({ question: ir, enableImageOptimize: imageOptimize });
				return await defaultAnswerWrapperHandler(wrappers, env);
			} catch (e: any) {
				if (!mediaErrorWarned) {
					mediaErrorWarned = true;
					$message.warn({ content: e?.message || String(e), duration: 10 });
				}
				throw e;
			}
		};

		// 不同图片可以拥有相同题干文字，图片题不能使用文本缓存。
		if (hasMedia) return await search();
		return await BackgroundProject.scripts.data.methods.searchAnswerInCaches(stem.text.trim(), search);
	};
}

/** 创建答题预处理信息 */
function workPreCheckMessage(
	options: CommonWorkOptions & {
		start_delay_seconds?: number;
		onrun: (opts: CommonWorkOptions) => void;
		/**
		 * 当没有题库配置时的回调
		 */
		onNoAnswererWrappers?: (opts: CommonWorkOptions) => void;
		/**
		 * 手动关闭时的回调
		 */
		onclose?: (opts: CommonWorkOptions, closedMessage: MessageElement) => void;
	}
) {
	const { onrun, onNoAnswererWrappers, onclose, ...opts } = options;

	if (opts.answererWrappers.length === 0) {
		onNoAnswererWrappers?.(opts);
		return answerWrapperEmptyWarning(0);
	} else {
		options.start_delay_seconds = options.start_delay_seconds ?? 5;
		return $message.info({
			duration: options.start_delay_seconds,
			content: h('span', [
				`将在 ${options.start_delay_seconds} 秒后自动答题，`,
				$ui.preventText({
					name: '点击取消',
					delay: options.start_delay_seconds,
					ondefault: (span) => {
						onrun(opts);
					},
					onprevent(span) {
						const closedMessage = $message.warn({
							content: '已关闭此次的自动答题，请手动开启或者忽略此警告。',
							duration: 0
						});
						if (closedMessage) {
							onclose?.(opts, closedMessage);
						}
					}
				})
			])
		});
	}
}
