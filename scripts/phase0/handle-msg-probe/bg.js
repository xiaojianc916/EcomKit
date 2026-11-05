
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'echo-handle') {
    const h = msg.handle;
    sendResponse({
      received: h !== undefined && h !== null,
      typeofValue: typeof h,
      kind: h?.kind ?? null,
      name: h?.name ?? null,
      hasGetFileHandle: typeof h?.getFileHandle === 'function',
    });
    return true;
  }
  return false;
});
chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('page.html') }));
