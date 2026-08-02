# Space lifecycle prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three structurally different interaction models for Space creation, one-time legacy migration, and gated Space Gardening. Variants and scenarios are URL-stable and switchable from the fixed prototype bar.

- `?variant=A&scenario=create` — **Guided conversation**: the agent asks one decision at a time while a live Space record stays visible.
- `?variant=B&scenario=create` — **Setup workbench**: the user directly configures sources and sees the resulting Space structure.
- `?variant=C&scenario=create` — **Proposal packet**: the agent prepares a complete, inspectable plan for one explicit approval.

Use `scenario=create`, `scenario=migrate`, or `scenario=garden` to compare the same lifecycle moment across variants.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-lifecycle\serve.ps1
```

Then open <http://localhost:4175/?variant=A&scenario=create>.

All content is fictional. No live OpenClaw or Obsidian state is read. State is in memory and resets on refresh.
