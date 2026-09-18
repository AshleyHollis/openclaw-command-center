import assert from 'node:assert/strict';
import test from 'node:test';
import { renderMarkdown } from '../src/ui/markdown.js';

test('Markdown preview renders the supported basic syntax deterministically', () => {
  const source = '# Heading\n\nA **strong** and *emphasized* `token`.\n\n- one\n- two\n\n> quoted\n\n```js\nconst value = 1;\n```\n\n[Safe](https://fictional.invalid/docs)';
  const rendered = renderMarkdown(source);
  assert.match(rendered, /<h1>Heading<\/h1>/u);
  assert.match(rendered, /<strong>strong<\/strong>/u);
  assert.match(rendered, /<em>emphasized<\/em>/u);
  assert.match(rendered, /<code>token<\/code>/u);
  assert.match(rendered, /<ul><li>one<\/li><li>two<\/li><\/ul>/u);
  assert.doesNotMatch(rendered, /<blockquote>/u);
  assert.match(rendered, /&gt; quoted/u);
  assert.match(rendered, /<pre><code>const value = 1;<\/code><\/pre>/u);
  assert.match(rendered, /href="https:\/\/fictional\.invalid\/docs"/u);
  assert.equal(rendered, renderMarkdown(source));
  assert.match(renderMarkdown(source, { headingOffset: 4 }), /<h5>Heading<\/h5>/u);
});

test('Markdown preview keeps HTML, images, and unsafe links inert', () => {
  const rendered = renderMarkdown('<script>alert(1)</script>\n\n[javascript](javascript:alert(1))\n\n![tracking](https://fictional.invalid/pixel)\n\n[data](data:text/html,unsafe)\n\n~~unknown syntax remains~~');
  assert.doesNotMatch(rendered, /<script|<img|onerror|javascript:|data:/iu);
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(rendered, /javascript/u);
  assert.match(rendered, /<p>data<\/p>/u);
  assert.match(rendered, /~~unknown syntax remains~~/u);
});

test('Markdown preview allows the frozen safe link targets only', () => {
  const rendered = renderMarkdown('[http](http://fictional.invalid) [relative](guides/topic.md) [root](/topics/one) [fragment](#details) [protocol-relative](//fictional.invalid) [script](javascript:alert(1)) [data](data:text/plain,unsafe)');
  for (const href of ['http://fictional.invalid', 'guides/topic.md', '/topics/one', '#details']) assert.match(rendered, new RegExp(`href="${href.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}"`, 'u'));
  assert.doesNotMatch(rendered, /href="(?:\/\/|javascript:|data:)/iu);
});

test('Markdown preview handles an 8 MiB-plus-newline fictional document without source truncation', () => {
  const prefix = '# Large Note\n\n';
  const marker = 'END-MARKER';
  const source = `${prefix}${'x'.repeat(8 * 1024 * 1024 - prefix.length - marker.length)}${marker}\n`;
  const rendered = renderMarkdown(source);
  assert.equal(source.length, 8 * 1024 * 1024 + 1);
  assert.equal(source.endsWith('\n'), true);
  assert.match(rendered, /<h1>Large Note<\/h1>/u);
  assert.ok(rendered.includes(marker));
  assert.equal(source.endsWith(`${marker}\n`), true);
});
