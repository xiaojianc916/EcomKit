/**
 * MAIN world 桥（方案 §4.2、§7.4）。
 *
 * 它跑在**页面的 JS 上下文**里，所以：
 *   - 不能访问任何 chrome.* 扩展 API（拿到的 chrome 是页面的，不是扩展的）
 *   - 不能 import 内核里任何依赖扩展 API 的东西
 *   - 绝不能改变页面的行为：所有逻辑包在 try/catch 里，永远返回原始的 Response
 *
 * 只做两件事：
 *   1. NetworkTap：包装 fetch / XHR，把**命中抓取规则**的 JSON 响应克隆一份丢进环形缓冲
 *   2. GlobalReader：按白名单路径读 window 全局变量，做 JSON 安全拷贝
 *
 * 和 ISOLATED 的通信全部走 CustomEvent，detail 一律 JSON 字符串（§6.3）。
 */

import {
  type BridgeCaptureMessage,
  type BridgeHello,
  type BridgeReadGlobalRequest,
  type BridgeReadGlobalResult,
  bridgeEvent,
  publishBridgePrefix,
  readPath,
  safeJsonCopy,
} from '../kernel/messaging/page-bridge';
import { findPageKind, PLATFORM_MATCHES } from '../platforms/registry';

/** 交给 MAIN 的抓取规则：**可序列化**（平台 manifest 是纯数据，MAIN 自己也能读） */
interface RuntimeCaptureRule {
  id: string;
  urlPattern: string;
  maxBytes: number;
  pageKinds: string[];
}

interface RuleMatcher {
  rule: RuntimeCaptureRule;
  re: RegExp;
}

const RING_SIZE = 60;
const DEFAULT_MAX_BYTES = 3 * 1024 * 1024;

export default defineContentScript({
  // 只在商品页注入（§13.2 最小注入面）：匹配范围由平台层 manifest 汇总生成
  matches: PLATFORM_MATCHES,
  runAt: 'document_start',
  world: 'MAIN',
  allFrames: false,
  main() {
    // 整个 MAIN world 逻辑都必须在 try/catch 里：这里一抛异常就会污染页面
    try {
      bootstrap();
    } catch {
      /* 静默：绝不影响页面 */
    }
  },
});

/**
 * 启动顺序（修正后）：
 *   1. document_start：MAIN 生成前缀写到 <html data-ecbox-c>，交给稍后启动的 ISOLATED；
 *   2. 同一时刻按当前 URL 从平台清单取出抓取规则，**立刻**包装 fetch/XHR —— 商品详情接口
 *      经常在 document_idle 之前就返回，等 ISOLATED 来下发规则就错过了；
 *   3. ISOLATED（document_idle）读走前缀后发 hello：MAIN 追加规则、回放环形缓冲、回 ready。
 */
function bootstrap(): void {
  const prefix = publishBridgePrefix(document);

  const ring: BridgeCaptureMessage[] = [];
  const matchers: RuleMatcher[] = [];

  const emit = (name: string, payload: unknown) => {
    try {
      document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
    } catch {
      /* 序列化失败就丢弃，不影响页面 */
    }
  };

  // 原生 fetch 的源码必须在包装**之前**取，否则拿到的是包装函数自己的源码
  const fetchSource = nativeSourceOf(window.fetch, 'function fetch() { [native code] }');

  let tapInstalled = false;
  const ensureTap = () => {
    if (tapInstalled || matchers.length === 0) return;
    tapInstalled = true;
    installNetworkTap(prefix, matchers, ring, emit);
    protectNativeToString(fetchSource);
  };

  // 1) 不等 ISOLATED：按当前 URL 立刻装载本页规则
  addRules(matchers, rulesForLocation());
  ensureTap();

  // 2) ISOLATED 下发 hello（SPA 换页时可能追加规则）→ 回放缓冲 → ready
  document.addEventListener(bridgeEvent.hello(prefix), (ev) => {
    try {
      const hello = JSON.parse((ev as CustomEvent<string>).detail) as BridgeHello & {
        rules?: RuntimeCaptureRule[];
      };
      addRules(matchers, Array.isArray(hello.rules) ? hello.rules : []);
      ensureTap();
      const wanted = new Set(hello.ruleIds ?? []);
      for (const msg of ring) {
        if (wanted.size === 0 || wanted.has(msg.ruleId)) emit(bridgeEvent.capture(prefix), msg);
      }
      emit(bridgeEvent.ready(prefix), { ok: true });
    } catch {
      /* 规则坏了就不工作 */
    }
  });

  // ISOLATED 请求读取全局变量
  document.addEventListener(bridgeEvent.readGlobal(prefix), (ev) => {
    let req: BridgeReadGlobalRequest | null = null;
    try {
      req = JSON.parse((ev as CustomEvent<string>).detail) as BridgeReadGlobalRequest;
    } catch {
      return;
    }
    if (!req?.id || typeof req.path !== 'string') return;

    const result: BridgeReadGlobalResult = { id: req.id, ok: false };
    try {
      const value = readPath(window, req.path);
      if (value === undefined) {
        result.error = 'undefined';
      } else {
        const json = safeJsonCopy(value);
        if (json === null) result.error = 'unserializable';
        else {
          result.ok = true;
          result.json = json;
        }
      }
    } catch (e) {
      result.error = e instanceof Error ? e.name : 'error';
    }
    emit(bridgeEvent.readGlobalResult(prefix), result);
  });
}

/** 当前 URL 命中的页面类型的抓取规则（平台清单是纯数据，MAIN 可以直接用） */
function rulesForLocation(): RuntimeCaptureRule[] {
  try {
    const hit = findPageKind(new URL(location.href));
    if (!hit) return [];
    return hit.platform.capture
      .filter((r) => r.pageKinds.includes(hit.kind))
      .map((r) => ({
        id: r.id,
        urlPattern: r.urlPattern,
        maxBytes: r.maxBytes ?? DEFAULT_MAX_BYTES,
        pageKinds: r.pageKinds,
      }));
  } catch {
    return [];
  }
}

/** 追加规则（按 id 去重）；正则编译失败的规则直接丢掉 */
function addRules(matchers: RuleMatcher[], rules: RuntimeCaptureRule[]): void {
  for (const rule of rules) {
    if (!rule || typeof rule.id !== 'string' || typeof rule.urlPattern !== 'string') continue;
    if (matchers.some((m) => m.rule.id === rule.id)) continue;
    try {
      matchers.push({ rule, re: new RegExp(rule.urlPattern) });
    } catch {
      /* 忽略坏规则 */
    }
  }
}

function nativeSourceOf(fn: unknown, fallback: string): string {
  try {
    return Function.prototype.toString.call(fn as () => unknown);
  } catch {
    return fallback;
  }
}

/**
 * 包装 fetch / XHR（方案 §7.4）。
 * 关键约束：**永远返回原始值**，克隆失败就当没发生过。
 * matchers 是可变数组：hello 追加的规则对已经装好的包装立即生效。
 */
function installNetworkTap(
  prefix: string,
  matchers: RuleMatcher[],
  ring: BridgeCaptureMessage[],
  emit: (name: string, payload: unknown) => void,
): void {
  const pushCapture = (ruleId: string, url: string, text: string, at: number, dropped = false) => {
    const msg: BridgeCaptureMessage = { ruleId, url, json: dropped ? null : text, at };
    if (dropped) msg.dropped = true;
    ring.push(msg);
    if (ring.length > RING_SIZE) ring.shift();
    emit(bridgeEvent.capture(prefix), msg);
  };

  const matchRule = (url: string) => matchers.find((m) => m.re.test(url));

  const handleJsonText = (url: string, text: string) => {
    const hit = matchRule(url);
    if (!hit) return;
    // 体积上限：超了就不克隆，保护页面性能（§7.4 表格最后一行）
    if (text.length > (hit.rule.maxBytes ?? DEFAULT_MAX_BYTES)) {
      pushCapture(hit.rule.id, url, '', Date.now(), true);
      return;
    }
    // 只接受 JSON：先确认能 parse，避免把 HTML 错误页当数据
    try {
      JSON.parse(text);
    } catch {
      return;
    }
    pushCapture(hit.rule.id, url, text, Date.now());
  };

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrappedFetch = function patchedFetch(
      this: unknown,
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> {
      const promise = origFetch.call(window, input, init);
      try {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const hit = matchRule(url);
        if (hit) {
          // 用 then 旁听，绝不改变原 promise 的行为
          promise.then(
            (res) => {
              try {
                const ct = res.headers.get('content-type') ?? '';
                if (!ct.includes('json')) return;
                // clone() 之后消耗的是副本，原响应不受影响
                res
                  .clone()
                  .text()
                  .then((text) => handleJsonText(url, text))
                  .catch(() => {});
              } catch {
                /* 忽略 */
              }
              return res;
            },
            () => {},
          );
        }
      } catch {
        /* 忽略：参数不是常规形态 */
      }
      return promise;
    };
    (wrappedFetch as unknown as { toString(): string }).toString = () => origFetch.toString();
    try {
      Object.defineProperty(window, 'fetch', {
        value: wrappedFetch,
        writable: true,
        configurable: true,
        enumerable: true,
      });
    } catch {
      /* 页面锁了 fetch 就算了 */
    }
  }

  // ---- XHR ----
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function patchedOpen(
      this: XMLHttpRequest & { __ecboxUrl?: string },
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      try {
        this.__ecboxUrl = typeof url === 'string' ? url : url.href;
      } catch {
        /* 忽略 */
      }
      // eslint-disable-next-line prefer-rest-params
      return (origOpen as any).apply(this, [method, url, ...rest]);
    } as typeof origOpen;

    XHR.prototype.send = function patchedSend(
      this: XMLHttpRequest,
      body?: Document | XMLHttpRequestBodyInit | null,
    ) {
      try {
        const url = (this as XMLHttpRequest & { __ecboxUrl?: string }).__ecboxUrl;
        if (url && matchRule(url)) {
          this.addEventListener('load', () => {
            try {
              const rt = this.responseType;
              // 只处理 ''、'text'、'json'；binary 一律忽略（§7.4 表格）
              if (rt === '' || rt === 'text') {
                handleJsonText(url, this.responseText);
              } else if (rt === 'json') {
                const text = JSON.stringify(this.response);
                if (text) handleJsonText(url, text);
              }
            } catch {
              /* 忽略 */
            }
          });
        }
      } catch {
        /* 忽略 */
      }
      return origSend.call(this, body);
    };
  }
}

/**
 * 原生函数保护（§7.4 表格）：页面的反调试脚本常检查 `fn.toString().includes('native code')`。
 * fetchSource 是包装之前取到的原生源码。
 */
function protectNativeToString(fetchSource: string): void {
  try {
    const nativeToString = Function.prototype.toString;
    Function.prototype.toString = function patchedToString(this: () => unknown) {
      if (this === window.fetch) return fetchSource;
      return nativeToString.call(this);
    } as () => string;
  } catch {
    /* 页面已经把 toString 锁死，放弃 */
  }
}
