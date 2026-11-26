/** Scoped presentation only: native OpenClaw continues to own the outer panes. */
export function readerStyles(document) {
  const style = document.createElement('style');
  style.textContent = `
    [data-topic-reader-page] { min-inline-size:0; position:relative; }
    [data-topic-reader-page="panel"] { display:flex; flex-direction:column; block-size:100%; min-block-size:0; overflow:hidden; }
    [data-topic-reader-page] [hidden] { display:none !important; }
    [data-topic-reader-page] .reader-toolbar { display:flex; align-items:center; flex-wrap:wrap; gap:.5rem; flex:none; }
    [data-topic-reader-page] .reader-toolbar h1 { font-size:1rem; margin:0; margin-inline-end:auto; }
    [data-topic-reader-page] .reader-status { margin:.4rem 0; font-size:.85rem; }
    [data-topic-reader-page] .reader-status:empty { display:none; }
    [data-topic-reader-page] .reader-announcement { position:absolute; inline-size:1px; block-size:1px; margin:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    [data-topic-reader-page] [data-topic-notes-workspace] { display:grid; grid-template-columns:minmax(11rem,30%) minmax(0,1fr); flex:1; min-block-size:0; min-inline-size:0; overflow:hidden; gap:.75rem; block-size:65vh; }
    /* Fill the host's definite pane height in either placement. Both the
       explorer and reader keep their own bounded scrolling regions. */
    [data-topic-reader-page="panel"] [data-topic-notes-workspace] { block-size:0; flex:1 1 0; }
    [data-topic-reader-page] .reader-skip { position:absolute; inline-size:1px; block-size:1px; padding:0; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
    [data-topic-reader-page] .reader-skip:focus { inline-size:auto; block-size:auto; padding:6px 10px; clip-path:none; inset-block-start:4px; inset-inline-start:4px; z-index:5; background:var(--bg,Canvas); }
    [data-topic-reader-page] [data-topic-notes-workspace][data-files-hidden] { grid-template-columns:minmax(0,1fr); }
    [data-topic-reader-page] [data-topic-notes-workspace][data-compact] { grid-template-columns:minmax(0,1fr); }
    [data-topic-reader-page] .reader-files { display:flex; flex-direction:column; min-block-size:0; min-inline-size:0; overflow:hidden; border-inline-end:1px solid color-mix(in srgb,currentColor 20%,transparent); padding-inline-end:.5rem; }
    /* The host Files rail owns its scrolling. Give its mounting boundary a
       definite flex height so long Topic trees scroll within the retained
       Files pane instead of extending the reader document. */
    [data-topic-reader-page] [data-native-topic-files] { display:flex; flex:1 1 auto; min-block-size:0; min-inline-size:0; }
    [data-topic-reader-page] [data-native-topic-files] .control-ui-file-explorer,
    [data-topic-reader-page] [data-native-topic-files] .chat-workspace-rail { display:flex; flex:1 1 auto; min-block-size:0; min-inline-size:0; }
    [data-topic-reader-page] [data-native-topic-files] .control-ui-file-explorer { flex-direction:column; }
    [data-topic-reader-page] [data-native-topic-files] input[type="search"] { box-sizing:border-box; inline-size:100%; min-inline-size:44px; min-block-size:44px; flex:none; }
    [data-topic-reader-page] [data-native-topic-files] .chat-workspace-rail__list { list-style:none; margin:0; padding:0; }
    [data-topic-reader-page] [data-native-topic-files] [role="group"] { padding-inline-start:14px; }
    [data-topic-reader-page] [data-native-topic-files] .chat-workspace-rail__file { box-sizing:border-box; min-inline-size:44px; min-block-size:44px; }
    [data-topic-reader-page] [data-native-topic-files] summary.chat-workspace-rail__file { display:flex; align-items:center; justify-content:flex-start; gap:6px; padding:4px; list-style:none; cursor:pointer; }
    [data-topic-reader-page] [data-native-topic-files] summary::-webkit-details-marker { display:none; }
    [data-topic-reader-page] [data-native-topic-files] summary::before { content:''; flex:none; inline-size:5px; block-size:5px; border-inline-end:1px solid; border-block-end:1px solid; transform:rotate(-45deg); color:var(--muted,inherit); }
    [data-topic-reader-page] [data-native-topic-files] details[open] > summary::before { transform:rotate(45deg); }
    [data-topic-reader-page] [data-native-topic-files] .chat-workspace-rail__file-main { min-inline-size:0; flex:1; text-align:start; }
    [data-topic-reader-page] [data-native-topic-files] .chat-workspace-rail__file-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    [data-topic-reader-page] .reader-files input { box-sizing:border-box; inline-size:100%; min-block-size:44px; font:inherit; padding:.4rem; }
    [data-topic-reader-page] .reader-files p { font-size:.8rem; margin:.4rem 0; }
    [data-topic-reader-page] .reader-sync-status { flex:none; overflow-wrap:anywhere; }
    [data-topic-reader-page] [data-topic-notes] { overflow:auto; flex:1; min-block-size:0; overscroll-behavior:contain; }
    [data-topic-reader-page] .topic-file-branch { list-style:none; margin-block:0; padding-inline-start:0; }
    [data-topic-reader-page] details > .topic-file-branch { padding-inline-start:1rem; }
    [data-topic-reader-page] .topic-file-row { margin-block:2px; }
    [data-topic-reader-page] .topic-file-pages { display:flex; flex-wrap:wrap; align-items:center; gap:.25rem; margin-block:.25rem; }
    [data-topic-reader-page] .topic-file-pages span { flex:1 0 100%; font-size:.8rem; }
    [data-topic-reader-page] .topic-file-pages button { min-block-size:44px; }
    [data-topic-reader-page] [data-topic-notes] summary { box-sizing:border-box; cursor:pointer; min-inline-size:44px; min-block-size:44px; line-height:1.8; white-space:nowrap; }
    [data-topic-reader-page] .note-tree-item { display:block; box-sizing:border-box; inline-size:100%; min-inline-size:44px; min-block-size:44px; padding:.25rem .4rem; border:0; border-radius:.2rem; background:transparent; color:inherit; font:inherit; font-size:.85rem; text-align:start; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    [data-topic-reader-page] .note-tree-item:hover { background:color-mix(in srgb,currentColor 8%,transparent); }
    [data-topic-reader-page] .note-tree-item[aria-current] { background:color-mix(in srgb,currentColor 15%,transparent); font-weight:600; border-inline-start:3px solid currentColor; }
    [data-topic-reader-page] :is(button,input,summary,[tabindex]):focus-visible { outline:2px solid currentColor; outline-offset:-2px; }
    [data-topic-reader-page] .reader-document { display:flex; flex-direction:column; overflow:hidden; min-inline-size:0; min-block-size:0; }
    [data-topic-reader-page] .reader-document h2 { font-size:.95rem; margin:0 0 .5rem; overflow-wrap:anywhere; }
    [data-topic-reader-page] .reader-document-header { display:flex; align-items:center; flex-wrap:wrap; gap:.4rem; padding:.35rem .5rem; border-bottom:1px solid var(--border,color-mix(in srgb,currentColor 15%,transparent)); }
    [data-topic-reader-page] .reader-document-header h2 { margin:0; margin-inline-end:auto; }
    [data-topic-reader-page] .reader-note-actions { position:relative; }
    [data-topic-reader-page] .reader-note-actions summary { display:list-item; min-block-size:44px; align-content:center; cursor:pointer; padding-inline:.4rem; }
    [data-topic-reader-page] .reader-note-actions > button { position:absolute; z-index:2; inset-inline-end:0; inset-block-start:100%; min-block-size:44px; white-space:nowrap; background:var(--card,Canvas); }
    [data-topic-reader-page] .reader-note-suggestion { box-sizing:border-box; inline-size:min(38rem,calc(100% - 2rem)); max-block-size:calc(100% - 2rem); padding:1rem; overflow:auto; overscroll-behavior:contain; background:var(--card,Canvas); color:var(--text,CanvasText); border:1px solid var(--border,CanvasText); border-radius:.5rem; }
    [data-topic-reader-page] .reader-note-suggestion::backdrop { background:rgb(0 0 0 / 45%); }
    [data-topic-reader-page] .reader-note-suggestion > header { display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-block-end:.75rem; }
    [data-topic-reader-page] .reader-note-suggestion > header h2 { margin:0; }
    [data-topic-reader-page] .reader-note-suggestion > header button { min-block-size:44px; }
    [data-topic-reader-page] .reader-note-suggestion fieldset { min-inline-size:0; margin:0 0 .75rem; }
    [data-topic-reader-page] .reader-note-suggestion summary { cursor:pointer; padding-block:.6rem; }
    [data-topic-reader-page] .reader-note-suggestion :is(label,pre) { overflow-wrap:anywhere; }
    [data-topic-reader-page] .reader-note-suggestion input[type="text"] { box-sizing:border-box; max-inline-size:100%; }
    [data-topic-reader-page] .note-suggestion-references { max-block-size:13rem; overflow:auto; }
    [data-topic-reader-page] .note-suggestion-references label { display:flex; align-items:baseline; gap:.5rem; min-block-size:1.65rem; }
    [data-topic-reader-page] [aria-label="Note view"] { display:flex; gap:2px; }
    [data-topic-reader-page] [aria-label="Note view"] button[aria-pressed="true"] { background:var(--accent-subtle,color-mix(in srgb,currentColor 12%,transparent)); }
    [data-topic-reader-page] .reader-breadcrumb { font-size:.8rem; overflow:auto hidden; white-space:nowrap; }
    [data-topic-reader-page] .reader-breadcrumb ol { display:flex; gap:.3rem; list-style:none; margin:0 0 .35rem; padding:0; }
    [data-topic-reader-page] .reader-breadcrumb li + li::before { content:"/"; margin-inline-end:.3rem; opacity:.65; }
    [data-topic-reader-page] .reader-body { min-block-size:0; overflow:auto; overscroll-behavior:contain; flex:1; padding:.5rem; }
    [data-topic-reader-page] .reader-body article { margin:0; }
    [data-topic-reader-page] .reader-body :is(pre,table) { max-inline-size:100%; overflow:auto; }
    [data-topic-reader-page] .reader-table-scroll { max-inline-size:100%; overflow:auto; overscroll-behavior-inline:contain; margin-block:.5rem; }
    [data-topic-reader-page] .reader-table-scroll table { inline-size:max-content; min-inline-size:100%; max-inline-size:none; border-collapse:collapse; }
    [data-topic-reader-page] .reader-table-scroll :is(th,td) { box-sizing:content-box; min-inline-size:6rem; max-inline-size:24rem; padding:.5rem; overflow-wrap:break-word; word-break:normal; white-space:normal; border:1px solid color-mix(in srgb,currentColor 20%,transparent); text-align:start; vertical-align:top; }
    [data-topic-reader-page] .reader-table-scroll th { white-space:nowrap; }
    [data-topic-reader-page] .reader-footer { font-size:.75rem; margin:.4rem 0 0; flex:none; }
    [data-topic-reader-page] .reader-pane-help { font-size:.75rem; color:var(--muted,inherit); margin:.25rem 0 .4rem; flex:none; }
    [data-topic-reader-page] .reader-pane-help summary { cursor:pointer; inline-size:fit-content; }
  `;
  return style;
}
