import { Check, Minus } from 'lucide-react';
import * as RadixCheckbox from 'radix-ui/checkbox';
import type { ReactNode } from 'react';

/**
 * 复选框（§10.3 素材行）。
 *
 * 用 Radix 的 Checkbox 而不是原生 input：素材行需要「半选」态
 * （挑选模式下这一行只选了一部分，§10.3），原生 input 的半选只能用 JS 设
 * indeterminate 属性，既不可控也读不到样式钩子。
 *
 * 尺寸 16px、圆角 3px、禁用时置灰 —— 数量为 0 的行复选框禁用（§10.3）。
 */
export interface CheckboxProps {
  checked: boolean | 'indeterminate';
  onCheckedChange(checked: boolean): void;
  disabled?: boolean;
  /** 读屏器用的名字；行里的可见文字不一定是这个控件的名字 */
  label: string;
  id?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled = false, label, id }: CheckboxProps) {
  return (
    <RadixCheckbox.Root
      id={id}
      aria-label={label}
      className="ec-checkbox"
      checked={checked}
      disabled={disabled}
      onCheckedChange={(next) => {
        // Radix 可能给 'indeterminate'，点下去一律变成选中
        onCheckedChange(next === true);
      }}
    >
      <RadixCheckbox.Indicator className="ec-checkbox__mark">
        {checked === 'indeterminate' ? (
          <Minus size={10} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Check size={10} strokeWidth={1.75} aria-hidden="true" />
        )}
      </RadixCheckbox.Indicator>
    </RadixCheckbox.Root>
  );
}

/** 图标统一 16px、线宽 1.75（§10.6 图标）。children 原样渲染，方便行内放置 */
export function IconSlot({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="ec-icon-slot">
      {children}
    </span>
  );
}
