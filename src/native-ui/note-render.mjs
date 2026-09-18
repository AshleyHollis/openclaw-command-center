import MarkdownIt from './vendor/markdown-it.mjs';
import createDOMPurify from './vendor/purify.es.mjs';

// Notes are user-authored, not UI templates. MarkdownIt never accepts raw
// HTML and DOMPurify is a second, independently maintained browser boundary
// before the rendered value reaches the DOM.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

function sanitiser(document) {
  return createDOMPurify(document.defaultView);
}

/** Render a conservative, read-only Note without enabling network-active media. */
export function renderReadOnlyMarkdown(container, text) {
  // Frontmatter is a document envelope, not a Markdown heading. Keep its raw
  // text in a collapsed disclosure: no YAML evaluation or stored-file rewrite.
  // Unterminated/oversized envelopes remain ordinary source rather than being
  // silently discarded. Source mode always receives the untouched input.
  const envelope = /^(?:\uFEFF)?---\r?\n([\s\S]{0,16384}?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(text);
  const body = envelope ? text.slice(envelope[0].length) : text;
  const clean = sanitiser(container.ownerDocument).sanitize(markdown.render(body), {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['base', 'embed', 'form', 'iframe', 'img', 'input', 'link', 'math', 'meta', 'object', 'script', 'style', 'svg', 'video', 'audio'],
    FORBID_ATTR: ['style'],
    ALLOWED_URI_REGEXP: /^(?:(?:https?):|mailto:)/iu
  });
  container.replaceChildren();
  // DOMPurify returns a string containing only the permitted inert document
  // markup. Images and other automatic remote-resource elements are removed.
  container.innerHTML = clean;
  // markdown-it terminates block output with a formatting newline. It is not
  // Note content and should not make a one-line Reading view appear changed.
  for (const child of [...container.childNodes]) {
    if (child.nodeType === container.ownerDocument.defaultView.Node.TEXT_NODE && !child.textContent.trim()) child.remove();
  }
  // Preserve a terminal plaintext newline where Markdown's block serializer
  // omits it. This keeps ordinary read-only Notes byte-faithful in their
  // visible text while Source remains the authoritative representation.
  const renderedText = container.textContent;
  if (body.startsWith(renderedText) && /^\s*$/u.test(body.slice(renderedText.length))) {
    container.append(container.ownerDocument.createTextNode(body.slice(renderedText.length)));
  }
  if (envelope) {
    const metadata = container.ownerDocument.createElement('details');
    const summary = container.ownerDocument.createElement('summary'); summary.textContent = 'Document metadata';
    const source = container.ownerDocument.createElement('pre'); source.textContent = envelope[1];
    metadata.append(summary, source); container.prepend(metadata);
  }
}
