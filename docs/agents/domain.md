# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root, or
- **`GLOSSARY-MAP.md`** at the repo root if it exists: it points at one `GLOSSARY.md` per context. Read each one relevant to the topic.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── GLOSSARY.md
├── docs/adr/
│   ├── event-sourced-orders.md
│   └── postgres-for-the-write-model.md
└── src/
```

Multi-context repo (presence of `GLOSSARY-MAP.md` at the root):

```
/
├── GLOSSARY-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## How this repo records decisions

An ADR is a decision that has to be re-litigated before it changes, not a permanent record. A file exists because the decision stands.

- **No numbering.** A file is named after the decision: `docs/adr/semantic-relay-with-state-cache.md`. A number says nothing and invites a supersession chain nobody reads.
- **One decision per file.** Open with one to three sentences: the context, the decision, and why. Record the rejected alternatives under `## Considered options`, with the reason each was rejected.
- **Edit it when the decision changes.** The file is a living record. Rewrite the decision and the alternatives in place; do not add a "superseded by" header.
- **Delete it when it stops being true.** Git keeps the history. A stale ADR that nobody repealed reads as a current rule.
- **No dates in the file.** `git log` already records when the decision was made and when it was last edited.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `GLOSSARY.md`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts `docs/adr/event-sourced-orders.md`, but worth reopening because…_
