import { describe, expect, it } from 'vitest';
import { alwaysReadyProbe, checkDirStatus, type DirStatusProbe } from './dir-status';

function probe(opts: {
  permission?: PermissionState;
  throwOnQuery?: boolean;
  throwOnProbe?: boolean;
}): DirStatusProbe {
  return {
    queryPermission: async () => {
      if (opts.throwOnQuery) throw new Error('broken handle');
      return opts.permission ?? 'granted';
    },
    probe: async () => {
      if (opts.throwOnProbe) throw new DOMException('missing', 'NotFoundError');
    },
  };
}

describe('checkDirStatus（§9.4 状态机）', () => {
  it('没有句柄 → unset', async () => {
    const state = await checkDirStatus(
      async () => null,
      async () => null,
    );
    expect(state).toEqual({ status: 'unset' });
  });

  it('读句柄抛错 → unset（不把异常抛给 UI）', async () => {
    const state = await checkDirStatus(
      async () => {
        throw new Error('idb broken');
      },
      async () => null,
    );
    expect(state.status).toBe('unset');
  });

  it('queryPermission 返回 prompt → needs-grant', async () => {
    const state = await checkDirStatus(
      async () => probe({ permission: 'prompt' }),
      async () => '电商素材',
    );
    expect(state).toEqual({ status: 'needs-grant', name: '电商素材' });
  });

  it('queryPermission 返回 denied → needs-grant', async () => {
    const state = await checkDirStatus(
      async () => probe({ permission: 'denied' }),
      async () => '电商素材',
    );
    expect(state.status).toBe('needs-grant');
  });

  it('queryPermission 抛错（句柄坏了）→ needs-grant', async () => {
    const state = await checkDirStatus(
      async () => probe({ throwOnQuery: true }),
      async () => '电商素材',
    );
    expect(state.status).toBe('needs-grant');
  });

  it('已授权但目录不存在 → gone', async () => {
    const state = await checkDirStatus(
      async () => probe({ throwOnProbe: true }),
      async () => '电商素材',
    );
    expect(state).toEqual({ status: 'gone', name: '电商素材' });
  });

  it('已授权且探测成功 → ready，并带目录名', async () => {
    const state = await checkDirStatus(
      async () => probe({}),
      async () => '电商素材',
    );
    expect(state).toEqual({ status: 'ready', name: '电商素材' });
  });

  it('拿不到目录名时省略 name 字段（exactOptionalPropertyTypes）', async () => {
    const state = await checkDirStatus(
      async () => probe({}),
      async () => null,
    );
    expect(state).toEqual({ status: 'ready' });
    expect('name' in state).toBe(false);
  });

  it('目录名读取抛错不影响状态判定', async () => {
    const state = await checkDirStatus(
      async () => probe({}),
      async () => {
        throw new Error('name failed');
      },
    );
    expect(state.status).toBe('ready');
  });
});

describe('alwaysReadyProbe（§9.13 downloads 模式）', () => {
  it('恒为 ready', async () => {
    const state = await checkDirStatus(
      async () => alwaysReadyProbe(),
      async () => '下载目录',
    );
    expect(state).toEqual({ status: 'ready', name: '下载目录' });
  });
});
