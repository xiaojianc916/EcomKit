/**
 * Phase 0 §17-7 细化：抖音图片处理后缀到底能不能去掉、哪种改法能拿到更大的图。
 * 拼多多已确认：去掉 ?imageView2/... 后 8945 → 20202 字节，原图规则成立。
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const BASE = 'https://p11.douyinpic.com/img/aweme-qrcode/rFtJiT7704704965461149491';

const VARIANTS = [
  { label: '原始 ~c5_720x720.webp', url: BASE + '~c5_720x720.webp?from=773146320' },
  { label: '~c5_1080x1080.webp', url: BASE + '~c5_1080x1080.webp?from=773146320' },
  { label: '~c5_2000x2000.webp', url: BASE + '~c5_2000x2000.webp?from=773146320' },
  { label: '~c5_720x720.jpg', url: BASE + '~c5_720x720.jpg?from=773146320' },
  { label: '仅 ~c5.webp（去尺寸）', url: BASE + '~c5.webp?from=773146320' },
  { label: '无后缀 + .webp', url: BASE + '.webp?from=773146320' },
  { label: '无后缀无参数', url: BASE },
  { label: '~tplv 形式（模拟）', url: BASE + '~tplv-obj:720:720.webp' },
  { label: '~tplv 形式 image（模拟）', url: BASE + '~tplv-obj.image' },
];

async function probe(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/*,*/*;q=0.8' },
      signal: ctrl.signal,
      credentials: 'omit',
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      contentType: res.headers.get('content-type'),
      bytes: buf.length,
      // webp: RIFF....WEBP;  jpeg: FFD8FF;  png: 89504E47
      magic: [...buf.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join(' '),
      head: new TextDecoder().decode(buf.slice(0, 120)).replace(/[^\x20-\x7e]/g, '.'),
    };
  } catch (e) {
    return { error: String(e?.name ?? e) };
  } finally {
    clearTimeout(t);
  }
}

for (const v of VARIANTS) {
  const r = await probe(v.url);
  console.log(JSON.stringify({ label: v.label, ...r }));
}
