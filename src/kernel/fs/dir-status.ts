import { asFsaDir, asFsaHandle } from './fsa-capabilities';
import type { DirState, DirStatus } from './types';

/**
 * 目录授权状态机（方案 §9.4）。
 *
 * 为什么要有这个状态：FSA 授权在浏览器重启、目录被移动/删除、U 盘拔出时会失效，
 * 而失效的表现各不相同（queryPermission 变成 prompt，或者迭代目录抛 NotFoundError）。
 * UI 只有四种状态可选，所以这里把它们收敛成 unset / needs-grant / gone / ready。
 */

/** 状态检查需要的最小能力面，方便单测注入假句柄 */
export interface DirStatusProbe {
  queryPermission(desc?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
  /** 目录还在不在：迭代目录不需要读完，拿到第一项（或正常结束）就算在 */
  probe(): Promise<void>;
}

export function probeFromHandle(handle: FileSystemDirectoryHandle): DirStatusProbe {
  return {
    queryPermission: (desc) => asFsaHandle(handle).queryPermission(desc),
    async probe() {
      for await (const _entry of asFsaDir(handle).entries?.() ?? emptyEntries()) {
        break;
      }
    },
  };
}

/** 空目录项迭代器：环境没有 entries() 时退化成「目录是空的但存在」 */
async function* emptyEntries(): AsyncIterableIterator<[string, FileSystemHandle]> {
  yield* [] as Array<[string, FileSystemHandle]>;
}

/**
 * §9.4 的 check()：
 *   没有句柄 → unset
 *   queryPermission ≠ granted → needs-grant
 *   迭代目录抛错 → gone
 *   否则 → ready
 *
 * 注意「needs-grant」包括 prompt 和 denied：两种情况用户能做的动作都是重新点授权，
 * UI 上不需要区分（§10.4 只有「继续使用「电商素材」」这一条）。
 */
export async function checkDirStatus(
  load: () => Promise<DirStatusProbe | null>,
  displayName: () => Promise<string | null>,
): Promise<DirState> {
  let probe: DirStatusProbe | null;
  try {
    probe = await load();
  } catch {
    return { status: 'unset' };
  }
  if (!probe) return { status: 'unset' };

  const name = await displayName().catch(() => null);
  const withName = (status: DirStatus): DirState => (name === null ? { status } : { status, name });

  let permission: PermissionState;
  try {
    permission = await probe.queryPermission({ mode: 'readwrite' });
  } catch {
    // 句柄本身坏了（旧版本存的、或者被浏览器清理了）→ 当作没授权
    return withName('needs-grant');
  }
  if (permission !== 'granted') return withName('needs-grant');

  try {
    await probe.probe();
  } catch {
    // NotFoundError：目录被删除/移动/改名，或者 U 盘被拔掉
    return withName('gone');
  }
  return withName('ready');
}

/** 一个固定的“永远 ready”探针，downloads 兜底模式用（§9.13：只要有 downloads 权限就一直可用） */
export function alwaysReadyProbe(): DirStatusProbe {
  return {
    queryPermission: async () => 'granted',
    probe: async () => {},
  };
}
