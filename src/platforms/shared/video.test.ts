import { describe, expect, it } from 'vitest';
import {
  compareVideo,
  guessCodec,
  guessContainer,
  isH265Only,
  selectVideo,
  toVideoMeta,
  type VideoCandidate,
} from './video';

function v(partial: Partial<VideoCandidate> & { url: string }): VideoCandidate {
  return { codec: 'h264', container: 'mp4', ...partial };
}

describe('selectVideo', () => {
  it('优先 H.264，即使 H.265 分辨率更高（Windows 自带播放器放不了 HEVC）', () => {
    const best = selectVideo([
      v({ url: 'https://v.douyinvod.com/h265.mp4', codec: 'h265', width: 1080, height: 1920 }),
      v({ url: 'https://v.douyinvod.com/h264.mp4', codec: 'h264', width: 720, height: 1280 }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/h264.mp4');
  });

  it('同编码里选分辨率最高的', () => {
    const best = selectVideo([
      v({ url: 'https://v.douyinvod.com/720.mp4', width: 720, height: 1280 }),
      v({ url: 'https://v.douyinvod.com/1080.mp4', width: 1080, height: 1920 }),
      v({ url: 'https://v.douyinvod.com/540.mp4', width: 540, height: 960 }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/1080.mp4');
  });

  it('同分辨率再选码率最高的', () => {
    const best = selectVideo([
      v({ url: 'https://v.douyinvod.com/a.mp4', width: 1080, height: 1920, bitrate: 2_000_000 }),
      v({ url: 'https://v.douyinvod.com/b.mp4', width: 1080, height: 1920, bitrate: 4_500_000 }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/b.mp4');
  });

  it('只有 H.265 时照常返回它（由调用方标记 h265Only）', () => {
    const candidates = [v({ url: 'https://v.douyinvod.com/only.mp4', codec: 'h265' })];
    expect(selectVideo(candidates)?.codec).toBe('h265');
    expect(isH265Only(candidates)).toBe(true);
  });

  it('非 mp4（HLS / DASH）不参与选择', () => {
    expect(
      selectVideo([
        v({ url: 'https://v.douyinvod.com/a.m3u8', container: 'hls' }),
        v({ url: 'https://v.douyinvod.com/a.mpd', container: 'dash' }),
      ]),
    ).toBeNull();
  });

  it('mp4 直链里混了 HLS 时，仍然选 mp4', () => {
    const best = selectVideo([
      v({ url: 'https://v.douyinvod.com/a.m3u8', container: 'hls' }),
      v({ url: 'https://v.douyinvod.com/a.mp4' }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/a.mp4');
  });

  it('编码未知时按中间优先级处理：排在 h264 之后、h265 之前', () => {
    const best = selectVideo([
      v({
        url: 'https://v.douyinvod.com/unknown.mp4',
        codec: 'unknown',
        width: 2160,
        height: 3840,
      }),
      v({ url: 'https://v.douyinvod.com/h264.mp4', codec: 'h264', width: 720, height: 1280 }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/h264.mp4');
  });

  it('空列表返回 null', () => {
    expect(selectVideo([])).toBeNull();
  });

  it('完全相同的候选保持原始顺序（稳定选择）', () => {
    const best = selectVideo([
      v({ url: 'https://v.douyinvod.com/first.mp4' }),
      v({ url: 'https://v.douyinvod.com/second.mp4' }),
    ]);
    expect(best?.url).toBe('https://v.douyinvod.com/first.mp4');
  });
});

describe('compareVideo', () => {
  it('负数表示 a 更优', () => {
    expect(
      compareVideo(
        v({ url: 'a', codec: 'h264' }),
        v({ url: 'b', codec: 'h265', width: 2160, height: 3840 }),
      ),
    ).toBeLessThan(0);
  });
});

describe('isH265Only', () => {
  it('同时有 H.264 时返回 false', () => {
    expect(isH265Only([v({ url: 'a', codec: 'h265' }), v({ url: 'b', codec: 'h264' })])).toBe(
      false,
    );
  });

  it('没有 mp4 时返回 false（不是「只有 H.265」，而是根本没有可用视频）', () => {
    expect(isH265Only([v({ url: 'a.m3u8', container: 'hls', codec: 'h265' })])).toBe(false);
  });
});

describe('toVideoMeta', () => {
  it('只带上真实存在的字段（exactOptionalPropertyTypes 下不能写 undefined）', () => {
    const meta = toVideoMeta(v({ url: 'a.mp4', codec: 'h264', width: 1080, height: 1920 }));
    expect(meta).toEqual({ codec: 'h264', container: 'mp4', width: 1080, height: 1920 });
    expect(meta).not.toHaveProperty('bitrate');
  });

  it('过期时间写进 expiresAt', () => {
    const meta = toVideoMeta(v({ url: 'a.mp4' }), { expiresAt: 1_793_890_600_000 });
    expect(meta.expiresAt).toBe(1_793_890_600_000);
  });

  it('kernel parseExpiry 返回 null 时不写 expiresAt（契约是 z.number().optional()）', () => {
    const meta = toVideoMeta(v({ url: 'a.mp4' }), { expiresAt: null });
    expect(meta).not.toHaveProperty('expiresAt');
  });
});

describe('guessCodec', () => {
  it('从各种编码写法猜出来', () => {
    expect(guessCodec('bytevc1')).toBe('h265');
    expect(guessCodec('h265')).toBe('h265');
    expect(guessCodec(undefined, 'HEVC')).toBe('h265');
    expect(guessCodec('avc1.640028')).toBe('h264');
    expect(guessCodec('H264')).toBe('h264');
    expect(guessCodec('mp4')).toBe('unknown');
    expect(guessCodec(undefined, undefined)).toBe('unknown');
  });
});

describe('guessContainer', () => {
  it('从地址猜容器', () => {
    expect(guessContainer('https://v.douyinvod.com/a.m3u8')).toBe('hls');
    expect(guessContainer('https://v.douyinvod.com/a.mpd')).toBe('dash');
    expect(guessContainer('https://v.douyinvod.com/a.mp4')).toBe('mp4');
    expect(guessContainer('https://v.douyinvod.com/a')).toBe('unknown');
  });
});
