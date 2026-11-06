/**
 * Phase 0 §17-7 定论：验证"~tplv-obj.image 是不是原图"。
 * 读 PNG IHDR / WebP VP8X / JPEG SOF 拿到真实像素尺寸再比较。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://p11.douyinpic.com/img/aweme-qrcode/rFtJiT7704704965461149491';

function pngSize(buf) {
  if (buf[0] !== 0x89 || buf[1] !== 0x50) return null;
  const v = new DataView(buf.buffer, buf.byteOffset, 33);
  return { w: v.getUint32(16), h: v.getUint32(20) };
}

function webpSize(buf) {
  const riff = new TextDecoder().decode(buf.slice(0, 4));
  if (riff !== 'RIFF') return null;
  const fourcc = new TextDecoder().decode(buf.slice(12, 16));
  if (fourcc === 'VP8X') {
    const w = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const h = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { w, h, kind: 'VP8X' };
  }
  if (fourcc === 'VP8 ') {
    const w = (buf[26] | (buf[27] << 8)) & 0x3fff;
    const h = (buf[28] | (buf[29] << 8)) & 0x3fff;
    return { w, h, kind: 'VP8' };
  }
  if (fourcc === 'VP8L') {
    const b = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1, kind: 'VP8L' };
  }
  return null;
}

function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = buf[i + 1];
    const len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (buf[i + 5] << 8) | buf[i + 6], w: (buf[i + 7] << 8) | buf[i + 8] };
    }
    i += 2 + len;
  }
  return null;
}

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: ctrl.signal,
      credentials: 'omit',
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    const dims = pngSize(buf) ?? webpSize(buf) ?? jpegSize(buf);
    return { status: res.status, type: res.headers.get('content-type'), bytes: buf.length, dims };
  } catch (e) {
    return { error: String(e?.name ?? e) };
  } finally {
    clearTimeout(t);
  }
}

const VARIANTS = [
  { label: '页面原始 ~c5_720x720.webp', url: BASE + '~c5_720x720.webp?from=773146320' },
  { label: '~c5_2000x2000.webp', url: BASE + '~c5_2000x2000.webp?from=773146320' },
  { label: '~tplv-obj.image （候选原图规则）', url: BASE + '~tplv-obj.image' },
  { label: '~tplv-obj:720:720.webp', url: BASE + '~tplv-obj:720:720.webp' },
];

for (const v of VARIANTS) {
  console.log(JSON.stringify({ label: v.label, ...(await probe(v.url)) }));
}
