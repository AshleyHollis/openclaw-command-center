## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues. External pull requests are not a triage request surface. See `docs/agents/issue-tracker.md`.

### Triage labels

The default five-label triage vocabulary is used. See `docs/agents/triage-labels.md`.

### Domain docs

This repository uses a single-context domain layout. See `docs/agents/domain.md`.

### Delivery policy

Classify each deployable change with `docs/agents/release-policy.md` before
choosing tests or release evidence. Use the smallest qualifying profile and
reuse still-valid host evidence. A mixed change takes the highest applicable
class; split independent presentation work from mutations when that lets useful
work ship sooner.

### Execution efficiency

Follow `docs/agents/execution-efficiency.md`: keep one bounded outcome and a
compact checkpoint, limit tool output, finish review fixes before final
qualification, and reuse valid evidence. Observe an explicitly agreed usage
budget when one exists; never infer a quota percentage from raw token totals.

## Repository scope

Command Center is an OpenClaw plugin. Keep plugin-specific policy and personal workflows out of OpenClaw core. Any proposed OpenClaw fork change must be generic, narrow, independently tested, and tracked separately.

Planning decisions belong in GitHub issues and, once resolved, in `CONTEXT.md` or `docs/adr/` as appropriate. Do not turn unresolved planning questions into implementation assumptions.

## Public-repository safety

This repository is public. Use only fictional fixtures and sanitized examples.

Never commit or publish:

- credentials, tokens, cookies, authentication material, or populated environment files;
- real OpenClaw configuration, session identifiers, conversations, logs, screenshots, or databases;
- personal channel names, private project names, hostnames, IP addresses, device names, or filesystem inventories;
- absolute personal filesystem paths; or
- information copied from a live OpenClaw installation.

Do not inspect or mutate live OpenClaw state without explicit task-specific authorization. Tests must use safe isolated state and must never connect to a live Gateway.

## Source-of-truth boundaries

Before changing any mutation or delayed publication, read `docs/agents/mutations.md`.

- OpenClaw Sessions remain authoritative for conversations.
- Workboard remains authoritative for actionable work where suitable.
- OpenClaw Tasks are execution and activity records, not a personal to-do store.
- Cron and automation remain authoritative for recurrence and execution timing.
- Command Center may own only lightweight presentation metadata until an ADR decides otherwise.

## Licensing

Issue #19 resolved licensing: this repository is MIT-licensed and contributions
are accepted under the same MIT terms (inbound equals outbound). Do not copy
OpenClaw source or assume license compatibility for code outside this repository.
