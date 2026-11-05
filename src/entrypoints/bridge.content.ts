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
import { PLATFORM_MATCHES } from '../platforms/registry';
import {
  bridgeEvent,
  consumeBridgePrefix,
  readPath,
  safeJsonCopy,
  type BridgeCaptureMessage,
  type BridgeHello,
  type BridgeReadGlobalRequest,
  type BridgeReadGlobalResult,
} from '../kernel/messaging/page-bridge';

/** 交给 MAIN 的抓取规则：**可序列化**，由 ISOLATED 通过 hello 事件下发 */
interface RuntimeCaptureRule {
  id: string;
  urlPattern: string;
  maxBytes: number;
  pageKinds: string[];
}

const RING_SIZE = 60;

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

function bootstrap(): void {
  const prefix = consumeBridgePrefix(document);
  if (!prefix) return; // ISOLATED 没准备好，什么也不做

  const ring: BridgeCaptureMessage[] = [];
  let rules: RuntimeCaptureRule[] = [];
  let started = false;

  const emit = (name: string, payload: unknown) => {
    try {
      document.dispatchEvent(
        new CustomEvent(name, { detail: JSON.stringify(payload) }),
      );
    } catch {
      /* 序列化失败就丢弃，不影响页面 */
    }
  };

  // ISOLATED 下发页面类型和规则 → 才开始包装
  document.addEventListener(bridgeEvent.hello(prefix), (ev) => {
    try {
      const hello = JSON.parse((ev as CustomEvent<string>).detail) as BridgeHello & {
        rules: RuntimeCaptureRule[];
      };
      rules = Array.isArray(hello.rules) ? hello.rules : [];
      if (!started && rules.length > 0) {
        started = true;
        installNetworkTap(prefix, rules, ring, emit);
        protectNativeToString();
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

/**
 * 包装 fetch / XHR（方案 §7.4）。
 * 关键约束：**永远返回原始值**，克隆失败就当没发生过。
 */
function installNetworkTap(
  prefix: string,
  rules: RuntimeCaptureRule[],
  ring: BridgeCaptureMessage[],
  emit: (name: string, payload: unknown) => void,
): void {
  const matchers = rules
    .map((r) => {
      try {
        return { rule: r, re: new RegExp(r.urlPattern) };
      } catch {
        return null;
      }
    })
    .filter((m): m is { rule: RuntimeCaptureRule; re: RegExp } => m !== null);

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
    if (text.length > (hit.rule.maxBytes ?? 3 * 1024 * 1024)) {
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
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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

    XHR.prototype.send = function patchedSend(this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
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
 * 在 document_start 缓存 Function.prototype.toString，再让包装过的函数返回原生字符串。
 */
function protectNativeToString(): void {
  try {
    const nativeToString = Function.prototype.toString;
    const originalFetch = window.fetch;
    const fetchSource = (() => {
      try {
        return nativeToString.call(originalFetch);
      } catch {
        return 'function fetch() { [native code] }';
      }
    })();

    Function.prototype.toString = function patchedToString(this: () => unknown) {
      if (this === window.fetch) return fetchSource;
      return nativeToString.call(this);
    } as () => string;
  } catch {
    /* 页面已经把 toString 锁死，放弃 */
  }
}