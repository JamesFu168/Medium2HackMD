// content/extractor.js - Extracts article content & high-res images from Medium and related web pages

(() => {
  if (window.__M2H_EXTRACTOR_INITIALIZED__) return;
  window.__M2H_EXTRACTOR_INITIALIZED__ = true;

  function isBlurPlaceholderUrl(url) {
    if (!url) return true;
    const lower = url.toLowerCase();
    return (
      lower.includes('?q=20') ||
      lower.includes('/resize:fit:20/') ||
      lower.includes('/resize:fit:30/') ||
      lower.includes('/resize:fit:40/') ||
      lower.includes('/resize:fill:20:') ||
      lower.includes('/resize:fill:30:') ||
      lower.includes('/freeze/ max/30/') ||
      lower.includes('/max/30/') ||
      lower.includes('/max/60/')
    );
  }

  function upgradeMediumImageUrl(url) {
    if (!url) return null;
    let upgraded = url;
    // Upgrade Medium v2 resize URLs to 1400px high-res
    if (upgraded.includes('miro.medium.com/v2/resize:fit:')) {
      upgraded = upgraded.replace(/resize:fit:\d+/, 'resize:fit:1400');
    } else if (upgraded.includes('miro.medium.com/max/')) {
      upgraded = upgraded.replace(/\/max\/\d+\//, '/max/1400/');
    }
    return upgraded;
  }

  function pickHighestResFromSrcset(srcset) {
    if (!srcset || typeof srcset !== 'string') return null;
    const candidates = srcset
      .split(',')
      .map((part) => {
        const tokens = part.trim().split(/\s+/);
        const url = tokens[0];
        let score = 1;
        if (tokens[1]) {
          const wMatch = tokens[1].match(/^(\d+)w$/i);
          const xMatch = tokens[1].match(/^(\d+(?:\.\d+)?)x$/i);
          if (wMatch) score = parseInt(wMatch[1], 10);
          else if (xMatch) score = parseFloat(xMatch[1]) * 1000;
        }
        return { url, score };
      })
      .filter((c) => c.url && !c.url.startsWith('data:') && !isBlurPlaceholderUrl(c.url));

    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].url;
  }

  function resolveBestImageUrlFromFigure(figureEl) {
    if (!figureEl) return null;

    // 1. Check <picture> <source srcset="..."> inside figure
    const sources = Array.from(figureEl.querySelectorAll('picture source[srcset]'));
    for (const source of sources) {
      const candidate = pickHighestResFromSrcset(source.getAttribute('srcset'));
      if (candidate) {
        try {
          return upgradeMediumImageUrl(new URL(candidate, window.location.href).href);
        } catch (_) {}
      }
    }

    // 2. Check all <img> inside figure (skipping tiny blur-up placeholders)
    const imgs = Array.from(figureEl.querySelectorAll('img'));
    for (const imgEl of imgs) {
      const fromSrcset =
        pickHighestResFromSrcset(imgEl.getAttribute('srcset')) ||
        pickHighestResFromSrcset(imgEl.getAttribute('data-srcset'));
      if (fromSrcset) {
        try {
          return upgradeMediumImageUrl(new URL(fromSrcset, window.location.href).href);
        } catch (_) {}
      }

      const rawSrc =
        imgEl.getAttribute('data-src') ||
        imgEl.getAttribute('data-original') ||
        imgEl.currentSrc ||
        imgEl.src ||
        imgEl.getAttribute('src');

      if (rawSrc && !rawSrc.startsWith('data:') && !isBlurPlaceholderUrl(rawSrc)) {
        try {
          return upgradeMediumImageUrl(new URL(rawSrc, window.location.href).href);
        } catch (_) {}
      }
    }

    // 3. Check <noscript> inside figure (Medium uses <noscript> for un-scrolled lazy images!)
    const noscriptEl = figureEl.querySelector('noscript');
    if (noscriptEl && noscriptEl.textContent) {
      const parsedDoc = new DOMParser().parseFromString(noscriptEl.textContent, 'text/html');
      const nsImg = parsedDoc.querySelector('img');
      if (nsImg) {
        const nsSrc =
          pickHighestResFromSrcset(nsImg.getAttribute('srcset')) ||
          nsImg.getAttribute('src');
        if (nsSrc) {
          try {
            return upgradeMediumImageUrl(new URL(nsSrc, window.location.href).href);
          } catch (_) {}
        }
      }
    }

    // 4. Last fallback: even if only a blurred Medium URL was loaded, upgrade its resolution URL!
    for (const imgEl of imgs) {
      const rawSrc = imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src');
      if (rawSrc && rawSrc.includes('miro.medium.com')) {
        try {
          const abs = new URL(rawSrc, window.location.href).href.replace(/\?q=20$/, '');
          return upgradeMediumImageUrl(abs);
        } catch (_) {}
      }
    }

    return null;
  }

  function resolveBestImageUrl(imgEl, pictureEl) {
    if (imgEl && imgEl.closest('figure')) {
      return resolveBestImageUrlFromFigure(imgEl.closest('figure'));
    }

    let bestUrl = null;
    if (pictureEl) {
      const sources = Array.from(pictureEl.querySelectorAll('source[srcset]'));
      for (const source of sources) {
        const candidate = pickHighestResFromSrcset(source.getAttribute('srcset'));
        if (candidate) {
          bestUrl = candidate;
          break;
        }
      }
    }

    if (!bestUrl && imgEl) {
      bestUrl =
        pickHighestResFromSrcset(imgEl.getAttribute('srcset')) ||
        pickHighestResFromSrcset(imgEl.getAttribute('data-srcset'));
    }

    if (!bestUrl && imgEl) {
      bestUrl =
        imgEl.getAttribute('data-src') ||
        imgEl.getAttribute('data-original') ||
        imgEl.currentSrc ||
        imgEl.src ||
        imgEl.getAttribute('src');
    }

    if (!bestUrl || isBlurPlaceholderUrl(bestUrl)) return null;

    try {
      bestUrl = new URL(bestUrl, window.location.href).href;
    } catch (_) {
      return null;
    }

    return upgradeMediumImageUrl(bestUrl);
  }

  function isNoiseOrAvatarImage(imgEl) {
    if (!imgEl) return true;
    const src = (imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src') || '').toLowerCase();

    if (!src || src.startsWith('data:image/svg') || src.includes('stat?event=')) {
      return true;
    }

    const rect = imgEl.getBoundingClientRect();
    const naturalW = imgEl.naturalWidth || 0;
    const naturalH = imgEl.naturalHeight || 0;
    const attrW = parseInt(imgEl.getAttribute('width') || '0', 10);
    const attrH = parseInt(imgEl.getAttribute('height') || '0', 10);

    // Filter out tiny avatars / icons (< 64px) unless inside an article <figure>
    const inFigure = Boolean(imgEl.closest('figure'));
    if (
      !inFigure &&
      ((attrW > 0 && attrW <= 64 && attrH > 0 && attrH <= 64) ||
        (rect.width > 0 && rect.width <= 56 && rect.height > 0 && rect.height <= 56) ||
        (naturalW > 0 && naturalW <= 56 && naturalH > 0 && naturalH <= 56))
    ) {
      return true;
    }

    // Medium author avatar resize:fill patterns
    if (
      src.includes('/resize:fill:88:88/') ||
      src.includes('/resize:fill:48:48/') ||
      src.includes('/resize:fill:64:64/') ||
      src.includes('/resize:fill:96:96/') ||
      src.includes('/resize:fill:128:128/')
    ) {
      return true;
    }

    if (
      imgEl.closest(
        'nav, header, footer, button, [data-testid="authorPhoto"], [data-testid="authorName"], [rel="author"]'
      )
    ) {
      return true;
    }

    return false;
  }

  function isMediumAuthorOrActionBar(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    if (
      node.querySelector('[data-testid="authorName"]') ||
      node.querySelector('[data-testid="authorPhoto"]') ||
      node.querySelector('[data-testid="audioPlayButton"]') ||
      node.querySelector('[data-testid="headerSocialShareButton"]')
    ) {
      // Only treat this node as an author/action bar if it doesn't contain main story paragraphs
      const paragraphCount = node.querySelectorAll('p.pw-post-body-paragraph, figure, pre, h2, h3').length;
      if (paragraphCount === 0) {
        return true;
      }
    }
    return false;
  }

  function findArticleContainer() {
    const articleEl = document.querySelector('article');
    if (articleEl && articleEl.innerText.trim().length > 150) {
      return articleEl;
    }

    const selectors = [
      '[role="main"] article',
      '.postArticle-content',
      '[itemprop="articleBody"]',
      '.article-content',
      '.post-content',
      '.entry-content',
      'main',
      '[role="main"]'
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText.trim().length > 150) {
        return el;
      }
    }

    return document.body;
  }

  function extractArticle(mode = 'auto') {
    const pageTitle =
      document.querySelector('article h1[data-testid="storyTitle"], article h1, h1')?.innerText?.trim() ||
      document.title.replace(/\s*\|\s*by .*$/, '').replace(/\s*-\s*Medium$/, '').trim();

    let rootNode = null;
    if (mode === 'selection') {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return {
          ok: false,
          error: '請先在 Medium 網頁上反白選取要擷取的文章段落與圖片！'
        };
      }
      const wrapper = document.createElement('div');
      for (let i = 0; i < selection.rangeCount; i++) {
        wrapper.appendChild(selection.getRangeAt(i).cloneContents());
      }
      rootNode = wrapper;
    } else {
      rootNode = findArticleContainer();
    }

    const images = [];
    const seenUrls = new Map();
    const processedFigures = new WeakSet();
    const processedImgNodes = new WeakSet();

    function registerImageUrl(bestUrl, rawAltText = '', captionText = '') {
      if (!bestUrl) return null;

      if (seenUrls.has(bestUrl)) {
        const existing = seenUrls.get(bestUrl);
        const rawRepeatAlt = (captionText || rawAltText || existing.alt || `圖片 ${existing.index}`).trim();
        const cleanRepeatAlt = rawRepeatAlt.replace(/[\r\n\[\]]+/g, ' ').trim() || existing.alt;
        // Share the stored image entry, but return the placeholder metadata so repeated occurrences remain in the article
        return {
          id: existing.id,
          alt: cleanRepeatAlt,
          caption: captionText.trim(),
          reused: true
        };
      }

      const index = images.length + 1;
      const id = `IMG_${index}`;
      const rawAlt = (captionText || rawAltText || `圖片 ${index}`).trim();
      const cleanAlt = rawAlt.replace(/[\r\n\[\]]+/g, ' ').trim() || `圖片 ${index}`;

      let ext = 'png';
      const extMatch = bestUrl.match(/\.(jpe?g|png|webp|gif)(?:[?#]|$)/i);
      if (extMatch) ext = extMatch[1].toLowerCase();

      images.push({
        id,
        index,
        originalUrl: bestUrl,
        alt: cleanAlt,
        caption: captionText.trim(),
        filename: `image_${index}.${ext}`
      });

      seenUrls.set(bestUrl, { id, index, alt: cleanAlt });
      return { id, alt: cleanAlt, caption: captionText.trim(), reused: false };
    }

    function serializeInline(node) {
      if (!node) return '';
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\s+/g, ' ');
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return '';

      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'button', 'nav', 'footer'].includes(tag)) {
        return '';
      }

      if (tag === 'br') return '\n';

      if (tag === 'code' && (!node.parentElement || node.parentElement.tagName.toLowerCase() !== 'pre')) {
        const txt = node.textContent.trim();
        return txt ? `\`${txt}\`` : '';
      }

      if (tag === 'strong' || tag === 'b') {
        const inner = Array.from(node.childNodes).map(serializeInline).join('').trim();
        return inner ? `**${inner}**` : '';
      }

      if (tag === 'em' || tag === 'i') {
        const inner = Array.from(node.childNodes).map(serializeInline).join('').trim();
        return inner ? `*${inner}*` : '';
      }

      if (tag === 'a') {
        const href = node.getAttribute('href');
        const inner = Array.from(node.childNodes).map(serializeInline).join('').trim();
        if (!inner) return '';
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return inner;
        try {
          const absUrl = new URL(href, window.location.href).href;
          return `[${inner}](${absUrl})`;
        } catch (_) {
          return inner;
        }
      }

      if (tag === 'img') {
        if (processedImgNodes.has(node)) return '';
        if (mode !== 'selection' && isNoiseOrAvatarImage(node)) return '';
        processedImgNodes.add(node);
        const bestUrl = resolveBestImageUrl(node, node.closest('picture'));
        const reg = registerImageUrl(bestUrl, node.getAttribute('alt') || '');
        if (!reg) return '';
        return `\n\n![${reg.alt}]({{${reg.id}}})\n\n`;
      }

      return Array.from(node.childNodes).map(serializeInline).join('');
    }

    const blocks = [];

    function walkBlock(node) {
      if (!node) return;
      if (node.nodeType === Node.TEXT_NODE) {
        const txt = node.textContent.trim();
        if (txt) blocks.push(txt);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      const tag = node.tagName.toLowerCase();

      if (
        ['script', 'style', 'noscript', 'svg', 'nav', 'footer', 'button', 'aside', 'form'].includes(tag) ||
        node.getAttribute('aria-hidden') === 'true'
      ) {
        return;
      }

      if (mode !== 'selection' && isMediumAuthorOrActionBar(node)) {
        return;
      }

      // Handle <figure> (Medium standard image / code / embed container)
      if (tag === 'figure') {
        if (processedFigures.has(node)) return;
        processedFigures.add(node);

        const preEl = node.querySelector('pre');
        if (preEl) {
          walkBlock(preEl);
          return;
        }

        const figcaptionEl = node.querySelector('figcaption');
        const captionText = figcaptionEl ? figcaptionEl.innerText.trim() : '';
        const firstImg = node.querySelector('img');
        const altText = firstImg ? firstImg.getAttribute('alt') || '' : '';

        // Mark all imgs inside this figure as processed
        node.querySelectorAll('img').forEach((img) => processedImgNodes.add(img));

        const bestUrl = resolveBestImageUrlFromFigure(node);
        const reg = registerImageUrl(bestUrl, altText, captionText);
        if (reg) {
          let md = `![${reg.alt}]({{${reg.id}}})`;
          if (captionText) {
            md += `\n*${captionText}*`;
          }
          blocks.push(md);
        }
        return;
      }

      if (tag === 'picture') {
        const imgEl = node.querySelector('img');
        if (imgEl && !processedImgNodes.has(imgEl)) {
          if (mode === 'selection' || !isNoiseOrAvatarImage(imgEl)) {
            processedImgNodes.add(imgEl);
            const bestUrl = resolveBestImageUrl(imgEl, node);
            const reg = registerImageUrl(bestUrl, imgEl.getAttribute('alt') || '');
            if (reg) {
              blocks.push(`![${reg.alt}]({{${reg.id}}})`);
            }
          }
        }
        return;
      }

      if (tag === 'img') {
        if (!processedImgNodes.has(node)) {
          if (mode === 'selection' || !isNoiseOrAvatarImage(node)) {
            processedImgNodes.add(node);
            const bestUrl = resolveBestImageUrl(node, null);
            const reg = registerImageUrl(bestUrl, node.getAttribute('alt') || '');
            if (reg) {
              blocks.push(`![${reg.alt}]({{${reg.id}}})`);
            }
          }
        }
        return;
      }

      if (/^h[1-6]$/.test(tag)) {
        const level = parseInt(tag[1], 10);
        const text = node.innerText.replace(/\s+/g, ' ').trim();
        if (text) {
          blocks.push(`${'#'.repeat(level)} ${text}`);
        }
        return;
      }

      if (tag === 'p') {
        const inlineMd = serializeInline(node).trim();
        if (inlineMd) {
          blocks.push(inlineMd);
        }
        return;
      }

      if (tag === 'blockquote') {
        const text = node.innerText.trim();
        if (text) {
          const quoted = text
            .split('\n')
            .map((line) => `> ${line.trim()}`)
            .join('\n');
          blocks.push(quoted);
        }
        return;
      }

      if (tag === 'pre') {
        const codeText = node.innerText.replace(/\r\n/g, '\n').trimEnd();
        if (codeText.trim()) {
          const codeEl = node.querySelector('code');
          let lang = '';
          if (codeEl && codeEl.className) {
            const m = codeEl.className.match(/language-([a-zA-Z0-9_-]+)/);
            if (m) lang = m[1];
          }
          blocks.push(`\`\`\`${lang}\n${codeText}\n\`\`\``);
        }
        return;
      }

      if (tag === 'ul' || tag === 'ol') {
        const isOrdered = tag === 'ol';
        const items = Array.from(node.querySelectorAll(':scope > li'));
        const listLines = items
          .map((li, idx) => {
            const prefix = isOrdered ? `${idx + 1}. ` : '- ';
            const content = serializeInline(li).replace(/\n+/g, ' ').trim();
            return content ? `${prefix}${content}` : '';
          })
          .filter(Boolean);
        if (listLines.length > 0) {
          blocks.push(listLines.join('\n'));
        }
        return;
      }

      if (tag === 'hr') {
        blocks.push('---');
        return;
      }

      for (const child of Array.from(node.childNodes)) {
        walkBlock(child);
      }
    }

    walkBlock(rootNode);

    let rawContent = blocks
      .map((b) => b.trim())
      .filter(Boolean)
      .join('\n\n');

    if (!rawContent.startsWith(`# `)) {
      rawContent = `# ${pageTitle}\n\n${rawContent}`;
    }

    return {
      ok: true,
      title: pageTitle || '未命名 Medium 文章',
      sourceUrl: window.location.href,
      rawContent,
      images
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'EXTRACT_ARTICLE') {
      try {
        const result = extractArticle(message.mode || 'auto');
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: err.message || String(err) });
      }
      return true;
    }
  });
})();
