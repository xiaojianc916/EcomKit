import { useCallback, useEffect, useRef, useState } from 'react';
import { EcError } from '../../kernel/errors/ec-error';
import type { DirState } from '../../kernel/fs/types';
import { sendMessage } from '../../kernel/messaging/runtime';
import { loadRootHandle, saveRootHandle } from '../../kernel/fs/handle-store';

/**
 * 授权小窗（方案 §9.4）。
 *
 * 为什么必须是独立窗口而不是 popup：
 * `showDirectoryPicker` 和 `requestPermission` 都需要**用户手势 + 一个前台文档**。
 * popup 一旦失焦就会自动关闭，系统对话框弹出来那一刻 popup 就没了。
 *
 * 四种状态对应四种文案，用户点完只有两种结局：成功（1 秒后自动关）或失败（原地给下一步）。
 */
type Mode = 'unset' | 'needs-grant' | 'gone' | 'change';

interface GrantInit {
  mode: Mode;
  currentName?: string;
}

export function GrantApp() {
  const [init, setInit] = useState<GrantInit | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<DirState | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void (async () => {
      try {
        const res = await sendMessage('grant.getInit');
        if (mounted.current) setInit(res as GrantInit);
      } catch {
        if (mounted.current) setInit({ mode: 'unset' });
      }
    })();
    return () => {
      mounted.current = false;
    };
  }, []);

  const finish = useCallback(async (state: DirState) => {
    setDone(state);
    try {
      await Promise.race([sendMessage('fs.changed', state), new Promise((r) => setTimeout(r, 600))]);
    } catch {
      /* 通知失败也要关窗，用户已经选完了 */
    }
    // 方案 §9.4：成功后显示「已就绪」，1 秒后自动关闭
    setTimeout(() => window.close(), 1000);
  }, []);

  /** 首次选择 / 更换目录 */
  const pick = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const handle = (await (
        window as unknown as {
          showDirectoryPicker(o: {
            id: string;
            mode: 'readwrite';
            startIn: string;
          }): Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker({
        id: 'ecbox-root',
        mode: 'readwrite',
        startIn: 'documents',
      })) as FileSystemDirectoryHandle;

      // 关键：句柄**不能**通过 runtime 消息传递（实测传过去会变成没有方法的空对象），
      // 只能在本上下文自己存进 IndexedDB。小窗和 bg / offscreen 同属扩展源，共享同一个库。
      await saveRootHandle(handle);
      await sendMessage('grant.persisted', { name: handle.name });
      await finish({ status: 'ready', name: handle.name });
    } catch (e) {
      const code = e instanceof DOMException ? e.name : 'Unknown';
      if (code === 'AbortError') {
        // 用户自己取消了，不算错误，直接关窗（方案 §9.4「用户直接关掉小窗」同理）
        window.close();
        return;
      }
      setError(describePickError(code));
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [finish]);

  /** 恢复授权：对已存的句柄请求权限 */
  const requestAccess = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // 同样不能走消息：直接读 IndexedDB
      const handle = await loadRootHandle();
      if (!handle) {
        setInit({ mode: 'gone' });
        setError('找不到上次选择的文件夹，请重新选择');
        return;
      }
      const perm = await (
        handle as FileSystemDirectoryHandle & {
          requestPermission(d: { mode: 'readwrite' }): Promise<PermissionState>;
        }
      ).requestPermission({ mode: 'readwrite' });

      if (perm !== 'granted') {
        setError('没有获得访问权限，请重试并选择「每次访问时允许」');
        return;
      }
      await finish({ status: 'ready', name: handle.name });
    } catch (e) {
      const code = e instanceof DOMException ? e.name : 'Unknown';
      if (code === 'AbortError') return;
      setError(EcError.is(e) ? '浏览器拒绝了这次请求' : '授权失败，请重试');
    } finally {
      if (mounted.current) setBusy(false);
    }
  }, [finish]);

  if (done) {
    return (
      <main className="grant">
        <h1 className="grant__title">已就绪</h1>
        <p className="grant__done">
          <CheckIcon />
          已设置保存位置：<strong>{done.name}</strong>
        </p>
      </main>
    );
  }

  if (!init) {
    return (
      <main className="grant">
        <h1 className="grant__title">准备中…</h1>
      </main>
    );
  }

  const copy = COPY[init.mode];

  return (
    <main className="grant">
      <h1 className="grant__title">{copy.title}</h1>
      <p className="grant__desc">{copy.desc}</p>
      <div className="grant__spacer" />
      {error ? <p className="grant__error">{error}</p> : null}
      <div className="grant__actions">
        <button
          type="button"
          className="grant__btn grant__btn--primary"
          onClick={init.mode === 'needs-grant' ? requestAccess : pick}
          disabled={busy}
        >
          {busy ? '处理中…' : copy.primary}
        </button>
        {init.mode === 'needs-grant' ? (
          <button type="button" className="grant__btn grant__btn--link" onClick={pick} disabled={busy}>
            改用其他文件夹
          </button>
        ) : null}
        {init.mode === 'change' ? (
          <button
            type="button"
            className="grant__btn grant__btn--link"
            onClick={() => window.close()}
            disabled={busy}
          >
            取消
          </button>
        ) : null}
      </div>
    </main>
  );
}

/** 文案照方案 §9.4 的表格，一字不改 */
const COPY: Record<Mode, { title: string; desc: string; primary: string }> = {
  unset: {
    title: '选择素材保存位置',
    desc: '建议新建一个专用文件夹，例如 D:\\电商素材。之后所有素材都会按平台和商品自动归档到这里。',
    primary: '选择文件夹',
  },
  'needs-grant': {
    title: '继续使用「电商素材」',
    desc: '浏览器需要你确认一次访问权限。在接下来的提示中选择「每次访问时允许」，以后就不会再问。',
    primary: '允许访问',
  },
  gone: {
    title: '找不到「电商素材」文件夹',
    desc: '它可能被移动、重命名或删除了。请重新选择一个文件夹。',
    primary: '重新选择',
  },
  change: {
    title: '更换保存位置',
    desc: '选一个新文件夹。原有的素材不会被移动，之后的新素材会存到新位置。',
    primary: '选择文件夹',
  },
};

function describePickError(name: string): string {
  switch (name) {
    case 'NotAllowedError':
      return '这个位置不能使用，请新建一个专用文件夹';
    case 'NotFoundError':
      return '找不到这个位置，请重新选择';
    case 'SecurityError':
      return '浏览器不允许选择这个位置，请换一个普通文件夹';
    case 'AbortError':
      return '';
    default:
      return '选择失败，请重试';
  }
}

function CheckIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}