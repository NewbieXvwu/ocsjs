import { SearchInformation } from '../answer-wrapper/interface';

export type ElementResolver<R> = (root: HTMLElement | Document) => R;
export type RawElements = Record<
	string | symbol,
	string | ElementResolver<(HTMLElement | null | undefined)[]> | ElementResolver<HTMLElement | null | undefined>[]
> & {
	/** 题目元素选择器 */
	title?:
		| string
		| ElementResolver<(HTMLElement | null | undefined)[]>
		| ElementResolver<HTMLElement | null | undefined>[];
	/** 题目选项的元素选择器 */
	options?:
		| string
		| ElementResolver<(HTMLElement | null | undefined)[]>
		| ElementResolver<HTMLElement | null | undefined>[];
};

export type SearchedElements<E, T> = Record<keyof E, T> & {
	/** 题目元素选择器 */
	title?: T extends Array<infer ArrayType> ? (undefined | ArrayType)[] : T;
	/** 题目选项的元素选择器 */
	options?: T extends Array<infer ArrayType> ? (undefined | ArrayType)[] : T;
};

/** 题目类型 */
export type QuestionTypes = 'single' | 'multiple' | 'completion' | 'judgement' | undefined;

export type AnswerMatchMode = 'exact' | 'similar';

/** 页面坐标（CSS 像素），来源于真实 DOM 的 getBoundingClientRect */
export interface QuestionBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * 题目文档中的一个有序片段。
 * 文本与图片必须保持原有先后顺序，图片片段可携带稳定的图片 ID。
 */
export type QuestionPart =
	| { kind: 'text'; text: string; box?: QuestionBox }
	| {
			kind: 'image';
			url: string;
			box?: QuestionBox;
			/** 例如 Q-1 / A-1，由 makeQuestionIR 统一分配 */
			imageId?: string;
			/** 在所属题干/选项内的序号（从 1 开始） */
			localIndex?: number;
			/** 图片来源：img / canvas / svg / css-background */
			origin?: string;
	  }
	| { kind: 'missing-image'; reason?: string; box?: QuestionBox };

/** 题干或某个选项的文本/图片文档 */
export interface QuestionDocument {
	parts: QuestionPart[];
	text: string;
	images: string[];
	missingImages: number;
	box?: QuestionBox | null;
}

/** 选项 IR：选项代号即答题标识，node 仅用于最终点击，不发送给模型 */
export interface QuestionChoice {
	id: string;
	index: number;
	node?: HTMLElement;
	box?: QuestionBox | null;
	document: QuestionDocument;
}

/** 归一化到 0-1000 的相对坐标 */
export interface QuestionRelativeBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface QuestionLayoutSection {
	id: string;
	box: QuestionBox | null;
	relative: QuestionRelativeBox | null;
}

export interface QuestionLayoutImage {
	id?: string;
	section: string;
	box: QuestionBox | null;
	relative: QuestionRelativeBox | null;
}

export interface QuestionLayout {
	scene: QuestionBox | null;
	/** 只有真实 DOM 坐标足够可靠时才为 true，否则不发送推测坐标 */
	geometryReady: boolean;
	complex: boolean;
	sections: QuestionLayoutSection[];
	images: QuestionLayoutImage[];
}

/**
 * QuestionIR v3：文本与图片的顺序、图片归属与页面位置在提取和请求之间保持不变。
 */
export interface QuestionIR {
	version: 3;
	type: QuestionTypes;
	stem: QuestionDocument;
	choices: QuestionChoice[];
	imageIds: string[];
	hasMedia: boolean;
	missingImages: number;
	layout?: QuestionLayout;
}

/** 答题器上下文 */
export interface WorkContext<E> {
	root: HTMLElement;
	elements: SearchedElements<E, HTMLElement[]>;
	searchInfos: SearchInformation[];
	type: QuestionTypes;
	/** 答案分隔符 */
	answerSeparators?: string[];
	/** 由 createCommonAnswerer 构建的结构化题目；老平台/自定义工作器可能为空 */
	questionIR?: QuestionIR;
}

/** 答案题目处理器结果 */
export interface ResolverResult {
	[x: string]: any;
	finish: boolean;
}

/** 答题结果 */
export interface WorkResult<E extends RawElements> {
	/** 查题完毕 */
	requested: boolean;
	/** 正在搜题中（查题线程已启动但尚未返回，供结果面板显示等待动画） */
	searching?: boolean;
	/** 答题完毕 */
	resolved: boolean;
	result?: ResolverResult;
	error?: string;
	ctx?: WorkContext<E>;
}

/**
 * 简化的答题结果 一般用于存储到本地
 *
 * 为什么不直接用 {@link WorkResult} ，因为对象里太多嵌套对象，一旦结果超过10个以上，可能导致 I/O 变慢，并且页面卡顿。
 */
export interface SimplifyWorkResult {
	/** 题目 */
	question: string;
	/** 题目类型 */
	type: QuestionTypes;
	/** 答题错误信息 */
	error?: string;
	/** 是否完成 */
	finish?: boolean;
	/** 正在等待 查题 线程处理 */
	requested: boolean;
	/** 正在搜题中（供结果面板显示等待动画） */
	searching?: boolean;
	/** 正在等待 答题 线程处理 */
	resolved: boolean;
	/** 查题信息 */
	searchInfos: {
		/** 题目名 */
		name: SearchInformation['name'];
		/** 题库链接 */
		homepage?: SearchInformation['homepage'];
		/** 题库搜索错误信息 */
		error?: string;
		/** 搜索结果 [题目，答案，额外数据] */
		results: [string, string, object][];
	}[];
}

/** 答案题目处理器 */
export type QuestionResolver<E> = (
	/** 查题信息 */
	searchInfos: SearchInformation[],
	/** 选项 */
	options: HTMLElement[],
	handler: (
		type: QuestionTypes,
		answer: string,
		option: HTMLElement,
		ctx: WorkContext<SearchedElements<E, HTMLElement[]>>
	) => void | Promise<void>
) => Promise<ResolverResult>;

/**
 * 使用默认工作器
 *
 * 需要自定义 handler
 */
export interface DefaultWork<E extends RawElements> {
	/** 工作器的题目类型 */
	type?: QuestionTypes | { (ctx: WorkContext<E>): QuestionTypes };
	/**
	 * 选项文本提供器：替代默认 `o.innerText`。
	 * 图片题等场景下 innerText 无法获取 img 的 URL，需由调用方通过 DOM 遍历提供。
	 * 不传则回退到 `o.innerText`。
	 */
	optionText?: (el: HTMLElement, i: number) => string;
	/**
     * 处理器， 每个题目的处理器， 实例可看默认的 zhs `作业脚本` 写法 : https://github.com/ocsjs/ocsjs/blob/3.0/packages/scripts/src/browser/zhs/work.ts
     *
     *
     * @param type 题目类型
     * @param answer 根据 查题器 解析出来的正确答案，
     * @param element 目标选项的dom对象
     *
     * @example
     *
     * ```js
    {
        elements:{
            // 必须提供 options 元素选择器，代表题目的子选项
            options: '.subject .option'
        },
        work: {
            // 自定义处理器例子：
            handler(type, answer, option, ctx) {
                // 如果是选择题，则获取目标按钮，并点击
                if (type === "judgement" || type === "single" || type === "multiple") {
                    if (!option.querySelector("input")?.checked) {
                        option.click();
                    }
                }
                // 如果是填空题，则获取 textarea 元素并输入答案
                else if (type === "completion") {
                    const text = option.querySelector("textarea");
                    if (text) {
                        text.value = answer;
                    }
                }
            },
        },
    }
     * ```
     *
     */
	handler: (
		type: QuestionTypes,
		answer: string,
		option: HTMLElement,
		ctx: WorkContext<SearchedElements<E, HTMLElement[]>>
	) => void;
}
/**
 * 自定义工作器
 *
 * 如果默认工作器不满足需求，可以自定义
 *
 * ```js
 *
 * {
 *      elements:{
 *          inputs: 'input',
 *      },
 *      // 简单例子
 *      work({ root, elements, searchResults}){
 *          for(const input of elements.inputs){
 *              if(searchResults.map(res=>res.answers.map(ans=>ans.answer)).includes(input.value)){
 *                  input.click()
 *                  return true
 *              }
 *          }
 *          return false
 *      }
 *
 * }
 *
 * ```
 *
 */
export type CustomWork<E extends RawElements> = (ctx: WorkContext<E>) => Promise<ResolverResult>;

/**  查题器的类型  */

export type AnswererType<E> = (
	elements: SearchedElements<E, HTMLElement[]>,
	ctx: WorkContext<SearchedElements<E, HTMLElement[]>>
) => SearchInformation[] | Promise<SearchInformation[]>;

/**
 * 元素观察器配置：root 元素从界面消失时自动关闭答题器
 */
export interface RootObserverOptions {
	/** 是否启用（默认 false，不传配置则完全不启用，向后兼容） */
	enabled?: boolean;
	/** 检测间隔（毫秒），默认 1000 */
	checkIntervalMs?: number;
	/**
	 * root 元素持续消失多少毫秒后判定为丢失（默认 3000）。
	 * 必须大于框架重渲染/正常切题的元素重建时间，防止瞬时脱离误判。
	 */
	lostTimeoutMs?: number;
	/** 判定丢失时的回调（在关闭答题器之前触发，可用于自定义提示） */
	onRootLost?: () => void;
}

/**
 * 答题器参数
 */
export interface WorkOptions<E extends RawElements> {
	/** 父元素 */
	root: string | HTMLElement[];
	/** dom元素解析器，可以在 WorkContext.elements 中使用解析后的元素 */
	elements: E;
	/** 查题器 */
	answerer: AnswererType<E>;
	/** 工作器 */
	work: DefaultWork<E> | CustomWork<E>;
	/** 多线程数量（个） */
	thread?: number;
	/** 分隔符 */
	answerSeparators?: string[];
	/**
	 * 元素观察器：root 元素从界面消失（如 location.hash 跳转、SPA 页面切换，
	 * 但脚本沙盒未重置、答题程序仍在运行）时，自动触发 close 关闭答题并弹出警告。
	 */
	rootObserver?: RootObserverOptions;
	/** 当元素被搜索到 */
	onElementSearched?: (elements: SearchedElements<E, HTMLElement[]>, root: HTMLElement) => void | Promise<void>;
	/**
	 * 题目检测到（加入待答队列）时的回调，早于搜题与 onResultsUpdate。
	 * 可用于在结果面板中提前展示占位（"等待搜索中"状态），
	 * 解决动态答题器（一题一题加载）全部流程结束后才显示结果、用户无感知的问题。
	 */
	onQuestionDetected?: (currentResult: WorkResult<E>, res: WorkResult<E>[]) => void | Promise<void>;
	/**
	 * 元素准备完毕、即将开始答题时回调（仅一次，此时全部为 未搜题/未答题 的初始状态）。
	 * 供结果面板一次性初始化全部题目列表（如 fillAll），
	 * 与 onResultsUpdate（搜题/答题过程中逐题多次触发）相互独立。
	 */
	onResultsInit?: (currentResult: WorkResult<E>, currentIndex: number, res: WorkResult<E>[]) => void | Promise<void>;
	/** 监听搜题结果 */
	onAnswerSearched?: (
		searchInfo: SearchInformation,
		currentResult: WorkResult<E>,
		currentIndex: number
	) => void | Promise<void>;
	/** 监听答题结果 */
	onResultsUpdate?: (currentResult: WorkResult<E>, currentIndex: number, res: WorkResult<E>[]) => void | Promise<void>;
}

export interface CustomWorkOptions {
	period: number;
	questions: () => { text: string; type: QuestionTypes }[] | Promise<{ text: string; type: QuestionTypes }[]>;
	answerer: (question: string) => SearchInformation[] | Promise<SearchInformation[]>;
	resolver: (searchInfos: SearchInformation[]) => ResolverResult | Promise<ResolverResult>;

	/** 监听答题结果 */
	onResultsUpdate?: (
		currentResult: SimplifyWorkResult,
		currentIndex: number,
		res: SimplifyWorkResult[]
	) => void | Promise<void>;
}

export type WorkUploadType = 'save' | 'nomove' | 'force' | number;

export type WorkerEvents = {
	/** 答题开始 */
	start: () => void;
	/** 答题结果 */
	done: () => void;
	/** 关闭答题 */
	close: () => void;
	/** 暂停答题 */
	stop: () => void;
	/** 继续答题 */
	continuate: () => void;
};
