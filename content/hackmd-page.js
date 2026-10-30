// content/hackmd-page.js - Executed in MAIN world on hackmd.io via chrome.scripting.executeScript({ world: 'MAIN' })

(() => {
  if (window.__M2H_HACKMD_API__) return;

  function getCodeMirror5Instance() {
    if (window.editor && typeof window.editor.getValue === 'function') {
      return window.editor;
    }
    const cmEl = document.querySelector('.CodeMirror');
    if (cmEl && cmEl.CodeMirror) {
      return cmEl.CodeMirror;
    }
    return null;
  }

  function getCodeMirror6View(cm6Content) {
    const editorRoot = cm6Content?.closest('.cm-editor');
    if (cm6Content?.cmView?.view) return cm6Content.cmView.view;
    if (editorRoot?.cmView?.view) return editorRoot.cmView.view;
    return null;
  }

  function getCsrfToken() {
    const meta = document.querySelector('meta[name="csrf-token"], meta[name="xsrf-token"]');
    if (meta && meta.content) return meta.content;
    const match = document.cookie.match(/(?:^|;\s*)(?:_csrf|XSRF-TOKEN)=([^;]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }

  function dataUrlToFile(dataUrl, filename = 'image.png') {
    const arr = dataUrl.split(',');
    const mimeMatch = arr[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const bstr = atob(arr[1]);
    let n = bstr.length;
    const u8arr = new Uint8Array(n);
    while (n--) {
      u8arr[n] = bstr.charCodeAt(n);
    }
    return new File([u8arr], filename, { type: mime });
  }

  function indexToPos(text, index) {
    const lines = text.slice(0, index).split('\n');
    const line = lines.length - 1;
    const ch = lines[line].length;
    return { line, ch };
  }

  // Surgical removal of a specific inserted token in CodeMirror 5 without touching user/collaborator edits
  function removeTokenFromCodeMirror(cm, tokenStr) {
    if (!cm || !tokenStr) return false;
    const currentText = cm.getValue();
    const idx = currentText.indexOf(tokenStr);
    if (idx === -1) return false;

    const fromPos =
      typeof cm.posFromIndex === 'function'
        ? cm.posFromIndex(idx)
        : indexToPos(currentText, idx);
    const toPos =
      typeof cm.posFromIndex === 'function'
        ? cm.posFromIndex(idx + tokenStr.length)
        : indexToPos(currentText, idx + tokenStr.length);

    cm.replaceRange('', fromPos, toPos);
    return true;
  }

  function cleanupUploadingPlaceholders(cm, marker) {
    if (!cm) return;
    const currentText = cm.getValue();
    const uploadingRegex = /!\[Uploading file[^\]]*\]\([^)]*\)/g;
    const matches = currentText.match(uploadingRegex) || [];
    for (const token of matches) {
      if (!marker || token.includes(marker) || matches.length === 1) {
        removeTokenFromCodeMirror(cm, token);
      }
    }
  }

  async function uploadSingleImageToHackMD(dataUrl, filename) {
    const file = dataUrlToFile(dataUrl, filename);

    // Attempt 1: HackMD's internal /uploadimage endpoint
    try {
      const formData = new FormData();
      formData.append('image', file, filename);

      const headers = {};
      const csrf = getCsrfToken();
      if (csrf) {
        headers['X-CSRF-Token'] = csrf;
        headers['X-XSRF-TOKEN'] = csrf;
      }

      const resp = await fetch('/uploadimage', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: formData
      });

      if (resp.ok) {
        const data = await resp.json();
        if (data && data.link) {
          return { ok: true, link: data.link };
        }
      }
    } catch (_) {
      // Fallback to Attempt 2
    }

    // Attempt 2: Simulate Drop into CodeMirror 5 and surgically remove only the temporary upload token
    const cm = getCodeMirror5Instance();
    if (cm) {
      const marker = `m2h_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const safeName = (filename || 'image.png').replace(/[^a-zA-Z0-9._-]/g, '_');
      const markedFile = dataUrlToFile(dataUrl, `${marker}_${safeName}`);

      try {
        const beforeLinks = new Set(
          cm.getValue().match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g) || []
        );

        const dt = new DataTransfer();
        dt.items.add(markedFile);

        const targetEl =
          document.querySelector('.CodeMirror-code') ||
          document.querySelector('.CodeMirror textarea') ||
          document.querySelector('.CodeMirror');

        if (targetEl) {
          const dropEvent = new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt
          });
          targetEl.dispatchEvent(dropEvent);

          const startTime = Date.now();
          while (Date.now() - startTime < 8000) {
            await new Promise((r) => setTimeout(r, 300));
            const currentText = cm.getValue();
            if (!currentText.includes('Uploading file...')) {
              const currentLinks =
                currentText.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g) || [];
              const matchedToken =
                currentLinks.find((t) => t.includes(marker)) ||
                currentLinks.find((t) => !beforeLinks.has(t));

              if (matchedToken) {
                const m = matchedToken.match(/\((https?:\/\/[^)\s]+)\)/);
                if (m && m[1]) {
                  removeTokenFromCodeMirror(cm, matchedToken);
                  return { ok: true, link: m[1] };
                }
              }
            }
          }
          cleanupUploadingPlaceholders(cm, marker);
        }
      } catch (_) {
        cleanupUploadingPlaceholders(cm, marker);
      }
    }

    return {
      ok: false,
      error: '自動上傳圖片失敗（可能需在 HackMD 登入或開啟圖片上傳權限）'
    };
  }

  function setNativeTextareaValue(textarea, value) {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (setter) {
      setter.call(textarea, value);
    } else {
      textarea.value = value;
    }
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function getVerificationProbe(markdown) {
    const lines = (markdown || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (lines.length === 0) return '';
    return lines[0].slice(0, 60);
  }

  async function injectMarkdownIntoEditor(markdown, mode = 'replace') {
    const probe = getVerificationProbe(markdown);
    if (!probe) {
      return { ok: false, verified: false, error: '欲寫入的 Markdown 內容為空' };
    }

    // 1. Try CodeMirror 5 / window.editor
    const cm = getCodeMirror5Instance();
    if (cm) {
      cm.focus();
      if (mode === 'append') {
        const current = cm.getValue();
        const separator = current.trim().length > 0 ? '\n\n' : '';
        cm.setValue(current + separator + markdown);
        if (typeof cm.lineCount === 'function' && typeof cm.setCursor === 'function') {
          cm.setCursor(cm.lineCount(), 0);
        }
      } else if (mode === 'cursor') {
        cm.replaceSelection(markdown);
      } else {
        cm.setValue(markdown);
      }

      const afterVal = cm.getValue() || '';
      const verified = afterVal.includes(probe);
      if (!verified) {
        return {
          ok: false,
          verified: false,
          error: 'CodeMirror 5 編輯器寫入後讀回驗證失敗，請重試或手動貼上。'
        };
      }
      return { ok: true, verified: true, method: 'codemirror5' };
    }

    // 2. Try CodeMirror 6 (.cm-editor .cm-content[contenteditable="true"])
    const cm6Content = document.querySelector('.cm-editor .cm-content[contenteditable="true"]');
    if (cm6Content) {
      const cm6View = getCodeMirror6View(cm6Content);
      if (cm6View && cm6View.state && typeof cm6View.dispatch === 'function') {
        cm6View.focus();
        const docText = cm6View.state.doc.toString();
        const docLen = cm6View.state.doc.length;

        if (mode === 'append') {
          const insertText = (docText.trim().length > 0 ? '\n\n' : '') + markdown;
          cm6View.dispatch({
            changes: { from: docLen, to: docLen, insert: insertText },
            selection: { anchor: docLen + insertText.length }
          });
        } else if (mode === 'cursor') {
          const sel = cm6View.state.selection.main;
          cm6View.dispatch({
            changes: { from: sel.from, to: sel.to, insert: markdown },
            selection: { anchor: sel.from + markdown.length }
          });
        } else {
          cm6View.dispatch({
            changes: { from: 0, to: docLen, insert: markdown },
            selection: { anchor: markdown.length }
          });
        }

        const afterDoc = cm6View.state.doc.toString();
        const verified = afterDoc.includes(probe);
        if (!verified) {
          return {
            ok: false,
            verified: false,
            error: 'CodeMirror 6 編輯器寫入後讀回驗證失敗，請重試或手動貼上。'
          };
        }
        return { ok: true, verified: true, method: 'codemirror6-view' };
      }

      // DOM Selection + Paste fallback for CodeMirror 6 with read-back verification
      cm6Content.focus();
      const beforeText = cm6Content.innerText || '';
      const selection = window.getSelection();
      const range = document.createRange();
      let textToPaste = markdown;

      if (mode === 'replace') {
        range.selectNodeContents(cm6Content);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (mode === 'append') {
        const hasExisting = beforeText.trim().length > 0;
        textToPaste = (hasExisting ? '\n\n' : '') + markdown;
        range.selectNodeContents(cm6Content);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else if (mode === 'cursor') {
        if (!selection.rangeCount || !cm6Content.contains(selection.anchorNode)) {
          range.selectNodeContents(cm6Content);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }

      const dt = new DataTransfer();
      dt.setData('text/plain', textToPaste);
      const pasteEvent = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      cm6Content.dispatchEvent(pasteEvent);

      await new Promise((r) => setTimeout(r, 80));
      let afterText = cm6Content.innerText || '';
      let verified =
        afterText.includes(probe) &&
        (mode === 'replace' || afterText !== beforeText || beforeText.includes(markdown));

      if (!verified) {
        try {
          document.execCommand('insertText', false, textToPaste);
          await new Promise((r) => setTimeout(r, 60));
          afterText = cm6Content.innerText || '';
          verified = afterText.includes(probe);
        } catch (_) {}
      }

      if (!verified) {
        return {
          ok: false,
          verified: false,
          error: 'HackMD 編輯器未接受自動寫入內容，請點擊「📋 複製最終 Markdown」後於編輯器按 Ctrl+V 貼上。'
        };
      }
      return { ok: true, verified: true, method: 'codemirror6-dom' };
    }

    // 3. Fallback textarea
    const textarea = document.querySelector('.CodeMirror textarea, textarea');
    if (textarea) {
      textarea.focus();
      const current = textarea.value || '';

      if (mode === 'append') {
        const separator = current.trim().length > 0 ? '\n\n' : '';
        const nextValue = current + separator + markdown;
        setNativeTextareaValue(textarea, nextValue);
        textarea.selectionStart = textarea.selectionEnd = nextValue.length;
      } else if (mode === 'cursor') {
        const start =
          typeof textarea.selectionStart === 'number' ? textarea.selectionStart : current.length;
        const end =
          typeof textarea.selectionEnd === 'number' ? textarea.selectionEnd : current.length;
        const nextValue = current.slice(0, start) + markdown + current.slice(end);
        setNativeTextareaValue(textarea, nextValue);
        const caretPos = start + markdown.length;
        textarea.selectionStart = textarea.selectionEnd = caretPos;
      } else {
        setNativeTextareaValue(textarea, markdown);
        textarea.selectionStart = textarea.selectionEnd = markdown.length;
      }

      const verified = (textarea.value || '').includes(probe);
      if (!verified) {
        return {
          ok: false,
          verified: false,
          error: 'Textarea 寫入後讀回驗證失敗，請改用剪貼簿手動貼上。'
        };
      }
      return { ok: true, verified: true, method: 'textarea' };
    }

    return {
      ok: false,
      verified: false,
      error: '找不到 HackMD 編輯器區域！請確認目前已打開一篇 HackMD 筆記並切換至「編輯模式」或「雙欄模式」。'
    };
  }

  window.__M2H_HACKMD_API__ = {
    uploadSingleImageToHackMD,
    injectMarkdownIntoEditor
  };
})();
