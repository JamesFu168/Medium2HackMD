// content/chatgpt.js - Injects Prompt + Article into ChatGPT, extracts generated Markdown,
// and runs an in-tab completion monitor that reports back to the background service worker.

(() => {
  // Re-initialize if a previous instance belongs to an invalidated extension context
  try {
    if (window.__M2H_CHATGPT_INSTANCE__ && window.__M2H_CHATGPT_INSTANCE__.alive()) return;
  } catch (_) {
    // fall through and re-initialize
  }

  const MONITOR_TICK_MS = 1500;
  // Time-based (not tick-based) so background-tab timer throttling cannot shorten the wait
  const STABLE_MS = 9000; // 內容連續 9 秒完全不變且至少觀察 2 次才視為完成
  const INVALID_STABLE_MS = 60000; // 內容穩定但未通過檢查時，最多再等 60 秒
  const DEFAULT_MAX_WAIT_MS = 15 * 60 * 1000;
  const PROGRESS_THROTTLE_MS = 2500;
  const THINKING_RE =
    /^(思考中|正在思考|已思考|思考了|推理中|正在推理|正在分析|分析中|Thinking|Reasoning|Thought for|Reasoned for|Analyzing|Searching|正在搜尋|搜尋中)/i;

  let monitorState = null;

  function findPromptInput() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('main form div[contenteditable="true"]') ||
      document.querySelector('main textarea')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button#composer-submit-button') ||
      document.querySelector('button[data-testid="composer-send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="傳送提示"]') ||
      document.querySelector('button[aria-label="發送提示"]') ||
      document.querySelector('form button[type="submit"]')
    );
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(probe, timeoutMs, intervalMs = 150) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = probe();
      if (v) return v;
      if (Date.now() >= deadline) return null;
      await sleep(intervalMs);
    }
  }

  function readComposerText(inputEl) {
    if (!inputEl) return '';
    if (inputEl.tagName.toLowerCase() === 'textarea') return inputEl.value || '';
    return inputEl.innerText || inputEl.textContent || '';
  }

  // True when the composer really holds (most of) the text we tried to insert
  function composerHasText(inputEl, fullText) {
    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const current = norm(readComposerText(inputEl));
    if (!current) return false;
    const head = norm(fullText.slice(0, 60));
    const tail = norm(fullText.slice(-60));
    return current.length >= fullText.length * 0.5 && current.includes(head) && current.includes(tail);
  }

  function clearComposer(inputEl) {
    if (inputEl.tagName.toLowerCase() === 'textarea') {
      inputEl.value = '';
      return;
    }
    inputEl.replaceChildren(document.createElement('p'));
  }

  // Strategy A: synthetic paste – ProseMirror handles paste events natively and reliably
  function setComposerViaPaste(inputEl, fullText) {
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', fullText);
      inputEl.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  // Strategy B: execCommand goes through beforeinput, which ProseMirror also understands
  function setComposerViaExecCommand(inputEl, fullText) {
    try {
      inputEl.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(inputEl);
      sel.removeAllRanges();
      sel.addRange(range);
      return document.execCommand('insertText', false, fullText);
    } catch (_) {
      return false;
    }
  }

  // Strategy C: direct DOM write + input event (legacy behaviour)
  function setComposerViaDom(inputEl, fullText) {
    const fragment = document.createDocumentFragment();
    for (const line of fullText.split('\n')) {
      const p = document.createElement('p');
      if (line.length > 0) {
        p.textContent = line;
      } else {
        p.appendChild(document.createElement('br'));
      }
      fragment.appendChild(p);
    }
    inputEl.replaceChildren(fragment);
    inputEl.dispatchEvent(
      new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: fullText })
    );
  }

  function getAssistantTurns() {
    const byRole = Array.from(
      document.querySelectorAll('[data-message-author-role="assistant"]')
    );
    if (byRole.length > 0) {
      return byRole;
    }
    const byAgentTurn = Array.from(
      document.querySelectorAll('article[data-testid^="conversation-turn-"] .agent-turn, .agent-turn')
    );
    if (byAgentTurn.length > 0) {
      return byAgentTurn;
    }
    // Fallback: any .markdown container not inside a user message
    return Array.from(document.querySelectorAll('main .markdown')).filter(
      (el) => !el.closest('[data-message-author-role="user"]')
    );
  }

  function isChatGPTStreaming() {
    return Boolean(
      document.querySelector('button[data-testid="stop-button"]') ||
      document.querySelector('button[data-testid="composer-stop-button"]') ||
      document.querySelector('button[aria-label*="Stop"]') ||
      document.querySelector('button[aria-label*="停止"]') ||
      document.querySelector('.result-streaming') ||
      document.querySelector('.result-thinking') ||
      document.querySelector('[data-testid="streaming-indicator"]')
    );
  }

  // Signature of the latest non-empty assistant turn, used to detect a NEW reply even when
  // turn counting is unreliable (ChatGPT re-renders / virtualizes the conversation list).
  function buildTurnSignature(turnEl) {
    if (!turnEl) return '';
    const txt = (turnEl.innerText || '').trim();
    return `${txt.length}:${txt.slice(0, 120)}`;
  }

  function looksLikeThinkingPlaceholder(turnEl, markdownText) {
    const txt = (turnEl?.innerText || '').trim();
    const md = (markdownText || '').trim();
    if (THINKING_RE.test(md) && md.length < 400) return true;
    if (THINKING_RE.test(txt) && txt.length < 400) return true;
    if (
      md.length < 200 &&
      turnEl &&
      turnEl.querySelector('.result-thinking, [class*="thinking"], [data-testid*="thinking"], [class*="animate-pulse"]')
    ) {
      return true;
    }
    return false;
  }

  // ChatGPT Canvas: long document outputs are rendered in a separate ProseMirror editor pane,
  // while the chat turn only contains a short sentence. Prefer the canvas content in that case.
  function findCanvasEditorRoot() {
    const selectors = [
      '#prosemirror-editor-container .ProseMirror',
      '#prosemirror-editor-container',
      '[data-testid="canvas-editor"] .ProseMirror',
      '[data-testid*="canvas"] .ProseMirror',
      'section[class*="canvas"] .ProseMirror',
      '.markdown.prose[contenteditable="true"]'
    ];
    const isPromptBox = (el) =>
      !el ||
      el.id === 'prompt-textarea' ||
      Boolean(el.closest('#prompt-textarea')) ||
      Boolean(el.closest('form'));

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && !isPromptBox(el) && (el.innerText || '').trim().length > 0) {
        return el;
      }
    }

    const editable = Array.from(document.querySelectorAll('.ProseMirror[contenteditable="true"]')).filter(
      (el) => !isPromptBox(el) && (el.innerText || '').trim().length > 0
    );
    if (editable.length === 0) return null;
    editable.sort((a, b) => (b.innerText || '').length - (a.innerText || '').length);
    return editable[0];
  }

  async function injectPromptToChatGPT(fullText, autoSend = true) {
    const inputEl = findPromptInput();
    if (!inputEl) {
      return {
        ok: false,
        error: '找不到 ChatGPT 輸入框 (#prompt-textarea)，請確認目前分頁已開啟並登入 ChatGPT。'
      };
    }

    const turns = getAssistantTurns();
    const nonEmptyTurns = turns.filter((t) => (t.innerText || '').trim().length > 0);
    const baselineTurnCount = turns.length;
    const baselineSignature = buildTurnSignature(nonEmptyTurns[nonEmptyTurns.length - 1]);
    // A canvas already open in this conversation must not be mistaken for the new reply
    const baselineCanvasSignature = buildTurnSignature(findCanvasEditorRoot());
    inputEl.focus();

    let method = '';
    if (inputEl.tagName.toLowerCase() === 'textarea') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(inputEl, fullText);
      } else {
        inputEl.value = fullText;
      }
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      method = 'textarea';
    } else {
      // ProseMirror contenteditable: try paste -> execCommand -> direct DOM, verifying each time
      clearComposer(inputEl);
      await sleep(60);

      if (setComposerViaPaste(inputEl, fullText)) {
        await sleep(200);
        if (composerHasText(inputEl, fullText)) method = 'paste';
      }
      if (!method) {
        clearComposer(inputEl);
        await sleep(60);
        if (setComposerViaExecCommand(inputEl, fullText)) {
          await sleep(200);
          if (composerHasText(inputEl, fullText)) method = 'execCommand';
        }
      }
      if (!method) {
        setComposerViaDom(inputEl, fullText);
        await sleep(200);
        if (composerHasText(inputEl, fullText)) method = 'dom';
      }
      if (!method) {
        return {
          ok: false,
          error:
            '已嘗試三種方式仍無法將文字填入 ChatGPT 輸入框（介面可能改版或頁面尚未就緒）。請改用「📋 複製 Prompt + 文章至剪貼簿」後手動貼上。'
        };
      }
    }

    const base = {
      ok: true,
      method,
      baselineTurnCount,
      baselineSignature,
      baselineCanvasSignature,
      conversationUrl: location.href
    };

    if (!autoSend) return { ...base, sent: false };

    // React re-renders the send button asynchronously after the editor state updates
    const sendBtn = await waitFor(() => {
      const b = findSendButton();
      return b && !b.disabled ? b : null;
    }, 4000);

    if (sendBtn) {
      sendBtn.click();
      await sleep(900);
      if (!composerHasText(inputEl, fullText)) return { ...base, sent: true };

      // Click didn't submit; try Enter as a second attempt
      inputEl.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true })
      );
      await sleep(900);
      if (!composerHasText(inputEl, fullText)) return { ...base, sent: true };
    }

    return {
      ...base,
      sent: false,
      warning: '已將 Prompt 與文章填入輸入框，但無法自動按下發送，請手動點擊 ChatGPT 的發送按鈕（送出後系統仍會自動偵測完成）。'
    };
  }

  function extractPreCodeAndLang(preNode) {
    let lang = '';
    const codeEl = preNode.querySelector('code, .cm-content');
    if (codeEl && codeEl.className && typeof codeEl.className === 'string') {
      const m = codeEl.className.match(/language-([a-zA-Z0-9_+-]+)/);
      if (m) lang = m[1].toLowerCase();
    }

    if (!lang) {
      const headerCandidates = Array.from(
        preNode.querySelectorAll('div.flex.items-center span, .text-xs, [class*="code-header"] span')
      );
      for (const span of headerCandidates) {
        const txt = (span.innerText || '').trim().toLowerCase();
        if (
          /^[a-z0-9_+-]{1,16}$/.test(txt) &&
          !['copy', 'edit', '複製', '複製程式碼', '編輯', 'run'].includes(txt)
        ) {
          lang = txt;
          break;
        }
      }
    }

    let rawCode = '';
    if (codeEl) {
      rawCode = codeEl.innerText || codeEl.textContent || '';
    } else {
      const clone = preNode.cloneNode(true);
      clone.querySelectorAll('button, svg, [role="toolbar"]').forEach((el) => el.remove());
      rawCode = clone.innerText || clone.textContent || '';
    }

    return {
      lang,
      rawCode: rawCode.replace(/\r\n/g, '\n').trimEnd()
    };
  }

  // Convert ChatGPT's rendered assistant DOM back to clean Markdown
  function htmlNodeToMarkdown(rootEl) {
    function inlineToMd(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      if (['button', 'svg', 'style', 'script'].includes(tag)) return '';
      if (tag === 'br') return '\n';

      if (tag === 'code' && (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre')) {
        return `\`${node.textContent}\``;
      }
      if (tag === 'strong' || tag === 'b') {
        const inner = Array.from(node.childNodes).map(inlineToMd).join('');
        return inner ? `**${inner}**` : '';
      }
      if (tag === 'em' || tag === 'i') {
        const inner = Array.from(node.childNodes).map(inlineToMd).join('');
        return inner ? `*${inner}*` : '';
      }
      if (tag === 'del' || tag === 's') {
        const inner = Array.from(node.childNodes).map(inlineToMd).join('');
        return inner ? `~~${inner}~~` : '';
      }
      if (tag === 'a') {
        const href = node.getAttribute('href') || '';
        const inner = Array.from(node.childNodes).map(inlineToMd).join('');
        return href ? `[${inner}](${href})` : inner;
      }
      if (tag === 'img') {
        const alt = node.getAttribute('alt') || 'image';
        const src = node.getAttribute('src') || '';
        return `![${alt}](${src})`;
      }

      return Array.from(node.childNodes).map(inlineToMd).join('');
    }

    const blocks = [];

    function blockToMd(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = node.textContent.trim();
        if (txt) blocks.push(txt);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();
      if (['button', 'svg', 'style', 'script'].includes(tag)) return;

      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        const text = Array.from(node.childNodes).map(inlineToMd).join('').trim();
        if (text) blocks.push(`${'#'.repeat(level)} ${text}`);
        return;
      }

      if (tag === 'p') {
        const text = Array.from(node.childNodes).map(inlineToMd).join('').trim();
        if (text) blocks.push(text);
        return;
      }

      if (tag === 'pre') {
        const { lang, rawCode } = extractPreCodeAndLang(node);
        if (!rawCode.trim()) return;

        // If ChatGPT wrapped article text inside a ```markdown / ```md block, unwrap it directly
        if (lang === 'markdown' || lang === 'md' || rawCode.includes('{{IMG_')) {
          blocks.push(unwrapOuterMarkdownFence(rawCode));
        } else {
          blocks.push(`\`\`\`${lang}\n${rawCode}\n\`\`\``);
        }
        return;
      }

      if (tag === 'blockquote') {
        const prevLen = blocks.length;
        Array.from(node.childNodes).forEach(blockToMd);
        const added = blocks.splice(prevLen);
        const quoted = added
          .join('\n\n')
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n');
        if (quoted) blocks.push(quoted);
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        const isOrdered = tag === 'ol';
        const startAttr = parseInt(node.getAttribute('start') || '1', 10);
        const items = Array.from(node.querySelectorAll(':scope > li'));
        const lines = items.map((li, idx) => {
          const prefix = isOrdered ? `${startAttr + idx}. ` : '- ';
          const content = Array.from(li.childNodes)
            .map(inlineToMd)
            .join('')
            .replace(/\n+/g, ' ')
            .trim();
          return `${prefix}${content}`;
        });
        if (lines.length) blocks.push(lines.join('\n'));
        return;
      }

      if (tag === 'table') {
        const rows = Array.from(node.querySelectorAll('tr'));
        if (rows.length > 0) {
          const mdRows = rows.map((tr) => {
            const cells = Array.from(tr.querySelectorAll('th, td')).map((cell) =>
              Array.from(cell.childNodes)
                .map(inlineToMd)
                .join('')
                .replace(/\|/g, '\\|')
                .replace(/\n+/g, ' ')
                .trim()
            );
            return `| ${cells.join(' | ')} |`;
          });
          if (mdRows.length >= 1) {
            const colCount = rows[0].querySelectorAll('th, td').length || 1;
            const sep = `| ${Array(colCount).fill('---').join(' | ')} |`;
            mdRows.splice(1, 0, sep);
            blocks.push(mdRows.join('\n'));
          }
        }
        return;
      }

      if (tag === 'hr') {
        blocks.push('---');
        return;
      }

      Array.from(node.childNodes).forEach(blockToMd);
    }

    blockToMd(rootEl);
    return blocks.join('\n\n').trim();
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

  function markdownFromContainer(markdownContainer) {
    // Strategy 1: If the response consists primarily of a single <pre> block
    const preBlocks = Array.from(markdownContainer.querySelectorAll('pre'));
    if (preBlocks.length === 1) {
      const { rawCode } = extractPreCodeAndLang(preBlocks[0]);
      const codeText = rawCode.trim();
      const totalTextLen = (markdownContainer.innerText || '').trim().length;
      if (codeText.length > 0 && codeText.length >= totalTextLen * 0.7) {
        return unwrapOuterMarkdownFence(codeText);
      }
    }
    // Strategy 2: Reconstruct full Markdown from the rendered DOM
    return unwrapOuterMarkdownFence(htmlNodeToMarkdown(markdownContainer));
  }

  function extractLatestAssistantMarkdown() {
    const allTurns = getAssistantTurns();
    const nonEmptyTurns = allTurns.filter((t) => (t.innerText || '').trim().length > 0);
    const isStreaming = isChatGPTStreaming();
    const canvasRoot = findCanvasEditorRoot();

    if (nonEmptyTurns.length === 0 && !canvasRoot) {
      return {
        ok: false,
        isStreaming,
        isThinking: false,
        turnCount: allTurns.length,
        nonEmptyTurnCount: 0,
        signature: '',
        error: '目前頁面上找不到 ChatGPT 的回覆內容，請確認 ChatGPT 已經開始或完成回覆。'
      };
    }

    const latestTurn = nonEmptyTurns[nonEmptyTurns.length - 1] || null;
    const signature = buildTurnSignature(latestTurn);
    const markdownContainer = latestTurn ? latestTurn.querySelector('.markdown') || latestTurn : null;

    let markdown = markdownContainer ? markdownFromContainer(markdownContainer) : '';
    let source = 'chat';
    let canvasSignature = '';

    if (canvasRoot) {
      const canvasMd = markdownFromContainer(canvasRoot);
      canvasSignature = buildTurnSignature(canvasRoot);
      // Canvas pane holds the real document when it is clearly longer than the chat reply
      if (canvasMd && canvasMd.length > Math.max(markdown.length, 200)) {
        markdown = canvasMd;
        source = 'canvas';
      }
    }

    const isThinking = source === 'chat' && looksLikeThinkingPlaceholder(latestTurn, markdown);

    if (!markdown) {
      return {
        ok: false,
        isStreaming,
        isThinking,
        turnCount: allTurns.length,
        nonEmptyTurnCount: nonEmptyTurns.length,
        signature,
        error: '擷取到的 ChatGPT 回覆為空白，請稍候再試。'
      };
    }

    return {
      ok: true,
      markdown,
      source,
      isStreaming,
      isThinking,
      turnCount: allTurns.length,
      nonEmptyTurnCount: nonEmptyTurns.length,
      signature,
      canvasSignature,
      conversationUrl: location.href
    };
  }

  // ==================== In-tab completion monitor ====================

  function validateCandidate(markdown, job) {
    const md = (markdown || '').trim();
    const problems = [];
    const warnings = [];

    if (md.length < 80) {
      problems.push(`回覆內容過短（僅 ${md.length} 字）`);
    }
    if (THINKING_RE.test(md) && md.length < 400) {
      problems.push('回覆看起來仍是「思考中」的提示文字');
    }
    if (typeof job.expectedMinLength === 'number' && job.expectedMinLength > 0 && md.length < job.expectedMinLength) {
      problems.push(
        `回覆長度 ${md.length} 字遠低於原文預期（至少約 ${job.expectedMinLength} 字），可能被截斷或只輸出了摘要`
      );
    }

    const expectedImgIds = Array.isArray(job.expectedImgIds) ? job.expectedImgIds : [];
    if (expectedImgIds.length > 0) {
      const found = expectedImgIds.filter((id) => md.includes(`{{${id}}}`));
      if (found.length === 0 && expectedImgIds.length >= 2) {
        problems.push(`回覆中完全沒有任何圖片佔位符（預期 ${expectedImgIds.length} 個），可能抓到了其他對話或 ChatGPT 未遵守規則`);
      } else if (found.length < expectedImgIds.length) {
        warnings.push(`有 ${expectedImgIds.length - found.length} 個圖片佔位符未出現在翻譯中`);
      }
    }

    return { ok: problems.length === 0, problems, warnings };
  }

  function sendToBackground(message) {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch (_) {
      return Promise.resolve(null);
    }
  }

  function reportProgress(phase, detail, force = false) {
    const st = monitorState;
    if (!st) return;
    const now = Date.now();
    const key = `${phase}|${detail.chars || 0}`;
    if (!force && now - st.lastProgressAt < PROGRESS_THROTTLE_MS && key === st.lastProgressKey) return;
    st.lastProgressAt = now;
    st.lastProgressKey = key;
    sendToBackground({
      type: 'CHATGPT_MONITOR_PROGRESS',
      jobId: st.jobId,
      articleId: st.articleId,
      phase,
      chars: detail.chars || 0,
      elapsedMs: now - st.startedAt,
      note: detail.note || '',
      diag: detail.diag || null,
      hidden: document.visibilityState === 'hidden'
    }).then((res) => {
      // Background no longer knows this job (cancelled / dismissed): stop polling
      if (res && res.stop && monitorState && monitorState.jobId === st.jobId) {
        stopMonitor();
      }
    });
  }

  function stopMonitor() {
    if (monitorState?.timer) {
      clearInterval(monitorState.timer);
    }
    monitorState = null;
  }

  function finishMonitorSuccess(markdown, source, warnings) {
    const st = monitorState;
    stopMonitor();
    sendToBackground({
      type: 'CHATGPT_TRANSLATION_READY',
      jobId: st.jobId,
      articleId: st.articleId,
      markdown,
      source,
      warnings,
      conversationUrl: location.href
    });
  }

  function finishMonitorFailure(reason, extra = {}) {
    const st = monitorState;
    stopMonitor();
    sendToBackground({
      type: 'CHATGPT_MONITOR_FAILED',
      jobId: st.jobId,
      articleId: st.articleId,
      reason,
      conversationUrl: location.href,
      ...extra
    });
  }

  function monitorTick() {
    const st = monitorState;
    if (!st) return;

    try {
      if (Date.now() - st.startedAt > st.maxWaitMs) {
        finishMonitorFailure(
          `等待 ChatGPT 回覆超過 ${Math.round(st.maxWaitMs / 60000)} 分鐘仍未完成，已停止自動偵測。若 ChatGPT 其實已完成，請按「立即從 ChatGPT 擷取回覆」。`
        );
        return;
      }

      const res = extractLatestAssistantMarkdown();
      const streaming = res.isStreaming;

      const hasNewTurn =
        res.ok &&
        (st.resume ||
          res.turnCount > st.baselineTurnCount ||
          res.nonEmptyTurnCount > st.baselineTurnCount ||
          (res.signature && res.signature !== st.baselineSignature) ||
          (res.source === 'canvas' && res.canvasSignature !== st.baselineCanvasSignature));

      const diag = {
        turns: res.turnCount,
        nonEmpty: res.nonEmptyTurnCount,
        baseline: st.baselineTurnCount,
        newTurn: hasNewTurn,
        streaming,
        thinking: Boolean(res.isThinking),
        source: res.source || '',
        extractError: res.ok ? '' : res.error || ''
      };

      const resetStability = () => {
        st.stableObservations = 0;
        st.stableSince = 0;
      };

      if (!hasNewTurn) {
        resetStability();
        reportProgress(streaming ? 'streaming' : 'waiting', { chars: 0, diag });
        return;
      }

      st.sawNewResponse = true;
      const chars = res.ok ? res.markdown.length : 0;

      if (streaming) {
        resetStability();
        st.lastMarkdown = res.ok ? res.markdown : st.lastMarkdown;
        reportProgress('streaming', { chars, diag });
        return;
      }

      if (!res.ok) {
        resetStability();
        reportProgress('waiting', { chars: 0, diag });
        return;
      }

      if (res.isThinking) {
        resetStability();
        reportProgress('thinking', { chars, diag });
        return;
      }

      if (res.markdown === st.lastMarkdown && st.stableObservations > 0) {
        st.stableObservations += 1;
      } else {
        st.lastMarkdown = res.markdown;
        st.stableSince = Date.now();
        st.stableObservations = 1;
      }
      const stableMs = Date.now() - st.stableSince;
      diag.stableMs = stableMs;

      if (stableMs < STABLE_MS || st.stableObservations < 2) {
        reportProgress('stabilizing', { chars, diag });
        return;
      }

      const validation = validateCandidate(res.markdown, st);
      if (validation.ok) {
        finishMonitorSuccess(res.markdown, res.source, validation.warnings);
        return;
      }

      // Content is stable but fails checks: keep waiting a bit in case ChatGPT is still working
      // (e.g. stop button selector broke, or it will continue after a pause), then give up with reason.
      if (stableMs >= INVALID_STABLE_MS) {
        finishMonitorFailure(
          `ChatGPT 回覆已停止變化，但內容未通過檢查：${validation.problems.join('；')}。未自動存入 Library，請檢查 ChatGPT 頁面；若確認內容正確，可按「立即從 ChatGPT 擷取回覆」強制存入。`,
          { candidateChars: res.markdown.length }
        );
        return;
      }
      reportProgress('verifying', { chars, note: validation.problems[0] || '', diag });
    } catch (err) {
      // Never let one bad tick kill the monitor; surface as progress note instead
      reportProgress('error', { chars: 0, note: err?.message || String(err) }, true);
    }
  }

  function startMonitor(job) {
    stopMonitor();
    monitorState = {
      jobId: job.jobId,
      articleId: job.articleId,
      baselineTurnCount: Number(job.baselineTurnCount) || 0,
      baselineSignature: job.baselineSignature || '',
      baselineCanvasSignature: job.baselineCanvasSignature || '',
      expectedImgIds: Array.isArray(job.expectedImgIds) ? job.expectedImgIds : [],
      expectedMinLength: Number(job.expectedMinLength) || 0,
      resume: Boolean(job.resume),
      startedAt: Number(job.startedAt) || Date.now(),
      maxWaitMs: Number(job.maxWaitMs) || DEFAULT_MAX_WAIT_MS,
      stableObservations: 0,
      stableSince: 0,
      lastMarkdown: '',
      sawNewResponse: false,
      lastProgressAt: 0,
      lastProgressKey: '',
      timer: null
    };
    monitorState.timer = setInterval(monitorTick, MONITOR_TICK_MS);
    reportProgress('waiting', { chars: 0 }, true);
    return { ok: true, jobId: job.jobId };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'INJECT_TO_CHATGPT') {
      injectPromptToChatGPT(message.fullText, message.autoSend)
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    if (message?.type === 'EXTRACT_FROM_CHATGPT') {
      try {
        const res = extractLatestAssistantMarkdown();
        sendResponse(res);
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return true;
    }

    if (message?.type === 'START_MONITOR') {
      try {
        sendResponse(startMonitor(message.job || {}));
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return true;
    }

    if (message?.type === 'STOP_MONITOR') {
      const wasActive = Boolean(monitorState);
      if (!message.jobId || !monitorState || monitorState.jobId === message.jobId) {
        stopMonitor();
      }
      sendResponse({ ok: true, wasActive });
      return true;
    }

    if (message?.type === 'GET_MONITOR_STATE' || message?.type === 'MONITOR_TICK_NOW') {
      // MONITOR_TICK_NOW: background watchdog forces a tick; message delivery is not subject to
      // the timer throttling Chrome/Edge applies to hidden tabs, so progress continues regardless.
      if (message.type === 'MONITOR_TICK_NOW' && monitorState) {
        try {
          monitorTick();
        } catch (_) {}
      }
      sendResponse({
        ok: true,
        active: Boolean(monitorState),
        jobId: monitorState?.jobId || null,
        articleId: monitorState?.articleId || null,
        chars: monitorState?.lastMarkdown?.length || 0,
        hidden: document.visibilityState === 'hidden',
        conversationUrl: location.href
      });
      return true;
    }

    if (message?.type === 'CHATGPT_COMPOSER_READY') {
      sendResponse({ ok: true, ready: Boolean(findPromptInput()), readyState: document.readyState });
      return true;
    }
  });

  window.__M2H_CHATGPT_INSTANCE__ = {
    alive() {
      try {
        return Boolean(chrome.runtime && chrome.runtime.id);
      } catch (_) {
        return false;
      }
    }
  };
})();
