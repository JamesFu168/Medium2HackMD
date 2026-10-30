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
  const STALE_STREAMING_MS = 90000; // 串流指示器持續存在但內容 90 秒毫無變化 → 視為指示器誤判
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

  const COMPOSER_ANCESTOR_SELECTOR = 'form, [data-type="unified-composer"], #composer-background, [class*="composer"]';

  function isInsideComposer(el) {
    return Boolean(el && (el.closest(COMPOSER_ANCESTOR_SELECTOR) || el.closest('#prompt-textarea')));
  }

  function isUserTurn(el) {
    return Boolean(
      el.matches('[data-message-author-role="user"], [data-turn="user"]') ||
        el.closest('[data-message-author-role="user"], [data-turn="user"]') ||
        el.querySelector('[data-message-author-role="user"], [data-turn="user"]')
    );
  }

  // Which selector strategy found the assistant turns (for diagnostics)
  let lastTurnStrategy = '';

  function getAssistantTurns() {
    const strategies = [
      ['role', () => Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'))],
      ['data-turn', () => Array.from(document.querySelectorAll('article[data-turn="assistant"], [data-turn="assistant"]'))],
      ['agent-turn', () => Array.from(document.querySelectorAll('article[data-testid^="conversation-turn-"] .agent-turn, .agent-turn'))],
      [
        'conversation-turn',
        () => {
          // Turn containers without role markers: keep the ones that are not user turns
          const turns = Array.from(document.querySelectorAll('[data-testid^="conversation-turn"], main article'));
          if (turns.length === 0) return [];
          const marked = turns.filter((t) => t.querySelector('[data-message-author-role], [data-turn]'));
          if (marked.length > 0) return turns.filter((t) => !isUserTurn(t) && !isInsideComposer(t));
          // No markers at all: assume alternating user/assistant, assistant = even index (0-based odd)
          return turns.filter((t, idx) => idx % 2 === 1 && !isInsideComposer(t));
        }
      ],
      [
        'markdown',
        () =>
          Array.from(document.querySelectorAll('main .markdown, main .prose, main [data-message-id]')).filter(
            (el) => !isUserTurn(el) && !isInsideComposer(el) && !el.closest('.markdown .markdown, .prose .prose')
          )
      ]
    ];

    for (const [name, fn] of strategies) {
      let found = [];
      try {
        found = fn();
      } catch (_) {
        found = [];
      }
      if (found.length > 0) {
        lastTurnStrategy = name;
        return found;
      }
    }
    lastTurnStrategy = 'none';
    return [];
  }

  const NON_STREAM_LABEL_RE = /voice|語音|dictat|聽寫|record|錄音|錄製|speech|microphone|麥克風|video|影片|share|分享/i;

  // Returns the matched indicator (string) or '' when nothing suggests ChatGPT is still generating
  function getStreamingIndicator() {
    const direct = [
      'button[data-testid="stop-button"]',
      'button[data-testid="composer-stop-button"]',
      'button[data-testid="composer-submit-button"][aria-label*="Stop" i]',
      'button[data-testid="composer-submit-button"][aria-label*="停止"]',
      '#composer-submit-button[aria-label*="Stop" i]',
      '#composer-submit-button[aria-label*="停止"]',
      '.result-streaming',
      '[data-testid="streaming-indicator"]'
    ];
    for (const sel of direct) {
      try {
        if (document.querySelector(sel)) return sel;
      } catch (_) {}
    }
    // Generic: a Stop button, but only inside the composer area and not a voice/recording control
    const buttons = Array.from(document.querySelectorAll('button[aria-label*="Stop" i], button[aria-label*="停止"], button[aria-label*="中止"]'));
    for (const b of buttons) {
      const label = b.getAttribute('aria-label') || '';
      if (NON_STREAM_LABEL_RE.test(label)) continue;
      if (isInsideComposer(b)) return `composer:${label}`;
    }
    return '';
  }

  function isChatGPTStreaming() {
    return Boolean(getStreamingIndicator());
  }

  // Compact DOM snapshot shipped with diagnostics so selector drift can be fixed from a log
  function domProbe() {
    const q = (s) => {
      try {
        return document.querySelectorAll(s).length;
      } catch (_) {
        return -1;
      }
    };
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || undefined,
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 80) || undefined,
      data: Array.from(el.attributes || [])
        .filter((a) => a.name.startsWith('data-'))
        .map((a) => `${a.name}=${String(a.value).slice(0, 30)}`)
        .join(' ')
        .slice(0, 160) || undefined,
      len: (el.innerText || '').length
    });
    const main = document.querySelector('main');
    const mainChildren = main ? Array.from(main.querySelectorAll('article, [data-testid^="conversation-turn"], [data-message-id], [data-turn]')).slice(-4) : [];
    const stopLike = Array.from(document.querySelectorAll('button'))
      .filter((b) => /stop|停止|中止/i.test(b.getAttribute('aria-label') || '') || /stop/i.test(b.getAttribute('data-testid') || ''))
      .slice(0, 5)
      .map((b) => ({
        testid: b.getAttribute('data-testid') || undefined,
        aria: b.getAttribute('aria-label') || undefined,
        id: b.id || undefined,
        inComposer: isInsideComposer(b)
      }));
    const submitLike = Array.from(document.querySelectorAll('button[data-testid*="send"], button[data-testid*="submit"], #composer-submit-button, form button[type="submit"]'))
      .slice(0, 5)
      .map((b) => ({
        testid: b.getAttribute('data-testid') || undefined,
        aria: b.getAttribute('aria-label') || undefined,
        id: b.id || undefined,
        disabled: Boolean(b.disabled)
      }));
    return {
      href: location.href,
      title: (document.title || '').slice(0, 60),
      hasMain: Boolean(main),
      turnStrategy: lastTurnStrategy,
      streamingMatch: getStreamingIndicator(),
      counts: {
        role: q('[data-message-author-role]'),
        turn: q('[data-turn]'),
        msgId: q('[data-message-id]'),
        convTurn: q('[data-testid^="conversation-turn"]'),
        article: q('main article'),
        markdown: q('.markdown'),
        prose: q('.prose'),
        agentTurn: q('.agent-turn'),
        prompt: q('#prompt-textarea')
      },
      lastTurnLike: mainChildren.map(describe),
      stopLike,
      submitLike
    };
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

    const attempts = [];
    const submitted = async (how) => {
      await sleep(900);
      const cleared = !composerHasText(inputEl, fullText);
      attempts.push(`${how}:${cleared ? 'ok' : 'no'}`);
      return cleared;
    };

    // React re-renders the send button asynchronously after the editor state updates
    const sendBtn = await waitFor(() => {
      const b = findSendButton();
      return b && !b.disabled ? b : null;
    }, 4000);

    if (sendBtn) {
      sendBtn.click();
      if (await submitted('click')) return { ...base, sent: true, attempts };
    } else {
      attempts.push('no-enabled-send-button');
    }

    // Enter key (ProseMirror/React handles keydown on the editor)
    inputEl.focus();
    for (const type of ['keydown', 'keypress', 'keyup']) {
      inputEl.dispatchEvent(
        new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }
    if (await submitted('enter')) return { ...base, sent: true, attempts };

    // Native form submission as a last resort
    const form = inputEl.closest('form');
    if (form && typeof form.requestSubmit === 'function') {
      try {
        form.requestSubmit();
      } catch (_) {}
      if (await submitted('requestSubmit')) return { ...base, sent: true, attempts };
    }

    return {
      ...base,
      sent: false,
      attempts,
      probe: domProbe(),
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
      let streaming = res.isStreaming;

      // Track when the visible content last changed; a "streaming" indicator that stays on while
      // nothing changes for a long time is treated as a stale/misidentified element.
      const contentKey = res.ok ? `${res.turnCount}:${res.markdown.length}:${res.markdown.slice(-80)}` : `none:${res.turnCount}`;
      if (contentKey !== st.lastContentKey) {
        st.lastContentKey = contentKey;
        st.lastContentChangeAt = Date.now();
      }
      let staleStreaming = false;
      if (streaming && res.ok && Date.now() - st.lastContentChangeAt > STALE_STREAMING_MS) {
        streaming = false;
        staleStreaming = true;
      }

      const hasNewTurn =
        res.ok &&
        (st.resume ||
          res.turnCount > st.baselineTurnCount ||
          res.nonEmptyTurnCount > st.baselineTurnCount ||
          (res.signature && res.signature !== st.baselineSignature) ||
          (res.source === 'canvas' && res.canvasSignature !== st.baselineCanvasSignature));

      const diag = {
        href: location.href,
        turns: res.turnCount,
        nonEmpty: res.nonEmptyTurnCount,
        baseline: st.baselineTurnCount,
        newTurn: hasNewTurn,
        streaming,
        staleStreaming: staleStreaming || undefined,
        thinking: Boolean(res.isThinking),
        source: res.source || '',
        strategy: lastTurnStrategy,
        extractError: res.ok ? '' : res.error || ''
      };
      // Ship a DOM snapshot while we cannot see any reply (selector drift) or the URL just changed
      if (!res.ok || res.turnCount === 0 || location.href !== st.lastHref) {
        diag.probe = domProbe();
      }
      st.lastHref = location.href;

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
      lastContentKey: '',
      lastContentChangeAt: Date.now(),
      lastHref: location.href,
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

    if (message?.type === 'CHATGPT_DOM_PROBE') {
      try {
        const res = extractLatestAssistantMarkdown();
        sendResponse({ ok: true, probe: domProbe(), extract: { ...res, markdown: (res.markdown || '').slice(0, 200) } });
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
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
