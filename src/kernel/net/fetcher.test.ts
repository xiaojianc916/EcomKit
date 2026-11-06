import { describe, expect, it, vi } from 'vitest';
import { createFetcher, IMAGE_TIMEOUT_MS, stripQuery, VIDEO_IDLE_TIMEOUT_MS } from './fetcher';
import { createHostLimiter } from './host-limiter';

function jpegResponse(): Response {
  const head = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
  const body = new Uint8Array([...head, ...new Uint8Array(60)]);
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg' } });
}

function mp4Response(): Response {
  const head = new Uint8Array(32);
  head.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  head.set([0x69, 0x73, 0x6f, 0x6d], 8); // isom
  return new Response(head, { status: 200, headers: { 'content-type': 'video/mp4' } });
}

const signal = () => new AbortController().signal;

describe('createFetcher（§9.7）', () => {
  it('成功时返回响应（body 已跳过头字节）', async () => {
    const fetchImpl = vi.fn(async () => jpegResponse());
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
      signal: signal(),
      kind: 'image',
    });
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    // body 必须是完整内容：嗅探读走的头字节会被接回去，否则落盘的文件会少前 32 字节
    expect(bytes.byteLength).toBe(64);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it('不带 Cookie、不用缓存（§9.7、§13）', async () => {
    // 显式声明 mock 的签名，否则 vi.fn 会把参数元组推断成 []
    const fetchImpl = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => jpegResponse(),
    );
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
      signal: signal(),
      kind: 'image',
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.credentials).toBe('omit');
    expect(init?.cache).toBe('no-store');
  });

  it('404 换下一个候选（§9.7 候选切换）', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('', { status: 404 });
      return jpegResponse();
    });
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(
      ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
      { signal: signal(), kind: 'image' },
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('全部候选 404 → HTTP_404', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 404 }));
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      fetcher.fetchWithFallback(
        ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
        {
          signal: signal(),
          kind: 'image',
        },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_404' });
  });

  it('410 也换下一个候选', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('', { status: 410 });
      return jpegResponse();
    });
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(
      fetcher.fetchWithFallback(
        ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
        {
          signal: signal(),
          kind: 'image',
        },
      ),
    ).resolves.toBeDefined();
  });

  it('Content-Type 是 text/html 时当作拒绝访问（§9.7 内容校验）', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('<html>403</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(
      fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
        signal: signal(),
        kind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'HTTP_403' });
  });

  it('内容不是期望类型时换下一个候选（§9.7 嗅探校验）', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      // 第一个候选返回的其实是 HTML（但不是 text/html Content-Type）
      if (call === 1) {
        return new Response(new Uint8Array([0x3c, 0x21, 0x44, 0x4f, ...new Uint8Array(40)]), {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        });
      }
      return jpegResponse();
    });
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(
      ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/b.jpg'],
      { signal: signal(), kind: 'image' },
    );
    expect(response.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('403 会重试（§9.7 不可重试 vs 可重试）', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < 2) return new Response('', { status: 403 });
      return jpegResponse();
    });
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
      signal: signal(),
      kind: 'image',
    });
    expect(response.status).toBe(200);
    expect(call).toBe(2);
  }, 15000);

  it('403 + 链接已过期 → URL_EXPIRED，不白白重试（§9.7）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 403 }));
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const expired = `https://cdn.example.com/a.mp4?expires=${Date.now() - 120_000}`;
    await expect(
      fetcher.fetchStream(expired, { signal: signal(), kind: 'video' }),
    ).rejects.toMatchObject({ code: 'URL_EXPIRED' });
  });

  it('429 遵守 Retry-After', async () => {
    const fetchImpl = vi.fn(async () => {
      const headers = new Headers();
      headers.set('retry-after', '0');
      return new Response('', { status: 429, headers });
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 1,
    });
    await expect(
      fetcher.fetchStream('https://cdn.example.com/a.jpg', { signal: signal(), kind: 'image' }),
    ).rejects.toMatchObject({ code: 'HTTP_429' });
  });

  it('网络错误映射成 NETWORK', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(
      fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
        signal: signal(),
        kind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('取消后立刻抛 CANCELED', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => jpegResponse());
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    controller.abort();
    await expect(
      fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
        signal: controller.signal,
        kind: 'image',
      }),
    ).rejects.toMatchObject({ code: 'CANCELED' });
  });

  it('空候选列表 → HTTP_404', async () => {
    const fetcher = createFetcher({ fetchImpl: vi.fn() as unknown as typeof fetch });
    await expect(
      fetcher.fetchWithFallback([], { signal: signal(), kind: 'image' }),
    ).rejects.toMatchObject({ code: 'HTTP_404' });
  });

  it('视频响应也能嗅探出 mp4', async () => {
    const fetchImpl = vi.fn(async () => mp4Response());
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(['https://cdn.example.com/a.mp4'], {
      signal: signal(),
      kind: 'video',
    });
    expect(response.status).toBe(200);
  });

  it('同一域名并发受限（§6.4 同域名 ≤4）', async () => {
    let active = 0;
    let maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return jpegResponse();
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      limiter: createHostLimiter(),
    });
    await Promise.all(
      Array.from({ length: 10 }, () =>
        fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
          signal: signal(),
          kind: 'image',
        }),
      ),
    );
    expect(maxActive).toBeLessThanOrEqual(4);
  });

  it('超时常量符合方案（§9.7）', () => {
    expect(IMAGE_TIMEOUT_MS).toBe(20_000);
    expect(VIDEO_IDLE_TIMEOUT_MS).toBe(30_000);
  });
});

describe('候选切换（§9.7：一个地址不行就换下一个）', () => {
  it('403 换下一个候选（原图域名被拒，备用域名能成功）', async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (calls.length === 1) return new Response('', { status: 403 });
      return jpegResponse();
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    const response = await fetcher.fetchWithFallback(
      ['https://cdn-a.example.com/a.jpg', 'https://cdn-b.example.com/a.jpg'],
      { signal: signal(), kind: 'image' },
    );
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
  });

  it('5xx 换下一个候选', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) return new Response('', { status: 503 });
      return jpegResponse();
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    const response = await fetcher.fetchWithFallback(
      ['https://cdn-a.example.com/a.jpg', 'https://cdn-b.example.com/a.jpg'],
      { signal: signal(), kind: 'image' },
    );
    expect(response.status).toBe(200);
    expect(call).toBe(2);
  });

  it('网络错误不逐个候选再试（断网时不能把每张图都拖成十几秒）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('failed to fetch');
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(
      fetcher.fetchWithFallback(
        ['https://cdn-a.example.com/a.jpg', 'https://cdn-b.example.com/a.jpg'],
        { signal: signal(), kind: 'image' },
      ),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('全部候选都失败时抛最后一个错误', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      return call === 1 ? new Response('', { status: 503 }) : new Response('', { status: 403 });
    });
    const fetcher = createFetcher({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxRetries: 0,
    });
    await expect(
      fetcher.fetchWithFallback(
        ['https://cdn-a.example.com/a.jpg', 'https://cdn-b.example.com/a.jpg'],
        { signal: signal(), kind: 'image' },
      ),
    ).rejects.toMatchObject({ code: 'HTTP_403' });
  });
});

describe('重建响应不丢元信息', () => {
  it('url / redirected / type 跟着原响应走（跟过 302 之后的地址要能进日志）', async () => {
    const fetchImpl = vi.fn(async () => {
      const res = jpegResponse();
      Object.defineProperty(res, 'url', { value: 'https://cdn.example.com/final.jpg' });
      Object.defineProperty(res, 'redirected', { value: true });
      return res;
    });
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
      signal: signal(),
      kind: 'image',
    });
    expect(response.url).toBe('https://cdn.example.com/final.jpg');
    expect(response.redirected).toBe(true);
  });

  it('headers 原样保留', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Uint8Array(60)]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '64' },
        }),
    );
    const fetcher = createFetcher({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const response = await fetcher.fetchWithFallback(['https://cdn.example.com/a.jpg'], {
      signal: signal(),
      kind: 'image',
    });
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(response.headers.get('content-length')).toBe('64');
  });
});

describe('stripQuery（§6.7 日志不带签名参数）', () => {
  it('去掉查询串', () => {
    expect(stripQuery('https://cdn.example.com/a.mp4?sign=secret&expires=1')).toBe(
      'https://cdn.example.com/a.mp4',
    );
  });

  it('非法 URL 也尽量去掉查询串', () => {
    expect(stripQuery('not-a-url?x=1')).toBe('not-a-url');
  });
});
