/**
 * Phase 0 §17-6 / §17-7 探针：拿真实 CDN 地址验证
 *   - 不带 Referer 是否 403
 *   - 去掉图片处理后缀是否拿到更大的原图
 *
 * 用法：node scripts/phase0/probe-cdn.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const rawDir = join(root, '.phase0-raw');
mkdirSync(rawDir, { recursive: true });

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TARGETS = [
  {
    platform: 'douyin',
    label: 'aweme-qrcode webp（真实采样地址）',
    url: 'https://p11.douyinpic.com/img/aweme-qrcode/rFtJiT7704704965461149491~c5_720x720.webp?from=773146320',
    referer: 'https://haohuo.jinritemai.com/',
  },
  {
    platform: 'douyin',
    label: 'aweme-qrcode 无处理后缀（原图规则验证）',
    url: 'https://p11.douyinpic.com/img/aweme-qrcode/rFtJiT7704704965461149491',
    referer: 'https://haohuo.jinritemai.com/',
  },
  {
    platform: 'pinduoduo',
    label: 'pddpic 静态图',
    url: 'https://funimg.pddpic.com/base/logo.jpg',
    referer: 'https://mobile.yangkeduo.com/',
  },
  {
    platform: 'pinduoduo',
    label: 'pddpic 静态图 + imageView2 参数（原图规则验证）',
    url: 'https://funimg.pddpic.com/base/logo.jpg?imageView2/2/w/200/q/80',
    referer: 'https://mobile.yangkeduo.com/',
  },
];

async function probe(url, referer) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        ...(referer ? { Referer: referer } : {}),
      },
      signal: ctrl.signal,
      credentials: 'omit',
      redirect: 'follow',
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      declaredLength: res.headers.get('content-length'),
      actualBytes: buf.length,
      magic: [...buf.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
    };
  } catch (e) {
    return { error: String(e?.name ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (const t of TARGETS) {
  const noRef = await probe(t.url, null);
  const withRef = await probe(t.url, t.referer);
  results.push({ ...t, noReferer: noRef, withReferer: withRef });
  console.log(JSON.stringify({ label: t.label, noReferer: noRef, withReferer: withRef }, null, 2));
}

const summary = { sampledAt: new Date().toISOString(), results };
writeFileSync(join(rawDir, 'cdn-probe.json'), JSON.stringify(summary, null, 2), 'utf8');
