import { createContext, type ReactNode, useContext } from 'react';

/**
 * 弹层容器（§10.10「Radix 弹层默认挂在页面 body 上，没有样式」）。
 *
 * Radix 的 Tooltip / Popover 用 createPortal 挂到 document.body，
 * 而面板在 shadow root 里 —— 挂到 body 的节点拿不到 shadow 内的样式，
 * 结果就是一个没有样式的裸弹层。
 *
 * 解法：外壳挂载时把 shadow root 塞进这个 context，所有弹层组件的 Portal 容器
 * 都从这里取。没提供时退回 document.body（popup / options 这类独立页面没有 Shadow DOM）。
 */
const PortalContainerContext = createContext<HTMLElement | ShadowRoot | null>(null);

export interface PortalRootProps {
  /** 内容脚本里传 shadow root；独立页面不用传 */
  value?: HTMLElement | ShadowRoot;
  /** React 19 之后 children 仍走 props，但用 createElement 时可以当第三个参数传 */
  children?: ReactNode;
}

export function PortalRoot({ value, children }: PortalRootProps) {
  return (
    <PortalContainerContext.Provider value={value ?? null}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/** 弹层应该挂到哪里；null 表示让 Radix 用默认的 document.body */
export function usePortalContainer(): HTMLElement | ShadowRoot | null {
  return useContext(PortalContainerContext);
}

/**
 * 转成 Radix Portal 的 container prop。
 * Radix 接受 HTMLElement | DocumentFragment；ShadowRoot 是 DocumentFragment 的子类型，
 * 所以这里不需要分支判断 —— 直接透传即可（旧实现写了一个
 * \`container instanceof ShadowRoot ? container : container\` 的三元，两个分支返回同一个值，
 * 实际等价于 \`return container\`，留着只会让人以为这里真的做了什么映射）。
 */
export function usePortalTarget(): HTMLElement | DocumentFragment | undefined {
  return usePortalContainer() ?? undefined;
}
