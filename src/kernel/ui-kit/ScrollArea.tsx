import type {
  CSSProperties,
  ReactElement,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 纵向滚动区 + 覆盖式自绘细滑块（§10.6）。
 *
 * 为什么不用系统滚动条：6px 的 ::-webkit-scrollbar 已经是下限，但它**永远占着**
 * 那 6px 的槽位 —— 面板总共 360px 宽，素材清单被吃掉 6px 就是缩略图少一排。
 * 这里换成 3px 覆盖式滑块：不占布局宽度，只在悬停/滚动时出现，静止 800ms 后淡出。
 *
 * 内层的 overflowY 与 overscrollBehavior **必须内联**，两个原因：
 * ① Panel 的既有测试（shell.test.tsx）按 style.overflowY === 'auto' 找滚动区，
 *    外壳换成组件但不许改这条契约；
 * ② overscroll-behavior: contain 是滚动隔离（§10.5）—— 在面板里滚到底不能带着页面一起滚。
 *
 * 自绘滑块只能"看"：滚动仍然是内层的原生行为，滚轮、方向键、PageUp/PageDown、
 * 触屏惯性一概不拦；滑块 aria-hidden，读屏器要的语义和键盘落点都在内层 div 上。
 */
export interface ScrollAreaProps {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** 滚动区无障碍名，面板会把「素材清单」之类传进来 */
  label?: string;
}

/** 滑块最小高度：3px 宽已经很细，再短就既点不中也看不出比例 */
const THUMB_MIN_HEIGHT = 24;

/** 滑动/悬停结束到淡出的间隔：够读完一行再退场，又不至于一直挂在视线里 */
const FADE_DELAY = 800;

/** 滑块高度：可见部分占内容的比例；最小 24px 是"还能按住拖"的下限，也不能超过容器本身 */
function thumbHeight(clientH: number, scrollH: number): number {
  // +1：缩放过的页面里 clientHeight/scrollHeight 是小数，差一像素不该冒出滑块
  if (clientH <= 0 || scrollH <= clientH + 1) return 0;
  return Math.min(clientH, Math.max(THUMB_MIN_HEIGHT, (clientH * clientH) / scrollH));
}

/** 渲染滑块要用的三个量：内层高度、内容总高、当前滚动位置 */
interface Metrics {
  clientH: number;
  scrollH: number;
  scrollTop: number;
}

/** 拖拽期间不变的量：按下时抓一次，中途就算重新布局也不让滑块跳 */
interface DragState {
  pointerId: number;
  startY: number;
  startScrollTop: number;
  /** 滑块能走的行程 = 内层高度 − 滑块高度 */
  travel: number;
  /** 可滚动范围 = 内容总高 − 内层高度 */
  maxScroll: number;
}

export function ScrollArea(props: ScrollAreaProps): ReactElement {
  const { children, className, style, label } = props;

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState<Metrics>({ clientH: 0, scrollH: 0, scrollTop: 0 });
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** 刚滚过（还在 800ms 的显隐窗口里） */
  const [scrolledRecently, setScrolledRecently] = useState(false);

  const frameRef = useRef<number | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<DragState | null>(null);

  /**
   * 量一次内层并把结果写进状态。
   *
   * 值没变时返回 prev：不溢出时滚动事件照样会来，React 拿到同一个对象直接 bail out，
   * 不会为一个"没有滑块可画"的滚动区白渲染。
   * 不碰 frameRef —— 它由 scheduleMeasure 负责，直接调（首帧）时那条账不该被改。
   */
  const measure = useCallback((): void => {
    const view = viewportRef.current;
    if (view === null) return;
    const clientH = view.clientHeight;
    const scrollH = view.scrollHeight;
    const scrollTop = view.scrollTop;
    setMetrics((prev) =>
      prev.clientH === clientH && prev.scrollH === scrollH && prev.scrollTop === scrollTop
        ? prev
        : { clientH, scrollH, scrollTop },
    );
  }, []);

  /**
   * 一帧最多量一次。
   *
   * 滚动事件在一帧里能来好几次（高刷屏、精密触控板），每次都 setState 是白渲染；
   * 用 rAF 把同一帧压成一次，滑块只跟渲染帧对齐，手感不变。
   */
  const scheduleMeasure = useCallback((): void => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      measure();
    });
  }, [measure]);

  /** 重置淡出倒计时：每次滚动都往后推，连续滑动期间滑块不会自己消失 */
  const scheduleFade = useCallback((): void => {
    if (fadeTimerRef.current !== null) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      fadeTimerRef.current = null;
      setScrolledRecently(false);
    }, FADE_DELAY);
  }, []);

  const handleScroll = useCallback((): void => {
    scheduleMeasure();
    // 同值 setState 只走一次 bail out，开销可以忽略，换来的是"滚动时一定亮着"这条简单规则
    setScrolledRecently(true);
    scheduleFade();
  }, [scheduleMeasure, scheduleFade]);

  const { clientH, scrollH, scrollTop } = metrics;
  const thumbH = thumbHeight(clientH, scrollH);
  const overflow = thumbH > 0;
  const travel = Math.max(0, clientH - thumbH);
  const maxScroll = Math.max(0, scrollH - clientH);
  const clampedScrollTop = Math.min(Math.max(scrollTop, 0), maxScroll);
  const thumbTop = travel === 0 || maxScroll === 0 ? 0 : (clampedScrollTop / maxScroll) * travel;

  const handleThumbPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>): void => {
    // 只认主键：右键菜单/中键粘贴不该让滑块跟着走
    if (event.button !== 0) return;
    const view = viewportRef.current;
    if (view === null) return;
    // 按在滑块上默认会开始选文字，拖到面板外还会选到页面内容，先掐掉
    event.preventDefault();
    /*
     * 现场重新量，而不是用上一次渲染的值：按下前一刻可能刚做完一次布局
     * （素材加载完、面板被拖动改高），用旧值换算会让滑块"咬不住"手指。
     */
    const nextClientH = view.clientHeight;
    const nextScrollH = view.scrollHeight;
    const nextThumbH = thumbHeight(nextClientH, nextScrollH);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScrollTop: view.scrollTop,
      travel: Math.max(0, nextClientH - nextThumbH),
      maxScroll: Math.max(0, nextScrollH - nextClientH),
    };
    setDragging(true);
    // 拖拽期间不能淡出：正拖着的时候滑块消失是最难受的一种"手滑"
    if (fadeTimerRef.current !== null) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // 没有真实指针的环境（测试、合成事件）会抛 InvalidStateError，下面对 document 的监听照样能拖
    }
  }, []);

  const endDrag = useCallback((): void => {
    dragRef.current = null;
    setDragging(false);
    // 松手和"滚完一段"一样收尾：静止 800ms 再淡出，别一撒手就没了
    setScrolledRecently(true);
    scheduleFade();
  }, [scheduleFade]);

  // 首帧就量：等 ResizeObserver 的第一次回调会先画出一帧没有滑块、或高度算错的画面
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const view = viewportRef.current;
    if (view === null) return;
    /*
     * 两样都观察：
     * · 内层 —— 面板高度变了（窗口 resize、视图切换）
     * · 内容 —— 素材增删、缩略图加载完后行高变化。这时内层高度没变，
     *   只观察内层会一直用旧比例，滑块长度就是错的。
     */
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(view);
    if (contentRef.current !== null) observer.observe(contentRef.current);
    return () => observer.disconnect();
  }, [scheduleMeasure]);

  // 拖拽期间的移动/松手挂在 document 上：指针滑出滑块（甚至滑出面板）也要继续跟手，
  // 这正是 setPointerCapture 在真实浏览器里的效果；捕获不可用的环境靠这里兜底
  useEffect(() => {
    if (!dragging) return;
    const onMove = (event: PointerEvent): void => {
      const drag = dragRef.current;
      const view = viewportRef.current;
      if (drag === null || view === null || event.pointerId !== drag.pointerId) return;
      // 滑块行程为 0（内容刚好一屏）时没有可换算的比例，直接不动
      if (drag.travel <= 0) return;
      /*
       * 按"滑块行程"换算，而不是直接按 scrollHeight 比例：滑块走到头必须正好是内容到底，
       * 最小高度 24px 会让纯比例换算在底部差一截（长内容时尤其明显）。
       */
      const next =
        drag.startScrollTop + ((event.clientY - drag.startY) / drag.travel) * drag.maxScroll;
      view.scrollTop = Math.max(0, Math.min(drag.maxScroll, next));
    };
    const onUp = (event: PointerEvent): void => {
      if (event.pointerId !== dragRef.current?.pointerId) return;
      endDrag();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, endDrag]);

  // 卸载清理：面板反复开关，残留的 rAF 会对已卸载组件 setState，
  // 残留的定时器还会在关闭之后把滑块"点亮"一次
  useEffect(
    () => () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
      if (fadeTimerRef.current !== null) clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
      dragRef.current = null;
    },
    [],
  );

  return (
    <div
      className={className === undefined ? 'ec-scroll' : `ec-scroll ${className}`}
      style={style}
      // 悬停整块滚动区就亮起：滑块只有 3px 宽，鼠标几乎不可能正好落在它上面
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: 这里只是把原生滚动包起来，不是文档分节 ——
          换成 <section> 就等于告诉读屏器「这是一个分区」，而我们要的是「这个滚动区叫什么名字」。
          另外 Panel 的既有测试按 div + style.overflowY 找滚动区，改标签会一起改掉契约。 */}
      <div
        ref={viewportRef}
        className="ec-scroll__viewport"
        role="region"
        aria-label={label}
        onScroll={handleScroll}
        // 内联而不是写样式表：见文件头注释 ①②
        style={{ overflowY: 'auto', overscrollBehavior: 'contain' }}
      >
        {/* 单独一层内容容器：ResizeObserver 需要一个稳定目标，children 可能是任意节点 */}
        <div ref={contentRef}>{children}</div>
      </div>

      {overflow ? (
        <div
          className="ec-scroll__thumb"
          // 纯装饰：读屏器念"滑块"没有意义，滚动位置由内容本身表达
          aria-hidden="true"
          data-visible={dragging || hovered || scrolledRecently ? 'true' : 'false'}
          data-dragging={dragging ? 'true' : undefined}
          onPointerDown={handleThumbPointerDown}
          // 几何值只走内联：位置必须逐帧跟手，任何 CSS 过渡都会变成"慢半拍"
          style={{ height: thumbH, top: thumbTop }}
        />
      ) : null}
    </div>
  );
}
