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
const btnCancelChatGPTMonitor = document.getElementById('btnCancelChatGPTMonitor');
const btnCopyDiagLog = document.getElementById('btnCopyDiagLog');
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

  renderMonitorStatus();
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
  const urlFilter = ['https://chatgpt.com/*', 'https://chat.openai.com/*'];
  // Prefer a ChatGPT tab in the window the side panel belongs to, so the user actually sees it
  const inCurrentWindow = await chrome.tabs.query({ url: urlFilter, currentWindow: true });
  if (inCurrentWindow.length > 0) return inCurrentWindow[0];
  const inFocusedWindow = await chrome.tabs.query({ url: urlFilter, lastFocusedWindow: true });
  if (inFocusedWindow.length > 0) return inFocusedWindow[0];
  const anywhere = await chrome.tabs.query({ url: urlFilter });
  return anywhere[0] || null;
}

// Poll until ChatGPT's composer exists in the tab (page may still be loading / waking from sleep)
async function waitForChatGPTComposer(tabId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () =>
          Boolean(
            document.querySelector('#prompt-textarea') ||
              document.querySelector('main form div[contenteditable="true"]') ||
              document.querySelector('main textarea')
          )
      });
      if (result && result.result) return true;
    } catch (err) {
      lastError = err?.message || String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(
    `等待 ChatGPT 輸入框就緒逾時${lastError ? `（${lastError}）` : ''}。請確認該分頁已登入且載入完成後再試一次。`
  );
}

async function findOrOpenChatGPTTab() {
  const existing = await findExistingChatGPTTab();
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    // Edge "sleeping tabs": a discarded tab reloads on activation and wipes anything injected early
    let tab = existing;
    try {
      tab = await chrome.tabs.get(existing.id);
    } catch (_) {}
    if (tab.discarded) {
      await chrome.tabs.reload(existing.id);
    }
    if (tab.discarded || tab.status !== 'complete') {
      await waitForTabComplete(existing.id, TAB_LOAD_TIMEOUT_MS);
    }
    await waitForChatGPTComposer(existing.id);
    return existing;
  }

  const newTab = await chrome.tabs.create({ url: 'https://chatgpt.com/' });
  await waitForTabComplete(newTab.id, TAB_LOAD_TIMEOUT_MS);
  await waitForChatGPTComposer(newTab.id);
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

// ==================== ChatGPT auto-capture bridge ====================
// The actual polling runs inside the ChatGPT tab (content/chatgpt.js) and the finished translation
// is written to IndexedDB by background.js, so closing this side panel no longer loses the result.
// This section only starts/cancels jobs and mirrors their status in the UI.

const MONITOR_PHASE_LABELS = {
  waiting: '⏳ 正在等待 ChatGPT 開始回覆',
  streaming: '⏳ ChatGPT 正在翻譯中',
  thinking: '🧠 ChatGPT 思考中（尚未輸出正文）',
  stabilizing: '🔎 ChatGPT 似乎已完成，確認內容不再變動',
  verifying: '🔎 內容已穩定，正在檢查完整性',
  error: '⚠️ 偵測時發生錯誤，持續重試中'
};

let monitorJobs = {};

function upsertLocalJob(job) {
  if (job && job.jobId) monitorJobs[job.jobId] = job;
}

function findPendingJob(articleId = null, strict = false) {
  const pending = Object.values(monitorJobs)
    .filter((j) => j.status === 'pending')
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const own = articleId ? pending.find((j) => j.articleId === articleId) : null;
  if (own) return own;
  return strict ? null : pending[0] || null;
}

function findLatestJobForArticle(articleId) {
  return (
    Object.values(monitorJobs)
      .filter((j) => j.articleId === articleId)
      .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))[0] || null
  );
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

function renderMonitorStatus() {
  const job = findPendingJob(currentArticleId);
  if (!job) {
    chatgptAutoStatus.classList.add('hidden');
    return;
  }
  const parts = [MONITOR_PHASE_LABELS[job.phase] || MONITOR_PHASE_LABELS.waiting];
  if (job.chars > 0) parts.push(`目前 ${job.chars} 字`);
  parts.push(`已等待 ${formatElapsed(Date.now() - (job.startedAt || Date.now()))}`);
  if (job.articleId !== currentArticleId && job.articleTitle) parts.push(`文章：${job.articleTitle}`);
  if (job.note) parts.push(job.note);
  chatgptAutoStatusText.textContent = `${parts.join('　|　')}。完成後會自動存入 Library（關閉側邊欄也會繼續）。`;
  chatgptAutoStatus.classList.remove('hidden');
}

async function sendToBackground(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function computeExpectedMinLength(article) {
  const raw = (article?.rawContent || '').trim();
  if (!raw) return 0;
  // Traditional Chinese is denser than English (~0.3x chars); 12% of the source length is a safe floor
  return Math.min(Math.round(raw.length * 0.12), 20000);
}

function getExpectedImgIds(article) {
  return (article?.images || []).map((img, idx) => sanitizeImageId(img.id, idx + 1));
}

function currentPromptHead() {
  const prompt = (textareaPrompt.value || '').trim() || DEFAULT_PROMPT;
  return prompt.slice(0, 80);
}

// Head/tail of the exact text we send to ChatGPT; the content script uses them to find our own turn
function currentPromptAnchors() {
  let full = null;
  try {
    full = buildFullPromptText();
  } catch (_) {
    full = null;
  }
  return {
    promptHead: currentPromptHead(),
    promptTail: full ? full.slice(-60) : ''
  };
}

async function requestStartMonitor(chatTab, injectRes) {
  if (!currentArticle) return null;
  const res = await sendToBackground({
    type: 'M2H_START_MONITOR',
    tabId: chatTab.id,
    articleId: currentArticle.id,
    articleTitle: currentArticle.title || '',
    ...currentPromptAnchors(),
    conversationUrl: injectRes?.conversationUrl || '',
    baselineTurnCount: Number(injectRes?.baselineTurnCount) || 0,
    baselineSignature: injectRes?.baselineSignature || '',
    baselineCanvasSignature: injectRes?.baselineCanvasSignature || '',
    expectedImgIds: getExpectedImgIds(currentArticle),
    expectedMinLength: computeExpectedMinLength(currentArticle)
  });
  if (!res || !res.ok) {
    throw new Error(res?.error || '無法啟動自動偵測');
  }
  upsertLocalJob(res.job);
  renderMonitorStatus();
  return res.job;
}

async function cancelActiveMonitor(silent = true) {
  const pending = findPendingJob(currentArticleId, true);
  if (!pending) {
    renderMonitorStatus();
    return false;
  }
  delete monitorJobs[pending.jobId];
  renderMonitorStatus();
  await sendToBackground({ type: 'M2H_CANCEL_MONITOR', jobId: pending.jobId, silent });
  return true;
}

async function handleTranslationSaved(job) {
  upsertLocalJob(job);
  renderMonitorStatus();
  sendToBackground({ type: 'M2H_CLEAR_BADGE' });

  const extras = [];
  if (job.source === 'canvas') extras.push('來源：ChatGPT Canvas');
  if (Array.isArray(job.warnings) && job.warnings.length) extras.push(`注意：${job.warnings.join('；')}`);
  const extraText = extras.length ? `（${extras.join('；')}）` : '';

  if (currentArticleId === job.articleId) {
    if (!isStep1Dirty && !isStep2Dirty) {
      await refreshLibraryList(job.articleId);
    } else {
      // Don't blow away unsaved edits; merge the saved translation into memory instead
      const fresh = await getLibraryItem(job.articleId, false);
      if (fresh && currentArticle) {
        currentArticle.translatedMarkdown = fresh.translatedMarkdown || '';
        currentArticle.status = fresh.status || currentArticle.status;
        if (!isStep2Dirty) textareaTranslatedMd.value = currentArticle.translatedMarkdown;
        verifyImagePlaceholders(currentArticle);
        updateStep3ContentStatusBanner();
      }
      libraryItems = await getAllLibraryItems();
      renderLibraryManagerTab();
    }
    showStatus(
      `✅ ChatGPT 翻譯完成！已自動將繁體中文 Markdown（${job.chars} 字）存入 Library ${extraText}`,
      'success',
      9000
    );
  } else {
    libraryItems = await getAllLibraryItems();
    renderLibraryManagerTab();
    showStatus(
      `✅ 文章「${job.articleTitle || job.articleId}」的 ChatGPT 翻譯已完成並存入 Library（${job.chars} 字）${extraText}`,
      'success',
      9000
    );
  }
}

async function restoreMonitorJobs() {
  const res = await sendToBackground({ type: 'M2H_GET_MONITOR_JOBS' });
  monitorJobs = res && res.ok && res.jobs ? res.jobs : {};
  renderMonitorStatus();

  const recentFailed = Object.values(monitorJobs)
    .filter((j) => j.status === 'failed')
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
  if (recentFailed) {
    showStatus(`❌ 上次 ChatGPT 自動擷取失敗：${recentFailed.reason}`, 'error', 0);
    delete monitorJobs[recentFailed.jobId];
    sendToBackground({ type: 'M2H_DISMISS_JOB', jobId: recentFailed.jobId });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  const type = message?.type;
  if (typeof type !== 'string' || !type.startsWith('M2H_')) return false;

  if (type === 'M2H_MONITOR_UPDATE') {
    upsertLocalJob(message.job);
    renderMonitorStatus();
  } else if (type === 'M2H_TRANSLATION_SAVED') {
    handleTranslationSaved(message.job).catch((err) =>
      showStatus(`翻譯已存入 Library，但更新畫面時發生錯誤：${err.message}`, 'error')
    );
  } else if (type === 'M2H_MONITOR_FAILED') {
    upsertLocalJob(message.job);
    renderMonitorStatus();
    showStatus(`❌ ChatGPT 自動擷取失敗：${message.job?.reason || '未知原因'}`, 'error', 0);
    sendToBackground({ type: 'M2H_DISMISS_JOB', jobId: message.job?.jobId });
    if (message.job?.jobId) delete monitorJobs[message.job.jobId];
  } else if (type === 'M2H_MONITOR_CANCELLED') {
    if (message.jobId) delete monitorJobs[message.jobId];
    renderMonitorStatus();
  }
  return false;
});

btnCancelChatGPTMonitor.addEventListener('click', async () => {
  const job = findPendingJob(currentArticleId);
  if (!job) {
    renderMonitorStatus();
    return;
  }
  delete monitorJobs[job.jobId];
  renderMonitorStatus();
  await sendToBackground({ type: 'M2H_CANCEL_MONITOR', jobId: job.jobId, silent: true });
  showStatus('已停止 ChatGPT 自動偵測。翻譯完成後請手動按「立即從 ChatGPT 擷取回覆」。', 'info', 6000);
});

btnCopyDiagLog.addEventListener('click', async () => {
  try {
    const res = await sendToBackground({ type: 'M2H_GET_DIAG_LOG' });
    if (!res || !res.ok) {
      throw new Error(res?.error || '背景程式沒有回應（請到 edge://extensions 重新載入擴充功能）');
    }
    await navigator.clipboard.writeText(res.text);
    showStatus('📋 已複製診斷記錄到剪貼簿，可直接貼給開發者分析。', 'success', 6000);
  } catch (err) {
    showStatus(`複製診斷記錄失敗：${err.message}`, 'error');
  }
});

// Refresh the elapsed-time text while a job is pending
setInterval(() => {
  if (findPendingJob(currentArticleId)) renderMonitorStatus();
}, 5000);

// ==================== Pull translation from an open ChatGPT tab (fallback path) ====================

function validateTranslationCandidate(candidate, article) {
  const md = (candidate || '').trim();
  const raw = (article?.rawContent || '').trim();
  const problems = [];

  if (md.length < 80) problems.push(`內容過短（僅 ${md.length} 字）`);
  if (raw && md === raw) problems.push('內容與原文完全相同');
  const head = currentPromptHead().replace(/\s+/g, ' ').trim().slice(0, 40);
  if (head.length >= 15 && md.replace(/\s+/g, ' ').includes(head)) {
    problems.push('內容包含您送出的 Prompt 本身，看起來抓到的是使用者訊息而非 ChatGPT 回覆');
  }
  const minLen = computeExpectedMinLength(article);
  if (minLen && md.length < minLen) {
    problems.push(`長度 ${md.length} 字遠低於原文預期（至少約 ${minLen} 字）`);
  }
  const imgIds = getExpectedImgIds(article);
  if (imgIds.length >= 2 && !imgIds.some((id) => md.includes(`{{${id}}}`))) {
    problems.push('完全沒有這篇文章的圖片佔位符，可能是其他對話的回覆');
  }
  return problems;
}

const CHATGPT_URL_RE = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

// Prefer the tab the prompt was actually sent from; fall back to the active / first ChatGPT tab
async function resolveChatGPTTabForArticle(articleId) {
  const job = articleId ? findLatestJobForArticle(articleId) : null;
  if (job && typeof job.tabId === 'number') {
    try {
      const tab = await chrome.tabs.get(job.tabId);
      if (tab?.url && CHATGPT_URL_RE.test(tab.url)) return { tab, fromJob: true, ambiguous: false };
    } catch (_) {}
  }
  const activeTab = await getActiveTab();
  if (activeTab?.url && CHATGPT_URL_RE.test(activeTab.url)) {
    return { tab: activeTab, fromJob: false, ambiguous: false };
  }
  const tabs = await chrome.tabs.query({ url: ['https://chatgpt.com/*', 'https://chat.openai.com/*'] });
  return { tab: tabs[0] || null, fromJob: false, ambiguous: tabs.length > 1 };
}

// ChatGPT may render the transcript inside an iframe: ask every frame and keep the best answer
async function extractFromChatGPTTab(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['content/chatgpt.js']
  });
  const frameIds = (results || []).map((r) => r.frameId).filter((id) => typeof id === 'number');
  if (frameIds.length === 0) frameIds.push(0);

  const anchors = currentPromptAnchors();
  const perFrame = [];
  for (const frameId of frameIds) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_FROM_CHATGPT', ...anchors }, { frameId });
      perFrame.push({ frameId, res });
    } catch (err) {
      perFrame.push({ frameId, res: { ok: false, error: err?.message || String(err) } });
    }
  }

  const okFrames = perFrame.filter((f) => f.res && f.res.ok && f.res.markdown);
  okFrames.sort((a, b) => (b.res.markdown.length || 0) - (a.res.markdown.length || 0));
  const best = okFrames[0] || perFrame.find((f) => f.res) || { frameId: 0, res: { ok: false, error: '沒有任何 frame 回應' } };
  return {
    ...best.res,
    frameId: best.frameId,
    frames: perFrame.map((f) => ({
      frameId: f.frameId,
      ok: Boolean(f.res?.ok),
      chars: f.res?.markdown?.length || 0,
      isStreaming: f.res?.isStreaming,
      error: f.res?.error || undefined
    }))
  };
}

async function probeChatGPTFrames(tabId, bestFrameId) {
  const anchors = currentPromptAnchors();
  let frameIds = [0];
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['content/chatgpt.js'] });
    frameIds = (results || []).map((r) => r.frameId).filter((id) => typeof id === 'number');
    if (frameIds.length === 0) frameIds = [0];
  } catch (_) {}
  const out = [];
  for (const frameId of frameIds) {
    try {
      const r = await chrome.tabs.sendMessage(tabId, { type: 'CHATGPT_DOM_PROBE', ...anchors }, { frameId });
      const p = r?.probe || null;
      if (!p) {
        out.push({ frameId, error: r?.error || 'no probe' });
      } else if (frameId === bestFrameId || p.turnStrategy !== 'none' || !p.isTop) {
        out.push({ frameId, ...p });
      } else {
        out.push({ frameId, href: p.href, isTop: p.isTop, bodyLen: p.bodyLen, iframes: p.iframes, counts: p.counts, turnStrategy: p.turnStrategy, composerButtons: p.composerButtons, streamingMatch: p.streamingMatch });
      }
    } catch (err) {
      out.push({ frameId, error: err?.message || String(err) });
    }
  }
  return out;
}

// Automatically pull translation from an open ChatGPT tab if the article has no saved translation yet
async function tryPullTranslationFromOpenChatGPT(silent = false) {
  if (!currentArticle) return false;
  if ((currentArticle.translatedMarkdown || '').trim().length > 0) return true;
  // Only trust the textarea when the user actually typed in it (it is saved by syncAndSaveDirtyEdits)
  if (isStep2Dirty && textareaTranslatedMd.value.trim().length > 0) return true;

  const pending = findPendingJob(currentArticle.id, true);
  if (pending) {
    if (!silent) {
      showStatus('⏳ 此文章的 ChatGPT 翻譯仍在自動偵測中，完成後會自動存入 Library，請稍候。', 'info', 7000);
    }
    return false;
  }

  const { tab, ambiguous } = await resolveChatGPTTabForArticle(currentArticle.id);
  if (!tab || !tab.id) return false;

  try {
    const res = await extractFromChatGPTTab(tab.id);
    if (!res || !res.ok || !res.markdown) {
      if (!silent) showStatus(`無法從 ChatGPT 分頁取得回覆：${res?.error || '未知錯誤'}`, 'info', 7000);
      return false;
    }
    if (res.isStreaming || res.isThinking) {
      if (!silent) showStatus('⏳ ChatGPT 仍在生成回覆，尚未擷取。請等它完成後再試。', 'info', 7000);
      return false;
    }

    const candidate = res.markdown.trim();
    const problems = validateTranslationCandidate(candidate, currentArticle);
    if (problems.length > 0) {
      if (!silent) {
        showStatus(
          `⚠️ 開啟的 ChatGPT 分頁回覆未自動採用：${problems.join('；')}。若確認內容無誤，請在步驟 2 按「立即從 ChatGPT 擷取回覆」強制存入。`,
          'info',
          10000
        );
      }
      return false;
    }

    await saveTranslatedMarkdownToArticle(currentArticle.id, candidate);
    if (!silent) {
      showStatus(
        `✅ 已自動從開啟的 ChatGPT 分頁擷取繁體中文翻譯 (${candidate.length} 字) 存入 Library！${
          ambiguous ? '（您開了多個 ChatGPT 分頁，請確認內容正確）' : ''
        }`,
        'success',
        8000
      );
    }
    return true;
  } catch (err) {
    if (!silent) showStatus(`從 ChatGPT 分頁擷取失敗：${err.message}`, 'error');
    return false;
  }
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

    let tabInfo = null;
    try {
      const t = await chrome.tabs.get(chatTab.id);
      tabInfo = { url: t.url, title: (t.title || '').slice(0, 60), windowId: t.windowId, active: t.active };
    } catch (_) {}

    sendToBackground({
      type: 'M2H_LOG',
      level: res?.ok ? 'info' : 'error',
      message: 'inject result',
      data: {
        tabId: chatTab.id,
        tab: tabInfo,
        ok: res?.ok,
        method: res?.method,
        sent: res?.sent,
        attempts: res?.attempts,
        warning: res?.warning,
        error: res?.error,
        baselineTurnCount: res?.baselineTurnCount,
        promptChars: fullText.length,
        probe: res?.probe
      }
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || '無法填入 ChatGPT 輸入框');
    }

    const tabLabel = tabInfo?.title ? `分頁「${tabInfo.title}」` : 'ChatGPT 分頁';
    if (res.warning) {
      showStatus(`${res.warning}（目標：${tabLabel}）`, 'info', 12000);
    } else if (res.sent) {
      showStatus(
        `🚀 已送出給 ${tabLabel}！系統正在自動等待翻譯完成並將自動存入 Library...`,
        'success',
        6000
      );
    } else {
      showStatus(`已將「Prompt + 文章」填入 ${tabLabel} 的輸入框！`, 'success');
    }

    if (targetArticleId) {
      try {
        await requestStartMonitor(chatTab, res);
      } catch (monitorErr) {
        showStatus(
          `已送出給 ChatGPT，但自動偵測啟動失敗：${monitorErr.message}。翻譯完成後請手動按「立即從 ChatGPT 擷取回覆」。`,
          'error',
          10000
        );
      }
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
    await cancelActiveMonitor(true); // Manual capture supersedes the background auto-detect job

    await syncAndSaveDirtyEdits(true);
    const targetArticleId = currentArticle ? currentArticle.id : null;

    lockArticleSwitcher();
    btnCaptureFromChatGPT.disabled = true;

    // Prefer the tab the prompt was sent from; otherwise the active/first ChatGPT tab, or open one
    const resolved = await resolveChatGPTTabForArticle(targetArticleId);
    const chatTab = resolved.tab || (await findOrOpenChatGPTTab());

    const res = await extractFromChatGPTTab(chatTab.id);

    // Record what the page looked like so selector drift can be fixed from the diagnostics log
    try {
      const probes = await probeChatGPTFrames(chatTab.id, res?.frameId);
      sendToBackground({
        type: 'M2H_LOG',
        level: res?.ok ? 'info' : 'error',
        message: 'manual capture',
        data: {
          tabId: chatTab.id,
          ok: res?.ok,
          error: res?.error,
          chars: res?.markdown?.length,
          source: res?.source,
          frameId: res?.frameId,
          frames: res?.frames,
          isStreaming: res?.isStreaming,
          isThinking: res?.isThinking,
          probes
        }
      });
    } catch (_) {}

    if (!res || !res.ok) {
      throw new Error(res?.error || '擷取 ChatGPT 回覆失敗');
    }
    if (res.isThinking) {
      throw new Error('ChatGPT 目前仍在「思考中」，尚未輸出翻譯正文，請稍候再按一次。');
    }

    await saveTranslatedMarkdownToArticle(targetArticleId, res.markdown);

    const problems = currentArticle ? validateTranslationCandidate(res.markdown, currentArticle) : [];
    const sourceNote = res.source === 'canvas' ? '（來源：ChatGPT Canvas）' : '';
    const tabNote = resolved.ambiguous && !resolved.fromJob ? '（您開了多個 ChatGPT 分頁，已取第一個，請確認內容）' : '';

    if (res.isStreaming) {
      showStatus(
        `⚠️ ChatGPT 仍在生成回覆中，目前已先擷取 ${res.markdown.length} 字存入 Library。建議生成完畢後再按一次！`,
        'info',
        6000
      );
    } else if (problems.length > 0) {
      showStatus(
        `⚠️ 已存入 Library（${res.markdown.length} 字）${sourceNote}，但內容檢查有疑慮：${problems.join('；')}。請確認 ChatGPT 頁面是否為本篇文章的完整翻譯。`,
        'info',
        10000
      );
    } else {
      showStatus(
        `✅ 已成功從 ChatGPT 擷取繁體中文 Markdown（共 ${res.markdown.length} 字）存入 Library！${sourceNote}${tabNote}`,
        'success',
        7000
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
    await cancelActiveMonitor(true);

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

  // A background auto-detect job is still running for this article: don't fall back to raw text
  if (findPendingJob(currentArticle.id, true)) {
    switchTab('step2');
    showStatus(
      '⏳ 此文章的 ChatGPT 翻譯仍在自動偵測中，完成後會自動存入 Library，請稍候再上傳。若 ChatGPT 其實已完成，可按「立即從 ChatGPT 擷取回覆」。',
      'info',
      9000
    );
    return { ok: false, allowRaw: false };
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
  await restoreMonitorJobs();
})();
