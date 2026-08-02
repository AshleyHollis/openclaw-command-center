# Domain docs

How the engineering skills should consume this repository’s domain documentation when exploring the codebase.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant architectural decisions under `docs/adr/`.

If one of these does not exist yet, proceed silently. Do not invent domain language or architectural decisions merely to fill a document. Domain-modeling work creates and updates them as terminology and decisions are resolved.

## File structure

This repository uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── src/
```

## Use the glossary’s vocabulary

When output names a domain concept—in an issue title, proposal, hypothesis, or test—use the term defined in `CONTEXT.md`. Do not drift to synonyms the glossary explicitly avoids.

If a required concept is absent, either reconsider whether it belongs to the domain or record the gap for domain-modeling work.

## Flag ADR conflicts

If proposed work contradicts an existing ADR, surface the conflict explicitly rather than silently overriding the decision.
