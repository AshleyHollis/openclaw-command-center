# Efficient agent execution

Deliver the smallest useful end-to-end outcome with the evidence required by
[release policy](release-policy.md). This policy changes execution habits, not
authorization, correctness, required review, or release gates.

## Scope and context

- Start with the current issue, exact repository state, affected owners and
  acceptance criteria. Verify what already exists before proposing new machinery.
- Keep unrelated refactors and additional source adapters out of the batch.
- Read only relevant instructions and files. Scope `rg` to source directories;
  exclude dependency trees, build output, scratch, recovery and archived evidence
  unless the specific investigation needs them. Never enumerate the entire
  cross-repository workspace to find a known repository file.
- Keep a short local checkpoint using [the batch template](batch-checkpoint.md).
  Update it at meaningful boundaries; reference logs and evidence instead of
  pasting them into every prompt. Do not reproduce the whole conversation.
- Preserve the requested model. Use scripts for repeatable bookkeeping and
  verification. Do not create additional agents merely for polling, waiting or
  summarizing; use independent review when required by the release class.

## Development and qualification

1. Map each acceptance claim to its affected owner and smallest applicable test.
   Record platform requirements and reusable evidence before starting tests.
2. Run focused checks while editing. Use the supported Linux environment for
   filesystem, descriptor, symlink and process-death guarantees. Do not repeat a
   broad Windows run after identifying an unsupported platform boundary.
3. Finish implementation, inspect the complete diff and resolve required review
   findings before dispatching expensive final qualification. Required automatic
   CI may still run on intermediate commits; it is not final journey evidence.
4. Freeze the candidate commit, then run the affected installed-package journeys.
   A later change invalidates only claims it can affect, subject to the existing
   identity rules. Record why carried-forward evidence remains valid.
5. Promote the qualified artifact through the existing release workflow. Reuse
   unchanged host receipts; do not rebuild solely because a merge commit exists.

A second occurrence of the same failure requires a diagnosis and a stated change
before another attempt. A documented bounded retry policy takes precedence.
Do not repeatedly rerun unchanged tests hoping for green. A test that hangs needs
its owned timeout, progress evidence or diagnosis, not a new blanket suite.

## Waiting and tool output

- Prefer one CLI watcher with a reasonable polling interval and a local log.
  Expose completion, changed stage or failure summaries to the agent; do not
  stream the full job tree on every poll. Use bounded tool waits so user input
  and required progress updates remain possible.
- Use process/job waits for their intended purpose. Never use agent-mailbox waits
  when waiting for CI, a clock deadline or a deployment observation window.
- Query only needed status fields. Read full logs once when a failure requires
  diagnosis, then inspect the relevant excerpt. Do not repeatedly retrieve all
  issue comments, completed test output or unchanged browser trees.
- Batch independent reads; keep dependent steps and mutations sequential.
- During a required observation window, use its specified probes and start/end
  checks. Do not repeatedly ask the model to decide whether time has elapsed.
  Continue independent useful work and report actual changes concisely.

## Usage checkpoints

- When usage tools are available, record the account allowance and reset identity
  at batch start, after implementation, before expensive qualification and at end.
  For long implementation phases, sample about every 30 minutes of active work.
  Record only percentages/times, never credentials or account identifiers.
- A quota budget exists only when explicitly agreed. Record the budget in
  percentage points and any minimum remaining allowance. A proposed budget is
  not approval, and elapsed hours or raw tokens do not predict a quota percentage.
- Usage is account-wide, rounded and potentially delayed. Concurrent tasks also
  consume it. Report the observed account change, not exact task attribution;
  do not promise a hard cutoff. Start a new baseline after a quota reset.
- If an agreed threshold is reached, stop starting optional work, save a resumable
  checkpoint and report remaining work. Respect an explicit stop; otherwise finish
  only the already authorized safety-critical cleanup needed to leave a stable
  state. Do not mark an incomplete goal complete or pause it without user request.

## Repeated production processing

Reuse accepted extraction for unchanged source revisions and effect retries.
Persist continuation and failures; do not repeatedly scan all history. Surface
due work through the existing scheduler without model re-extraction. These are
implementation requirements for authorized intake work, not permission to scan
personal data, change routing, or enable producers during a policy-only task.
