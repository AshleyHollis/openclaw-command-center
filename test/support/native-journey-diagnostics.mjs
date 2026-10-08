import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Private isolated-fixture evidence only. Never retain HTML, URL fragments,
// input values, cookies, storage, network bodies or native session keys.
export async function retainNativeJourneyDiagnostics(page, directory, name) {
  if (!page || !directory) return;
  const status = { schemaVersion: 1, name, dom: 'unavailable', screenshot: 'unavailable' };
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let timer;
    try {
      const inventory = await Promise.race([
        page.evaluate(() => {
          const controls = []; const owners = []; let truncated = false; let visited = 0;
          const ids = new WeakMap(); let nextId = 0;
          const id = element => { if (!ids.has(element)) ids.set(element, ++nextId); return ids.get(element); };
          const walk = (root, owner, parentId = null) => {
            for (const element of root.children ?? []) {
              if (++visited > 5_000 || controls.length + owners.length >= 500) { truncated = true; return; }
              const tag = element.localName;
              const nodeId = id(element);
              const region = /^[a-z-]{1,40}$/.test(element.getAttribute('data-region') ?? '') ? element.getAttribute('data-region') : null;
              const structural = tag.startsWith('openclaw-') || ['dialog', 'wa-dialog', 'slot'].includes(tag) || region !== null;
              const currentOwner = structural ? { tag, nodeId } : owner;
              const rect = element.getBoundingClientRect();
              const visible = rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== 'hidden';
              if (structural) owners.push({ tag, nodeId, parentId, owner: owner?.tag ?? null, ownerNodeId: owner?.nodeId ?? null, visible,
                ariaHidden: element.getAttribute('aria-hidden'),
                region,
                assigned: tag === 'slot' ? element.assignedElements().slice(0, 20).map(assigned => ({ tag: assigned.localName, nodeId: id(assigned) })) : undefined,
                bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
                scroll: { top: element.scrollTop, left: element.scrollLeft } });
              const role = element.getAttribute('role');
              if (visible && (['button', 'a', 'summary', 'input', 'textarea', 'select'].includes(tag) || role)) {
                controls.push({ tag, role, nodeId, parentId, owner: currentOwner?.tag ?? null, ownerNodeId: currentOwner?.nodeId ?? null,
                  label: (element.getAttribute('aria-label') ?? '').slice(0, 160),
                  text: !element.isContentEditable && (['button', 'a', 'summary'].includes(tag) || ['button', 'link', 'menuitem', 'heading'].includes(role)) ? (element.innerText ?? '').slice(0, 160) : '',
                  expanded: element.getAttribute('aria-expanded'), selected: element.getAttribute('aria-selected'),
                  disabled: element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true',
                  focused: element.matches(':focus'),
                  bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } });
              }
              if (element.shadowRoot) walk(element.shadowRoot, currentOwner, nodeId);
              walk(element, currentOwner, nodeId);
            }
          };
          walk(document, null);
          return { schemaVersion: 1, viewport: { width: innerWidth, height: innerHeight }, owners, controls, truncated };
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Diagnostic DOM deadline')), 1_000); })
      ]);
      await writeFile(path.join(directory, `${name}-dom.json`), `${JSON.stringify(inventory)}\n`, { mode: 0o600 });
      status.dom = 'retained';
    } catch { status.dom = 'failed'; }
    finally { clearTimeout(timer); }
    try {
      const screenshot = await page.screenshot({ fullPage: false, timeout: 2_000,
        mask: [page.locator('input, textarea, [contenteditable]')] });
      await writeFile(path.join(directory, `${name}.png`), screenshot, { mode: 0o600 });
      status.screenshot = 'retained';
    } catch { status.screenshot = 'failed'; }
    await writeFile(path.join(directory, `${name}-capture.json`), `${JSON.stringify(status)}\n`, { mode: 0o600 });
  } catch { /* Diagnosis must not replace the original failure or cleanup. */ }
}
