// Isolated-world bridge between inject.js (page), the popup and the extension.
let latest = { videos: [], currentId: null };

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'fdl-inject') return;
  if (e.data.type === 'list') latest = e.data;
  else if (e.data.type === 'download') chrome.runtime.sendMessage({ type: 'fdl:download', job: e.data.job });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'fdl:progress') {
    window.postMessage({ source: 'fdl-content', type: 'progress', ...msg.progress }, '*');
    return;
  }
  if (msg?.type !== 'fdl:list') return;
  window.postMessage({ source: 'fdl-content', type: 'rescan' }, '*');
  // Give inject.js a moment to rescan and post fresh data.
  setTimeout(() => sendResponse({ url: location.href, currentId: latest.currentId, videos: latest.videos }), 400);
  return true;
});
