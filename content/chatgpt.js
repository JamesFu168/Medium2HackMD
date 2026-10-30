// content/chatgpt.js - Injects Prompt + Article into ChatGPT and extracts generated Markdown

(() => {
  if (window.__M2H_CHATGPT_INITIALIZED__) return;
  window.__M2H_CHATGPT_INITIALIZED__ = true;

  function findPromptInput() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
      document.querySelector('textarea[name="prompt-textarea"]') ||
      document.querySelector('main div[contenteditable="true"]') ||
      document.querySelector('main textarea')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="傳送提示"]') ||
      document.querySelector('form button[type="submit"]')
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
      document.querySelector('button[aria-label*="Stop"]') ||
      document.querySelector('button[aria-label*="停止"]') ||
      document.querySelector('.result-streaming')
    );
  }

  async function injectPromptToChatGPT(fullText, autoSend = true) {
    const inputEl = findPromptInput();
    if (!inputEl) {
      return {
        ok: false,
        error: '找不到 ChatGPT 輸入框 (#prompt-textarea)，請確認目前分頁已開啟並登入 ChatGPT。'
      };
    }

    const baselineTurnCount = getAssistantTurns().length;
    inputEl.focus();

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
    } else {
      // ProseMirror contenteditable div - build DOM nodes safely without innerHTML
      const fragment = document.createDocumentFragment();
      const lines = fullText.split('\n');
      for (const line of lines) {
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
        new InputEvent('input', {
          bubbles: true,
          cancelable: true,
          inputType: 'insertText',
          data: fullText
        })
      );
    }

    if (autoSend) {
      await new Promise((r) => setTimeout(r, 400));
      const sendBtn = findSendButton();
      if (sendBtn && !sendBtn.disabled) {
        sendBtn.click();
        return { ok: true, sent: true, baselineTurnCount };
      }
      return {
        ok: true,
        sent: false,
        baselineTurnCount,
        warning: '已將 Prompt 與文章填入輸入框，請手動點擊 ChatGPT 的發送按鈕。'
      };
    }

    return { ok: true, sent: false, baselineTurnCount };
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

  function extractLatestAssistantMarkdown() {
    const allTurns = getAssistantTurns();
    const nonEmptyTurns = allTurns.filter((t) => (t.innerText || '').trim().length > 0);

    if (nonEmptyTurns.length === 0) {
      return {
        ok: false,
        isStreaming: isChatGPTStreaming(),
        turnCount: allTurns.length,
        error: '目前頁面上找不到 ChatGPT 的回覆內容，請確認 ChatGPT 已經開始或完成回覆。'
      };
    }

    const latestTurn = nonEmptyTurns[nonEmptyTurns.length - 1];
    const markdownContainer = latestTurn.querySelector('.markdown') || latestTurn;
    const isStreaming = isChatGPTStreaming();

    // Strategy 1: If the assistant response consists primarily of a single <pre> block
    const preBlocks = Array.from(markdownContainer.querySelectorAll('pre'));
    if (preBlocks.length === 1) {
      const { rawCode } = extractPreCodeAndLang(preBlocks[0]);
      const codeText = rawCode.trim();
      const totalTextLen = (markdownContainer.innerText || '').trim().length;
      if (codeText.length > 0 && codeText.length >= totalTextLen * 0.7) {
        return {
          ok: true,
          markdown: unwrapOuterMarkdownFence(codeText),
          isStreaming,
          turnCount: allTurns.length,
          nonEmptyTurnCount: nonEmptyTurns.length
        };
      }
    }

    // Strategy 2: Reconstruct full Markdown from the assistant DOM (unwrapping any markdown <pre> blocks)
    const reconstructed = htmlNodeToMarkdown(markdownContainer);
    const cleaned = unwrapOuterMarkdownFence(reconstructed);

    if (!cleaned) {
      return {
        ok: false,
        isStreaming,
        turnCount: allTurns.length,
        error: '擷取到的 ChatGPT 回覆為空白，請稍候再試。'
      };
    }

    return {
      ok: true,
      markdown: cleaned,
      isStreaming,
      turnCount: allTurns.length,
      nonEmptyTurnCount: nonEmptyTurns.length
    };
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
  });
})();
