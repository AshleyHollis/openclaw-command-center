# Global Dashboard prototype

> PROTOTYPE — throwaway planning artifact. Do not promote this code directly to production.

Three original Global Dashboard variants plus one feedback-driven synthesis, switchable with the fixed prototype bar or the left/right arrow keys:

- `?variant=A` — **Triage stack**: scan and clear a compact attention inbox.
- `?variant=B` — **Focus desk**: select one Attention Item and work it in a detail pane.
- `?variant=C` — **Command canvas**: orient by Spaces first, with a concise action strip above.
- `?variant=D` — **Refined inbox**: a current-only Attention card list with approval-ready operational items (diagnosis, proposed remediation, side effects, and precise HITL actions), split-button snooze duration menus, aligned styled Attention and Coming Up panels, clickable details, richer future-only Reminders, and a responsive Space dropdown in the page header.

## MVP verdict

Variant D is the selected Global Dashboard direction for MVP. It combines A's separate action-card structure with C's stronger green header treatment, while keeping Attention as a scalable list rather than a compact strip.

The validated MVP contract is:

- current Attention Items and future-only Coming Up reminders remain separate;
- personal Reminders, operational items, and approval-gated proposals expose source-appropriate actions;
- operational Approval Requests arrive after OpenClaw's available investigation and state the diagnosis, proposed remediation, expected side effects, and exact HITL decision;
- approving remediation moves the item into a running state, with the verified result returning through OpenClaw Activity;
- Action Cards open richer evidence and retain flexible snooze durations;
- the Space launcher is a compact dropdown in the wide page header and a normal-flow panel on narrow screens; and
- advanced personalization, batch actions, risk visualisation, and execution-progress polish are deferred until real MVP usage provides evidence.

The prototype remains a planning artifact and must be rewritten for production. The detailed Attention state machine and policy remain owned by **Define Attention Item lifecycle, deduplication, escalation, and push policy** (#8); the final implementation boundary remains owned by **Choose the first usable MVP boundary and priority order** (#15).

Run from the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\prototypes\global-dashboard\serve.ps1
```

Then open <http://localhost:4173/?variant=A>.

All content is fictional. State is in memory and resets on refresh.
