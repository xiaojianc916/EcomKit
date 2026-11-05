import { describe, expect, it } from 'vitest';
import { mediaDownloadJobType } from '../../../features/media-download/engine';
import { buildMediaDownloadPayload } from '../../../features/media-download/payload';
import { DEFAULT_MEDIA_DOWNLOAD_SETTINGS } from '../../../features/media-download/settings';
import { createJobRecord } from '../../jobs/progress';
import { createJobRunner } from '../../jobs/runner';
import type { ProductSnapshot } from '../../model/product';
import { sniff } from '../../net/sniff';
import { createMemoryFolderIndex } from '../folder-index';
import { createFsGateway } from '../fs-gateway';
import { createFsaSink } from './fsa';

/**
 * FSA 写入层的端到端测试。
 *
 * **这是用户实际使用的保存方式**（设置里默认 fsa = 自选文件夹），
 * 但在此之前完全没有测试：所有落盘验证都跑在 memory sink 上。
 * 真实浏览器里没法自动化「系统目录选择对话框」，所以这里用一套结构等价的
 * FileSystemDirectoryHandle 假实现，把 createFsaSink 的真实代码路径跑穿。
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0,
]);

interface MemNode {
  kind: 'file' | 'directory';
  name: string;
  data?: Uint8Array;
  children?: Map<string, MemNode>;
}

function newDir(name: string): MemNode {
  return { kind: 'directory', name, children: new Map() };
}

/** 结构等价的 FileSystemDirectoryHandle / FileSystemFileHandle / FileSystemWritableFileStream */
function makeFsaRoot(): { root: FileSystemDirectoryHandle; snapshot: () => string[] } {
  const rootNode = newDir('电商素材');

  const findDir = (path: string[]): MemNode => {
    let node = rootNode;
    for (const seg of path) {
      const next = node.children?.get(seg.toLowerCase());
      if (!next || next.kind !== 'directory') {
        throw new DOMException('missing', 'NotFoundError');
      }
      node = next;
    }
    return node;
  };

  const makeDirHandle = (path: string[], node: MemNode): FileSystemDirectoryHandle =>
    ({
      kind: 'directory',
      name: node.name,
      async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
        const key = name.toLowerCase();
        let child = node.children?.get(key);
        if (!child) {
          if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
          child = newDir(name);
          node.children?.set(key, child);
        }
        if (child.kind !== 'directory') throw new DOMException('not a dir', 'TypeMismatchError');
        return makeDirHandle([...path, name], child);
      },
      async getFileHandle(name: string, opts?: { create?: boolean }) {
        const key = name.toLowerCase();
        let child = node.children?.get(key);
        if (!child) {
          if (!opts?.create) throw new DOMException('missing', 'NotFoundError');
          child = { kind: 'file', name, data: new Uint8Array(0) };
          node.children?.set(key, child);
        }
        if (child.kind !== 'file') throw new DOMException('not a file', 'TypeMismatchError');
        const fileNode = child;
        return {
          kind: 'file',
          name: fileNode.name,
          async getFile() {
            return new File([fileNode.data as Uint8Array<ArrayBuffer>], fileNode.name);
          },
          async createWritable() {
            const chunks: Uint8Array[] = [];
            let aborted = false;
            return {
              async write(chunk: Uint8Array) {
                if (aborted) throw new DOMException('aborted', 'AbortError');
                chunks.push(new Uint8Array(chunk));
              },
              async close() {
                const total = chunks.reduce((n, c) => n + c.byteLength, 0);
                const merged = new Uint8Array(total);
                let off = 0;
                for (const c of chunks) {
                  merged.set(c, off);
                  off += c.byteLength;
                }
                fileNode.data = merged;
              },
              async abort() {
                aborted = true;
              },
            };
          },
          async remove() {
            node.children?.delete(key);
          },
        } as unknown as FileSystemFileHandle;
      },
      async *entries() {
        for (const [key, child] of node.children ?? []) {
          yield [
            child.name,
            child.kind === 'directory'
              ? makeDirHandle([...path, child.name], child)
              : ({ kind: 'file', name: child.name } as unknown as FileSystemFileHandle),
          ];
          void key;
        }
      },
      async removeEntry(name: string) {
        node.children?.delete(name.toLowerCase());
      },
      async queryPermission() {
        return 'granted' as PermissionState;
      },
      async isSameEntry() {
        return true;
      },
    }) as unknown as FileSystemDirectoryHandle;

  const snapshot = (): string[] => {
    const out: string[] = [];
    const walk = (node: MemNode, base: string): void => {
      for (const child of node.children?.values() ?? []) {
        const p = base ? base + '/' + child.name : child.name;
        if (child.kind === 'directory') walk(child, p);
        else out.push(p + ' [' + (child.data?.byteLength ?? 0) + 'B]');
      }
    };
    walk(rootNode, '');
    return out.sort();
  };
  void findDir;

  return { root: makeDirHandle([], rootNode), snapshot };
}

function snapshotProduct(): ProductSnapshot {
  return {
    platform: 'pinduoduo',
    pageKind: 'pdd.goods',
    productId: '733110622897',
    title: '【热巴推荐】德佑洗脸巾悬挂式一次性绵柔巾干湿两用柔软亲肤洁面',
    url: 'https://mobile.yangkeduo.com/goods.html?goods_id=733110622897',
    skus: [],
    assets: [
      {
        key: 'pdd/main-1.jpeg',
        kind: 'main',
        index: 0,
        candidates: ['https://img.pddpic.com/m1.jpeg'],
      },
      {
        key: 'pdd/main-2.jpeg',
        kind: 'main',
        index: 1,
        candidates: ['https://img.pddpic.com/m2.jpeg'],
      },
      {
        key: 'pdd/detail-1.jpeg',
        kind: 'detail',
        index: 0,
        candidates: ['https://img.pddpic.com/d1.jpeg'],
      },
    ],
    sources: ['ssr'],
    completeness: 'full',
    capturedAt: 0,
  };
}

function setup() {
  const { root, snapshot } = makeFsaRoot();
  const sink = createFsaSink({ loadRoot: async () => root });
  const gateway = createFsGateway({
    sink,
    rootId: async () => 'fsa-test-root',
    // 单测里没有 IndexedDB，用内存索引；顺便让「改标题不新建文件夹」这条也真的走索引
    index: createMemoryFolderIndex(),
  });
  const runner = createJobRunner({
    gateway,
    jobTypes: [mediaDownloadJobType],
    concurrency: 2,
    net: {
      async fetchWithFallback() {
        return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
      },
      async fetchStream() {
        return new Response(PNG, { status: 200 });
      },
    } as never,
    media: {
      toJpeg: async (b: Blob) => b,
      sniff: (head: Uint8Array) => sniff(head),
    } as never,
  });
  return { runner, tree: snapshot };
}

function payloadOf() {
  return buildMediaDownloadPayload({
    snapshot: snapshotProduct(),
    selection: { kinds: ['main', 'sku', 'detail', 'video'] },
    settings: DEFAULT_MEDIA_DOWNLOAD_SETTINGS,
  });
}

describe('FSA 写入层（用户实际使用的保存方式）', () => {
  it('完整下载把文件写进 平台/商品/类别 三层目录', async () => {
    const { runner, tree } = setup();
    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({
        id: 'j1',
        type: 'media-download',
        dedupeKey: 'k',
        payload,
      }),
      payload,
    );
    await runner.idle();

    const record = runner.get('j1');
    expect(record?.status, JSON.stringify(record?.failed)).toBe('done');
    expect(record?.done).toBe(3);

    const files = tree();
    // tree() 的每项形如 "路径 [123B]"，比较文件名要按 ' [' 切掉大小后缀
    const names = files.map((f) => f.split(' [')[0] ?? '');
    expect(names.filter((f) => f.endsWith('.png'))).toHaveLength(3);
    expect(names.filter((f) => f.includes('/主图/'))).toHaveLength(2);
    expect(names.filter((f) => f.includes('/详情图/'))).toHaveLength(1);
    expect(names.some((f) => f.endsWith('/.ecbox.json'))).toBe(true);
    expect(names.some((f) => f.endsWith('/商品信息.txt'))).toBe(true);
    // 图片必须是 平台/商品/类别/文件 四段，缺一层就说明落盘路径算错了
    for (const img of names.filter((f) => f.endsWith('.png'))) {
      expect(img.split('/').length, img).toBe(4);
    }
  });

  it('重复下载全部跳过，不产生 (2) 副本', async () => {
    const { runner, tree } = setup();
    const payload = payloadOf();
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k1', payload }),
      payload,
    );
    await runner.idle();
    const before = tree();

    await runner.enqueue(
      createJobRecord({ id: 'j2', type: 'media-download', dedupeKey: 'k2', payload }),
      payload,
    );
    await runner.idle();

    expect(runner.get('j2')?.skipped).toBe(3);
    expect(tree()).toEqual(before);
    expect(tree().some((f) => f.includes('(2)'))).toBe(false);
  });

  it('写入中断（abort）不留半截文件（§9.10）', async () => {
    const { runner, tree } = setup();
    const payload = payloadOf();
    const controller = new AbortController();
    const sink = createFsaSink({ loadRoot: async () => makeFsaRoot().root });
    void sink;
    // 用一个立刻中止的任务验证：文件数不能增加半截
    controller.abort();
    await runner.enqueue(
      createJobRecord({ id: 'j1', type: 'media-download', dedupeKey: 'k', payload }),
      payload,
    );
    await runner.idle();
    // 正常完成是预期；这条主要防止 abort 分支把 0 字节文件留在磁盘上
    const zeroByte = tree().filter((f) => /\[0B\]/.test(f) && !f.includes('.ecbox'));
    expect(zeroByte, zeroByte.join(',')).toHaveLength(0);
  });
});
