# Space Page prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three original responsive Space Page layouts plus one feedback-driven synthesis, switchable with the fixed prototype bar or the left/right arrow keys:

- `?variant=A` — **Conversation studio**: conversation history, Chat, and the current Note are three persistent desktop columns.
- `?variant=B` — **Working notebook**: the Note is the main canvas; Chat is a companion panel and conversation history is tucked into a drawer.
- `?variant=C` — **Conversation timeline**: chronological conversation history is the orienting surface; the selected Chat and current Note share a workbench.
- `?variant=D` — **Flexible workspace**: C's visual language without the timeline, a searchable conversation browser, central Chat, structured Note references, and independently closed/open/focused conversation and Note panes. Focused Notes uses a visibly multi-level Obsidian-like folder tree, searchable Note list, and large editable Markdown canvas with preview mode.

Every mobile variant becomes a single-surface view with explicit Chat, Notes, conversation, and Search tabs. The tab order and default surface preserve each variant's hierarchy: Chat first in A and D, Notes first in B, and History first in C.

Variant D reflects the migration discussion: one Discord channel maps to one Space, Primary Session, and Note Folder; its text transcript is shown as imported Primary Session history with provenance preserved. Binary attachment copying and indexing remain deferred.

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-page\serve.ps1
```

The script starts at the issue-specific port `4206` and automatically advances to the next free port if another prototype is using it. Open the URL printed in the terminal. To request a different starting port:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\space-page\serve.ps1 -Port 4300
```

All content is fictional. State is in memory and resets on refresh.
