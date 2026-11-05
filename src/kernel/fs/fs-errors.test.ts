import { describe, expect, it } from 'vitest';
import { EcError } from '../errors/ec-error';
import { mapFsError } from './fs-errors';
import { blobToText, countingStream, stripBom, toStream } from './stream-utils';

describe('mapFsError（§9.10）', () => {
  it('NotFoundError → DIR_GONE', () => {
    expect(mapFsError(new DOMException('x', 'NotFoundError')).code).toBe('DIR_GONE');
  });

  it('NotAllowedError → DIR_NEEDS_GRANT', () => {
    expect(mapFsError(new DOMException('x', 'NotAllowedError')).code).toBe('DIR_NEEDS_GRANT');
  });

  it('QuotaExceededError → DISK_FULL', () => {
    expect(mapFsError(new DOMException('x', 'QuotaExceededError')).code).toBe('DISK_FULL');
  });

  it('AbortError → CANCELED', () => {
    expect(mapFsError(new DOMException('x', 'AbortError')).code).toBe('CANCELED');
  });

  it('其他 DOMException → WRITE_FAILED', () => {
    expect(mapFsError(new DOMException('x', 'InvalidStateError')).code).toBe('WRITE_FAILED');
  });

  it('message 里带空间不足字样 → DISK_FULL', () => {
    expect(mapFsError(new Error('There is not enough space on the disk')).code).toBe('DISK_FULL');
  });

  it('已经是 EcError 时原样返回', () => {
    const original = new EcError('HTTP_404');
    expect(mapFsError(original)).toBe(original);
  });

  it('非 Error 值也能映射', () => {
    expect(mapFsError('boom').code).toBe('WRITE_FAILED');
  });
});

describe('stream-utils', () => {
  it('stripBom 去掉 UTF-8 BOM', () => {
    expect(stripBom('\uFEFF{}')).toBe('{}');
    expect(stripBom('{}')).toBe('{}');
  });

  it('blobToText 自动去 BOM（记事本改坏的 .ecbox.json）', async () => {
    expect(await blobToText(new Blob(['\uFEFF{"v":1}']))).toBe('{"v":1}');
  });

  it('toStream 把 Blob 转成流', async () => {
    const stream = toStream(new Blob(['abc']));
    const text = await new Response(stream).text();
    expect(text).toBe('abc');
  });

  it('toStream 对流原样返回', () => {
    const stream = new Blob(['x']).stream();
    expect(toStream(stream)).toBe(stream);
  });

  it('countingStream 统计转发的字节数', async () => {
    const { stream, total } = countingStream();
    const source = new Blob(['abcdef']).stream();
    const out = new Response(source.pipeThrough(stream));
    expect(await out.text()).toBe('abcdef');
    expect(total()).toBe(6);
  });
});
