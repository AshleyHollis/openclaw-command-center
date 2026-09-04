const escapeHtml = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

function safeHref(value) {
  const href = String(value).trim();
  if (/^(?:https?:|mailto:)/iu.test(href)) return href;
  if (href.startsWith('#')) return href;
  return href !== '' && !href.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/iu.test(href) ? href : null;
}

function inline(value) {
  const source = String(value);
  if (!source.includes('`') && !source.includes('!') && !source.includes('[') && !source.includes('*') && !source.includes('_')) return escapeHtml(source);
  const tokens = [];
  const stash = (html) => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };
  let text = escapeHtml(source);
  text = text.replace(/`([^`\n]+)`/gu, (_, code) => stash(`<code>${code}</code>`));
  text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/gu, (_, alt) => alt);
  text = text.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+["']([^"']*)["'])?\)/gu, (_, label, rawUrl, title) => {
    const href = safeHref(rawUrl);
    return href ? stash(`<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`) : label;
  });
  text = text.replace(/\*\*([^*\n]+)\*\*/gu, '<strong>$1</strong>');
  text = text.replace(/__([^_\n]+)__/gu, '<strong>$1</strong>');
  text = text.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/gu, '<em>$1</em>');
  text = text.replace(/(?<!_)_([^_\n]+)_(?!_)/gu, '<em>$1</em>');
  return text.replace(/\u0000(\d+)\u0000/gu, (_, index) => tokens[Number(index)]);
}

function renderLines(source, { headingOffset = 0 } = {}) {
  const lines = String(source ?? '').replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const output = [];
  let paragraph = [];
  let list = null;
  let fence = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      output.push(`<p>${inline(paragraph.join('\n')).replaceAll('\n', '<br>')}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (!list) return;
    output.push(`<${list.kind}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.kind}>`);
    list = null;
  };
  const flushFence = () => {
    if (!fence) return;
    output.push(`<pre><code>${escapeHtml(fence.lines.join('\n'))}</code></pre>`);
    fence = null;
  };

  for (const line of lines) {
    if (fence) {
      if (/^\s*```/u.test(line)) flushFence();
      else fence.lines.push(line);
      continue;
    }
    const fenceMatch = /^\s*```\s*([\w-]*)\s*$/u.exec(line);
    if (fenceMatch) {
      flushParagraph(); flushList();
      fence = { lines: [], language: fenceMatch[1] };
      continue;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (heading) {
      flushParagraph(); flushList();
      const level = Math.min(6, heading[1].length + Math.max(0, headingOffset));
      output.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/u.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/u.exec(line);
    if (unordered || ordered) {
      flushParagraph();
      const kind = unordered ? 'ul' : 'ol';
      if (list?.kind !== kind) { flushList(); list = { kind, items: [] }; }
      list.items.push((unordered ?? ordered)[1]);
      continue;
    }
    if (list && line.trim() === '') { flushList(); continue; }
    if (line.trim() === '') { flushParagraph(); continue; }
    paragraph.push(line);
  }
  flushFence(); flushParagraph(); flushList();
  return output.join('');
}

export function renderMarkdown(markdown, options) {
  return renderLines(markdown, options);
}

export function renderMarkdownInto(element, markdown, options) {
  if (!element) return;
  element.innerHTML = renderMarkdown(markdown, options);
}

globalThis.CommandCenterMarkdown = { renderMarkdown, renderMarkdownInto };
