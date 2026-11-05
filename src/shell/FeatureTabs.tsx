import { useState } from 'react';
import type { RegisteredFeature } from '../features/types';

/**
 * 功能标签（§8.5「多功能时的布局」）。
 *
 * 规则很简单但必须写在这里而不是功能里：**只有一个功能提供 Panel 时不渲染标签栏**。
 * v1 就只有一个功能，所以实际上永远不渲染；等以后加了「复制商品信息」，
 * 面板头部下方自动出现一行文字标签「素材 / 信息」，并记住用户上次的标签。
 *
 * 文字标签而不是图标标签：方案 §10.1 要求「一眼看懂」，两个字的标签比一个
 * 需要猜的图标直观。
 */
export interface FeatureTabsProps {
  features: RegisteredFeature[];
  activeId: string;
  onSelect(id: string): void;
}

export function FeatureTabs({ features, activeId, onSelect }: FeatureTabsProps) {
  // §8.5：只有一个功能时不渲染任何标签栏
  if (features.length <= 1) return null;

  return (
    <div
      role="tablist"
      aria-label="功能"
      style={{
        display: 'flex',
        gap: 16,
        padding: '0 16px',
        borderBottom: '1px solid var(--ec-line)',
      }}
    >
      {features.map((feature) => {
        const active = feature.manifest.id === activeId;
        return (
          <button
            key={feature.manifest.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(feature.manifest.id)}
            style={{
              height: 32,
              padding: 0,
              border: 'none',
              borderBottom: active ? '2px solid var(--ec-accent)' : '2px solid transparent',
              background: 'transparent',
              color: active ? 'var(--ec-text)' : 'var(--ec-text-2)',
              fontFamily: 'inherit',
              fontSize: 13,
              fontWeight: active ? 600 : 400,
              cursor: 'pointer',
            }}
          >
            {feature.manifest.title}
          </button>
        );
      })}
    </div>
  );
}

/** 当前激活的功能 id：用户选过的优先，否则取第一个（§10.9 shellStore.activeFeature） */
export function pickActiveFeature(
  features: RegisteredFeature[],
  preferred: string | null,
): string | null {
  if (preferred !== null && features.some((f) => f.manifest.id === preferred)) return preferred;
  return features[0]?.manifest.id ?? null;
}

/** 只有提供 Panel 的功能才占标签位；v1 只有一个，所以标签栏永远不出现 */
export function panelFeatures(features: RegisteredFeature[]): RegisteredFeature[] {
  return features.filter((f) => f.page !== undefined);
}

/** 组件测试和 popup 里复用：标签栏是否应该出现（§8.5） */
export function shouldRenderTabs(features: RegisteredFeature[]): boolean {
  return panelFeatures(features).length >= 2;
}

/**
 * 记住当前标签（§8.5「记住用户上次所在的标签」）。
 * 返回 [当前 id, 切换函数]；切换时同时通知外部持久化。
 */
export function useActiveFeature(
  features: RegisteredFeature[],
  preferred: string | null,
  onChange: (id: string) => void,
): [string | null, (id: string) => void] {
  const [active, setActive] = useState<string | null>(() => pickActiveFeature(features, preferred));
  const select = (id: string): void => {
    setActive(id);
    onChange(id);
  };
  return [active ?? pickActiveFeature(features, preferred), select];
}
