export const attentionStyles = `
  .cc-command-center-page {
    --cc-accent: #315f43;
    --cc-accent-strong: #244a34;
    --cc-accent-soft: color-mix(in srgb, var(--cc-accent) 11%, Canvas);
    --cc-warm-soft: color-mix(in srgb, #b98848 11%, Canvas);
    --cc-purple-soft: color-mix(in srgb, #8063a8 11%, Canvas);
    --cc-line: color-mix(in srgb, CanvasText 13%, transparent);
    --cc-line-strong: color-mix(in srgb, CanvasText 22%, transparent);
    --cc-muted: color-mix(in srgb, CanvasText 62%, Canvas);
    --cc-panel: color-mix(in srgb, Canvas 97%, CanvasText 3%);
    --cc-shadow: 0 8px 28px color-mix(in srgb, CanvasText 7%, transparent);
    box-sizing: border-box;
    color: CanvasText;
    container-type: inline-size;
    max-width: 118rem;
    margin-inline: auto;
    padding: clamp(1rem, 2.4vw, 2.25rem);
  }
  .cc-command-center-page *, .cc-command-center-page *::before, .cc-command-center-page *::after { box-sizing: border-box; }
  .cc-command-center-page [hidden] { display:none!important; }
  .cc-command-center-page button, .cc-command-center-page input, .cc-command-center-page select, .cc-command-center-page textarea { font: inherit; }
  .cc-command-center-page button, .cc-command-center-page summary, .cc-command-center-page select { cursor: pointer; }
  .cc-command-center-page button:focus-visible, .cc-command-center-page summary:focus-visible, .cc-command-center-page input:focus-visible, .cc-command-center-page select:focus-visible, .cc-command-center-page textarea:focus-visible, .cc-command-center-page a:focus-visible { outline: 3px solid color-mix(in srgb, var(--cc-accent) 58%, transparent); outline-offset: 3px; }
  .cc-page-head { display:flex; justify-content:space-between; align-items:flex-end; gap:1.25rem; margin-block-end:1.35rem; }
  .cc-title-group { min-width:0; }
  .cc-eyebrow { margin:0 0 .45rem; color:var(--cc-accent); font-size:.72rem; font-weight:750; letter-spacing:.11em; text-transform:uppercase; }
  .cc-command-center-page h1 { margin:0; font-size:clamp(1.8rem, 3vw, 2.7rem); line-height:1.05; letter-spacing:-.035em; }
  .cc-subtitle { max-width:46rem; margin:.65rem 0 0; color:var(--cc-muted); font-size:.92rem; line-height:1.55; }
  .cc-toolbar { display:flex; gap:.55rem; flex-wrap:wrap; align-items:center; justify-content:flex-end; }
  .cc-command-center-page button { min-height:2.65rem; padding:.62rem .9rem; border:1px solid var(--cc-line); border-radius:.65rem; background:Canvas; color:CanvasText; font-weight:650; }
  .cc-command-center-page button:hover { border-color:var(--cc-line-strong); background:var(--cc-accent-soft); }
  .cc-command-center-page button:disabled { cursor:not-allowed; opacity:.55; }
  .cc-toolbar button:last-of-type { background:var(--cc-accent); border-color:var(--cc-accent); color:white; }
  .cc-toolbar>[data-selected-document-intake] { position:relative; }
  .cc-toolbar>[data-selected-document-intake]>summary { min-height:2.65rem; display:flex; align-items:center; padding:.62rem .85rem; border:1px solid var(--cc-line); border-radius:.65rem; font-weight:650; list-style:none; }
  .cc-toolbar>[data-selected-document-intake]>summary::-webkit-details-marker { display:none; }
  .cc-toolbar>[data-selected-document-intake][open] { flex-basis:100%; width:min(42rem, 100%); padding:.9rem; border:1px solid var(--cc-line); border-radius:.75rem; background:var(--cc-panel); }
  .cc-toolbar>[data-selected-document-intake][open]>summary { margin-block-end:.65rem; }
  .cc-status { min-height:1.4rem; margin:.25rem 0 1rem; color:var(--cc-muted); font-size:.82rem; }
  .cc-status:not(:empty) { padding:.7rem .9rem; border-left:3px solid var(--cc-accent); border-radius:.25rem .55rem .55rem .25rem; background:var(--cc-accent-soft); }
  .cc-workspace { display:grid; grid-template-columns:minmax(0, 3fr) minmax(19rem, 2fr); gap:clamp(1rem, 2vw, 2rem); align-items:start; }
  .cc-workspace[data-page-mode="planner"] { grid-template-columns:minmax(0, 1fr); }
  .cc-focus, .cc-dashboards { min-width:0; display:grid; gap:1rem; align-content:start; }
  .cc-zone-head { display:flex; justify-content:space-between; align-items:baseline; gap:1rem; padding-inline:.2rem; }
  .cc-zone-head h2 { margin:0; font-size:1rem; letter-spacing:.01em; }
  .cc-zone-head p { margin:0; color:var(--cc-muted); font-size:.76rem; }
  .cc-module, .cc-focus>details, .cc-dashboards>details, .cc-open-loop-summary { min-width:0; border:1px solid var(--cc-line); border-radius:1rem; padding:1rem; background:var(--cc-panel); box-shadow:var(--cc-shadow); }
  .cc-module h2, .cc-module h3, .cc-module h4 { margin-block-start:0; }
  .cc-module>p { color:var(--cc-muted); line-height:1.5; }
  .cc-module>summary, .cc-focus>details>summary, .cc-dashboards>details>summary { padding:.15rem; font-weight:720; }
  .cc-kicker { margin:0 0 .35rem; color:var(--cc-accent); font-size:.7rem; font-weight:750; letter-spacing:.1em; text-transform:uppercase; }
  .cc-quick-capture { border-color:color-mix(in srgb, var(--cc-accent) 32%, transparent); background:linear-gradient(145deg, var(--cc-accent-soft), var(--cc-panel)); }
  .cc-quick-capture form { display:grid; grid-template-columns:minmax(6.5rem,.65fr) minmax(9rem,1fr) minmax(13rem,2fr) auto; gap:.65rem; align-items:end; }
  .cc-command-center-page label { display:grid; gap:.35rem; color:var(--cc-muted); font-size:.75rem; font-weight:650; }
  .cc-command-center-page input, .cc-command-center-page select, .cc-command-center-page textarea { min-width:0; min-height:2.65rem; padding:.62rem .7rem; border:1px solid var(--cc-line-strong); border-radius:.55rem; background:Canvas; color:CanvasText; }
  .cc-command-center-page textarea { min-height:5rem; resize:vertical; }
  .cc-work-card, .cc-open-loop-card, .cc-activity-card, .cc-coverage-card { position:relative; margin:.65rem 0 0; padding:1rem; border:1px solid var(--cc-line); border-radius:.85rem; background:Canvas; box-shadow:0 2px 10px color-mix(in srgb, CanvasText 4%, transparent); }
  .cc-work-card { border-inline-start:4px solid var(--cc-accent); }
  .cc-open-loop-card[data-loop-kind="payment"] { border-inline-start:4px solid #b97836; }
  .cc-open-loop-card[data-loop-kind="decision"] { border-inline-start:4px solid #8063a8; }
  .cc-open-loop-card[data-loop-kind="response"] { border-inline-start:4px solid #4b7891; }
  .cc-work-card h3, .cc-open-loop-card h4 { margin:0 0 .45rem; font-size:.98rem; line-height:1.35; }
  .cc-work-card>p, .cc-open-loop-card>p, .cc-activity-card>p, .cc-coverage-card>p { margin:.35rem 0; color:var(--cc-muted); font-size:.78rem; line-height:1.5; }
  .cc-work-card form { display:flex; flex-wrap:wrap; gap:.55rem; align-items:end; margin-block-start:.8rem; padding-block-start:.75rem; border-block-start:1px solid var(--cc-line); }
  .cc-work-card form label { min-width:8.5rem; flex:1; }
  .cc-work-card form button { min-width:4.5rem; }
  .cc-card-actions { margin-block-start:.7rem; }
  .cc-card-actions>summary { color:var(--cc-accent); font-size:.76rem; font-weight:700; }
  .cc-open-loop-card>button { margin-block-start:.7rem; background:var(--cc-accent); border-color:var(--cc-accent); color:white; }
  .cc-open-loop-card>details { margin-block-start:.7rem; padding:.7rem; border:1px solid var(--cc-line); border-radius:.65rem; background:var(--cc-panel); }
  .cc-empty { margin:0; padding:1rem; border:1px dashed var(--cc-line-strong); border-radius:.8rem; background:var(--cc-accent-soft); color:var(--cc-muted); line-height:1.5; }
  .cc-disconnected { max-width:46rem; padding:1.2rem; border:1px solid color-mix(in srgb, #b97836 35%, transparent); border-radius:.9rem; background:var(--cc-warm-soft); }
  .cc-disconnected h2 { margin:0 0 .45rem; font-size:1.05rem; }
  .cc-disconnected p { margin:0; color:var(--cc-muted); line-height:1.55; }
  .cc-topic-widget { background:linear-gradient(145deg, var(--cc-warm-soft), var(--cc-panel)); }
  .cc-topic-widget .cc-widget-actions { display:flex; flex-wrap:wrap; gap:.55rem; }
  .cc-coverage-card { display:grid; grid-template-columns:minmax(6rem,.7fr) minmax(0,1.3fr); gap:.25rem .75rem; align-items:baseline; }
  .cc-coverage-card h4 { margin:0; }
  .cc-coverage-card p { margin:0; }
  .cc-coverage-note { font-size:.74rem; }
  .cc-planner-board { display:grid; grid-template-columns:repeat(5,minmax(15rem,1fr)); gap:.8rem; overflow-x:auto; padding:.75rem .15rem .35rem; scrollbar-gutter:stable; }
  .cc-planner-lane { min-width:0; min-height:16rem; max-height:68vh; overflow-y:auto; overscroll-behavior:contain; border:1px solid var(--cc-line); border-radius:.85rem; padding:.7rem; background:color-mix(in srgb, Canvas 94%, CanvasText 6%); scrollbar-gutter:stable; }
  .cc-planner-lane>h3 { position:sticky; top:0; z-index:1; margin:0; padding:.45rem; border-radius:.5rem; background:var(--cc-panel); font-size:.85rem; }
  .cc-planner-controls { display:grid; grid-template-columns:minmax(12rem,2fr) repeat(3,minmax(8rem,1fr)) auto; gap:.65rem; align-items:end; padding:1rem; border:1px solid var(--cc-line); border-radius:.9rem; background:var(--cc-panel); box-shadow:var(--cc-shadow); }
  .cc-view-switcher { display:flex; gap:.25rem; align-items:center; }
  .cc-view-switcher button { min-height:2.65rem; }
  .cc-view-switcher button[aria-pressed="true"] { background:var(--cc-accent); border-color:var(--cc-accent); color:white; }
  .cc-planner-list { display:grid; grid-template-columns:repeat(auto-fill,minmax(18rem,1fr)); gap:.75rem; }
  .cc-planner-agenda { border:1px solid var(--cc-line); border-radius:.9rem; padding:1rem; background:var(--cc-panel); }
  .cc-dashboards [data-dashboard-customize] { box-shadow:none; }
  .cc-dashboards [data-preference-section] { display:grid; grid-template-columns:minmax(0,1fr) auto auto; gap:.4rem; align-items:center; padding:.45rem 0; }
  .cc-dashboards [data-preference-section] button { min-height:2.3rem; padding:.4rem .55rem; font-size:.72rem; }
  .cc-dashboard-jump { display:none; }
  .cc-mini-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1rem; }
  .cc-command-center-page [aria-busy="true"] { opacity:.72; }
  @container (max-width: 68rem) {
    .cc-workspace { grid-template-columns:minmax(0,1fr); }
    .cc-dashboards { grid-template-columns:repeat(2,minmax(0,1fr)); }
    .cc-dashboards>.cc-zone-head, .cc-dashboards>[data-dashboard-section="topic"] { grid-column:1/-1; }
    .cc-dashboard-jump { display:inline-block; }
    .cc-planner-controls { grid-template-columns:repeat(2,minmax(0,1fr)); }
  }
  @container (max-width: 46rem) {
    .cc-page-head { align-items:flex-start; flex-direction:column; }
    .cc-toolbar { justify-content:flex-start; }
    .cc-quick-capture form, .cc-dashboards { grid-template-columns:minmax(0,1fr); }
    .cc-dashboards>.cc-zone-head, .cc-dashboards>[data-dashboard-section="topic"] { grid-column:auto; }
    .cc-work-card form { display:grid; grid-template-columns:minmax(0,1fr); }
    .cc-coverage-card { grid-template-columns:minmax(0,1fr); }
    .cc-planner-board { grid-template-columns:repeat(5,minmax(13rem,1fr)); }
    .cc-planner-controls { grid-template-columns:minmax(0,1fr); }
  }
  @media (max-width: 850px) { .cc-command-center-page { padding:1rem 1rem 1rem 3rem; } }
  @media (prefers-color-scheme: dark) {
    .cc-command-center-page { --cc-accent:#83b996; --cc-accent-strong:#9bcaaa; --cc-shadow:0 8px 28px #0004; }
    .cc-toolbar button:last-of-type, .cc-open-loop-card>button { color:#102418; }
  }
  @media (prefers-reduced-motion: reduce) { .cc-command-center-page * { scroll-behavior:auto!important; transition:none!important; } }
`;
