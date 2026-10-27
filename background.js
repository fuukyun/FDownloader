// Opens a download tab for a job coming from the on-page button or the popup.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'fdl:download') return;
  const fromPage = !!sender.tab;
  const job = { ...msg.job, tabId: msg.tabId ?? sender.tab?.id, autoClose: fromPage };
  const jobId = crypto.randomUUID();
  chrome.storage.session.set({ [jobId]: job }).then(() =>
    chrome.tabs.create({
      url: chrome.runtime.getURL(`download.html?job=${jobId}`),
      // From the page: work in the background so the user stays on Facebook.
      active: !fromPage,
      ...(fromPage && { index: sender.tab.index + 1, openerTabId: sender.tab.id }),
    })
  );
});
