import { topicCatalogPageSize } from './topic-catalog.mjs';

function buildTree(notes) {
  const root = { folders: new Map(), files: [] };
  for (const note of notes) {
    const parts = note.path.split('/').filter(Boolean);
    let branch = root;
    for (const part of parts.slice(0, -1)) {
      if (!branch.folders.has(part)) branch.folders.set(part, { folders: new Map(), files: [] });
      branch = branch.folders.get(part);
    }
    branch.files.push(note);
  }
  return root;
}

// Keep the existing DOM for unchanged folders and files. Later cursor pages
// can then reveal new folders without replacing the focused row.
function reconcileChildren(parent, nodes) {
  const retained = new Set(nodes);
  for (const child of [...parent.children]) {
    if (!retained.has(child)) child.remove();
  }
  let current = parent.firstElementChild;
  for (const node of nodes) {
    if (node === current) current = current.nextElementSibling;
    else parent.insertBefore(node, current);
  }
}

export function createTopicFileTree(container, { sourceKindFor, onSelect, filterControl, signal }) {
  const document = container.ownerDocument;
  const element = (tag, text) => {
    const node = document.createElement(tag);
    if (text) node.textContent = text;
    return node;
  };
  let root;
  let filtered;
  let view;
  let selected;
  let expectedScroll;
  let restoreScroll;

  function createBranch(path, name) {
    const list = element('ul');
    list.className = 'topic-file-branch';
    const branch = { list, folders: new Map(), files: new Map() };
    if (!path) return branch;
    const summary = element('summary', name);
    summary.title = path;
    const details = element('details');
    details.dataset.folderPath = path;
    details.append(summary, list);
    details.addEventListener('toggle', () => {
      if (!filtered && details.isConnected) view?.folders.set(path, details.open);
    });
    const row = element('li');
    row.append(details);
    return { ...branch, details, row };
  }

  function pageControls(branch, path) {
    if (branch.pager) return branch.pager;
    const row = element('li');
    const nav = element('nav');
    nav.className = 'topic-file-pages';
    nav.setAttribute('aria-label', path ? `File pages in ${path}` : 'Root file pages');
    const status = element('span');
    status.setAttribute('role', 'status');
    const previous = element('button', 'Previous files');
    const next = element('button', 'Next files');
    previous.type = next.type = 'button';
    previous.className = next.className = 'btn btn--sm';
    previous.addEventListener('click', () => branch.turnPage(-1, next));
    next.addEventListener('click', () => branch.turnPage(1, previous));
    nav.append(status, previous, next);
    row.append(nav);
    branch.pager = { row, status, previous, next };
    return branch.pager;
  }

  function renderBranch(branch, data, path = '') {
    const nodes = [];
    const nextFolders = new Map();
    for (const [name, folder] of [...data.folders].sort(([left], [right]) => left.localeCompare(right))) {
      const childPath = path ? `${path}/${name}` : name;
      const child = branch.folders.get(name) ?? createBranch(childPath, name);
      if (!branch.folders.has(name)) child.details.open = filtered || (view?.folders.get(childPath) ?? false);
      renderBranch(child, folder, childPath);
      nextFolders.set(name, child);
      nodes.push(child.row);
    }
    branch.folders = nextFolders;

    const files = [...data.files].sort((left, right) => left.path.localeCompare(right.path));
    const lastPage = Math.max(0, Math.ceil(files.length / topicCatalogPageSize) - 1);
    const page = filtered ? 0 : Math.min(view?.filePages.get(path) ?? 0, lastPage);
    const offset = page * topicCatalogPageSize;
    const pageEnd = Math.min(offset + topicCatalogPageSize, files.length);
    if (!filtered && lastPage > 0) {
      const pager = pageControls(branch, path);
      pager.status.textContent = `Files ${offset + 1}–${pageEnd} of ${files.length}.`;
      pager.previous.disabled = page === 0;
      pager.next.disabled = page === lastPage;
      branch.turnPage = (direction, alternate) => {
        const trigger = direction > 0 ? pager.next : pager.previous;
        if (!trigger.isConnected || trigger.disabled) return;
        const hadFocus = trigger.getRootNode().activeElement === trigger;
        const nextPage = page + direction;
        if (nextPage === 0) view.filePages.delete(path);
        else view.filePages.set(path, nextPage);
        renderBranch(branch, data, path);
        if (hadFocus && trigger.disabled) alternate.focus({ preventScroll: true });
      };
      nodes.push(pager.row);
    }
    const nextFiles = new Map();
    for (const note of filtered ? files : files.slice(offset, pageEnd)) {
      let row = branch.files.get(note);
      if (!row) {
        const isDocument = sourceKindFor(note) === 'document';
        const name = note.path.split('/').filter(Boolean).at(-1);
        const button = element('button', `${name}${isDocument ? ' · original attachment' : ''}`);
        button.type = 'button';
        button.className = 'note-tree-item';
        button.dataset.path = note.path;
        button.dataset.referenceId = note.sourceReference.referenceId;
        button.setAttribute('aria-label', `${isDocument ? 'View attachment information for' : 'Read'} ${note.path}`);
        button.title = note.path;
        button.addEventListener('click', () => { if (button.isConnected) onSelect(note); });
        row = element('li');
        row.className = 'topic-file-row';
        row.append(button);
      }
      const button = row.firstElementChild;
      if (selected?.path === note.path && selected.referenceId === note.sourceReference.referenceId) button.setAttribute('aria-current', 'true');
      else button.removeAttribute('aria-current');
      nextFiles.set(note, row);
      nodes.push(row);
    }
    branch.files = nextFiles;

    reconcileChildren(branch.list, nodes);
  }

  function restoreFocus(focus, fallbackPath) {
    if (!focus || focus.isConnected) return;
    const exactFile = focus.dataset.referenceId && [...container.querySelectorAll('button[data-reference-id]')]
      .find(button => button.dataset.referenceId === focus.dataset.referenceId && button.dataset.path === focus.dataset.path);
    const folder = fallbackPath && [...container.querySelectorAll('summary[title]')].find(summary => summary.title === fallbackPath);
    const replacement = [exactFile, folder].find(node => node && node.getClientRects().length);
    (replacement ?? filterControl).focus({ preventScroll: true });
  }

  container.addEventListener('scroll', () => {
    if (!root || filtered || !view || container.scrollTop === expectedScroll) return;
    restoreScroll = undefined;
    view.scroll = container.scrollTop;
  }, { signal });

  return {
    render(notes, options) {
      const { viewState, searching, selection, complete, resetPosition = false } = options;
      const previousScroll = container.scrollTop;
      const active = container.getRootNode().activeElement;
      const focus = container.contains(active) ? active : null;
      const focusTop = focus?.getBoundingClientRect().top;
      const fallbackPath = focus?.closest('[data-folder-path]')?.dataset.folderPath;
      if (!root || searching !== filtered) {
        if (root && !filtered && view) view.scroll = restoreScroll ?? previousScroll;
        restoreScroll = searching ? undefined : viewState?.scroll;
        root = createBranch();
        container.replaceChildren(root.list);
      }
      view = viewState;
      filtered = searching;
      selected = selection;
      renderBranch(root, buildTree(notes));
      const focusOffset = focus?.isConnected ? focus.getBoundingClientRect().top - focusTop : 0;
      container.scrollTop = filtered && resetPosition ? 0 : restoreScroll ?? previousScroll + focusOffset;
      expectedScroll = container.scrollTop;
      if (!filtered && view && (complete || expectedScroll === restoreScroll)) {
        restoreScroll = undefined;
        view.scroll = expectedScroll;
      }
      restoreFocus(focus, fallbackPath);
    },
    clear() {
      if (root && !filtered && view) view.scroll = restoreScroll ?? container.scrollTop;
      root = undefined;
      view = undefined;
      container.replaceChildren();
    }
  };
}
