// background.js - Service Worker for Medium2HackMD Extension
// Owns the ChatGPT auto-capture jobs so they survive the side panel being closed:
//  - the content script inside the ChatGPT tab does the polling and reports back here
//  - this worker persists the finished translation straight into IndexedDB (db.js)
//  - a 1-minute alarm acts as a watchdog that re-injects the monitor if the tab reloaded / slept

import { getLibraryItem, saveLibraryItem, getAllLibraryItems, sumLibraryBytes } from './db.js';

const JOBS_KEY = 'm2h_monitor_jobs';
const LOG_KEY = 'm2h_diag_log';
const LOG_MAX_ENTRIES = 300;
const WATCHDOG_ALARM = 'm2h-monitor-watchdog';
const WATCHDOG_PERIOD_MIN = 0.5; // Chromium clamps to its minimum (30s–60s depending on version)
const JOB_MAX_WAIT_MS = 15 * 60 * 1000;
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000; // keep done/failed jobs visible for an hour

// ==================== Diagnostics log (ring buffer in session storage) ====================

let logChain = Promise.resolve();
function logEvent(level, message, data = null) {
  const entry = { t: Date.now(), level, message, data };
  const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${message}${data ? ' ' + safeJson(data) : ''}`;
  if (level === 'error') console.error('[M2H]', line);
  else console.log('[M2H]', line);
  logChain = logChain
    .then(async () => {
      const stored = await chrome.storage.session.get(LOG_KEY);
      const list = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
      list.push(entry);
      while (list.length > LOG_MAX_ENTRIES) list.shift();
      await chrome.storage.session.set({ [LOG_KEY]: list });
    })
    .catch(() => {});
  return logChain;
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (_) {
    return String(v);
  }
}

async function getDiagLogText() {
  const stored = await chrome.storage.session.get([LOG_KEY, JOBS_KEY]);
  const list = Array.isArray(stored[LOG_KEY]) ? stored[LOG_KEY] : [];
  const lines = list.map(
    (e) => `[${new Date(e.t).toISOString()}] ${String(e.level).toUpperCase()} ${e.message}${e.data ? ' ' + safeJson(e.data) : ''}`
  );
  const manifest = chrome.runtime.getManifest();
  const header = [
    `Medium2HackMD ${manifest.version} 診斷記錄`,
    `UA: ${navigator.userAgent}`,
    `產生時間: ${new Date().toISOString()}`,
    `目前工作: ${safeJson(stored[JOBS_KEY] || {})}`,
    '---'
  ];
  return header.concat(lines.length ? lines : ['(尚無記錄)']).join('\n');
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel
      .setPanelBehavior({ openPanelOnActionClick: true })
      .catch((err) => console.error('Failed to set sidePanel behavior:', err));
  }
});

// ==================== Job persistence (chrome.storage.session survives SW restarts) ====================

async function loadJobs() {
  try {
    const stored = await chrome.storage.session.get(JOBS_KEY);
    return stored[JOBS_KEY] || {};
  } catch (_) {
    return {};
  }
}

async function saveJobs(jobs) {
  await chrome.storage.session.set({ [JOBS_KEY]: jobs });
}

async function getJob(jobId) {
  const jobs = await loadJobs();
  return jobs[jobId] || null;
}

async function upsertJob(job) {
  const jobs = await loadJobs();
  jobs[job.jobId] = job;
  await saveJobs(jobs);
  return job;
}

async function patchJob(jobId, patch) {
  const jobs = await loadJobs();
  const existing = jobs[jobId];
  if (!existing) return null;
  const updated = { ...existing, ...patch, updatedAt: Date.now() };
  jobs[jobId] = updated;
  await saveJobs(jobs);
  return updated;
}

async function removeJob(jobId) {
  const jobs = await loadJobs();
  delete jobs[jobId];
  await saveJobs(jobs);
}

async function pruneOldJobs() {
  const jobs = await loadJobs();
  const now = Date.now();
  let changed = false;
  for (const [id, job] of Object.entries(jobs)) {
    if (job.status !== 'pending' && now - (job.updatedAt || job.startedAt || 0) > FINISHED_JOB_TTL_MS) {
      delete jobs[id];
      changed = true;
    }
  }
  if (changed) await saveJobs(jobs);
  return jobs;
}

function broadcast(message) {
  // Side panel may not be open; ignore "receiving end does not exist"
  try {
    chrome.runtime.sendMessage(message).catch(() => {});
  } catch (_) {}
}

function setBadge(text, color = '#2e7d32') {
  try {
    chrome.action.setBadgeText({ text }).catch(() => {});
    if (text) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
  } catch (_) {}
}

function unwrapOuterMarkdownFence(text) {
  if (!text) return '';
  const trimmed = text.trim();
  const match = trimmed.match(/^`{3,4}(?:markdown|md)?\s*\n([\s\S]*?)\n`{3,4}$/i);
  return match ? match[1].trim() : trimmed;
}

// ==================== Monitor control inside the ChatGPT tab ====================

// ChatGPT may render the transcript inside an iframe, so the monitor runs in EVERY frame of the tab
// and the background accepts the finished translation from whichever frame finds it.

function buildStartPayload(job, resume) {
  return {
    jobId: job.jobId,
    articleId: job.articleId,
    baselineTurnCount: resume ? 0 : job.baselineTurnCount,
    baselineSignature: resume ? '' : job.baselineSignature,
    baselineCanvasSignature: resume ? '' : job.baselineCanvasSignature,
    promptHead: job.promptHead || '',
    promptTail: job.promptTail || '',
    expectedImgIds: job.expectedImgIds,
    expectedMinLength: job.expectedMinLength,
    startedAt: job.startedAt,
    maxWaitMs: JOB_MAX_WAIT_MS,
    resume
  };
}

async function injectIntoFrames(tabId, frameIds = null) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({ target, files: ['content/chatgpt.js'] });
  const ids = (results || []).map((r) => r.frameId).filter((id) => typeof id === 'number');
  return ids.length ? ids : [0];
}

async function sendToFrame(tabId, frameId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId });
  } catch (_) {
    return null;
  }
}

async function mergeFrameIds(jobId, frameIds) {
  const job = await getJob(jobId);
  if (!job) return;
  const known = new Set([...(job.frameIds || []), ...frameIds]);
  await patchJob(jobId, { frameIds: Array.from(known) });
}

// Inject into the given frames (or all) and make sure each runs the monitor for this job.
// Frames already running it just get a forced tick (message delivery ignores timer throttling).
async function ensureMonitorsInFrames(job, resume, reason, frameIds = null) {
  const ids = await injectIntoFrames(job.tabId, frameIds);
  const summary = [];
  let running = 0;
  for (const frameId of ids) {
    const state = await sendToFrame(job.tabId, frameId, { type: 'MONITOR_TICK_NOW' });
    if (state && state.active && state.jobId === job.jobId) {
      running++;
      summary.push({ frameId, top: state.isTop, chars: state.chars });
      continue;
    }
    const res = await sendToFrame(job.tabId, frameId, {
      type: 'START_MONITOR',
      job: buildStartPayload(job, resume)
    });
    if (res && res.ok) running++;
    summary.push({ frameId, started: Boolean(res && res.ok), error: res ? res.error : 'no response' });
  }
  await mergeFrameIds(job.jobId, ids);
  logEvent(running ? 'info' : 'error', `frames ensured (${reason})`, { jobId: job.jobId, frames: summary });
  if (running === 0) {
    throw new Error(summary.map((s) => `frame ${s.frameId}: ${s.error || 'failed'}`).join('; ') || '無法在 ChatGPT 分頁啟動自動偵測');
  }
  return summary;
}

async function injectAndStartMonitor(job, resume = false) {
  logEvent('info', 'inject monitor', { jobId: job.jobId, tabId: job.tabId, resume });
  await ensureMonitorsInFrames(job, resume, resume ? 'resume' : 'start');
}

async function stopMonitorsInTab(job) {
  const ids = new Set([0, ...(job.frameIds || [])]);
  for (const frameId of ids) {
    await sendToFrame(job.tabId, frameId, { type: 'STOP_MONITOR', jobId: job.jobId });
  }
}

async function ensureWatchdog() {
  try {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!existing) {
      await chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: WATCHDOG_PERIOD_MIN });
    }
  } catch (err) {
    logEvent('warn', 'alarms unavailable', { error: err?.message || String(err) });
  }
}

async function failJob(jobId, reason, extra = {}) {
  const job = await patchJob(jobId, {
    status: 'failed',
    phase: 'failed',
    reason,
    finishedAt: Date.now(),
    ...extra
  });
  logEvent('error', 'job failed', { jobId, reason, ...extra });
  if (job) {
    if (typeof job.tabId === 'number') await stopMonitorsInTab(job);
    setBadge('!', '#c62828');
    broadcast({ type: 'M2H_MONITOR_FAILED', job });
  }
  return job;
}

async function startMonitorJob(payload) {
  const now = Date.now();
  const job = {
    jobId: `job_${now}_${Math.random().toString(36).slice(2, 7)}`,
    articleId: payload.articleId,
    articleTitle: payload.articleTitle || '',
    tabId: payload.tabId,
    conversationUrl: payload.conversationUrl || '',
    baselineTurnCount: Number(payload.baselineTurnCount) || 0,
    baselineSignature: payload.baselineSignature || '',
    baselineCanvasSignature: payload.baselineCanvasSignature || '',
    promptHead: String(payload.promptHead || '').slice(0, 120),
    promptTail: String(payload.promptTail || '').slice(-120),
    expectedImgIds: Array.isArray(payload.expectedImgIds) ? payload.expectedImgIds : [],
    expectedMinLength: Number(payload.expectedMinLength) || 0,
    status: 'pending',
    phase: 'waiting',
    chars: 0,
    note: '',
    startedAt: now,
    updatedAt: now
  };

  // Only one pending job per article: cancel the previous one
  const jobs = await loadJobs();
  for (const other of Object.values(jobs)) {
    if (other.status === 'pending' && other.articleId === job.articleId) {
      await stopMonitorsInTab(other);
      delete jobs[other.jobId];
    }
  }
  jobs[job.jobId] = job;
  await saveJobs(jobs);
  logEvent('info', 'job created', {
    jobId: job.jobId,
    articleId: job.articleId,
    tabId: job.tabId,
    baselineTurnCount: job.baselineTurnCount,
    expectedImgIds: job.expectedImgIds.length,
    expectedMinLength: job.expectedMinLength,
    conversationUrl: job.conversationUrl
  });

  try {
    await injectAndStartMonitor(job, false);
  } catch (err) {
    // Don't leave a ghost job behind; the side panel tells the user to capture manually
    logEvent('error', 'start monitor failed', { jobId: job.jobId, error: err?.message || String(err) });
    await removeJob(job.jobId);
    throw err;
  }
  await ensureWatchdog();
  setBadge('…', '#1565c0');
  broadcast({ type: 'M2H_MONITOR_UPDATE', job });
  return job;
}

async function cancelMonitorJob(jobId, silent = false) {
  const job = await getJob(jobId);
  if (!job) return;
  if (typeof job.tabId === 'number') await stopMonitorsInTab(job);
  await removeJob(jobId);
  setBadge('');
  logEvent('info', 'job cancelled', { jobId });
  if (!silent) broadcast({ type: 'M2H_MONITOR_CANCELLED', jobId, articleId: job.articleId });
}

// ==================== Persist the finished translation ====================

async function handleTranslationReady(message, sender) {
  const job = await getJob(message.jobId);
  logEvent('info', 'translation ready received', {
    jobId: message.jobId,
    chars: (message.markdown || '').length,
    source: message.source,
    senderTab: sender?.tab?.id,
    frameId: sender?.frameId,
    frameHref: message.conversationUrl,
    jobStatus: job?.status || 'missing'
  });
  if (!job || job.status !== 'pending') {
    return { ok: false, error: 'job not pending' };
  }
  if (sender?.tab?.id !== undefined && sender.tab.id !== job.tabId) {
    logEvent('warn', 'translation ready from unexpected tab', { expected: job.tabId, got: sender.tab.id });
    return { ok: false, error: 'wrong tab' };
  }

  const cleanMd = unwrapOuterMarkdownFence(message.markdown || '');
  if (!cleanMd) {
    await failJob(job.jobId, 'ChatGPT 回覆內容為空白，未存入 Library。');
    return { ok: false };
  }

  try {
    const article = await getLibraryItem(job.articleId, false);
    if (!article) {
      await failJob(job.jobId, '找不到對應的 Library 文章（可能已被刪除），翻譯未存入。');
      return { ok: false };
    }

    article.translatedMarkdown = cleanMd;
    if (!article.status || article.status === 'captured') {
      article.status = 'translated';
    }
    article.translatedAt = Date.now();
    article.chatgptConversationUrl = message.conversationUrl || job.conversationUrl || '';

    const allItems = await getAllLibraryItems();
    const existingBytes = sumLibraryBytes(allItems, article.id);
    await saveLibraryItem(article, existingBytes);

    const done = await patchJob(job.jobId, {
      status: 'done',
      phase: 'done',
      chars: cleanMd.length,
      source: message.source || 'chat',
      warnings: Array.isArray(message.warnings) ? message.warnings : [],
      conversationUrl: message.conversationUrl || job.conversationUrl || '',
      finishedAt: Date.now()
    });
    setBadge('✓', '#2e7d32');
    logEvent('info', 'translation saved to library', { jobId: job.jobId, articleId: article.id, chars: cleanMd.length });
    broadcast({ type: 'M2H_TRANSLATION_SAVED', job: done });
    await stopMonitorsInTab(job); // other frames of the same tab are still polling
    return { ok: true };
  } catch (err) {
    await failJob(job.jobId, `翻譯已完成但寫入 Library 失敗：${err?.message || err}`);
    return { ok: false, error: err?.message || String(err) };
  }
}

// ==================== Watchdog: re-attach monitor if the ChatGPT tab reloaded / slept ====================

async function watchdogTick() {
  const jobs = await pruneOldJobs();
  const pending = Object.values(jobs).filter((j) => j.status === 'pending');

  if (pending.length === 0) {
    try {
      await chrome.alarms.clear(WATCHDOG_ALARM);
    } catch (_) {}
    return;
  }

  for (const job of pending) {
    if (Date.now() - job.startedAt > JOB_MAX_WAIT_MS + 60 * 1000) {
      await failJob(job.jobId, '等待 ChatGPT 回覆逾時，已停止自動偵測。');
      continue;
    }

    let tab = null;
    try {
      tab = await chrome.tabs.get(job.tabId);
    } catch (_) {
      await failJob(job.jobId, '原本送出翻譯的 ChatGPT 分頁已關閉，無法自動擷取。');
      continue;
    }
    if (!tab?.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) {
      await failJob(job.jobId, 'ChatGPT 分頁已離開 ChatGPT 網站，無法自動擷取。');
      continue;
    }

    // Edge "sleeping tabs" discards the page (content script gone). Reload it; onUpdated re-attaches.
    if (tab.discarded) {
      logEvent('warn', 'tab discarded by browser, reloading', { jobId: job.jobId, tabId: job.tabId });
      try {
        await chrome.tabs.reload(job.tabId);
      } catch (err) {
        logEvent('error', 'reload discarded tab failed', { error: err?.message || String(err) });
      }
      continue;
    }
    if (tab.status && tab.status !== 'complete') continue;

    // Re-inject into all frames (idempotent), force a tick where running, start where missing.
    // Message delivery is not subject to hidden-tab timer throttling, so this keeps things moving.
    try {
      await ensureMonitorsInFrames(job, true, 'watchdog');
    } catch (err) {
      logEvent('error', 'watchdog re-attach failed', { jobId: job.jobId, error: err?.message || String(err) });
      await patchJob(job.jobId, { note: `重新連接失敗：${err?.message || err}` });
    }
  }
}

// Decide whether per-frame "content invalid" reports add up to a failed job
async function handleMonitorInvalid(message, sender) {
  const job = await getJob(message.jobId);
  if (!job || job.status !== 'pending') return { ok: false, stop: true };
  const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
  const frameInvalid = { ...(job.frameInvalid || {}), [frameId]: { reason: message.reason, chars: Number(message.candidateChars) || 0, at: Date.now() } };
  await patchJob(job.jobId, { frameInvalid });
  logEvent('warn', 'frame reports invalid content', {
    jobId: job.jobId,
    frameId,
    candidateChars: message.candidateChars,
    activeFrameId: job.activeFrameId,
    jobChars: job.chars,
    reason: message.reason
  });

  // Another frame currently holds more content (the real transcript): ignore this frame
  if (typeof job.activeFrameId === 'number' && job.activeFrameId !== frameId && (job.chars || 0) > (Number(message.candidateChars) || 0)) {
    return { ok: true };
  }
  const frames = (job.frameIds && job.frameIds.length ? job.frameIds : [frameId]).map(Number);
  const allInvalid = frames.every((id) => frameInvalid[id]);
  if (frames.length <= 1 || allInvalid) {
    await failJob(job.jobId, message.reason || '回覆內容未通過檢查', {
      candidateChars: Number(message.candidateChars) || 0,
      conversationUrl: message.conversationUrl || ''
    });
    return { ok: true, stop: true };
  }
  return { ok: true };
}

if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === WATCHDOG_ALARM) {
      watchdogTick().catch((err) => console.warn('watchdog error', err));
    }
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  (async () => {
    const jobs = await loadJobs();
    const job = Object.values(jobs).find((j) => j.status === 'pending' && j.tabId === tabId);
    if (!job) return;
    if (!tab?.url || !/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//.test(tab.url)) return;
    try {
      await ensureMonitorsInFrames(job, true, 'tab complete');
    } catch (err) {
      logEvent('error', 're-inject after reload failed', { jobId: job.jobId, error: err?.message || String(err) });
    }
  })().catch(() => {});
});

// Sub-frames (ChatGPT renders the transcript in an iframe that appears after the first message)
if (chrome.webNavigation) {
  chrome.webNavigation.onCompleted.addListener(
    (details) => {
      (async () => {
        const jobs = await loadJobs();
        const job = Object.values(jobs).find((j) => j.status === 'pending' && j.tabId === details.tabId);
        if (!job) return;
        logEvent('info', 'frame navigation completed', { jobId: job.jobId, frameId: details.frameId, url: (details.url || '').slice(0, 120) });
        try {
          await ensureMonitorsInFrames(job, true, `frame ${details.frameId} completed`, [details.frameId]);
        } catch (err) {
          logEvent('warn', 'inject into frame failed', { jobId: job.jobId, frameId: details.frameId, error: err?.message || String(err) });
        }
      })().catch(() => {});
    },
    { url: [{ hostSuffix: 'chatgpt.com' }, { hostSuffix: 'openai.com' }, { hostSuffix: 'oaiusercontent.com' }, { hostSuffix: 'oaistatic.com' }] }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  (async () => {
    const jobs = await loadJobs();
    for (const job of Object.values(jobs)) {
      if (job.status === 'pending' && job.tabId === tabId) {
        await failJob(job.jobId, '原本送出翻譯的 ChatGPT 分頁已關閉，自動擷取已中止。');
      }
    }
  })().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => logEvent('info', 'service worker startup'));
logEvent('info', 'service worker loaded');

// ==================== Message router ====================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  if (!type) return false;

  const respond = (promise) => {
    promise
      .then((res) => sendResponse(res))
      .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
    return true;
  };

  switch (type) {
    // ---- from side panel ----
    case 'M2H_START_MONITOR':
      return respond(startMonitorJob(message).then((job) => ({ ok: true, job })));

    case 'M2H_GET_MONITOR_JOBS':
      return respond(pruneOldJobs().then((jobs) => ({ ok: true, jobs })));

    case 'M2H_CANCEL_MONITOR':
      return respond(cancelMonitorJob(message.jobId, Boolean(message.silent)).then(() => ({ ok: true })));

    case 'M2H_DISMISS_JOB':
      return respond(
        removeJob(message.jobId).then(() => {
          setBadge('');
          return { ok: true };
        })
      );

    case 'M2H_CLEAR_BADGE':
      setBadge('');
      sendResponse({ ok: true });
      return false;

    case 'M2H_GET_DIAG_LOG':
      return respond(getDiagLogText().then((text) => ({ ok: true, text })));

    case 'M2H_LOG':
      logEvent(message.level || 'info', `[sidepanel] ${message.message || ''}`, message.data || null);
      sendResponse({ ok: true });
      return false;

    // ---- from ChatGPT content script ----
    case 'CHATGPT_MONITOR_PROGRESS':
      return respond(
        getJob(message.jobId).then(async (existing) => {
          if (!existing || existing.status !== 'pending') {
            logEvent('warn', 'progress for unknown/finished job, telling tab to stop', { jobId: message.jobId });
            return { ok: false, stop: true }; // tell the tab to stop polling a dead job
          }
          const phase = message.phase || 'waiting';
          const frameId = typeof sender?.frameId === 'number' ? sender.frameId : 0;
          const chars = Number(message.chars) || 0;
          // The frame that has content owns the job's displayed status; empty frames only log
          const owner = typeof existing.activeFrameId === 'number' ? existing.activeFrameId : null;
          const takesOwnership = chars > 0 && (owner === null || chars >= (existing.chars || 0) || frameId === owner);
          const mayUpdate = takesOwnership || owner === null || frameId === owner;
          const phaseChanged = mayUpdate && existing.phase !== phase;
          const lastLogKey = `lastLogAt_${frameId}`;
          const lastLogAt = existing[lastLogKey] || 0;
          const shouldLog = phaseChanged || Date.now() - lastLogAt > 30000;
          if (shouldLog) {
            logEvent('debug', `progress ${phase}`, {
              jobId: message.jobId,
              frameId,
              top: message.isTop,
              chars,
              hidden: message.hidden,
              note: message.note || undefined,
              diag: message.diag || undefined
            });
          }
          const patch = { [lastLogKey]: shouldLog ? Date.now() : lastLogAt };
          if (mayUpdate) {
            Object.assign(patch, {
              phase,
              chars,
              note: message.note || '',
              elapsedMs: Number(message.elapsedMs) || 0
            });
            if (takesOwnership) patch.activeFrameId = frameId;
          }
          const job = await patchJob(message.jobId, patch);
          if (job && mayUpdate) broadcast({ type: 'M2H_MONITOR_UPDATE', job });
          return { ok: Boolean(job) };
        })
      );

    case 'CHATGPT_MONITOR_INVALID':
      return respond(handleMonitorInvalid(message, sender));

    case 'CHATGPT_TRANSLATION_READY':
      return respond(handleTranslationReady(message, sender));

    case 'CHATGPT_MONITOR_FAILED':
      logEvent('error', 'tab reported monitor failure', {
        jobId: message.jobId,
        reason: message.reason,
        candidateChars: message.candidateChars
      });
      return respond(
        failJob(message.jobId, message.reason || '自動偵測失敗', {
          candidateChars: Number(message.candidateChars) || 0,
          conversationUrl: message.conversationUrl || ''
        }).then((job) => ({ ok: Boolean(job) }))
      );

    default:
      return false;
  }
});
