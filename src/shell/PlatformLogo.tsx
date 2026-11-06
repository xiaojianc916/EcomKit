import douyinLogo from './assets/douyin.svg?raw';
import pinduoduoLogo from './assets/pinduoduo.svg?raw';

/**
 * 平台图标（标题栏左上角）。
 *
 * 为什么内联 SVG 而不是 <img src>：面板渲染在商品页的 Shadow DOM 里，
 * 一个 `/assets/xxx.svg` 的相对地址会被解析到**商品页的源**上（404），
 * 想用 URL 就得走 runtime.getURL + web_accessible_resources 两道配置。
 * ?raw 在构建期把 SVG 文本打进 bundle，没有地址解析问题，也没有第二次请求。
 */
const LOGOS: Record<string, string> = {
  pinduoduo: normalize(pinduoduoLogo),
  douyin: normalize(douyinLogo),
};

/**
 * 把源文件洗成「能直接内联、能跟着容器高度缩放」的 SVG。
 *
 * - 去掉 width/height：源文件里是固定像素，会把 40px 标题栏撑爆；
 * - 去掉 <title>：它会被读屏器念一遍，而外面已经有 aria-label；
 * - 保留 viewBox，尺寸交给 CSS（height:100% + width:auto）。
 */
function normalize(markup: string): string {
  const open = markup.match(/<svg[^>]*>/)?.[0];
  if (open === undefined) return markup;
  const viewBox = open.match(/viewBox="([^"]+)"/)?.[1] ?? '0 0 1 1';
  const body = markup.slice(open.length).replace(/<title>[\s\S]*?<\/title>/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" style="display:block;height:100%;width:auto">${body}`;
}

export interface PlatformLogoProps {
  /** 平台 id（pinduoduo / douyin）；没有对应图标时返回 null，由调用方退回原来的色点 */
  platformId: string | undefined;
  /** 显示名，给读屏器 */
  name: string;
  height?: number;
}

export function PlatformLogo({ platformId, name, height = 18 }: PlatformLogoProps) {
  const markup = platformId === undefined ? undefined : LOGOS[platformId];
  if (markup === undefined) return null;
  return (
    <span
      role="img"
      aria-label={name}
      data-ecbox-logo={platformId}
      style={{ display: 'inline-flex', height, flex: 'none' }}
      /*
        markup 来自构建期 ?raw 打包的本地 SVG 文件（src/shell/assets/*.svg），
        没有任何运行时/外部输入，不存在 XSS 面；用 innerHTML 是因为要把整段 SVG
        当图形插进 DOM，逐节点转成 React 元素既没必要也和源文件对不上。
      */
      // biome-ignore lint/security/noDangerouslySetInnerHtml: 内容是构建期打包的静态 SVG
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
