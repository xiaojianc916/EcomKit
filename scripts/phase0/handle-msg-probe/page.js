(async () => {
  const log = [];
  const push = (k, v) => {
    log.push(k + ' = ' + JSON.stringify(v));
    document.getElementById('out').textContent = log.join('\n');
  };
  try {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('probe-dir', { create: true });
    push('gotHandle', dir.name);

    // 1. 直接存 IndexedDB 再读回（同源，必定可行）
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('probe-db', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('h');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    await new Promise((res, rej) => {
      const tx = db.transaction('h', 'readwrite');
      tx.objectStore('h').put(dir, 'k');
      tx.oncomplete = res;
      tx.onerror = () => rej(tx.error);
    });
    const back = await new Promise((res) => {
      const tx = db.transaction('h', 'readonly');
      const q = tx.objectStore('h').get('k');
      q.onsuccess = () => res(q.result);
    });
    push('idbRoundTrip', !!back && back.kind);

    // 2. 关键：handle 能否通过 runtime 消息传给 bg
    try {
      const res = await chrome.runtime.sendMessage({ type: 'echo-handle', handle: dir });
      push('sendMessage', res);
    } catch (e) {
      push('sendMessageError', String(e?.message ? e.message : e).slice(0, 200));
    }
  } catch (e) {
    push('fatal', String(e?.stack ? e.stack : e).slice(0, 300));
  }
})();
