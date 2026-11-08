import { describe, expect, it } from 'vitest';
import { clearInlineGlobalCache, extractAssignedObject, readInlineGlobal } from './inline-ssr';

function docFrom(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('extractAssignedObject', () => {
  it('解析 window.rawData = {…}', () => {
    expect(extractAssignedObject('window.rawData={"a":1};', 'rawData')).toEqual({ a: 1 });
  });

  it('等号两侧有空白也能解析', () => {
    expect(extractAssignedObject('window.rawData  =  {"a":1};', 'rawData')).toEqual({ a: 1 });
  });

  it('window["name"] 写法', () => {
    expect(extractAssignedObject('window["rawData"]={"a":1};', 'rawData')).toEqual({ a: 1 });
  });

  it('var 声明写法', () => {
    expect(extractAssignedObject('var rawData={"a":1};', 'rawData')).toEqual({ a: 1 });
  });

  it('字符串里的花括号不影响括号配平', () => {
    const code = 'window.rawData={"t":"}{"}';
    expect(extractAssignedObject(code, 'rawData')).toEqual({ t: '}{' });
  });

  it('字符串里的转义引号不会被当成字符串结束', () => {
    const code = 'window.rawData={"t":"a\\"}{b"}';
    expect(extractAssignedObject(code, 'rawData')).toEqual({ t: 'a"}{b' });
  });

  it('嵌套对象完整取出来', () => {
    const code = 'window.rawData={"store":{"initDataObj":{"needLogin":true}}};';
    expect(extractAssignedObject(code, 'rawData')).toEqual({
      store: { initDataObj: { needLogin: true } },
    });
  });

  it('没有赋值语句返回 undefined', () => {
    expect(extractAssignedObject('window.other=1;', 'rawData')).toBeUndefined();
  });

  it('JSON 非法时返回 undefined 而不是抛异常', () => {
    expect(extractAssignedObject('window.rawData={a:undefined};', 'rawData')).toBeUndefined();
  });

  it('括号不闭合时返回 undefined', () => {
    expect(extractAssignedObject('window.rawData={"a":1', 'rawData')).toBeUndefined();
  });
});

describe('readInlineGlobal', () => {
  it('从真实形状的 SSR 脚本里读出 rawData（FINDINGS §1 的 needLogin 样本）', () => {
    const doc = docFrom(
      '<html><head><script>window.rawData={"store":{"initDataObj":{"needLogin":true}}};</script></head><body></body></html>',
    );
    expect(readInlineGlobal(doc, 'rawData')).toEqual({
      store: { initDataObj: { needLogin: true } },
    });
  });

  it('忽略带 src 的外链脚本', () => {
    const doc = docFrom(
      '<html><body><script src="https://a/x.js">window.rawData={"a":1};</script></body></html>',
    );
    expect(readInlineGlobal(doc, 'rawData')).toBeUndefined();
  });

  it('跳过前面不相关的内联脚本', () => {
    const doc = docFrom(
      '<html><body><script>window.__pft={};</script><script>window.rawData={"a":1};</script></body></html>',
    );
    expect(readInlineGlobal(doc, 'rawData')).toEqual({ a: 1 });
  });

  it('没有任何脚本时返回 undefined', () => {
    expect(readInlineGlobal(docFrom('<html><body></body></html>'), 'rawData')).toBeUndefined();
  });
});

describe('内联 SSR 解析缓存', () => {
  it('同一份文档、同一个名字只解析一次（返回同一对象引用）', () => {
    const doc = docFrom(
      '<html><head><script>window.rawData={"store":{"initDataObj":{"goods":{"goodsName":"t"}}}};</script></head></html>',
    );
    const first = readInlineGlobal(doc, 'rawData');
    const second = readInlineGlobal(doc, 'rawData');
    expect(second).toBe(first);
  });

  it('新增内联脚本会让缓存自动失效（SPA 注入 SSR 数据的常见形态）', () => {
    const doc = docFrom('<html><body></body></html>');
    expect(readInlineGlobal(doc, 'rawData')).toBeUndefined();

    const script = doc.createElement('script');
    script.textContent = 'window.rawData={"a":1};';
    doc.body.appendChild(script);

    expect(readInlineGlobal(doc, 'rawData')).toEqual({ a: 1 });
  });

  it('clearInlineGlobalCache 能作废「脚本数量不变、内容被原地改写」的缓存', () => {
    const doc = docFrom('<html><body><script>window.rawData={"a":1};</script></body></html>');
    expect(readInlineGlobal(doc, 'rawData')).toEqual({ a: 1 });

    const script = doc.querySelector('script');
    if (script !== null) script.textContent = 'window.rawData={"a":2};';
    // 脚本数量没变：只有显式作废（换商品）才能看到新内容
    expect(readInlineGlobal(doc, 'rawData')).toEqual({ a: 1 });

    clearInlineGlobalCache(doc);
    expect(readInlineGlobal(doc, 'rawData')).toEqual({ a: 2 });
  });
});
