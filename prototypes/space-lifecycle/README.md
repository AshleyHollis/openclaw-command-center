# Space lifecycle prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three structurally different interaction models for Space creation, one-time legacy migration, and gated Space Gardening. Variants and scenarios are URL-stable and switchable from the fixed prototype bar.

- `?variant=A&scenario=create` — **Guided conversation**: name the Space, then answer the one required PARA Category question.
- `?variant=B&scenario=create` — **Quick form**: enter the Space name and PARA Category together, then create immediately.
- `?variant=C&scenario=create` — **Compact proposal**: confirm the two essentials while automatic defaults remain optionally inspectable.

Routine creation follows the default convention: Command Center derives the Note Folder and Primary Session from the Space name. Exact-match adoption or naming conflicts appear only as exceptions; source binding is not a normal creation decision.

Use `scenario=create`, `scenario=migrate`, or `scenario=garden` to compare the same lifecycle moment across variants.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-lifecycle\serve.ps1
```

Then open <http://localhost:4175/?variant=A&scenario=create>.

All content is fictional. No live OpenClaw or Obsidian state is read. State is in memory and resets on refresh.
