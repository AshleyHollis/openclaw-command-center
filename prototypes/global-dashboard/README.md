# Global Dashboard prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three structurally different Global Dashboard variants, switchable with the fixed prototype bar or the left/right arrow keys:

- `?variant=A` — **Triage stack**: scan and clear a compact attention inbox.
- `?variant=B` — **Focus desk**: select one Attention Item and work it in a detail pane.
- `?variant=C` — **Command canvas**: orient by Spaces first, with a concise action strip above.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\global-dashboard\serve.ps1
```

Then open <http://localhost:4173/?variant=A>.

All content is fictional. State is in memory and resets on refresh.
