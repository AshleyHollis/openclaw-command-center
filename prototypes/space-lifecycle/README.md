# Space lifecycle prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three exploratory interaction models plus a resolved MVP model for Space creation, one-time legacy migration, and Space Review. Variants and scenarios are URL-stable and switchable from the fixed prototype bar.

The creation scenario now begins on the first-class **Spaces** destination. It provides a compact existing-Space selector, a browsable Space list, and a prominent **Create Space** action. Creation opens with `view=new` and returns to the list after the in-memory Space is created.

- `?variant=A&scenario=create` — **Guided conversation**: name the Space, then answer the one required PARA Category question.
- `?variant=B&scenario=create` — **Quick form**: enter the Space name and PARA Category together, then create immediately.
- `?variant=C&scenario=create` — **Compact proposal**: confirm the two essentials while automatic defaults remain optionally inspectable.
- `?variant=D&scenario=create` — **Resolved model**: a first-class Spaces list and the convention-first two-field creation flow.

Routine creation follows the default convention: Command Center derives the Note Folder and Primary Session from the Space name. Exact-match adoption or naming conflicts appear only as exceptions; source binding is not a normal creation decision.

Use `scenario=create`, `scenario=migrate`, or `scenario=review` to compare the same lifecycle moment across variants. Old `scenario=garden` links are redirected in memory to `scenario=review`.

## Resolved MVP model (Variant D)

- **Spaces and creation:** Spaces is a first-class destination for listing, selecting, opening, and creating Spaces. Routine creation asks only for the Space name and PARA Category; source conventions are automatic unless there is a conflict.
- **Initial migration:** legacy importing happens exactly once during initial setup. An incomplete migration exposes only **Resume migration** and **Review failures**. After verified success, migration controls disappear; the read-only, searchable Legacy Conversation Archive remains.
- **Space Review:** a weekly run is the default and can be rescheduled or disabled. A quiet run produces Activity only. A run with findings creates one grouped Action Card whose proposals are decided independently with **Approve**, **Adjust**, or **Keep as-is**. Snooze applies to the whole card, and approved changes wait for the final **Apply approved changes** checkpoint. The proposals are not Tasks or subtasks.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-lifecycle\serve.ps1
```

Then open <http://localhost:4175/?variant=D&scenario=review>.

All content is fictional. No live OpenClaw or Obsidian state is read. State is in memory and resets on refresh.
