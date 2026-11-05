/**
 * 功能插槽的懒加载容器（方案 §8.3、§8.5）。
 *
 * 为什么懒加载：功能多了以后内容脚本首屏体积不能线性增长。
 * page.tsx 用 import.meta.glob 的非 eager 形式收集，这里用 Suspense 兜住首次加载的空档。
 *
 * 它只做三件事：
 *   1. 取功能的 settings（读一次 + 订阅变化）
 *   2. 把外壳查好的 dir / job 透传给功能（§9.4：目录状态只查一次）
 *   3. 拼出 PageApi 需要的最小上下文
 */
import { Component, Suspense, useEffect, useState, type ReactNode } from 'react';
import type { PageApi, RegisteredFeature } from '../../features/types';
import type { DirState } from '../../kernel/fs/types';
import type { JobRecord } from '../../kernel/jobs/types';
import type { ProductSnapshot } from '../../kernel/model/product';
import { createLogger } from '../../kernel/log/logger';
import { createFeatureSettings } from '../../kernel/settings/store';

const log = createLogger('feature-slot');

export interface FeatureSlotProps {
  feature: RegisteredFeature;
  snapshot: ProductSnapshot | null;
  status: 'resolving' | 'ready';
  dir: DirState;
  job: JobRecord | null;
  api: PageApi;
}

/**
 * 用 class 组件做错误边界：某个功能崩溃不能把整个工具箱带下去（§10.4 空状态要有可执行动作）。
 */
class FeatureErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    log.error('feature panel crashed', error);
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p style={{ padding: '12px 16px', fontSize: '13px', color: 'var(--ec-fg-2)' }}>
          这个功能加载失败，刷新页面重试。
        </p>
      );
    }
    return this.props.children;
  }
}

/** 读功能私有设置并订阅变化（§6.6：存在 feature:<id> 这个 key 下） */
function useFeatureSettings(feature: RegisteredFeature): unknown {
  const [value, setValue] = useState<unknown>(() => feature.manifest.settings?.defaults ?? {});

  useEffect(() => {
    const spec = feature.manifest.settings;
    if (!spec) {
      setValue({});
      return;
    }
    const store = createFeatureSettings({
      featureId: feature.manifest.id,
      schema: spec.schema,
      defaults: spec.defaults,
    });
    let alive = true;
    void store.get().then((v: unknown) => {
      if (alive) setValue(v);
    });
    const unwatch = store.watch((v: unknown) => {
      if (alive) setValue(v);
    });
    return () => {
      alive = false;
      unwatch();
    };
  }, [feature]);

  return value;
}

export function FeatureSlot(props: FeatureSlotProps) {
  const { feature, snapshot, status, dir, job, api } = props;
  const settings = useFeatureSettings(feature);
  const [loaded, setLoaded] = useState<{ default: import('../../features/types').PageFeature } | null>(
    null,
  );

  useEffect(() => {
    if (!feature.page) return;
    let alive = true;
    void feature
      .page.load()
      .then((mod) => {
        if (alive) setLoaded(mod);
      })
      .catch((e) => log.warn('feature load failed', e));
    return () => {
      alive = false;
    };
  }, [feature]);

  // 没有 page 部分的功能（纯后台功能）不占插槽
  if (!feature.page) return null;
  // 快照还没出来时功能拿不到数据，显示占位而不挂载（§8.4 能力门控）
  if (!snapshot) return null;

  if (!loaded?.default.Panel) return null;

  const Panel = loaded.default.Panel;


  return (
    <FeatureErrorBoundary>
      <div data-ecbox-feature={feature.manifest.id}>
        <Suspense fallback={null}>
          <Panel
            snapshot={snapshot}
            status={status}
            settings={settings as never}
            api={api}
            dir={dir}
            job={job}
          />
        </Suspense>
      </div>
    </FeatureErrorBoundary>
  );
}