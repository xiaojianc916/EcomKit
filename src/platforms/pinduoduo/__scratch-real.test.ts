import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { draftFromPayload } from './resolver';

describe('scratch real payload', () => {
  it('dumps draft', () => {
    const raw = JSON.parse(readFileSync('D:/EcomKit/.tmp-rawdata.json', 'utf8'));
    const draft = draftFromPayload(
      raw,
      { url: new URL('https://mobile.yangkeduo.com/goods.html?goods_id=547575437012'), document: {} as Document },
      'ssr',
    );
    console.log('DRAFT', JSON.stringify(draft, null, 2).slice(0, 4000));
    console.log('counts', draft?.assets?.length, draft?.skus?.length, draft?.title);
    expect(draft).toBeTruthy();
  });
});
