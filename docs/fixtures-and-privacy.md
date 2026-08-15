# Fixtures and privacy

Command Center is developed in a public repository. Examples and test data must be fictional, minimal, and safe to publish.

## Allowed examples

Use generic spaces such as:

- Cooking
- Household
- Vehicle
- Technology

Use synthetic session identifiers, timestamps, task titles, alerts, and automation results. Make synthetic values visibly fictional where practical.

## Prohibited material

Do not commit:

- real OpenClaw configuration or live-state exports;
- credentials, tokens, cookies, or authentication material;
- real session keys, conversation identifiers, transcripts, logs, screenshots, or databases;
- personal channel names or private project names;
- hostnames, IP addresses, device names, or filesystem inventories; or
- absolute personal filesystem paths.

## Environment files

Commit only `.env.example`, containing variable names and safe explanatory comments. Local `.env` variants are ignored. Example values must not resemble usable secrets or disclose private infrastructure.

## Test isolation

Tests and prototypes must use isolated synthetic state. They must never connect to or modify a live OpenClaw Gateway.

Persistence tests use a disposable resolved-state directory and a fictional broad-archive bridge. The bridge captures the complete isolated state tree (including SQLite sidecars) only for test evidence; no database, archive, or source payload is committed.

## Review before publication

Before every commit and push:

1. inspect all staged paths and diffs;
2. scan staged content for secrets and prohibited identifiers;
3. confirm fixtures are fictional; and
4. confirm no absolute personal paths are present.
