# Batch checkpoint template

Use this as a short local handoff (aim for at most 60 lines), not a new process
engine or a duplicate issue tracker. Publish only sanitized evidence to GitHub;
keep live source details and account usage locally. Unknown fields stay unknown.

```text
Outcome / issue:
Acceptance criteria (maximum five for this batch):
Out of scope:

Repository / worktree / branch:
Starting commit / current commit / dirty changes:
Requested model:
Authorization already granted / action still requiring authorization:
Release class and affected owners:

Usage start: timestamp / limit bucket / reset timestamp / remaining percent
Agreed allowance budget and reserve: none unless explicitly agreed
Latest usage: timestamp / reset timestamp / remaining percent
Observed account delta: percentage points; concurrent usage / resets / uncertainty

Claim | affected files/owner | test or journey | platform | pass/fail/pending
Reused evidence | relevant identities | reason still valid
Required final review | commit | findings resolved / remaining

Candidate commit / build digest / archive digest:
Host identity / package run / qualification runs:
Deploy revision / backup / rollback / live verification, if in scope:

Completed and proven:
Mocked behavior / working integration / external blockers:
Remaining work:
Next exact command or action:
Local logs / issue evidence links:
```
