/**
 * ui-kit 公共出口。
 *
 * 内容脚本、popup、options、grant 都从这里取组件；样式统一在
 * `entrypoints/...` 里 import `@/kernel/ui-kit/tokens.css` + `ui-kit.css`
 * （配置页再额外 import `tailwind.css`）。
 */
export {
  Button,
  type ButtonProps,
  type ButtonVariant,
  IconButton,
  type IconButtonProps,
  INLINE_ICON_SIZE,
} from './Button';
export { Checkbox, type CheckboxProps } from './Checkbox';
export {
  PortalRoot,
  type PortalRootProps,
  usePortalContainer,
  usePortalTarget,
} from './PortalRoot';
export { Progress, type ProgressProps } from './Progress';
export { Thumb, type ThumbProps } from './Thumb';
export { showToast, type ToastAction, type ToastItem, ToastViewport } from './Toast';
export { Tooltip, type TooltipProps, TooltipProvider } from './Tooltip';
