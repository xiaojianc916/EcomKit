import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { forwardRef } from 'react';

/**
 * 按钮（§10.1「主按钮 36px 高，一行文字」、§10.6 圆角 6px）。
 *
 * 只有四种外观，够用且不给人「这里能点那里也能点」的错觉：
 * - primary：主按钮，强调色，36px
 * - neutral：中性实心（“已保存 48 个文件”这种结果态）
 * - outline：次要操作
 * - ghost：图标按钮和行内文字按钮
 */
export type ButtonVariant = 'primary' | 'neutral' | 'outline' | 'ghost' | 'link';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  /** 占满一行（主按钮用） */
  block?: boolean;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'ec-btn ec-btn--primary',
  neutral: 'ec-btn ec-btn--neutral',
  outline: 'ec-btn',
  ghost: 'ec-btn ec-btn--ghost',
  link: 'ec-btn ec-btn--link',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'outline', block = false, type = 'button', className, style, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={`${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`}
      style={block ? { width: '100%', ...style } : style}
      {...rest}
    />
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 图标按钮必须有可读的名字（读屏器和 tooltip 共用） */
  label: string;
  children: ReactNode;
}

/** 图标按钮：⚙ ⟩ ⧉ 这类。label 同时用作 aria-label */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, children, type = 'button', className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={`ec-icon-btn${className ? ` ${className}` : ''}`}
      {...rest}
    >
      {children}
    </button>
  );
});
