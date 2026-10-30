// sidepanel.js - Main Controller for Medium2HackMD Edge Side Panel

import {
  DEFAULT_PROMPT,
  LEGACY_DEFAULT_PROMPT_SIGNATURE,
  STORAGE_LIMITS,
  dataUrlToBlob,
  estimateItemImageBytes,
  sumLibraryBytes,
  getAllLibraryItems,
  getLibraryItem,
  saveLibraryItem,
  deleteLibraryItem,
  getSetting,
  setSetting
} from './db.js';

// ==================== Constants & State ====================
const IMAGE_DOWNLOAD_CONCURRENCY = 4;
const IMAGE_FETCH_TIMEOUT_MS = 15000;
const TAB_LOAD_TIMEOUT_MS = 12000;

const ALLOWED_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif'
]);

let libraryItems = [];
let currentArticleId = null;
let currentArticle = null;
let isStep1Dirty = false;
let isStep2Dirty = false;
let activeAsyncLockCount = 0;
let lastKnownActiveTabUrl = '';
let activeObjectUrls = [];
let activeChatGPTMonitorId = 0; // token to cancel previous auto-monitor loop

// ==================== DOM Elements ====================
const siteBadge = document.getElementById('siteBadge');
const activeArticleSelect = document.getElementById('activeArticleSelect');
const btnNewBlankArticle = document.getElementById('btnNewBlankArticle');
const statusBanner = document.getElementById('statusBanner');
const stepTabs = Array.from(document.querySelectorAll('.step-tab'));
const tabPanels = {
  step1: document.getElementById('tab-step1'),
  step2: document.getElementById('tab-step2'),
  step3: document.getElementById('tab-step3'),
  library: document.getElementById('tab-library')
};

// Step 1 Elements
const btnExtractFull = document.getElementById('btnExtractFull');
const btnExtractSelection = document.getElementById('btnExtractSelection');
const extractProgress = document.getElementById('extractProgress');
const extractProgressText = document.getElementById('extractProgressText');
const extractProgressBar = document.getElementById('extractProgressBar');
const inputArticleTitle = document.getElementById('inputArticleTitle');
const articleSourceUrl = document.getElementById('articleSourceUrl');
const step1ImageCount = document.getElementById('step1ImageCount');
const step1ImageGallery = document.getElementById('step1ImageGallery');
const textareaRawContent = document.getElementById('textareaRawContent');
const btnSaveRawEdits = document.getElementById('btnSaveRawEdits');
const btnGoToStep2 = document.getElementById('btnGoToStep2');

// Step 2 Elements
const btnOpenChatGPT = document.getElementById('btnOpenChatGPT');
const textareaPrompt = document.getElementById('textareaPrompt');
const btnSavePrompt = document.getElementById('btnSavePrompt');
const btnResetPrompt = document.getElementById('btnResetPrompt');
const chkAutoSendChatGPT = document.getElementById('chkAutoSendChatGPT');
const btnSendToChatGPT = document.getElementById('btnSendToChatGPT');
const btnCopyPromptAndArticle = document.getElementById('btnCopyPromptAndArticle');
const chatgptAutoStatus = document.getElementById('chatgptAutoStatus');
const chatgptAutoStatusText = document.getElementById('chatgptAutoStatusText');
const btnCaptureFromChatGPT = document.getElementById('btnCaptureFromChatGPT');
const btnPasteTranslatedFromClipboard = document.getElementById('btnPasteTranslatedFromClipboard');
const placeholderCheckBadge = document.getElementById('placeholderCheckBadge');
const textareaTranslatedMd = document.getElementById('textareaTranslatedMd');
const btnSaveTranslatedMd = document.getElementById('btnSaveTranslatedMd');
const btnGoToStep3 = document.getElementById('btnGoToStep3');

// Step 3 Elements
const btnOpenHackMD = document.getElementById('btnOpenHackMD');
const step3ContentStatus = document.getElementById('step3ContentStatus');
const selectHackMDInjectMode = document.getElementById('selectHackMDInjectMode');
const hackmdUploadProgress = document.getElementById('hackmdUploadProgress');
const hackmdUploadProgressText = document.getElementById('hackmdUploadProgressText');
const hackmdUploadProgressBar = document.getElementById('hackmdUploadProgressBar');
const btnHackMDUploadAllAndInject = document.getElementById('btnHackMDUploadAllAndInject');
const btnHackMDInjectWithOriginalUrls = document.getElementById('btnHackMDInjectWithOriginalUrls');
const btnCopyFinalMarkdown = document.getElementById('btnCopyFinalMarkdown');
const btnDownloadMarkdownFile = document.getElementById('btnDownloadMarkdownFile');
const btnMarkAsPublished = document.getElementById('btnMarkAsPublished');
const step3ImageCount = document.getElementById('step3ImageCount');
const step3ImageList = document.getElementById('step3ImageList');

// Library Tab Elements
const libraryTotalBadge = document.getElementById('libraryTotalBadge');
const libraryListContainer = document.getElementById('libraryListContainer');

// ==================== Security, URL & Blob Helpers ====================

const SAFE_DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|webp|gif|avif);base64,[A-Za-z0-9+/=]+$/i;

function revokeActiveObjectUrls() {
  for (const url of activeObjectUrls) {
    try {
      URL.revokeObjectURL(url);
    } catch (_) {}
  }
  activeObjectUrls = [];
}

function createTrackedObjectUrl(blob) {
  if (!(blob instanceof Blob)) return '';
  const url = URL.createObjectURL(blob);
  activeObjectUrls.push(url);
  return url;
}

function sanitizeImageSrc(rawSrc) {
  if (!rawSrc || typeof rawSrc !== 'string') return '';
  const trimmed = rawSrc.trim();
  if (SAFE_DATA_IMAGE_RE.test(trimmed)) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (_) {}
  return '';
}

function resolvePreviewSrcForImage(img) {
  if (!img) return '';
  if (img.blob instanceof Blob) {
    return createTrackedObjectUrl(img.blob);
  }
  return sanitizeImageSrc(img.dataUrl) || sanitizeImageSrc(img.originalUrl);
}

function sanitizeImageId(rawId, fallbackIndex = 1) {
  if (typeof rawId === 'string' && /^IMG_\d+$/.test(rawId)) {
    return rawId;
  }
  return `IMG_${fallbackIndex}`;
}

function createEmptyHint(text) {
  const div = document.createElement('div');
  div.className = 'empty-hint';
  div.textContent = text;
  return div;
}

function cloneArticleSnapshot(article) {
  if (!article) return null;
  if (typeof structuredClone === 'function') {
    return structuredClone(article);
  }
  return {
    ...article,
    images: Array.isArray(article.images)
      ? article.images.map((img) => ({ ...img }))
      : []
  };
}

function lockArticleSwitcher() {
  activeAsyncLockCount++;
  activeArticleSelect.disabled = true;
  btnNewBlankArticle.disabled = true;
}

function unlockArticleSwitcher() {
  activeAsyncLockCount = Math.max(0, activeAsyncLockCount - 1);
  if (activeAsyncLockCount === 0) {
    activeArticleSelect.disabled = false;
    btnNewBlankArticle.disabled = false;
  }
}

function unwrapOuterMarkdownFence(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const match = trimmed.match(/^`{3,4}(?:markdown|md)?\s*\n([\s\S]*?)\n`{3,4}$/i);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

// ==================== Direct Image Fetch as Native Blob ====================

function isForbiddenHost(hostname) {
  const h = (hostname || '').toLowerCase().trim();
  if (!h) return true;
  if (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === '[::1]' ||
    h === '0.0.0.0'
  ) {
    return true;
  }
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31)
    ) {
      return true;
    }
  }
  return false;
}

function validateImageUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { ok: false, error: '無效的圖片網址格式' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (_) {
    return { ok: false, error: '無法解析圖片網址' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: '僅允許下載 HTTPS 圖片網址' };
  }
  if (isForbiddenHost(parsed.hostname)) {
    return { ok: false, error: '不允許連線至內部或本機網路位址' };
  }
  return { ok: true, url: parsed.href };
}

async function readStreamToBlobWithLimit(response, maxBytes, mimeType) {
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) {
      throw new Error(`圖片大小超過上限 (${(maxBytes / (1024 * 1024)).toFixed(1)} MB)`);
    }
    return new Blob([buffer], { type: mimeType });
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          await reader.cancel('Image size limit exceeded');
          throw new Error(`圖片大小超過上限 (${(maxBytes / (1024 * 1024)).toFixed(1)} MB)`);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return new Blob(chunks, { type: mimeType });
}

async function fetchImageBlobDirect(imageUrl, maxBytes = STORAGE_LIMITS.MAX_SINGLE_IMAGE_BYTES) {
  const validation = validateImageUrl(imageUrl);
  if (!validation.ok) {
    return { ok: false, error: validation.error };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(validation.url, {
      method: 'GET',
      credentials: 'omit',
      cache: 'force-cache',
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP 狀態碼 ${response.status}`);
    }

    const rawContentType = (response.headers.get('content-type') || '').toLowerCase();
    const mimeType = rawContentType.split(';')[0].trim();

    if (!ALLOWED_IMAGE_MIMES.has(mimeType)) {
      throw new Error(`不支援的內容類型 (${mimeType || '未知'})，僅允許常見點陣圖格式`);
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const declaredSize = parseInt(contentLengthHeader, 10);
      if (!Number.isNaN(declaredSize) && declaredSize > maxBytes) {
        throw new Error(
          `圖片大小 (${(declaredSize / (1024 * 1024)).toFixed(1)} MB) 超過上限`
        );
      }
    }

    const normalizedMime = mimeType === 'image/jpg' ? 'image/jpeg' : mimeType;
    const blob = await readStreamToBlobWithLimit(response, maxBytes, normalizedMime);
    if (blob.size === 0) {
      throw new Error('下載的圖片內容為空');
    }

    return {
      ok: true,
      blob,
      mimeType: normalizedMime,
      size: blob.size
    };
  } catch (err) {
    const isAbort = err && err.name === 'AbortError';
    return {
      ok: false,
      error: isAbort ? '下載圖片逾時 (超過 15 秒)' : err.message || String(err)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('讀取圖片 Blob 失敗'));
    reader.readAsDataURL(blob);
  });
}

// ==================== Dynamic Host Permission Helper ====================

function getOriginPattern(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      return `${u.origin}/*`;
    }
  } catch (_) {}
  return null;
}

async function requestOriginPermissionIfNeeded(rawUrl) {
  const originPattern = getOriginPattern(rawUrl);
  if (!originPattern || !chrome.permissions) return true;
  try {
    const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
    if (alreadyGranted) return true;
    return await chrome.permissions.request({ origins: [originPattern] });
  } catch (_) {
    return false;
  }
}

// ==================== Dirty State & Unsaved Edits Management ====================

function updateDirtyIndicators() {
  if (isStep1Dirty) {
    btnSaveRawEdits.textContent = '💾 儲存修改 ● (未儲存)';
    btnSaveRawEdits.classList.add('dirty');
  } else {
    btnSaveRawEdits.textContent = '💾 儲存修改';
    btnSaveRawEdits.classList.remove('dirty');
  }

  if (isStep2Dirty) {
    btnSaveTranslatedMd.textContent = '💾 儲存修改 ● (未儲存)';
    btnSaveTranslatedMd.classList.add('dirty');
  } else {
    btnSaveTranslatedMd.textContent = '💾 儲存修改';
    btnSaveTranslatedMd.classList.remove('dirty');
  }
}

function clearDirtyState() {
  isStep1Dirty = false;
  isStep2Dirty = false;
  updateDirtyIndicators();
}

function checkStep1Dirty() {
  if (!currentArticle) {
    isStep1Dirty = Boolean(inputArticleTitle.value.trim() || textareaRawContent.value.trim());
  } else {
    isStep1Dirty =
      inputArticleTitle.value !== (currentArticle.title || '') ||
      textareaRawContent.value !== (currentArticle.rawContent || '');
  }
  updateDirtyIndicators();
}

function checkStep2Dirty() {
  if (!currentArticle) {
    isStep2Dirty = Boolean(textareaTranslatedMd.value.trim());
  } else {
    isStep2Dirty = textareaTranslatedMd.value !== (currentArticle.translatedMarkdown || '');
  }
  updateDirtyIndicators();
  updateStep3ContentStatusBanner();
}

inputArticleTitle.addEventListener('input', checkStep1Dirty);
textareaRawContent.addEventListener('input', checkStep1Dirty);
textareaTranslatedMd.addEventListener('input', checkStep2Dirty);

async function syncAndSaveDirtyEdits(silent = true) {
  if (!currentArticle) return null;
  if (!isStep1Dirty && !isStep2Dirty) return currentArticle;

  if (isStep1Dirty) {
    currentArticle.title = inputArticleTitle.value.trim() || '未命名文章';
    currentArticle.rawContent = textareaRawContent.value;
  }

  if (isStep2Dirty) {
    currentArticle.translatedMarkdown = textareaTranslatedMd.value;
    if (
      currentArticle.translatedMarkdown.trim() &&
      (!currentArticle.status || currentArticle.status === 'captured')
    ) {
      currentArticle.status = 'translated';
    }
  }

  const existingBytes = sumLibraryBytes(libraryItems, currentArticle.id);
  currentArticle = await saveLibraryItem(currentArticle, existingBytes);
  clearDirtyState();
  updateStep3ContentStatusBanner();
  if (!silent) {
    showStatus('已自動儲存目前文章的編輯內容。', 'info');
  }
  return currentArticle;
}

async function resolveUnsavedBeforeSwitch() {
  if (!currentArticle || (!isStep1Dirty && !isStep2Dirty)) {
    return;
  }
  const shouldSave = window.confirm(
    `文章「${currentArticle.title || '未命名'}」有尚未儲存的修改，是否在切換前儲存？\n（按「確定」儲存變更，按「取消」放棄未儲存修改）`
  );
  if (shouldSave) {
    await syncAndSaveDirtyEdits(false);
  } else {
    clearDirtyState();
  }
}

// ==================== UI Helpers ====================

let bannerTimeout = null;
function showStatus(message, type = 'info', durationMs = 4500) {
  if (bannerTimeout) clearTimeout(bannerTimeout);
  statusBanner.textContent = message;
  statusBanner.className = `status-banner ${type}`;
  statusBanner.classList.remove('hidden');
  if (durationMs > 0) {
    bannerTimeout = setTimeout(() => {
      statusBanner.classList.add('hidden');
    }, durationMs);
  }
}

function switchTab(tabKey) {
  stepTabs.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabKey);
  });
  Object.entries(tabPanels).forEach(([key, panel]) => {
    panel.classList.toggle('active', key === tabKey);
  });
  if (tabKey === 'step3') {
    updateStep3ContentStatusBanner();
  }
}

stepTabs.forEach((btn) => {
  btn.addEventListener('click', async () => {
    if (isStep1Dirty || isStep2Dirty) {
      try {
        await syncAndSaveDirtyEdits(true);
      } catch (_) {}
    }
    if (btn.dataset.tab === 'step3') {
      await tryPullTranslationFromOpenChatGPT(true);
    }
    switchTab(btn.dataset.tab);
  });
});

btnGoToStep2.addEventListener('click', async () => {
  try {
    await syncAndSaveDirtyEdits(true);
  } catch (_) {}
  switchTab('step2');
});

btnGoToStep3.addEventListener('click', async () => {
  try {
    await syncAndSaveDirtyEdits(true);
    await tryPullTranslationFromOpenChatGPT(false);
  } catch (_) {}
  switchTab('step3');
});

function formatStatusLabel(status) {
  if (status === 'published') return '已儲存／發佈';
  if (status === 'injected') return '已寫入編輯器';
  if (status === 'translated') return '已翻譯 Markdown';
  return '已擷取原文';
}

function formatStatusIcon(status) {
  if (status === 'published') return '✅';
  if (status === 'injected') return '📝';
  if (status === 'translated') return '🈶';
  return '📄';
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(
    d.getMinutes()
  ).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// ==================== Active Browser Tab & Timeout-Safe Load Helpers ====================

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function waitForTabComplete(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    };

    const finish = (err = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else setTimeout(resolve, 600);
    };

    const timer = setTimeout(() => {
      finish();
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === 'complete') {
        finish();
      }
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) {
        finish(new Error('目標分頁已被關閉'));
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);

    chrome.tabs
      .get(tabId)
      .then((tab) => {
        if (tab && tab.status === 'complete') {
          finish();
        }
      })
      .catch(() => finish());
  });
}

async function updateSiteBadge() {
  try {
    const tab = await getActiveTab();
    const url = tab?.url || '';
    lastKnownActiveTabUrl = url;
    siteBadge.className = 'site-badge';
    if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
      siteBadge.textContent = '🤖 ChatGPT 頁面';
      siteBadge.classList.add('site-chatgpt');
    } else if (url.includes('hackmd.io')) {
      siteBadge.textContent = '📝 HackMD 頁面';
      siteBadge.classList.add('site-hackmd');
    } else if (url.startsWith('http://') || url.startsWith('https://')) {
      const host = new URL(url).hostname.replace(/^www\./, '');
      siteBadge.textContent = `📰 ${host}`;
      siteBadge.classList.add('site-media');
    } else {
      siteBadge.textContent = '系統分頁';
    }
  } catch (_) {
    siteBadge.textContent = '就緒';
  }
}

chrome.tabs.onActivated.addListener(updateSiteBadge);
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url) {
    updateSiteBadge();
  }
});

// ==================== Image Conversion Helper (For Clipboard Copy) ====================

async function convertBlobToPngBlob(sourceBlob) {
  if (!(sourceBlob instanceof Blob)) {
    throw new Error('無效的暫存圖片 Blob 資料');
  }
  if (sourceBlob.type === 'image/png') {
    return sourceBlob;
  }

  const tempUrl = URL.createObjectURL(sourceBlob);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth || img.width || 800;
        canvas.height = img.naturalHeight || img.height || 600;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        canvas.toBlob((pngBlob) => {
          if (pngBlob) resolve(pngBlob);
          else reject(new Error('Canvas 轉換 PNG 失敗'));
        }, 'image/png');
      };
      img.onerror = () => reject(new Error('載入圖片資料失敗'));
      img.src = tempUrl;
    });
  } finally {
    URL.revokeObjectURL(tempUrl);
  }
}

async function copyImageToClipboard(imgRecord) {
  const blob =
    imgRecord?.blob instanceof Blob
      ? imgRecord.blob
      : imgRecord?.dataUrl
      ? dataUrlToBlob(imgRecord.dataUrl)
      : null;

  if (!blob) {
    const fallbackReason = imgRecord?.downloadError ? `（原因：${imgRecord.downloadError}）` : '';
    showStatus(`此圖片尚未暫存二進位資料${fallbackReason}，已改為複製原始圖片網址。`, 'info');
    await navigator.clipboard.writeText(imgRecord?.originalUrl || '');
    return;
  }

  try {
    const pngBlob = await convertBlobToPngBlob(blob);
    await navigator.clipboard.write([
      new ClipboardItem({
        'image/png': pngBlob
      })
    ]);
    showStatus(
      `已將 {{${sanitizeImageId(imgRecord.id)}}} 圖片複製到剪貼簿！可直接在 HackMD 按 Ctrl+V 貼上上傳。`,
      'success'
    );
  } catch (err) {
    showStatus(`複製圖片失敗：${err.message}`, 'error');
  }
}

// ==================== Library State & Single-Pass Metadata Rendering ====================

async function refreshLibraryList(selectId = null) {
  libraryItems = await getAllLibraryItems();
  const totalUsedBytes = sumLibraryBytes(libraryItems);
  const maxTotalMb = Math.round(STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES / (1024 * 1024));
  libraryTotalBadge.textContent = `${libraryItems.length} 篇 (${formatBytes(totalUsedBytes)} / ${maxTotalMb} MB)`;

  activeArticleSelect.replaceChildren();
  if (libraryItems.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '-- 尚無擷取的文章 --';
    activeArticleSelect.appendChild(opt);
    currentArticleId = null;
    currentArticle = null;
    clearDirtyState();
  } else {
    libraryItems.forEach((item) => {
      const opt = document.createElement('option');
      opt.value = item.id;
      const statusTag = formatStatusIcon(item.status);
      const imgCount = item.images ? item.images.length : 0;
      opt.textContent = `${statusTag} ${item.title} (${imgCount}圖)`;
      activeArticleSelect.appendChild(opt);
    });

    const targetId =
      selectId ||
      (currentArticleId && libraryItems.some((x) => x.id === currentArticleId)
        ? currentArticleId
        : libraryItems[0].id);

    activeArticleSelect.value = targetId;
    currentArticleId = targetId;
    currentArticle = await getLibraryItem(targetId, true);
    clearDirtyState();
  }

  renderCurrentArticleViews();
  renderLibraryManagerTab();
}

activeArticleSelect.addEventListener('change', async () => {
  const nextId = activeArticleSelect.value;
  if (!nextId || nextId === currentArticleId) return;
  await resolveUnsavedBeforeSwitch();
  currentArticleId = nextId;
  currentArticle = await getLibraryItem(nextId, true);
  clearDirtyState();
  renderCurrentArticleViews();
  renderLibraryManagerTab();
});

btnNewBlankArticle.addEventListener('click', async () => {
  try {
    await resolveUnsavedBeforeSwitch();
    const existingBytes = sumLibraryBytes(libraryItems);
    const newItem = await saveLibraryItem(
      {
        title: `自訂文章 (${formatDate(Date.now())})`,
        sourceUrl: '手動建立',
        status: 'captured',
        rawContent: '',
        translatedMarkdown: '',
        images: []
      },
      existingBytes
    );
    await refreshLibraryList(newItem.id);
    showStatus('已建立新的空白文章項目。', 'info');
  } catch (err) {
    showStatus(err.message, 'error');
  }
});

function verifyImagePlaceholders(article) {
  if (!article || !article.images || article.images.length === 0 || !article.translatedMarkdown) {
    placeholderCheckBadge.classList.add('hidden');
    return;
  }

  const missing = [];
  for (const img of article.images) {
    const safeId = sanitizeImageId(img.id);
    const token = `{{${safeId}}}`;
    if (!article.translatedMarkdown.includes(token) && !article.translatedMarkdown.includes(img.originalUrl)) {
      missing.push(token);
    }
  }

  placeholderCheckBadge.classList.remove('hidden');
  if (missing.length === 0) {
    placeholderCheckBadge.className = 'placeholder-check ok';
    placeholderCheckBadge.textContent = `✅ 圖片位置檢查通過：全部 ${article.images.length} 張圖片佔位符皆完整保留於 Markdown 中！`;
  } else {
    placeholderCheckBadge.className = 'placeholder-check warn';
    placeholderCheckBadge.textContent = `⚠️ 注意：有 ${missing.length} 個圖片佔位符 (${missing.join(', ')}) 未出現在翻譯後的 Markdown 中，您可手動補回。`;
  }
}

function updateStep3ContentStatusBanner() {
  if (!currentArticle) {
    step3ContentStatus.classList.add('hidden');
    return;
  }
  const translatedText = (
    textareaTranslatedMd.value ||
    currentArticle.translatedMarkdown ||
    ''
  ).trim();

  step3ContentStatus.classList.remove('hidden');
  if (translatedText.length > 0) {
    step3ContentStatus.className = 'placeholder-check ok';
    step3ContentStatus.textContent = `✅ 目前將上傳：Library 中已翻譯的繁體中文 Markdown（共 ${translatedText.length} 字）`;
  } else {
    step3ContentStatus.className = 'placeholder-check warn';
    step3ContentStatus.textContent =
      '⚠️ 注意：目前此文章尚未儲存「翻譯後的繁體中文 Markdown」！請先在步驟 2 擷取 ChatGPT 回覆，否則將使用未翻譯原文。';
  }
}

function renderStep1ImageGallery(images) {
  step1ImageGallery.replaceChildren();
  if (!images || images.length === 0) {
    step1ImageGallery.appendChild(createEmptyHint('此文章無圖片'));
    return;
  }

  images.forEach((img, idx) => {
    const safeId = sanitizeImageId(img.id, idx + 1);
    const previewSrc = resolvePreviewSrcForImage(img);

    const card = document.createElement('div');
    card.className = 'img-thumb-card';

    const imgEl = document.createElement('img');
    imgEl.loading = 'lazy';
    imgEl.alt = img.alt || safeId;
    if (previewSrc) {
      imgEl.src = previewSrc;
    }

    const metaRow = document.createElement('div');
    metaRow.className = 'img-thumb-meta';

    const tagSpan = document.createElement('span');
    tagSpan.className = 'img-tag';
    tagSpan.textContent = `{{${safeId}}}`;

    const sizeSpan = document.createElement('span');
    if ((img.blob || img.hasBlob) && img.size) {
      sizeSpan.style.color = '#64748b';
      sizeSpan.textContent = formatBytes(img.size);
    } else if (img.downloadError) {
      sizeSpan.style.color = '#dc2626';
      sizeSpan.title = img.downloadError;
      sizeSpan.textContent = '⚠️ 僅連結';
    } else {
      sizeSpan.style.color = '#64748b';
      sizeSpan.textContent = '僅連結';
    }

    metaRow.appendChild(tagSpan);
    metaRow.appendChild(sizeSpan);
    card.appendChild(imgEl);
    card.appendChild(metaRow);
    step1ImageGallery.appendChild(card);
  });
}

function renderStep3ImageList(images) {
  step3ImageList.replaceChildren();
  if (!images || images.length === 0) {
    step3ImageList.appendChild(createEmptyHint('目前文章無暫存圖片'));
    return;
  }

  images.forEach((img, idx) => {
    const safeId = sanitizeImageId(img.id, idx + 1);
    const previewSrc = resolvePreviewSrcForImage(img);

    const row = document.createElement('div');
    row.className = 'step3-img-item';

    const imgEl = document.createElement('img');
    imgEl.alt = safeId;
    if (previewSrc) {
      imgEl.src = previewSrc;
    }

    const infoDiv = document.createElement('div');
    infoDiv.className = 'step3-img-info';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'step3-img-title';

    const tagSpan = document.createElement('span');
    tagSpan.className = 'img-tag';
    tagSpan.textContent = `{{${safeId}}}`;

    const altTextNode = document.createTextNode(` ${img.alt || ''}`);
    titleDiv.appendChild(tagSpan);
    titleDiv.appendChild(altTextNode);

    const statusDiv = document.createElement('div');
    statusDiv.className = 'step3-img-status';
    if (img.hackmdUrl) {
      statusDiv.textContent = '✅ 已上傳 HackMD';
    } else if (img.blob || img.hasBlob) {
      statusDiv.textContent = `📦 已暫存於本機 (${formatBytes(img.size || 0)})`;
    } else if (img.downloadError) {
      statusDiv.style.color = '#dc2626';
      statusDiv.textContent = `⚠️ 未暫存：${img.downloadError}`;
    } else {
      statusDiv.textContent = '🔗 僅原始連結';
    }

    infoDiv.appendChild(titleDiv);
    infoDiv.appendChild(statusDiv);

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'step3-img-actions';

    const btnCopyImg = document.createElement('button');
    btnCopyImg.className = 'btn-xs btn-copy-img';
    btnCopyImg.textContent = '📋 複製圖片檔';
    btnCopyImg.addEventListener('click', () => copyImageToClipboard(img));

    const btnCopyMd = document.createElement('button');
    btnCopyMd.className = 'btn-xs btn-copy-md-tag';
    btnCopyMd.textContent = '複製語法';
    btnCopyMd.addEventListener('click', async () => {
      const urlToUse = img.hackmdUrl || img.originalUrl || '';
      const cleanAlt = (img.alt || safeId).replace(/[\r\n\[\]]+/g, ' ').trim();
      const syntax = `![${cleanAlt}](${urlToUse})`;
      await navigator.clipboard.writeText(syntax);
      showStatus(`已複製 {{${safeId}}} 的 Markdown 圖片語法！`, 'success');
    });

    actionsDiv.appendChild(btnCopyImg);
    actionsDiv.appendChild(btnCopyMd);

    row.appendChild(imgEl);
    row.appendChild(infoDiv);
    row.appendChild(actionsDiv);
    step3ImageList.appendChild(row);
  });
}

function renderCurrentArticleViews() {
  revokeActiveObjectUrls();

  if (!currentArticle) {
    inputArticleTitle.value = '';
    articleSourceUrl.textContent = '-';
    step1ImageCount.textContent = '0';
    step1ImageGallery.replaceChildren(createEmptyHint('尚未擷取圖片'));
    textareaRawContent.value = '';
    textareaTranslatedMd.value = '';
    placeholderCheckBadge.classList.add('hidden');
    step3ContentStatus.classList.add('hidden');
    step3ImageCount.textContent = '0';
    step3ImageList.replaceChildren(createEmptyHint('目前文章無暫存圖片'));
    return;
  }

  // Step 1 fields
  inputArticleTitle.value = currentArticle.title || '';
  articleSourceUrl.textContent = currentArticle.sourceUrl || '-';
  textareaRawContent.value = currentArticle.rawContent || '';

  const images = currentArticle.images || [];
  step1ImageCount.textContent = String(images.length);
  renderStep1ImageGallery(images);

  // Step 2 fields
  textareaTranslatedMd.value = currentArticle.translatedMarkdown || '';
  verifyImagePlaceholders(currentArticle);

  // Step 3 fields
  updateStep3ContentStatusBanner();
  step3ImageCount.textContent = String(images.length);
  renderStep3ImageList(images);
}

function renderLibraryManagerTab() {
  libraryListContainer.replaceChildren();
  if (libraryItems.length === 0) {
    libraryListContainer.appendChild(createEmptyHint('Library 目前尚無文章'));
    return;
  }

  libraryItems.forEach((item) => {
    const card = document.createElement('div');
    card.className = `library-card ${item.id === currentArticleId ? 'active-item' : ''}`;
    const imgCount = item.images ? item.images.length : 0;
    const itemBytes = estimateItemImageBytes(item);
    const statusClass = ['captured', 'translated', 'injected', 'published'].includes(item.status)
      ? item.status
      : 'captured';

    const topRow = document.createElement('div');
    topRow.className = 'library-card-top';

    const titleDiv = document.createElement('div');
    titleDiv.className = 'library-card-title';
    titleDiv.textContent = item.title || '未命名文章';

    const statusSpan = document.createElement('span');
    statusSpan.className = `status-pill ${statusClass}`;
    statusSpan.textContent = formatStatusLabel(statusClass);

    topRow.appendChild(titleDiv);
    topRow.appendChild(statusSpan);

    const metaDiv = document.createElement('div');
    metaDiv.className = 'library-card-meta';
    metaDiv.textContent = `🖼️ ${imgCount} 張圖片 (${formatBytes(itemBytes)}) ・ 🕒 更新於 ${formatDate(
      item.updatedAt
    )}`;

    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'library-card-actions';

    const btnSelect = document.createElement('button');
    btnSelect.className = 'btn-xs btn-select-item';
    btnSelect.textContent = '📂 載入工作區';
    btnSelect.addEventListener('click', async () => {
      if (activeAsyncLockCount > 0) {
        showStatus('目前有背景上傳或擷取作業進行中，請稍候再切換文章。', 'info');
        return;
      }
      await resolveUnsavedBeforeSwitch();
      await refreshLibraryList(item.id);
      switchTab(
        item.status === 'translated' || item.status === 'injected' || item.status === 'published'
          ? 'step3'
          : 'step1'
      );
      showStatus(`已切換至文章：${item.title}`, 'info');
    });

    const btnExport = document.createElement('button');
    btnExport.className = 'btn-xs btn-export-item';
    btnExport.textContent = '💾 下載 .md';
    btnExport.addEventListener('click', async () => {
      const fullItem = await getLibraryItem(item.id, false);
      downloadArticleMarkdown(fullItem || item);
    });

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-xs danger btn-delete-item';
    btnDelete.textContent = '🗑️ 刪除';
    btnDelete.addEventListener('click', async () => {
      if (activeAsyncLockCount > 0 && item.id === currentArticleId) {
        showStatus('此文章目前正在執行上傳或擷取作業，請稍候再刪除。', 'error');
        return;
      }
      const confirmed = window.confirm(
        `確定要從 Library 永久刪除文章「${item.title || '未命名文章'}」嗎？\n（包含已暫存的 ${imgCount} 張圖片 (${formatBytes(
          itemBytes
        )}) 與翻譯內容，刪除後無法復原）`
      );
      if (!confirmed) return;

      await deleteLibraryItem(item.id);
      await refreshLibraryList();
      showStatus('已從 Library 刪除該篇文章並釋放儲存空間。', 'info');
    });

    actionsDiv.appendChild(btnSelect);
    actionsDiv.appendChild(btnExport);
    actionsDiv.appendChild(btnDelete);

    card.appendChild(topRow);
    card.appendChild(metaDiv);
    card.appendChild(actionsDiv);
    libraryListContainer.appendChild(card);
  });
}

// ==================== STEP 1: EXTRACT ARTICLE & CONCURRENT BLOB DOWNLOAD ====================

async function downloadImagesConcurrently(extractedImages, existingLibraryBytes) {
  let articleImageBytes = 0;
  let cachedCount = 0;
  let failedCount = 0;
  let completedCount = 0;
  let nextIndex = 0;
  const total = extractedImages.length;

  async function worker() {
    while (nextIndex < total) {
      const i = nextIndex++;
      const img = extractedImages[i];
      img.id = sanitizeImageId(img.id, i + 1);

      if (i >= STORAGE_LIMITS.MAX_ARTICLE_IMAGE_COUNT) {
        img.downloadError = `超過單篇圖片數量上限 (${STORAGE_LIMITS.MAX_ARTICLE_IMAGE_COUNT} 張)`;
        failedCount++;
      } else {
        const remainingArticleQuota = STORAGE_LIMITS.MAX_ARTICLE_IMAGE_BYTES - articleImageBytes;
        const remainingTotalQuota =
          STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES - (existingLibraryBytes + articleImageBytes);

        if (remainingArticleQuota <= 64 * 1024) {
          img.downloadError = `已達單篇文章圖片容量上限 (${formatBytes(
            STORAGE_LIMITS.MAX_ARTICLE_IMAGE_BYTES
          )})`;
          failedCount++;
        } else if (remainingTotalQuota <= 64 * 1024) {
          img.downloadError = `已達 Library 總容量上限 (${formatBytes(
            STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES
          )})`;
          failedCount++;
        } else {
          const maxAllowed = Math.min(
            STORAGE_LIMITS.MAX_SINGLE_IMAGE_BYTES,
            remainingArticleQuota,
            remainingTotalQuota
          );

          const res = await fetchImageBlobDirect(img.originalUrl, maxAllowed);
          if (res.ok && res.blob) {
            if (
              articleImageBytes + res.size <= STORAGE_LIMITS.MAX_ARTICLE_IMAGE_BYTES &&
              existingLibraryBytes + articleImageBytes + res.size <=
                STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES
            ) {
              img.blob = res.blob;
              img.hasBlob = true;
              img.mimeType = res.mimeType;
              img.size = res.size;
              articleImageBytes += res.size;
              cachedCount++;
            } else {
              img.downloadError = '下載後超過單篇或 Library 容量配額';
              failedCount++;
            }
          } else {
            img.downloadError = res.error || '圖片下載失敗';
            failedCount++;
          }
        }
      }

      completedCount++;
      const pct = Math.round((completedCount / total) * 100);
      extractProgressText.textContent = `正在並行下載圖片 (${completedCount} / ${total})...`;
      extractProgressBar.style.width = `${pct}%`;
    }
  }

  const workerCount = Math.min(IMAGE_DOWNLOAD_CONCURRENCY, total);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { articleImageBytes, cachedCount, failedCount };
}

async function handleExtractFromPage(mode = 'auto') {
  try {
    if (lastKnownActiveTabUrl && lastKnownActiveTabUrl.startsWith('http')) {
      await requestOriginPermissionIfNeeded(lastKnownActiveTabUrl);
    }

    await resolveUnsavedBeforeSwitch();

    const tab = await getActiveTab();
    if (!tab || !tab.id || !tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) {
      showStatus('請先切換到要擷取的 Medium 或文章網頁分頁！', 'error');
      return;
    }

    const hasPermission = await requestOriginPermissionIfNeeded(tab.url);

    lockArticleSwitcher();
    btnExtractFull.disabled = true;
    btnExtractSelection.disabled = true;
    showStatus('正在解析頁面文章結構與圖片...', 'info');

    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/extractor.js']
      });
    } catch (scriptErr) {
      if (!hasPermission) {
        throw new Error(
          `需要授權存取網域 (${new URL(tab.url).hostname}) 才能擷取自訂網域文章，請重新點擊擷取並允許權限。`
        );
      }
      throw new Error(
        `無法在目前頁面執行擷取腳本 (${scriptErr.message})。請點擊工具列擴充功能圖示或允許網站存取權限後重試。`
      );
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'EXTRACT_ARTICLE',
      mode
    });

    if (!response || !response.ok) {
      throw new Error(response?.error || '無法擷取頁面內容');
    }

    const extractedImages = Array.isArray(response.images) ? response.images : [];
    const existingLibraryBytes = sumLibraryBytes(libraryItems);
    let articleImageBytes = 0;
    let cachedCount = 0;
    let failedCount = 0;

    if (extractedImages.length > 0) {
      extractProgress.classList.remove('hidden');
      extractProgressText.textContent = `準備下載 ${extractedImages.length} 張圖片...`;
      extractProgressBar.style.width = '0%';

      const stats = await downloadImagesConcurrently(extractedImages, existingLibraryBytes);
      articleImageBytes = stats.articleImageBytes;
      cachedCount = stats.cachedCount;
      failedCount = stats.failedCount;

      extractProgress.classList.add('hidden');
    }

    const saved = await saveLibraryItem(
      {
        title: response.title,
        sourceUrl: response.sourceUrl,
        status: 'captured',
        rawContent: response.rawContent,
        translatedMarkdown: '',
        images: extractedImages
      },
      existingLibraryBytes
    );

    await refreshLibraryList(saved.id);

    if (failedCount > 0) {
      showStatus(
        `擷取完成！已暫存 ${cachedCount} 張圖片（另有 ${failedCount} 張因超過容量限制或非標準格式僅保留原始連結，可於圖片清單查看原因）。`,
        'info',
        6500
      );
    } else {
      showStatus(
        `擷取成功！已儲存文章與 ${cachedCount} 張圖片 (${formatBytes(articleImageBytes)}) 至 Library。`,
        'success'
      );
    }
  } catch (err) {
    extractProgress.classList.add('hidden');
    showStatus(`擷取失敗：${err.message}`, 'error');
  } finally {
    unlockArticleSwitcher();
    btnExtractFull.disabled = false;
    btnExtractSelection.disabled = false;
  }
}

btnExtractFull.addEventListener('click', () => handleExtractFromPage('auto'));
btnExtractSelection.addEventListener('click', () => handleExtractFromPage('selection'));

btnSaveRawEdits.addEventListener('click', async () => {
  if (!currentArticle) return;
  try {
    currentArticle.title = inputArticleTitle.value.trim() || '未命名文章';
    currentArticle.rawContent = textareaRawContent.value;
    const existingBytes = sumLibraryBytes(libraryItems, currentArticle.id);
    await saveLibraryItem(currentArticle, existingBytes);
    clearDirtyState();
    await refreshLibraryList(currentArticle.id);
    showStatus('已儲存原文與標題修改！', 'success');
  } catch (err) {
    showStatus(`儲存失敗：${err.message}`, 'error');
  }
});

// ==================== STEP 2: CHATGPT PROMPT, AUTO-MONITOR & TRANSLATION ====================

async function initPromptSetting() {
  let savedPrompt = await getSetting('customPrompt', DEFAULT_PROMPT);
  // Auto-upgrade legacy default prompt that used outer ```markdown block
  if (!savedPrompt || savedPrompt.includes(LEGACY_DEFAULT_PROMPT_SIGNATURE)) {
    savedPrompt = DEFAULT_PROMPT;
    await setSetting('customPrompt', DEFAULT_PROMPT);
  }
  textareaPrompt.value = savedPrompt;
}

btnSavePrompt.addEventListener('click', async () => {
  const val = textareaPrompt.value.trim();
  await setSetting('customPrompt', val || DEFAULT_PROMPT);
  showStatus('已儲存自訂 Prompt 設定！', 'success');
});

btnResetPrompt.addEventListener('click', async () => {
  textareaPrompt.value = DEFAULT_PROMPT;
  await setSetting('customPrompt', DEFAULT_PROMPT);
  showStatus('已還原為預設繁體中文翻譯 Prompt。', 'info');
});

function buildFullPromptText(rawSourceOverride = null) {
  const prompt = textareaPrompt.value.trim() || DEFAULT_PROMPT;
  const raw = (
    rawSourceOverride !== null
      ? rawSourceOverride
      : textareaRawContent.value || currentArticle?.rawContent || ''
  ).trim();
  if (!raw) return null;
  return `${prompt}\n\n---\n以下是需要翻譯並轉換為 Markdown 的原文內容：\n\n${raw}`;
}

async function findExistingChatGPTTab() {
  const activeTab = await getActiveTab();
  if (
    activeTab?.url &&
    (activeTab.url.includes('chatgpt.com') || activeTab.url.includes('chat.openai.com'))
  ) {
    return activeTab;
  }
  const existingTabs = await chrome.tabs.query({
    url: ['https://chatgpt.com/*', 'https://chat.openai.com/*']
  });
  return existingTabs[0] || null;
}

async function findOrOpenChatGPTTab() {
  const existing = await findExistingChatGPTTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    return existing;
  }

  const newTab = await chrome.tabs.create({ url: 'https://chatgpt.com/' });
  await waitForTabComplete(newTab.id, TAB_LOAD_TIMEOUT_MS);
  return newTab;
}

async function saveTranslatedMarkdownToArticle(targetArticleId, markdownText) {
  const cleanMd = unwrapOuterMarkdownFence(markdownText);
  if (!cleanMd) return null;

  let articleToUpdate =
    currentArticle && currentArticle.id === targetArticleId
      ? cloneArticleSnapshot(currentArticle)
      : await getLibraryItem(targetArticleId, true);

  if (!articleToUpdate) {
    const existingBytes = sumLibraryBytes(libraryItems);
    const created = await saveLibraryItem(
      {
        title: `ChatGPT 翻譯文章 (${formatDate(Date.now())})`,
        sourceUrl: 'https://chatgpt.com/',
        status: 'translated',
        rawContent: '',
        translatedMarkdown: cleanMd,
        images: []
      },
      existingBytes
    );
    await refreshLibraryList(created.id);
    return created;
  }

  articleToUpdate.translatedMarkdown = cleanMd;
  if (!articleToUpdate.status || articleToUpdate.status === 'captured') {
    articleToUpdate.status = 'translated';
  }
  const existingBytes = sumLibraryBytes(libraryItems, articleToUpdate.id);
  const saved = await saveLibraryItem(articleToUpdate, existingBytes);
  if (currentArticleId === targetArticleId) {
    clearDirtyState();
    await refreshLibraryList(targetArticleId);
  } else {
    await refreshLibraryList(currentArticleId);
  }
  return saved;
}

// Automatically monitor ChatGPT tab after sending prompt and save the finished translation into Library
async function startChatGPTAutoCaptureMonitor(chatTabId, targetArticleId, baselineTurnCount = 0) {
  const monitorId = ++activeChatGPTMonitorId;
  chatgptAutoStatus.classList.remove('hidden');
  chatgptAutoStatusText.textContent = '⏳ 正在等待 ChatGPT 開始生成繁體中文翻譯...';

  let sawNewResponse = false;
  let stableCompletedTicks = 0;
  let lastMarkdown = '';
  const startTime = Date.now();
  const maxWaitMs = 4 * 60 * 1000; // Wait up to 4 minutes for long articles

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 1800));
    if (monitorId !== activeChatGPTMonitorId) return; // Superseded by another monitor

    try {
      await chrome.scripting.executeScript({
        target: { tabId: chatTabId },
        files: ['content/chatgpt.js']
      });

      const res = await chrome.tabs.sendMessage(chatTabId, {
        type: 'EXTRACT_FROM_CHATGPT'
      });

      if (monitorId !== activeChatGPTMonitorId) return;

      if (res && res.ok && res.markdown) {
        const hasNewTurn =
          res.turnCount > baselineTurnCount ||
          res.nonEmptyTurnCount > baselineTurnCount ||
          res.isStreaming;

        if (hasNewTurn) {
          sawNewResponse = true;
        }

        if (sawNewResponse) {
          // Live preview in Step 2 textarea if looking at the same article
          if (currentArticleId === targetArticleId && !isStep2Dirty) {
            textareaTranslatedMd.value = res.markdown;
          }

          if (res.isStreaming) {
            stableCompletedTicks = 0;
            lastMarkdown = res.markdown;
            chatgptAutoStatusText.textContent = `⏳ ChatGPT 正在翻譯中...（目前已生成 ${res.markdown.length} 字，完成後將自動存入 Library）`;
          } else {
            if (res.markdown === lastMarkdown && res.markdown.length > 20) {
              stableCompletedTicks++;
            } else {
              lastMarkdown = res.markdown;
              stableCompletedTicks = 1;
            }

            // Once streaming has stopped and text is stable for 2 checks (~1.8s), auto-save to Library!
            if (stableCompletedTicks >= 2) {
              chatgptAutoStatus.classList.add('hidden');
              await saveTranslatedMarkdownToArticle(targetArticleId, res.markdown);
              showStatus(
                `✅ ChatGPT 翻譯完成！已自動將繁體中文 Markdown (${res.markdown.length} 字) 存入 Library！`,
                'success',
                6500
              );
              return;
            }
          }
        }
      }
    } catch (_) {
      // Tab might be navigating or busy; continue polling
    }
  }

  if (monitorId === activeChatGPTMonitorId) {
    chatgptAutoStatus.classList.add('hidden');
  }
}

// Automatically pull translation from an open ChatGPT tab if currentArticle.translatedMarkdown is still empty
async function tryPullTranslationFromOpenChatGPT(silent = false) {
  if (!currentArticle) return false;
  const existingTranslated = (
    textareaTranslatedMd.value ||
    currentArticle.translatedMarkdown ||
    ''
  ).trim();
  if (existingTranslated.length > 0) {
    return true;
  }

  const chatTab = await findExistingChatGPTTab();
  if (!chatTab || !chatTab.id) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: chatTab.id },
      files: ['content/chatgpt.js']
    });

    const res = await chrome.tabs.sendMessage(chatTab.id, {
      type: 'EXTRACT_FROM_CHATGPT'
    });

    if (res && res.ok && res.markdown) {
      const candidate = res.markdown.trim();
      const rawTrimmed = (currentArticle.rawContent || '').trim();
      if (candidate.length > 0 && candidate !== rawTrimmed) {
        await saveTranslatedMarkdownToArticle(currentArticle.id, candidate);
        if (!silent) {
          showStatus(
            `✅ 已自動從開啟的 ChatGPT 分頁擷取繁體中文翻譯 (${candidate.length} 字) 存入 Library！`,
            'success'
          );
        }
        return true;
      }
    }
  } catch (_) {}
  return false;
}

btnOpenChatGPT.addEventListener('click', async () => {
  try {
    await findOrOpenChatGPTTab();
  } catch (err) {
    showStatus(`開啟 ChatGPT 分頁失敗：${err.message}`, 'error');
  }
});

btnCopyPromptAndArticle.addEventListener('click', async () => {
  try {
    await syncAndSaveDirtyEdits(true);
    const fullText = buildFullPromptText();
    if (!fullText) {
      showStatus('目前沒有可複製的文章內容，請先在步驟 1 擷取文章！', 'error');
      return;
    }
    await navigator.clipboard.writeText(fullText);
    showStatus('已儲存修改並將「Prompt + 原文」完整複製到剪貼簿！', 'success');
  } catch (err) {
    showStatus(`複製失敗：${err.message}`, 'error');
  }
});

btnSendToChatGPT.addEventListener('click', async () => {
  try {
    await syncAndSaveDirtyEdits(true);
    const fullText = buildFullPromptText();
    if (!fullText) {
      showStatus('目前沒有文章內容，請先在步驟 1 擷取文章！', 'error');
      return;
    }

    const targetArticleId = currentArticle ? currentArticle.id : null;

    lockArticleSwitcher();
    btnSendToChatGPT.disabled = true;
    await setSetting('customPrompt', textareaPrompt.value.trim() || DEFAULT_PROMPT);

    showStatus('正在連線至 ChatGPT 分頁並填入 Prompt...', 'info');
    const chatTab = await findOrOpenChatGPTTab();

    await chrome.scripting.executeScript({
      target: { tabId: chatTab.id },
      files: ['content/chatgpt.js']
    });

    const res = await chrome.tabs.sendMessage(chatTab.id, {
      type: 'INJECT_TO_CHATGPT',
      fullText,
      autoSend: chkAutoSendChatGPT.checked
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || '無法填入 ChatGPT 輸入框');
    }

    if (res.warning) {
      showStatus(res.warning, 'info');
    } else if (res.sent) {
      showStatus(
        '🚀 已送出給 ChatGPT！系統正在自動等待翻譯完成並將自動存入 Library...',
        'success',
        6000
      );
    } else {
      showStatus('已將「Prompt + 文章」填入 ChatGPT 輸入框！', 'success');
    }

    if (targetArticleId) {
      startChatGPTAutoCaptureMonitor(
        chatTab.id,
        targetArticleId,
        typeof res.baselineTurnCount === 'number' ? res.baselineTurnCount : 0
      );
    }
  } catch (err) {
    showStatus(`送入 ChatGPT 失敗：${err.message}`, 'error');
  } finally {
    unlockArticleSwitcher();
    btnSendToChatGPT.disabled = false;
  }
});

btnCaptureFromChatGPT.addEventListener('click', async () => {
  try {
    activeChatGPTMonitorId++; // Cancel any background auto-poll
    chatgptAutoStatus.classList.add('hidden');

    await syncAndSaveDirtyEdits(true);
    const targetArticleId = currentArticle ? currentArticle.id : null;

    lockArticleSwitcher();
    btnCaptureFromChatGPT.disabled = true;
    const chatTab = await findOrOpenChatGPTTab();

    await chrome.scripting.executeScript({
      target: { tabId: chatTab.id },
      files: ['content/chatgpt.js']
    });

    const res = await chrome.tabs.sendMessage(chatTab.id, {
      type: 'EXTRACT_FROM_CHATGPT'
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || '擷取 ChatGPT 回覆失敗');
    }

    await saveTranslatedMarkdownToArticle(targetArticleId, res.markdown);

    if (res.isStreaming) {
      showStatus(
        `⚠️ ChatGPT 仍在生成回覆中，目前已先擷取 ${res.markdown.length} 字存入 Library。建議生成完畢後再按一次！`,
        'info',
        6000
      );
    } else {
      showStatus(
        `✅ 已成功從 ChatGPT 擷取繁體中文 Markdown（共 ${res.markdown.length} 字）存入 Library！`,
        'success'
      );
    }
  } catch (err) {
    showStatus(`擷取失敗：${err.message}`, 'error');
  } finally {
    unlockArticleSwitcher();
    btnCaptureFromChatGPT.disabled = false;
  }
});

btnPasteTranslatedFromClipboard.addEventListener('click', async () => {
  try {
    activeChatGPTMonitorId++;
    chatgptAutoStatus.classList.add('hidden');

    const clipText = await navigator.clipboard.readText();
    const cleaned = unwrapOuterMarkdownFence(clipText);
    if (!cleaned) {
      showStatus('剪貼簿目前沒有文字內容！請先在 ChatGPT 點擊複製按鈕。', 'error');
      return;
    }

    const targetId = currentArticle ? currentArticle.id : null;
    await saveTranslatedMarkdownToArticle(targetId, cleaned);
    showStatus(`✅ 已從剪貼簿載入翻譯結果（共 ${cleaned.length} 字）並存入 Library！`, 'success');
  } catch (err) {
    showStatus(`讀取剪貼簿失敗：${err.message}`, 'error');
  }
});

btnSaveTranslatedMd.addEventListener('click', async () => {
  if (!currentArticle) return;
  try {
    currentArticle.translatedMarkdown = textareaTranslatedMd.value;
    if (
      currentArticle.translatedMarkdown.trim() &&
      (!currentArticle.status || currentArticle.status === 'captured')
    ) {
      currentArticle.status = 'translated';
    }
    const existingBytes = sumLibraryBytes(libraryItems, currentArticle.id);
    await saveLibraryItem(currentArticle, existingBytes);
    clearDirtyState();
    await refreshLibraryList(currentArticle.id);
    showStatus('已儲存 Library 中的繁體中文 Markdown 修改！', 'success');
  } catch (err) {
    showStatus(`儲存失敗：${err.message}`, 'error');
  }
});

// ==================== STEP 3: HACKMD UPLOAD & MAIN WORLD INJECTION ====================

async function findOrOpenHackMDTab() {
  const activeTab = await getActiveTab();
  if (activeTab?.url && activeTab.url.includes('hackmd.io')) {
    return activeTab;
  }

  const existingTabs = await chrome.tabs.query({
    url: ['https://hackmd.io/*', 'https://*.hackmd.io/*']
  });

  if (existingTabs.length > 0) {
    const target = existingTabs[0];
    await chrome.tabs.update(target.id, { active: true });
    return target;
  }

  const newTab = await chrome.tabs.create({ url: 'https://hackmd.io/new' });
  await waitForTabComplete(newTab.id, TAB_LOAD_TIMEOUT_MS);
  return newTab;
}

async function ensureHackMDMainWorldReady(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    files: ['content/hackmd-page.js']
  });
}

async function uploadImageInHackMDMainWorld(tabId, dataUrl, filename) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (dUrl, fname) => window.__M2H_HACKMD_API__.uploadSingleImageToHackMD(dUrl, fname),
    args: [dataUrl, filename]
  });
  return results?.[0]?.result || { ok: false, error: '無法執行 HackMD 圖片上傳' };
}

async function injectMarkdownInHackMDMainWorld(tabId, markdown, mode) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (md, injectMode) => window.__M2H_HACKMD_API__.injectMarkdownIntoEditor(md, injectMode),
    args: [markdown, mode]
  });
  return results?.[0]?.result || { ok: false, verified: false, error: '無法執行 HackMD 編輯器寫入' };
}

btnOpenHackMD.addEventListener('click', async () => {
  try {
    await findOrOpenHackMDTab();
  } catch (err) {
    showStatus(`開啟 HackMD 分頁失敗：${err.message}`, 'error');
  }
});

function buildFinalMarkdownWithUrls(article, preferHackMDUrl = true, allowRawFallback = false) {
  if (!article) return '';
  const translated = (article.translatedMarkdown || '').trim();
  const raw = (article.rawContent || '').trim();
  let md = translated || (allowRawFallback ? raw : '');
  if (!md) return '';

  const images = article.images || [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    const safeId = sanitizeImageId(img.id, i + 1);
    const targetUrl =
      preferHackMDUrl && img.hackmdUrl ? img.hackmdUrl : img.originalUrl;
    if (targetUrl) {
      const placeholderRegex = new RegExp(`\\{\\{${safeId}\\}\\}`, 'g');
      md = md.replace(placeholderRegex, targetUrl);
    }
  }
  return md;
}

// Ensures translation is available (auto-pulling from open ChatGPT tab if needed) or asks user before falling back to rawContent
async function ensureTranslationOrConfirmRawFallback() {
  await syncAndSaveDirtyEdits(true);
  if (!currentArticle) return { ok: false, allowRaw: false };

  if ((currentArticle.translatedMarkdown || '').trim().length > 0) {
    return { ok: true, allowRaw: false };
  }

  // Try pulling automatically from open ChatGPT tab first
  const pulled = await tryPullTranslationFromOpenChatGPT(false);
  if (pulled && (currentArticle.translatedMarkdown || '').trim().length > 0) {
    return { ok: true, allowRaw: false };
  }

  // Ask explicitly so we NEVER silently upload untranslated rawContent
  const confirmRaw = window.confirm(
    '⚠️ 目前此文章在 Library 中尚未有「翻譯後的繁體中文 Markdown」！\n\n・建議按「取消」返回步驟 2 點擊「📥 立即從 ChatGPT 擷取回覆並存入 Library」。\n・若您確定要直接上傳「未翻譯的英文原文」至 HackMD，請按「確定」。'
  );
  if (!confirmRaw) {
    switchTab('step2');
    showStatus('請在步驟 2 點擊「📥 立即從 ChatGPT 擷取回覆」或「📋 從剪貼簿載入翻譯結果」。', 'info');
    return { ok: false, allowRaw: false };
  }

  return { ok: true, allowRaw: true };
}

btnHackMDUploadAllAndInject.addEventListener('click', async () => {
  if (!currentArticle) {
    showStatus('請先選擇或擷取一篇文章！', 'error');
    return;
  }

  try {
    const check = await ensureTranslationOrConfirmRawFallback();
    if (!check.ok) return;

    const targetArticle = cloneArticleSnapshot(currentArticle);
    const targetArticleId = targetArticle.id;

    const baseMd = buildFinalMarkdownWithUrls(targetArticle, true, check.allowRaw);
    if (!baseMd) {
      showStatus('目前文章尚無 Markdown 內容可上傳！', 'error');
      return;
    }

    lockArticleSwitcher();
    btnHackMDUploadAllAndInject.disabled = true;
    btnHackMDInjectWithOriginalUrls.disabled = true;

    const hackTab = await findOrOpenHackMDTab();
    await ensureHackMDMainWorldReady(hackTab.id);

    const images = targetArticle.images || [];
    let uploadedCount = 0;
    let fallbackCount = 0;

    if (images.length > 0) {
      hackmdUploadProgress.classList.remove('hidden');
      for (let i = 0; i < images.length; i++) {
        const img = images[i];
        const safeId = sanitizeImageId(img.id, i + 1);
        const pct = Math.round(((i + 1) / images.length) * 100);
        hackmdUploadProgressText.textContent = `正在上傳圖片 {{${safeId}}} 至 HackMD (${i + 1}/${images.length})...`;
        hackmdUploadProgressBar.style.width = `${pct}%`;

        if (img.hackmdUrl) {
          uploadedCount++;
          continue;
        }

        const blobToUpload =
          img.blob instanceof Blob
            ? img.blob
            : img.dataUrl
            ? dataUrlToBlob(img.dataUrl)
            : null;

        if (blobToUpload) {
          const dataUrl = await blobToDataUrl(blobToUpload);
          const uploadRes = await uploadImageInHackMDMainWorld(
            hackTab.id,
            dataUrl,
            img.filename || `${safeId}.png`
          );

          if (uploadRes && uploadRes.ok && uploadRes.link) {
            img.hackmdUrl = uploadRes.link;
            uploadedCount++;
          } else {
            fallbackCount++;
          }
        } else {
          fallbackCount++;
        }
      }
      hackmdUploadProgress.classList.add('hidden');
      const existingBytes = sumLibraryBytes(libraryItems, targetArticleId);
      await saveLibraryItem(targetArticle, existingBytes);
    }

    const finalMarkdown = buildFinalMarkdownWithUrls(targetArticle, true, check.allowRaw);

    const injectRes = await injectMarkdownInHackMDMainWorld(
      hackTab.id,
      finalMarkdown,
      selectHackMDInjectMode.value
    );

    if (!injectRes || !injectRes.ok || !injectRes.verified) {
      throw new Error(injectRes?.error || '寫入 HackMD 編輯器並驗證失敗');
    }

    if (targetArticle.status !== 'published') {
      targetArticle.status = 'injected';
    }
    const existingBytes = sumLibraryBytes(libraryItems, targetArticleId);
    await saveLibraryItem(targetArticle, existingBytes);
    await refreshLibraryList(targetArticleId);

    if (fallbackCount > 0 && images.length > 0) {
      showStatus(
        `📝 繁體中文 Markdown 已寫入 HackMD 編輯器！(上傳成功 ${uploadedCount} 張圖片，其餘 ${fallbackCount} 張保留原始網址)`,
        'success',
        6500
      );
    } else {
      showStatus(
        `📝 已成功將繁體中文 Markdown 與 ${uploadedCount} 張圖片寫入 HackMD 編輯器！`,
        'success',
        6000
      );
    }
  } catch (err) {
    hackmdUploadProgress.classList.add('hidden');
    showStatus(`HackMD 上傳失敗：${err.message}`, 'error');
  } finally {
    unlockArticleSwitcher();
    btnHackMDUploadAllAndInject.disabled = false;
    btnHackMDInjectWithOriginalUrls.disabled = false;
  }
});

btnHackMDInjectWithOriginalUrls.addEventListener('click', async () => {
  if (!currentArticle) {
    showStatus('請先選擇或擷取一篇文章！', 'error');
    return;
  }

  try {
    const check = await ensureTranslationOrConfirmRawFallback();
    if (!check.ok) return;

    const targetArticle = cloneArticleSnapshot(currentArticle);
    const targetArticleId = targetArticle.id;

    const finalMarkdown = buildFinalMarkdownWithUrls(targetArticle, true, check.allowRaw);
    if (!finalMarkdown) {
      showStatus('目前文章尚無 Markdown 內容！', 'error');
      return;
    }

    lockArticleSwitcher();
    btnHackMDInjectWithOriginalUrls.disabled = true;
    const hackTab = await findOrOpenHackMDTab();
    await ensureHackMDMainWorldReady(hackTab.id);

    const injectRes = await injectMarkdownInHackMDMainWorld(
      hackTab.id,
      finalMarkdown,
      selectHackMDInjectMode.value
    );

    if (!injectRes || !injectRes.ok || !injectRes.verified) {
      throw new Error(injectRes?.error || '寫入 HackMD 編輯器並驗證失敗');
    }

    if (targetArticle.status !== 'published') {
      targetArticle.status = 'injected';
    }
    const existingBytes = sumLibraryBytes(libraryItems, targetArticleId);
    await saveLibraryItem(targetArticle, existingBytes);
    await refreshLibraryList(targetArticleId);
    showStatus('📝 已將圖片替換為網址並將繁體中文 Markdown 寫入 HackMD 編輯器！', 'success');
  } catch (err) {
    showStatus(`寫入 HackMD 失敗：${err.message}`, 'error');
  } finally {
    unlockArticleSwitcher();
    btnHackMDInjectWithOriginalUrls.disabled = false;
  }
});

btnMarkAsPublished.addEventListener('click', async () => {
  if (!currentArticle) {
    showStatus('請先選擇一篇文章！', 'error');
    return;
  }
  try {
    await syncAndSaveDirtyEdits(true);
    currentArticle.status = 'published';
    const existingBytes = sumLibraryBytes(libraryItems, currentArticle.id);
    await saveLibraryItem(currentArticle, existingBytes);
    await refreshLibraryList(currentArticle.id);
    showStatus('✅ 已將此文章標記為「已儲存／發佈」！', 'success');
  } catch (err) {
    showStatus(`更新狀態失敗：${err.message}`, 'error');
  }
});

btnCopyFinalMarkdown.addEventListener('click', async () => {
  if (!currentArticle) return;
  try {
    const check = await ensureTranslationOrConfirmRawFallback();
    if (!check.ok) return;

    const finalMd = buildFinalMarkdownWithUrls(currentArticle, true, check.allowRaw);
    if (!finalMd) {
      showStatus('尚無可複製的 Markdown 內容！', 'error');
      return;
    }
    await navigator.clipboard.writeText(finalMd);
    showStatus('📋 已將最終版 Markdown (含圖片網址) 複製至剪貼簿！', 'success');
  } catch (err) {
    showStatus(`複製失敗：${err.message}`, 'error');
  }
});

function downloadArticleMarkdown(article, allowRaw = true) {
  if (!article) return;
  const finalMd = buildFinalMarkdownWithUrls(article, true, allowRaw);
  if (!finalMd) {
    showStatus('尚無可下載的 Markdown 內容！', 'error');
    return;
  }
  const safeName = (article.title || 'article')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .slice(0, 60);
  const blob = new Blob([finalMd], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${safeName}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showStatus(`💾 已下載 ${safeName}.md`, 'success');
}

btnDownloadMarkdownFile.addEventListener('click', async () => {
  const check = await ensureTranslationOrConfirmRawFallback();
  if (!check.ok) return;
  downloadArticleMarkdown(currentArticle, check.allowRaw);
});

// ==================== Initialize ====================
(async function init() {
  await updateSiteBadge();
  await initPromptSetting();
  await refreshLibraryList();
})();
