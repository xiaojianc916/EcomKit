import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_SUFFIX,
  originalImageCandidates,
  thumbnailUrl,
  toDyImageAsset,
  toOriginalImageUrl,
  toVideoCandidates,
} from './media';

/**
 * 这一组用例直接对应 docs/phase0/FINDINGS.md §1.5 的实测表格，
 * 5 种输入每种一条，规则改动时这里必须先改。
 */

describe('toOriginalImageUrl（FINDINGS §1.5 实测规则）', () => {
  it('① 页面原始 ~c5_720x720.webp → ~tplv-obj.image', () => {
    expect(
      toOriginalImageUrl(
        'https://p3.douyinpic.com/img/aweme-qrcode/AsyRjK7704704965423548200~c5_720x720.webp?from=773146320',
      ),
    ).toBe(
      'https://p3.douyinpic.com/img/aweme-qrcode/AsyRjK7704704965423548200~tplv-obj.image?from=773146320',
    );
  });

  it('② ~c5_2000x2000.webp → ~tplv-obj.image', () => {
    expect(toOriginalImageUrl('https://p3.douyinpic.com/img/a~c5_2000x2000.webp')).toBe(
      'https://p3.douyinpic.com/img/a~tplv-obj.image',
    );
  });

  it('③ ~tplv-obj:720:720.webp → ~tplv-obj.image', () => {
    expect(toOriginalImageUrl('https://p3.douyinpic.com/img/a~tplv-obj:720:720.webp')).toBe(
      'https://p3.douyinpic.com/img/a~tplv-obj.image',
    );
  });

  it('④ 已经是 ~tplv-obj.image 时保持不变（幂等）', () => {
    const once = toOriginalImageUrl('https://p3.douyinpic.com/img/a~tplv-obj.image');
    expect(once).toBe('https://p3.douyinpic.com/img/a~tplv-obj.image');
    expect(toOriginalImageUrl(once as string)).toBe(once);
  });

  it('⑤ 没有 ~ 后缀时返回 undefined（实测去掉后缀会 400，不能凭空造）', () => {
    expect(toOriginalImageUrl('https://p3.douyinpic.com/img/a.webp?from=1')).toBeUndefined();
  });

  it('查询串保持不变（追踪参数不影响 CDN 取图）', () => {
    expect(toOriginalImageUrl('https://p3.douyinpic.com/img/a~c5_720x720.webp?from=1&x=2')).toBe(
      'https://p3.douyinpic.com/img/a~tplv-obj.image?from=1&x=2',
    );
  });

  it('不可用地址返回 undefined', () => {
    expect(toOriginalImageUrl('data:image/png;base64,AA')).toBeUndefined();
    expect(toOriginalImageUrl('')).toBeUndefined();
    expect(toOriginalImageUrl(undefined as unknown as string)).toBeUndefined();
  });

  it('原图后缀常量就是实测可用的那个', () => {
    expect(ORIGINAL_SUFFIX).toBe('~tplv-obj.image');
  });
});

describe('originalImageCandidates', () => {
  it('候选顺序是 [原图, 页面原始 URL]', () => {
    expect(
      originalImageCandidates('https://p3.douyinpic.com/aweme/a~c5_720x720.webp?from=1'),
    ).toEqual([
      'https://p3.douyinpic.com/aweme/a~tplv-obj.image?from=1',
      'https://p3.douyinpic.com/aweme/a~c5_720x720.webp?from=1',
    ]);
  });

  it('没有 ~ 后缀时只有一个候选', () => {
    expect(originalImageCandidates('https://p3.douyinpic.com/aweme/a.webp')).toEqual([
      'https://p3.douyinpic.com/aweme/a.webp',
    ]);
  });

  it('不可用地址返回空数组', () => {
    expect(originalImageCandidates('blob:https://x/1')).toEqual([]);
  });
});

describe('thumbnailUrl', () => {
  it('缩略图直接用页面原始 URL，不改后缀（实测后缀尺寸不生效）', () => {
    const raw = 'https://p3.douyinpic.com/aweme/a~c5_720x720.webp?from=1';
    expect(thumbnailUrl(raw)).toBe(raw);
  });

  it('不改写没有 ~ 后缀的地址', () => {
    expect(thumbnailUrl('https://p6.douyinpic.com/x.webp')).toBe('https://p6.douyinpic.com/x.webp');
  });

  it('不可用地址返回 undefined', () => {
    expect(thumbnailUrl('data:image/png;base64,AA')).toBeUndefined();
  });
});

describe('toDyImageAsset', () => {
  it('生成素材：key 取原图路径，candidates 两个，preview 是页面原始 URL', () => {
    const asset = toDyImageAsset(
      { url: 'https://p3.douyinpic.com/a~c5_720x720.webp', width: 720, height: 720 },
      { kind: 'main', index: 0 },
    );
    expect(asset).toMatchObject({
      kind: 'main',
      index: 0,
      candidates: [
        'https://p3.douyinpic.com/a~tplv-obj.image',
        'https://p3.douyinpic.com/a~c5_720x720.webp',
      ],
      preview: 'https://p3.douyinpic.com/a~c5_720x720.webp',
      width: 720,
      height: 720,
    });
  });

  it('地址不可用返回 null', () => {
    expect(
      toDyImageAsset({ url: 'data:image/png;base64,AA' }, { kind: 'main', index: 0 }),
    ).toBeNull();
  });
});

describe('toVideoCandidates', () => {
  it('is_h265 是 1 时标 h265，0 时标 h264', () => {
    const candidates = toVideoCandidates({
      bit_rate: [
        {
          gear_name: 'normal_1080_0',
          bit_rate: 4_500_000,
          is_h265: 1,
          play_addr: { url_list: ['https://v.douyinvod.com/h265.mp4'], width: 1080, height: 1920 },
        },
        {
          gear_name: 'normal_720_0',
          bit_rate: 2_000_000,
          is_h265: 0,
          play_addr: { url_list: ['https://v.douyinvod.com/h264.mp4'], width: 720, height: 1280 },
        },
      ],
    });
    expect(candidates.map((c) => c.codec)).toEqual(['h265', 'h264']);
    expect(candidates.map((c) => c.container)).toEqual(['mp4', 'mp4']);
  });

  it('bit_rate 为空时退回 play_addr', () => {
    const candidates = toVideoCandidates({
      play_addr: { url_list: ['https://v.douyinvod.com/main.mp4'], width: 1080, height: 1920 },
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.url).toBe('https://v.douyinvod.com/main.mp4');
  });

  it('封面和时长带进每个候选', () => {
    const [first] = toVideoCandidates({
      play_addr: { url_list: ['https://v.douyinvod.com/main.mp4'] },
      cover: { url_list: ['https://p3.douyinpic.com/cover.webp'] },
      duration: 15,
    });
    expect(first?.cover).toBe('https://p3.douyinpic.com/cover.webp');
    expect(first?.duration).toBe(15);
  });

  it('没有任何地址时返回空数组', () => {
    expect(toVideoCandidates({})).toEqual([]);
  });
});
