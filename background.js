// background.js - Service Worker for Medium2HackMD Extension

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error('Failed to set sidePanel behavior:', err));
  }
});
