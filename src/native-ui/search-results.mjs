// The native Topic page owns this renderer. Search projections provide display
// text only; opening a result still goes through the authoritative owners.
const display = (value, limit = 500) => Array.from(String(value ?? '').replace(/[\u0000-\u001f]+/gu, ' ').trim()).slice(0, limit).join('');

export function renderGroupedSearchResults(container, grouped, { openNote, openConversation } = {}) {
  const document = container.ownerDocument;
  const make = (tag, value, limit) => { const node = document.createElement(tag); node.textContent = display(value, limit); return node; };
  const fragment = document.createDocumentFragment();
  for (const [key, label] of [['notes', 'Notes'], ['conversations', 'Conversations']]) {
    const section = document.createElement('section'); section.setAttribute('aria-label', label); section.dataset.searchGroup = key;
    section.append(make('h3', label));
    const results = grouped?.[key]?.results;
    if (!Array.isArray(results)) throw new TypeError('Grouped Search results are incomplete.');
    for (const result of results.slice(0, 100)) {
      const article = document.createElement('article'); article.style.overflowWrap = 'anywhere'; article.style.minInlineSize = '0';
      if (key === 'notes') {
        article.append(make('strong', result.heading || result.path || 'Untitled Note'));
        if (result.heading && result.path) article.append(make('p', result.path));
      } else {
        article.append(make('strong', result.conversationName || 'Conversation'));
        const provenance = [result.date, result.provenance?.role, result.provenance?.status, result.provenance?.importedPrimaryHistory ? 'Imported history' : ''].filter(Boolean).join(' · ');
        if (provenance) article.append(make('p', provenance));
      }
      if (result.contextBefore) article.append(make('p', result.contextBefore, 300));
      article.append(make('p', result.snippet, 240));
      if (result.contextAfter) article.append(make('p', result.contextAfter, 300));
      const button = make('button', key === 'notes' ? 'Open Note' : 'Open Conversation'); button.type = 'button';
      button.addEventListener('click', () => key === 'notes' ? openNote?.(result.navigation) : openConversation?.(result.navigation));
      article.append(button); section.append(article);
    }
    fragment.append(section);
  }
  container.replaceChildren(fragment);
}
