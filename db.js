// db.js - IndexedDB Wrapper for Medium2HackMD Library, Image Blobs & Settings

const DB_NAME = 'MediaToHackMD_DB';
const DB_VERSION = 2;
const STORE_LIBRARY = 'library';
const STORE_IMAGES = 'images';
const STORE_SETTINGS = 'settings';

export const STORAGE_LIMITS = {
  MAX_SINGLE_IMAGE_BYTES: 8 * 1024 * 1024, // 單張圖片上限 8 MB
  MAX_ARTICLE_IMAGE_BYTES: 25 * 1024 * 1024, // 單篇文章圖片總容量上限 25 MB
  MAX_ARTICLE_IMAGE_COUNT: 30, // 單篇文章最多暫存 30 張圖片二進位檔
  MAX_TOTAL_LIBRARY_BYTES: 100 * 1024 * 1024 // Library 全部文章圖片總容量上限 100 MB
};

export const LEGACY_DEFAULT_PROMPT_SIGNATURE = '請將最終完整的 Markdown 內容包在一個 ```markdown ... ``` 程式碼區塊中輸出';

export const DEFAULT_PROMPT = `你是一位專業的台灣繁體中文技術與媒體專欄編譯者。
請將以下文章完整翻譯為自然、流暢、符合台灣在地用語習慣的「繁體中文」，並進行適當的排版修正，輸出為標準的 Markdown 格式。

請嚴格遵守以下規則：
1. **完整翻譯不遺漏**：請完整翻譯所有段落，不要自行摘要或刪減內容。
2. **台灣繁體中文慣用語**：請使用台灣常見詞彙（例如：資訊、軟體、硬體、專案、預設、最佳化、人工智慧、伺服器、變數、函式等），避免中國大陸用語。
3. **保留專有名詞與程式碼**：程式碼區塊、API 名稱、指令或特定專有名詞請保留原文，或於首次出現時以「中文（English）」呈現。
4. **嚴格保留圖片佔位符**：原文中所有的圖片標記格式如 \`![圖片說明]({{IMG_1}})\`、\`![圖片說明]({{IMG_2}})\` 等，請**務必保留在對應的段落位置**，你可以將 \`[]\` 內的圖片說明翻譯成繁體中文，但括號內的 \`({{IMG_x}})\` 編號請絕對不要修改或刪除！
5. **Markdown 結構最佳化**：包含文章主標題 (\`# \`)、次標題 (\`## \`, \`### \`)、重點粗體、清單與區塊引言 (\`> \`)，讓版面在 HackMD 上閱讀起來清晰易讀。
6. **直接輸出翻譯內容**：請直接以文章主標題 (\`# ...\`) 開始輸出翻譯後的 Markdown 內容，不要在開頭或結尾加上「好的，這是翻譯結果」等對話寒暄，也不要用外層 \`\`\`markdown 程式碼區塊包覆整篇文章（以免與文內的程式碼區塊衝突）。`;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_LIBRARY)) {
        const store = db.createObjectStore(STORE_LIBRARY, { keyPath: 'id' });
        store.createIndex('updatedAt', 'updatedAt', { unique: false });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        const imgStore = db.createObjectStore(STORE_IMAGES, { keyPath: 'key' });
        imgStore.createIndex('articleId', 'articleId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function formatWriteError(err, fallbackMsg = '寫入 IndexedDB 失敗') {
  if (err && err.name === 'QuotaExceededError') {
    return new Error('瀏覽器 IndexedDB 儲存空間已滿 (QuotaExceededError)，請刪除部分舊文章。');
  }
  return err instanceof Error ? err : new Error(err ? String(err) : fallbackMsg);
}

// Convert legacy base64 dataUrl to Blob if encountered from v1 records
export function dataUrlToBlob(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;
  try {
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(parts[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new Blob([u8arr], { type: mime });
  } catch (_) {
    return null;
  }
}

export function estimateItemImageBytes(item) {
  if (!item) return 0;
  if (typeof item.imageBytes === 'number' && item.imageBytes >= 0) {
    return item.imageBytes;
  }
  if (!Array.isArray(item.images)) return 0;
  return item.images.reduce((sum, img) => {
    if (!img) return sum;
    if (typeof img.size === 'number' && img.size > 0 && (img.hasBlob || img.blob || img.dataUrl)) {
      return sum + img.size;
    }
    if (img.blob instanceof Blob) {
      return sum + img.blob.size;
    }
    if (typeof img.dataUrl === 'string') {
      return sum + Math.round((img.dataUrl.length * 3) / 4);
    }
    return sum;
  }, 0);
}

export function sumLibraryBytes(items, excludeItemId = null) {
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const item of items) {
    if (!item || (excludeItemId && item.id === excludeItemId)) continue;
    total += estimateItemImageBytes(item);
  }
  return total;
}

// ==================== Library & Image Blob CRUD ====================

export async function getAllLibraryItems() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readonly');
    const store = tx.objectStore(STORE_LIBRARY);
    const request = store.getAll();
    request.onsuccess = () => {
      const items = request.result || [];
      items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      resolve(items);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error || request.error);
  });
}

export async function getLibraryStorageUsage(excludeItemId = null) {
  const items = await getAllLibraryItems();
  return sumLibraryBytes(items, excludeItemId);
}

export async function getArticleImageMap(articleId) {
  if (!articleId) return new Map();
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_IMAGES, 'readonly');
    const store = tx.objectStore(STORE_IMAGES);
    const index = store.index('articleId');
    const request = index.getAll(IDBKeyRange.only(articleId));
    request.onsuccess = () => {
      const map = new Map();
      for (const rec of request.result || []) {
        if (rec && rec.imageId && rec.blob) {
          map.set(rec.imageId, rec.blob);
        }
      }
      resolve(map);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error || request.error);
  });
}

export async function getLibraryItem(id, includeBlobs = true) {
  if (!id) return null;
  const db = await openDB();
  const item = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_LIBRARY, 'readonly');
    const store = tx.objectStore(STORE_LIBRARY);
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error || request.error);
  });

  if (!item || !includeBlobs || !Array.isArray(item.images) || item.images.length === 0) {
    return item;
  }

  const blobMap = await getArticleImageMap(id);
  item.images = item.images.map((img) => {
    const copy = { ...img };
    if (blobMap.has(copy.id)) {
      copy.blob = blobMap.get(copy.id);
      copy.hasBlob = true;
      copy.size = copy.blob.size;
    } else if (copy.dataUrl) {
      // Legacy v1 fallback
      const legacyBlob = dataUrlToBlob(copy.dataUrl);
      if (legacyBlob) {
        copy.blob = legacyBlob;
        copy.hasBlob = true;
        copy.size = legacyBlob.size;
      }
    }
    return copy;
  });

  return item;
}

/**
 * Saves an article record to STORE_LIBRARY and any new/updated image Blobs to STORE_IMAGES
 * in a single atomic IndexedDB transaction. Strips heavy Blob/dataUrl fields from STORE_LIBRARY
 * so getAllLibraryItems() only reads lightweight metadata.
 */
export async function saveLibraryItem(item, knownExistingBytes = null) {
  const now = Date.now();
  const itemId = item.id || `art_${now}_${Math.random().toString(36).slice(2, 7)}`;

  const blobsToWrite = [];
  let calculatedImageBytes = 0;

  const cleanImagesMeta = (Array.isArray(item.images) ? item.images : []).map((img, idx) => {
    const imageId = img.id || `IMG_${idx + 1}`;
    let blob = img.blob instanceof Blob ? img.blob : null;
    if (!blob && typeof img.dataUrl === 'string') {
      blob = dataUrlToBlob(img.dataUrl);
    }

    const hasBlob = Boolean(blob || img.hasBlob);
    const size = blob ? blob.size : hasBlob && typeof img.size === 'number' ? img.size : 0;

    if (hasBlob && size > 0) {
      calculatedImageBytes += size;
    }

    if (blob) {
      blobsToWrite.push({
        key: `${itemId}:${imageId}`,
        articleId: itemId,
        imageId,
        blob,
        mimeType: blob.type || img.mimeType || 'image/png',
        size: blob.size,
        updatedAt: now
      });
    }

    return {
      id: imageId,
      index: img.index || idx + 1,
      originalUrl: img.originalUrl || '',
      alt: img.alt || '',
      caption: img.caption || '',
      filename: img.filename || `image_${idx + 1}.png`,
      mimeType: blob ? blob.type : img.mimeType || '',
      size,
      hasBlob,
      hackmdUrl: img.hackmdUrl || '',
      downloadError: img.downloadError || ''
    };
  });

  const existingBytes =
    typeof knownExistingBytes === 'number'
      ? knownExistingBytes
      : await getLibraryStorageUsage(itemId);

  if (existingBytes + calculatedImageBytes > STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES) {
    const limitMb = (STORAGE_LIMITS.MAX_TOTAL_LIBRARY_BYTES / (1024 * 1024)).toFixed(0);
    const usedMb = ((existingBytes + calculatedImageBytes) / (1024 * 1024)).toFixed(1);
    throw new Error(
      `Library 本機儲存空間超過上限 (${usedMb} MB / ${limitMb} MB)，請先至 Library 分頁刪除舊文章以釋放空間。`
    );
  }

  const db = await openDB();
  const libraryRecord = {
    ...item,
    id: itemId,
    images: cleanImagesMeta,
    imageBytes: calculatedImageBytes,
    createdAt: item.createdAt || now,
    updatedAt: now
  };

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(formatWriteError(err, '寫入 IndexedDB 交易失敗'));
    };

    const storeNames = blobsToWrite.length > 0 ? [STORE_LIBRARY, STORE_IMAGES] : [STORE_LIBRARY];
    const tx = db.transaction(storeNames, 'readwrite');
    const libStore = tx.objectStore(STORE_LIBRARY);
    const putReq = libStore.put(libraryRecord);
    putReq.onerror = () => fail(putReq.error || tx.error);

    if (blobsToWrite.length > 0) {
      const imgStore = tx.objectStore(STORE_IMAGES);
      for (const blobRec of blobsToWrite) {
        const imgReq = imgStore.put(blobRec);
        imgReq.onerror = () => fail(imgReq.error || tx.error);
      }
    }

    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('IndexedDB 交易已中止 (Transaction Aborted)'));
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
  });

  // Return record with in-memory Blobs attached so active article state stays ready
  return {
    ...libraryRecord,
    images: cleanImagesMeta.map((meta, idx) => {
      const orig = item.images?.[idx];
      const attachedBlob = orig?.blob instanceof Blob ? orig.blob : null;
      return attachedBlob ? { ...meta, blob: attachedBlob } : meta;
    })
  };
}

export async function deleteLibraryItem(id) {
  if (!id) return false;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(formatWriteError(err, '刪除 IndexedDB 項目失敗'));
    };

    const tx = db.transaction([STORE_LIBRARY, STORE_IMAGES], 'readwrite');
    const libStore = tx.objectStore(STORE_LIBRARY);
    const imgStore = tx.objectStore(STORE_IMAGES);

    const delLibReq = libStore.delete(id);
    delLibReq.onerror = () => fail(delLibReq.error || tx.error);

    const index = imgStore.index('articleId');
    const cursorReq = index.openKeyCursor(IDBKeyRange.only(id));
    cursorReq.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        imgStore.delete(cursor.primaryKey);
        cursor.continue();
      }
    };
    cursorReq.onerror = () => fail(cursorReq.error || tx.error);

    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error || new Error('IndexedDB 刪除交易已中止'));
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
  });
}

// ==================== Settings CRUD ====================

export async function getSetting(key, defaultValue = null) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_SETTINGS, 'readonly');
    const store = tx.objectStore(STORE_SETTINGS);
    const request = store.get(key);
    request.onsuccess = () => {
      resolve(request.result !== undefined ? request.result.value : defaultValue);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error || request.error);
  });
}

export async function setSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(formatWriteError(err, '儲存設定失敗'));
    };

    const tx = db.transaction(STORE_SETTINGS, 'readwrite');
    const store = tx.objectStore(STORE_SETTINGS);
    const request = store.put({ key, value, updatedAt: Date.now() });

    request.onerror = () => fail(request.error || tx.error);
    tx.onerror = () => fail(tx.error || request.error);
    tx.onabort = () => fail(tx.error || request.error || new Error('儲存設定交易已中止'));
    tx.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };
  });
}
