const MENU_ID = "loounp-capture-article";

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Enviar artigo ao Loounp",
      contexts: ["page", "link"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) return;
  const target = info.linkUrl || info.pageUrl || tab?.url;
  if (!target) return;

  let url;
  try {
    url = new URL(target);
  } catch {
    return;
  }
  if (!["http:", "https:"].includes(url.protocol)) return;

  const captureLink = `loounp://capture?url=${encodeURIComponent(url.toString())}`;
  chrome.tabs.create({ url: captureLink, active: true });
});
