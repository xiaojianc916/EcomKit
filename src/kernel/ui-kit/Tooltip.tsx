import * as RadixTooltip from 'radix-ui/tooltip';
import type { ReactNode } from 'react';
import { usePortalTarget } from './PortalRoot';

/**
 * 悬停提示（§10.3：⟩ 的提示“收起到边缘 · Alt+Shift+E”、商品标题悬停看全文、
 * 缩略图悬停显示尺寸）。
 *
 * 两个实现要点：
 * - 弹层必须挂进 shadow root（§10.10）：Radix 默认 portal 到 document.body，
 *   那样在内容脚本里会掉样式。容器从 PortalRoot 的 context 取。
 * - Radix 要求 Tooltip 必须在 Provider 里。这里让 Tooltip 自己带一层 Provider，
 *   调用点就不会因为忘了包 Provider 直接抛错（面板、popup、设置页都能直接用）。
 *   外壳还额外包了一层 TooltipProvider，用来共享 skipDelay（连续悬停时不重复等待）。
 */
export interface TooltipProps {
  content: ReactNode;
  children: ReactNode;
  /**
   * 悬停多久后出现；默认 300ms。
   * 标题全文这种「内容已经现成、用户就是要看它」的提示传 0（不要延迟）。
   */
  delayDuration?: number;
  side?: 'top' | 'right' | 'bottom' | 'left';
}

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <RadixTooltip.Provider delayDuration={300} skipDelayDuration={300}>
      {children}
    </RadixTooltip.Provider>
  );
}

export function Tooltip({ content, children, delayDuration, side = 'top' }: TooltipProps) {
  const container = usePortalTarget();
  return (
    <RadixTooltip.Provider delayDuration={delayDuration ?? 300} skipDelayDuration={0}>
      <RadixTooltip.Root {...(delayDuration === undefined ? {} : { delayDuration })}>
        <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
        <RadixTooltip.Portal container={container}>
          <RadixTooltip.Content
            className="ec-tooltip"
            side={side}
            sideOffset={6}
            collisionPadding={8}
          >
            {content}
          </RadixTooltip.Content>
        </RadixTooltip.Portal>
      </RadixTooltip.Root>
    </RadixTooltip.Provider>
  );
}
