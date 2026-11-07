/**
 * 把 public/icon/EcomKit-icon.svg 渲染成扩展要用的 16/32/48/128 PNG。
 *
 * 为什么不用 sharp / imagemagick：仓库里没有这些图形库，为 4 张图加一整套原生依赖
 * 不划算。Playwright 的 Chromium 已经装着（e2e 在用），它的截图就是现成的
 * SVG 光栅化器，输出还是浏览器真实渲染的结果。
 *
 * 两条必须守住的细节：
 *   1. 透明背景 —— 不开 omitBackground 截出来是一张白底图，
 *      挂到深色工具栏上就是一块白方块。
 *   2. 裁掉源文件自带的留白 —— 源 SVG 的 viewBox 是 0..512，但图形只占中间
 *      364×379（四周 12.5% 透明），照搬的话 16px 下图形只剩约 11px，糊成一团。
 *      所以渲染时按 alpha 包围盒**在脚本里**改 viewBox 放大图形，源文件一个字节不动：
 *      它才是图标的事实来源，改它就等于手改矢量。
 *
 * 跑法：node scripts/icon-render.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const iconDir = join(root, 'public', 'icon');
const svgPath = join(iconDir, 'EcomKit-icon.svg');
const SIZES = [16, 32, 48, 128];

/** 图形四周留白占图形边长的比例。留一点是为了小尺寸下不被工具栏裁边，多了就又变小了。 */
const MARGIN_RATIO = 0.06;
/** 参与包围盒计算的最小 alpha：更低的像素是抗锯齿边缘，算进去会把图形撑大一圈。 */
const ALPHA_FLOOR = 24;

const source = readFileSync(svgPath, 'utf8');

const browser = await chromium.launch();
try {
  const page = await browser.newPage();

  // 1. 量出图形在源坐标系里的实际范围（先按 512 光栅化，再读 alpha）
  const [, , vbW, vbH] = svgViewBox(source);
  const bbox = await measureInk(page, source, Math.max(vbW, vbH));
  const side = Math.max(bbox.width, bbox.height) * (1 + MARGIN_RATIO * 2);
  // 以图形中心裁一个正方形；源坐标系不是正方形时也可能越界，夹回画布内
  const cx = bbox.x + bbox.width / 2;
  const cy = bbox.y + bbox.height / 2;
  const left = clamp(cx - side / 2, 0, vbW - side);
  const top = clamp(cy - side / 2, 0, vbH - side);
  const cropped = source.replace(
    /viewBox="[^"]*"/,
    `viewBox="${round(left)} ${round(top)} ${round(side)} ${round(side)}"`,
  );
  console.log(
    `[icon] ink ${round(bbox.width)}x${round(bbox.height)} @ ${round(bbox.x)},${round(bbox.y)} -> viewBox ${round(left)} ${round(top)} ${round(side)} ${round(side)}`,
  );

  // 2. 每个尺寸单独设视口再截：Playwright 的截图尺寸等于视口，不会二次缩放
  for (const size of SIZES) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}
       svg{display:block;width:${size}px;height:${size}px}</style>${cropped}`,
    );
    const png = await page.screenshot({ omitBackground: true, type: 'png' });
    writeFileSync(join(iconDir, `${size}.png`), png);
    console.log(`[icon] ${size}x${size} -> icon/${size}.png (${png.length} B)`);
  }
} finally {
  await browser.close();
}

/** 从 SVG 文本里读 viewBox 的四个数；没有就退化成 512 正方形（源文件已知是它） */
function svgViewBox(svg) {
  const raw = svg.match(/viewBox="([^"]+)"/)?.[1];
  const parts =
    raw
      ?.trim()
      .split(/[\s,]+/)
      .map(Number) ?? [];
  return parts.length === 4 ? parts : [0, 0, 512, 512];
}

/** 把 SVG 光栅化到边长 px 的 canvas，返回不透明像素的包围盒（源坐标系单位） */
async function measureInk(page, svg, px) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}
     svg{display:block;width:${px}px;height:${px}px}</style>${svg}`,
  );
  const [, , vbW, vbH] = svgViewBox(svg);
  const box = await page.evaluate((floor) => {
    const svgEl = document.querySelector('svg');
    const rect = svgEl.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const blobUrl = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(svgEl)], { type: 'image/svg+xml' }),
    );
    return new Promise((ok) => {
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height);
        const data = ctx.getImageData(0, 0, width, height).data;
        let minX = width;
        let minY = height;
        let maxX = -1;
        let maxY = -1;
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] < floor) continue;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
        URL.revokeObjectURL(blobUrl);
        ok(maxX < 0 ? null : { minX, minY, maxX, maxY, width, height });
      };
      img.src = blobUrl;
    });
  }, ALPHA_FLOOR);
  if (box === null) throw new Error('EcomKit-icon.svg 渲染不出任何不透明像素，源文件坏了');

  // 像素坐标换回源坐标系，网格对齐误差向上取整，宁可多留半像素也不要切到图形
  const scaleX = vbW / box.width;
  const scaleY = vbH / box.height;
  const x = box.minX * scaleX;
  const y = box.minY * scaleY;
  return {
    x,
    y,
    width: (box.maxX + 1) * scaleX - x,
    height: (box.maxY + 1) * scaleY - y,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function round(value) {
  return Math.round(value * 100) / 100;
}
