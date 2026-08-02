# Space Page prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three structurally different responsive Space Page layouts, switchable with the fixed prototype bar or the left/right arrow keys:

- `?variant=A` — **Conversation studio**: conversation history, Chat, and the current Note are three persistent desktop columns.
- `?variant=B` — **Working notebook**: the Note is the main canvas; Chat is a companion panel and conversation history is tucked into a drawer.
- `?variant=C` — **Conversation timeline**: chronological conversation history is the orienting surface; the selected Chat and current Note share a workbench.

Every mobile variant becomes a single-surface view with explicit Chat, Notes, History, and Search tabs. The tab order and default surface preserve each variant's hierarchy: Chat first in A, Notes first in B, and History first in C. Space Search identifies whether each result comes from a Note, Space Conversation, or Legacy Conversation Archive.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-page\serve.ps1
```

Then open <http://localhost:4174/?variant=A>.

All content is fictional. State is in memory and resets on refresh.
