# Research: decompiled Minecraft source in the repo

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

What is the easiest legal and reproducible way to get readable Minecraft 26.1
Java source locally so we can inspect packet behavior and implementation details
when `minecraft-data` or the protocol docs are not enough?

Compare:

- Fabric Loom `genSources` / `genSourcesWithVineflower` in a tiny Gradle
  project, with Mojang mappings and a pinned 26.1 version.
- `MinecraftDecompiler`, Vineflower, CFR, or `MCP-Reborn` directly.
- `minecraft-data` protocol JSON plus `minecraft-protocol` source as the primary
  reference; decompiled source only as a fallback.
- Mappings: Mojang official mappings, Yarn, MCP, and what is actually available
  for 26.1.

Answer:

- Which toolchain supports 26.1 today, and what are the exact commands?
- Where should generated source live (`build/`, `.cache/`, `vendor/`), and what
  must be gitignored?
- What are the legal constraints on downloading/decompiling for personal
  inspection, and on committing or redistributing the result?
- How do we pin the version and make the task reproducible without committing
  Mojang code or assets?
- What `mise` task shape and README warning should the repo use?
- What is the smallest experiment that proves the workflow works for 26.1?

Deliverable: a recommended workflow, `mise` task sketch, output layout, legal
boundary, and a reproducibility check. Do not implement.

## Answer

<!-- filled on resolution -->

## Answer

26.1 is **unobfuscated**; Mojang’s 26.1/26.1.1/26.1.2 version JSON has no
`client_mappings`, and Yarn has no 26.1 branch. Use a tiny Fabric Loom project
in `tools/mc-source/`: Loom 1.19.3, Gradle 9.8.2, Java 25.0.2, Minecraft
**26.1.2**, **no mappings line**, and `genSourcesWithVineflower`. Output only to
`.cache/minecraft/26.1.2/`; `.cache/` must be gitignored. Commit the recipe, not
the output or jars. Use `minecraft-data` 3.119.0 protocol JSON and
`javap -c -p` on the pinned client jar first; decompile only for
implementation details the JSON cannot answer.

This is an engineering convenience, **not a Gate B acceptance criterion**. The
legal boundary: decompiled Minecraft code is Mojang’s copyrighted code; local
inspection on a licensed machine is intended, but committing, publishing,
shipping, or attaching the source/jars is redistribution. This is not legal
advice. Full note:
[`research/04-decompiled-source.md`](../research/04-decompiled-source.md).
