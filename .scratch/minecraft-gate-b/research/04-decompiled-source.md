# Research: decompiled Minecraft 26.1 source in the repo

**Ticket:** `.scratch/minecraft-gate-b/issues/04-research-decompiled-source.md`
**Target:** Minecraft Java 26.1 / protocol 775
**Date:** 2026-11-05
**Status:** research complete; nothing implemented, no repo files changed except this note.

## Verdict

Use a tiny Fabric Loom project pinned to **Loom 1.19.3**, **Gradle 9.8.2**,
**Java 25**, and **Minecraft 26.1**, with **no mappings dependency**, and run
`genSourcesWithVineflower`. The Loom 1.19 line pins Vineflower 1.12.0 and
already makes it the default for `genSources`, so the explicit task is mostly a
reproducibility choice.

Write the generated source under **`.cache/minecraft/26.1/`**, not `build/` or
`vendor/`, and gitignore the whole `.cache/` tree. Keep `minecraft-data` 3.119.0
protocol JSON plus `minecraft-protocol` 1.68.0 as the **primary** reference;
use decompiled source only for implementation questions the protocol JSON
cannot answer.

Do **not** use MCP-Reborn, MinecraftDecompiler, or standalone CFR for this.
MCP-Reborn works but is a full in-tree modding workspace, MinecraftDecompiler
has no 26.1 release, and CFR is a 2021 decompiler. Standalone Vineflower is a
useful fallback for one class, not the primary workflow.

The legal rule is simple: decompiled Minecraft code is still Mojang's
copyrighted code. Local inspection on a licensed machine is the intended
modding use; committing, publishing, shipping, or attaching the generated source
or the client/server jar is redistribution and is not permitted. See
[Legal boundary](#legal-boundary).

---

## Proven facts

### Version and mapping facts

- **26.1** was released **2026-03-24**, is protocol **775**, data version
  **4786**, and requires **Java 25**.
  [Minecraft Wiki: Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1),
  [Protocol version list](https://minecraft.wiki/w/Protocol_version)
- **26.1.1 and 26.1.2 are also protocol 775 and Java 25.** If Gate B runs a
  specific patch client, pin that patch; do not assume 26.1 source is identical
  to 26.1.2 source.
- Mojang's version JSON for 26.1, 26.1.1, and 26.1.2 contains only
  `downloads.client` and `downloads.server`. There is **no `client_mappings`**
  entry. There are therefore no official mappings to download for 26.1.
  [26.1 version JSON](https://piston-meta.mojang.com/v1/packages/90d81d9cd00c1ce55eb2b40aad4f1112bb58f12a/26.1.json),
  [26.1.2 version JSON](https://piston-meta.mojang.com/v1/packages/4e49d699db7dba839226d0ed1fcf36c465c2edbe/26.1.2.json)
- Mojang's announcement says obfuscation is being removed starting with the
  first snapshot after *Mounts of Mayhem* (1.21.11), that future jars contain
  original names **including variable names**, that there are **no more
  obfuscation maps in version `.jsons`**, and that every jar now contains a
  `LICENSE` file. It also says **the EULA is unchanged**.
  [Removing obfuscation in Java Edition](https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition)
- Fabric's migration guide states: **"Minecraft 26.1 is unobfuscated and
  includes parameter names, so there is no need for any obfuscation
  mappings."** It also documents that Yarn is no longer maintained for 26.1+.
  [Fabric: Migrating Mappings](https://docs.fabricmc.net/develop/porting/mappings/),
  [Fabric: Removing Obfuscation from Fabric](https://fabricmc.net/2025/10/31/obfuscation.html)
- Yarn has **no 26.1 branch or tag**. Its newest version branches are the
  1.21.11 line; `git ls-remote --heads https://github.com/FabricMC/yarn` shows
  `1.21.11` and its pre/rc branches, not `26.1`.
- The official 26.1 Fabric example project declares
  `minecraft "com.mojang:minecraft:26.1"` and **no `mappings` line at all**;
  it uses the `net.fabricmc.fabric-loom` plugin (the non-remapping plugin ID),
  Gradle wrapper 9.8.2, and Java 25.
  [fabric-example-mod, branch 26.1](https://github.com/FabricMC/fabric-example-mod/tree/26.1)

### Loom facts (from Loom 1.19 source)

- `genSources` exists and depends on the default decompiler:
  `DEFAULT_DECOMPILER = "Vineflower"`.
  [DecompileConfiguration.java](https://github.com/FabricMC/fabric-loom/blob/1.19/src/main/java/net/fabricmc/loom/configuration/decompile/DecompileConfiguration.java)
- The task names are `genSources`, `genSourcesWithVineflower`, and
  `genSourcesWithCfr`. `genSources` is an alias that depends on
  `genSourcesWithVineflower`.
  [SingleJarDecompileConfiguration.java](https://github.com/FabricMC/fabric-loom/blob/1.19/src/main/java/net/fabricmc/loom/configuration/decompile/SingleJarDecompileConfiguration.java)
- Loom 1.19 pins **Vineflower 1.12.0** and Fabric's CFR fork **0.2.2**.
  [runtime.libs.versions.toml](https://github.com/FabricMC/fabric-loom/blob/1.19/gradle/runtime.libs.versions.toml)
- Loom does **not** require a mappings dependency for an unobfuscated version.
  When `disableObfuscation()` is true and no mapping configuration exists, it
  creates and uses an `empty.tiny` mapping file.
  [SourceMappingsService.java](https://github.com/FabricMC/fabric-loom/blob/1.19/src/main/java/net/fabricmc/loom/task/service/SourceMappingsService.java)
- With no mappings, Loom's mapped artifact name includes `deobf` and its version
  is the Minecraft version. Expect:
  `.../minecraftMaven/net/minecraft/minecraft-merged-deobf/26.1/minecraft-merged-deobf-26.1-sources.jar`
  under the Loom cache. This path is derived from Loom 1.19 source, not yet
  observed from a run here; use `find` as the authoritative locator.
- Loom 1.19 itself is compiled for Java 25 (`sourceCompatibility = 25`), so the
  Gradle daemon must run on JDK 25 or newer. The 26.1 example wrapper uses
  Gradle 9.8.2.

### Direct checks against the real 26.1 jar (run locally, 2026-11-05)

These were run in `/tmp` only; no Minecraft code was written into the repo.

- Client jar: `https://piston-data.mojang.com/v1/objects/191771837687b766537a8c4607cb6fad79c533a1/client.jar`
  - 38,113,398 bytes, SHA-1 `191771837687b766537a8c4607cb6fad79c533a1`
    (matches Mojang's version JSON).
  - 30,675 zip entries; class names are human-readable, e.g.
    `net/minecraft/network/protocol/game/ServerboundChatPacket.class`.
  - Class file major version **69** (Java 25).
  - `GameProtocols.class` has `SourceFile: "GameProtocols.java"`, a
    `LocalVariableTable`, and `ServerboundChatPacket` has a `MethodParameters`
    attribute. Parameter names are really present.
- Packet registration order can be read without any decompiler:

  ```bash
  curl -O https://piston-data.mojang.com/v1/objects/191771837687b766537a8c4607cb6fad79c533a1/client.jar
  javap -cp client.jar -c -p net.minecraft.network.protocol.game.GameProtocols \
    | grep -c 'getstatic.*SERVERBOUND'   # 69
  javap -cp client.jar -c -p net.minecraft.network.protocol.game.GameProtocols \
    | grep -c 'getstatic.*CLIENTBOUND'   # 141
  ```

  This matches the corrected protocol-775 counts of **69 serverbound / 141
  clientbound** packets.
- Vineflower 1.12.0 decompiled `GameProtocols.class` successfully:

  ```bash
  java -jar vineflower-1.12.0.jar GameProtocols.class out/
  # out/GameProtocols.java: 262 lines, contains addPacket(...) and
  # SERVERBOUND_KEEP_ALIVE
  ```

  CFR 0.152 also parsed this single Java 25 class, but it is a 2021 release and
  is not a good bet for the full jar. Loom does not use that CFR anyway; it uses
  Fabric's CFR fork 0.2.2.

### Local `minecraft-data` / `minecraft-protocol` facts

The locally installed versions are already correct for 26.1:

- `minecraft-data` **3.119.0**:
  - version `26.1`, protocol `775`, data version `4786`;
  - `play.toServer` has **69** packet IDs and `play.toClient` has **141**;
  - corrected IDs are present: `custom_payload = 0x16`, `settings = 0x0e`,
    `keep_alive = 0x1c`, `chat_session_update = 0x0a`.
- `minecraft-protocol` **1.68.0**:
  - `defaultVersion: '26.1'`;
  - `supportedVersions` ends with `26.1`.

The old mineflayer issue about wrong 775 packet IDs was against an earlier
`pc26_1_2` data branch. It is **not** present in the pinned 3.119.0 data.
[PrismarineJS/mineflayer#3888](https://github.com/PrismarineJS/mineflayer/issues/3888)

Practical consequence: for packet IDs, field layouts, and state transitions,
read:

```text
node_modules/minecraft-data/minecraft-data/data/pc/26.1/protocol.json
node_modules/minecraft-protocol/src/client/
node_modules/minecraft-protocol/src/server/
```

Only fall back to decompiled Java when the question is about an implementation
detail (validation, timing, ordering, or behaviour not expressible in the JSON).

### Local toolchain audit

| Tool | Local state | Needed for this workflow |
|---|---|---|
| `mise` | 2026.10.11 installed | yes |
| `java` | 21.0.2, 25.0.2, 26.0.2 installed via mise; **no project pin** | pin `25.0.2` |
| `gradle` | 9.5.0 and 9.7.1 installed; **9.8.2 available but not installed** | pin `9.8.2` |
| `node` / `pnpm` | 26.7.0 / 11.25.0 pinned in `mise.toml` | not relevant |
| `unzip` | **missing** on this machine | task must use JDK `jar` or Python, not `unzip` |
| `javap` | present with JDK 21/25 | useful zero-install fallback |

Currently `java -version` and `gradle --version` through the mise shims fail
with "No version is set for shim". Adding project pins fixes that. Java 21 is
not enough for Loom 1.19 or Minecraft 26.1; Java 26 is unnecessary and not the
supported target.

### Tool comparison for 26.1

| Option | Supports 26.1? | Exact command / output | Verdict |
|---|---|---|---|
| Loom `genSources` | Yes; default is Vineflower | `gradle genSources`; writes a `*-sources.jar` into the Loom cache | **Recommended** |
| Loom `genSourcesWithVineflower` | Yes; explicit | `gradle genSourcesWithVineflower`; same output | **Recommended for pinning/CI** |
| Loom `genSourcesWithCfr` | Yes, but older decompiler | `gradle genSourcesWithCfr` | Avoid unless debugging Vineflower |
| MCP-Reborn `26.1` branch | Yes; branch currently tracks **26.1.2**, JDK 25, Gradle wrapper 8.14.4 | `./gradlew setup`; decompiles into `src/main/java`, assets into `run/assets` | Works, but heavy and dangerous for a clean repo; no 26.1 tag, branch head is `4b061a66...`; not recommended |
| MinecraftDecompiler (`MaxPixelStudios/MinecraftDecompiler`) | No documented 26.1 support; last release **v3.3.2 (2024-02-07)** | mapping-oriented CLI; would only wrap Vineflower/CFR | Not recommended |
| Vineflower 1.12.0 standalone | Yes; tested on a 26.1 class | `java -jar vineflower-1.12.0.jar <input.jar> <out-dir>` | Good fallback for one class or if Loom breaks |
| CFR 0.152 standalone | Parsed one Java 25 class, but 2021-era | `java -jar cfr-0.152.jar <input.jar> --outputdir <out>` | Not recommended for full 26.1 jar |
| `minecraft-data` + `minecraft-protocol` | Yes, accurate in pinned versions | read JSON/source directly | **Primary reference** |

MCP-Reborn source: <https://github.com/Hexeption/MCP-Reborn/tree/26.1>. Its
README explicitly warns: **"YOU CANNOT publish any code generated by this
tool."** It also confirms JDK 25 for 26.1+, and writes decompiled code to
`src/main/java`, which is exactly the accidental-commit risk we want to avoid.

MinecraftDecompiler: <https://github.com/MaxPixelStudios/MinecraftDecompiler>.
Its README and releases have no 26.1 entry; the last release is from 2024.

Vineflower: <https://github.com/Vineflower/vineflower/releases/tag/1.12.0>.
Issue #560 documents broken output on Minecraft 26.1.1 with Vineflower 1.11.2;
it was closed when 1.12 shipped. Pin **1.12.0**, not an older version.
<https://github.com/Vineflower/vineflower/issues/560>

### Mappings: Mojang vs Yarn vs MCP for 26.1

| Mapping set | Available for 26.1? | What to do |
|---|---|---|
| Mojang official mappings | **No.** Not in 26.1/26.1.1/26.1.2 version JSON; names are already in the jar | Do **not** add `loom.officialMojangMappings()`; there is nothing to fetch |
| Yarn | **No.** Discontinued after 1.21.11; no 26.1 branch/tag | Do not use; migrate any old code to Mojang names |
| MCP / MCP-Reborn | Only as part of the MCP-Reborn 26.1 workspace (MCP config `20260409.101008`, mappings version `26.1.2`) | Not needed; it is a toolchain, not a mapping set you must install |
| None | Yes | **Correct choice**: decompile the unobfuscated jar directly |

The practical answer for 26.1 is "no mappings". Adding a mappings line is at
best pointless and at worst fails resolution.

---

## Recommended workflow

### 1. Tiny Loom project

Create three tracked files under `tools/mc-source/`. Do not add a Gradle wrapper
unless the repo decides to stop using mise; pin Gradle in `mise.toml` instead.

`tools/mc-source/settings.gradle`:

```groovy
pluginManagement {
    repositories {
        maven {
            name = 'Fabric'
            url = 'https://maven.fabricmc.net/'
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

rootProject.name = 'mc-source'
```

`tools/mc-source/build.gradle`:

```groovy
plugins {
    id 'net.fabricmc.fabric-loom' version '1.19.3'
}

repositories {
    mavenCentral()
}

dependencies {
    minecraft 'com.mojang:minecraft:26.1'

    // Not needed for genSources; included because the official 26.1
    // template uses it. Remove if you want the absolute minimum.
    implementation 'net.fabricmc:fabric-loader:0.20.1'
}

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
}
```

`tools/mc-source/gradle.properties`:

```properties
org.gradle.jvmargs=-Xmx3G
org.gradle.parallel=true
org.gradle.configuration-cache=true
```

Notes:

- Use the **new** plugin ID `net.fabricmc.fabric-loom` (the non-remapping
  plugin). The legacy `fabric-loom` ID is for remapping older obfuscated
  versions; 26.1 does not need remapping.
- Do **not** add `mappings ...`.
- Do **not** add Fabric API; it is unrelated to source generation.
- If Loom complains about the missing loader, keep the
  `fabric-loader:0.20.1` line; if not, remove it for a smaller graph.

### 2. Commands

From the repo root, with Java 25 and Gradle 9.8.2 pinned:

```bash
mise install

# Explicit decompiler, reproducible
gradle -p tools/mc-source --no-daemon \
  --project-cache-dir "$PWD/.cache/gradle-project" \
  -g "$PWD/.cache/gradle" \
  genSourcesWithVineflower

# Locate the output (name is derived from Loom's artifact naming)
find .cache/gradle/caches/fabric-loom -name '*-sources.jar'
```

`genSources` is equivalent today because Loom 1.19 defaults to Vineflower, but
use `genSourcesWithVineflower` so a future default change cannot silently switch
decompilers.

### 3. Output layout

```text
.cache/
  gradle/                                      # GRADLE_USER_HOME (tool + Loom cache)
    caches/fabric-loom/
      minecraftMaven/net/minecraft/
        minecraft-merged-deobf/26.1/
          minecraft-merged-deobf-26.1.jar
          minecraft-merged-deobf-26.1-sources.jar
      decompile/v1.zip                         # Loom decompile cache
  gradle-project/                              # --project-cache-dir
  minecraft/26.1/
    sources.jar                                # copy of the Loom output
    src/net/minecraft/...                      # extracted .java files
```

Why not `build/`:

- `build/` is disposable and `gradle clean` removes it; you do not want to
  re-decompile just because someone cleaned.
- `build/` is already conventionally gitignored, but the source would still be
  mixed with build outputs and easy to accidentally copy into an artifact.
- `.cache/` clearly means "local, derived, not source-controlled".

Why not `vendor/`:

- `vendor/` implies third-party code that is committed or shipped. Decompiled
  Mojang code must never be either.

The Loom merged jar contains both client and server classes. The 26.1 client
jar itself contains the client classes directly; the server jar is a bundler
with a nested server jar. Loom handles the merge, so for packet behaviour use
Loom's merged source or the client jar's network classes, not a hand-extracted
server bundle.

### 4. `mise` task shape

Add to the existing `mise.toml`:

```toml
[tools]
node = "26.7.0"
pnpm = "11.25.0"
java = "25.0.2"
gradle = "9.8.2"

[tasks."mc-source"]
description = "Decompile Minecraft 26.1 into .cache/minecraft/26.1 (local inspection only; never commit)"
dir = "tools/mc-source"
shell = "bash"
run = '''
set -eu
root="$(git rev-parse --show-toplevel)"
export GRADLE_USER_HOME="$root/.cache/gradle"

gradle --no-daemon \
  --project-cache-dir "$root/.cache/gradle-project" \
  genSourcesWithVineflower

src="$(find "$root/.cache" \
  -type f -name '*-sources.jar' -path '*/26.1/*' | head -n 1)"
test -n "$src" || {
  echo "No 26.1 sources jar under $root/.cache" >&2
  exit 1
}

out="$root/.cache/minecraft/26.1"
mkdir -p "$out/src"
cp "$src" "$out/sources.jar"
(cd "$out/src" && jar xf "$out/sources.jar")

echo "Minecraft 26.1 sources: $out/src"
'''

[tasks."mc-source-clean"]
description = "Remove local decompiled Minecraft source and project caches."
shell = "bash"
run = '''
set -eu
root="$(git rev-parse --show-toplevel)"
rm -rf "$root/.cache/minecraft" "$root/.cache/gradle-project" \
  "$root/tools/mc-source/build"
'''
```

If you prefer not to add Java/Gradle globally, move the two tools into a
separate `mise.mc-source.toml` environment file, or invoke
`mise exec java@25.0.2 gradle@9.8.2 -- ...` inside the task. The task-level
`tools` field is supported by current mise, but the global pin above is the
least surprising shape for a repo whose current `mise.toml` is small.

`unzip` is not installed on this machine, hence `jar xf`. `jar` comes from the
pinned JDK, so the task has no extra system dependency.

### 5. `.gitignore`

Add:

```gitignore
# Local, derived Minecraft source and Loom/Gradle caches. Never commit.
.cache/
tools/mc-source/.gradle/
tools/mc-source/build/
```

`.cache/` covers everything when `GRADLE_USER_HOME` and
`--project-cache-dir` point into it. The two `tools/mc-source/` entries are
defense in depth for a developer who runs Gradle manually without the task.

Do **not** gitignore `tools/mc-source/*.gradle` or `gradle.properties`; those
are the reproducible recipe and should be reviewed like any other build file.

Optionally add a CI guard so a future contributor cannot commit the output:

```bash
if [ -n "$(git ls-files -- .cache)" ]; then
  echo ".cache/ must not be tracked" >&2
  exit 1
fi
```

### 6. README warning

Add a short section near the Gate B runbook:

```markdown
## Decompiled Minecraft source (local only)

`mise run mc-source` downloads the Minecraft 26.1 client/server jars and
decompiles them into `.cache/minecraft/26.1/`. That directory is gitignored.

Minecraft code and assets are Mojang's. The jars ship a `META-INF/LICENSE`
that points to the Minecraft EULA (https://aka.ms/MinecraftEULA) and the
Microsoft Services Agreement. The EULA does not permit distributing the game
software or content, and a "Mod" may not contain a substantial part of
Mojang's copyrightable code.

Do not commit, publish, redistribute, or ship the jars or the generated
sources, and do not put them in CI artifacts, container images, or public
issue attachments. Generate them only on a machine with a legitimate
Minecraft license, for personal inspection. This is not legal advice.
```

### 7. Pinning and reproducibility

Pin all of these in one place and record them in the note/README:

| Thing | Pin | Why |
|---|---|---|
| Minecraft | `26.1` (or the exact patch the test client runs) | protocol 775 spans 26.1–26.1.2, but classes can differ |
| Loom | `1.19.3` | stable release; **not** `1.19-SNAPSHOT`, which moves |
| Gradle | `9.8.2` | matches the 26.1 example and Loom 1.19 line |
| Java | `25.0.2` | Minecraft 26.1 and Loom 1.19 both target Java 25 |
| Vineflower | `1.12.0` via Loom 1.19.3 | fixes the 26.1.1 output bug in 1.11.2 |
| Client SHA-1 | `191771837687b766537a8c4607cb6fad79c533a1` | verify the downloaded 26.1 jar |

Additional reproducibility notes:

- `minecraft-data` is currently `^3.119.0` in `package.json` even though
  `pnpm-lock.yaml` resolves exactly `3.119.0`. Change it to `3.119.0` (and keep
  `minecraft-protocol` at `1.68.0`) so a lockfile refresh cannot silently move
  the protocol reference.
- Loom downloads the client/server jars from Mojang at build time. Do not
  vendor or cache them in git. If you need an offline run, keep the Loom/Gradle
  cache in `.cache/` and accept that it is local state, not a repo artifact.
- Decompiler output is not bit-for-bit reproducible across decompiler versions.
  Pin Loom/Vineflower rather than trying to checksum the `.java` files.
- Optional, for supply-chain paranoia: commit Gradle dependency verification
  metadata (`gradle/verification-metadata.xml`, hashes only). That is legal;
  it contains no Mojang code.

---

## Legal boundary

### What the shipped files actually say

The 26.1 client jar contains `META-INF/LICENSE` with exactly this text:

> Use of the contents of this archive is subject to the Minecraft End-User
> License Agreement (EULA) and the Microsoft Services Agreement.
>
> Minecraft EULA: https://aka.ms/MinecraftEULA
> Microsoft Services Agreement: https://www.microsoft.com/msa

The current Minecraft EULA says, among other things:

- "you must not distribute anything we've made", defined to include
  "give copies of our game software or content to anyone else";
- a "Mod" is "something original ... that doesn't contain a substantial part of
  our copyrightable code or content";
- "You may not distribute any Modded Versions of our game or software".

Mojang's obfuscation-removal article explicitly says the change **does not
change the EULA** and that both the EULA and the Usage Guidelines still apply.

Sources:
[EULA](https://www.minecraft.net/en-us/eula),
[Minecraft Usage Guidelines](https://www.minecraft.net/en-us/usage-guidelines),
[Removing obfuscation](https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition)

### What follows

**Proven / high confidence:**

- The decompiled output is a copy/derivative of Mojang's copyrighted code. It is
  not open source, and removing obfuscation did not relicense it.
- Committing it to a public or private repo, publishing it, shipping it in a
  release or container, or attaching it to an issue is redistribution of
  Mojang's content. The EULA does not permit that.
- The generated source is not a "Mod" in the EULA sense if it contains a
  substantial part of Mojang's code. Calling it a mod does not make
  redistribution okay.
- The client/server jars themselves must not be committed either.

**Interpretation / recommendation (not legal advice):**

- Personal, local inspection on a machine with a legitimate Minecraft license is
  the workflow the obfuscation removal is intended to support, and Mojang now
  ships parameter names specifically to make the code readable. That said, the
  rendered EULA text inspected for this note contains no express "you may
  decompile" clause; do not treat this note as a legal opinion. If the project
  needs certainty, ask counsel before relying on local decompilation.
- Keep generated source out of git history, CI artifacts, Docker images, release
  assets, and public issue comments. If a bug report needs evidence, cite packet
  IDs/field layouts from `minecraft-data` or describe the behaviour; do not paste
  large decompiled excerpts.
- If the project ever wants to publish an excerpt or ship a patched client, get
  legal review first. MCP-Reborn's own README ("YOU CANNOT publish any code
  generated by this tool") is a useful industry sanity check.
- There are no 26.1 mappings to license or redistribute. Yarn's absence for
  26.1 means the old "commit the mappings, not the code" workaround is not
  available either; the correct boundary is "commit the recipe, not the output".

---

## Smallest falsifying experiment

This is the smallest test that would disprove the recommendation. It is
deliberately narrower than a full Gate B source pipeline.

**Hypothesis:** Loom 1.19.3 can decompile Minecraft 26.1 with no mappings
dependency and place a readable `GameProtocols.java` under the repo-local
`.cache/`, without touching tracked files.

**Setup (about 10 minutes, mostly downloads):**

1. Add `java = "25.0.2"` and `gradle = "9.8.2"` to `mise.toml`; run
   `mise install`.
2. Create `tools/mc-source/{settings.gradle,build.gradle,gradle.properties}` as
   in the recommendation above. No `mappings` line.
3. Add `.cache/` to `.gitignore`.
4. Run:
   ```bash
   gradle -p tools/mc-source --no-daemon \
     --project-cache-dir "$PWD/.cache/gradle-project" \
     -g "$PWD/.cache/gradle" \
     genSourcesWithVineflower
   ```

**Pass criteria (all must hold):**

- Gradle exits 0 and a `*-sources.jar` exists under
  `.cache/gradle/caches/fabric-loom/`.
- `jar tf <sources.jar> | grep -q 'net/minecraft/network/protocol/game/GameProtocols.java'`.
- The extracted `GameProtocols.java` contains `addPacket(...)` calls and
  `SERVERBOUND_KEEP_ALIVE`.
- `git status --porcelain` shows no tracked Minecraft source or jar, and
  `git check-ignore .cache/minecraft/26.1` succeeds.
- Optional cross-check: the same file has 69 serverbound registrations, matching
  `minecraft-data` 3.119.0.

**Fail criteria / fallback:**

- Loom errors with "Mappings have not been configured" or cannot resolve 26.1:
  the no-mappings premise is wrong; try Loom 1.19.3 with an explicit empty
  mapping or use standalone Vineflower on the client jar.
- `genSourcesWithVineflower` is missing: check the plugin ID
  (`net.fabricmc.fabric-loom`, not legacy `fabric-loom`) and Loom version.
- The sources jar exists but lacks `GameProtocols.java`: inspect the decompile
  error log; fall back to `javap` for packet IDs and standalone Vineflower for
  one class.
- If the output lands outside `.cache/` or is tracked: stop and fix the task
  before anyone uses it.

**Cheap pre-check already performed here:** the client jar SHA-1 matches
Mojang's metadata; `javap` reads 69/141 packet registrations and parameter
names; Vineflower 1.12.0 decompiles a real 26.1 network class successfully.
Only the Loom wrapper itself remains unexecuted.

---

## Risks and open questions

- **Full-jar decompile quality.** Vineflower 1.12.0 fixes the known 26.1.1
  output bug, but some classes may still decompile imperfectly. Treat generated
  Java as a reading aid; verify packet semantics against `minecraft-data` and,
  where necessary, `javap` bytecode.
- **Patch drift.** 26.1, 26.1.1, and 26.1.2 share protocol 775 but are different
  jars. Pin the exact patch the Gate B client runs.
- **Server classes.** Loom produces a merged client+server source jar; the
  server jar is a bundler. If you use standalone Vineflower, extract the nested
  server jar first (the mineflayer issue shows the layout:
  `META-INF/versions/26.1.1/server-26.1.1.jar`).
- **Moving snapshots.** `1.19-SNAPSHOT` is what the Fabric example uses, but it
  is not reproducible. Pin `1.19.3`.
- **No `unzip`.** Use JDK `jar` or Python `zipfile`; the task above uses `jar`.
- **Gradle download size.** `mise install gradle@9.8.2` plus the Minecraft jars
  and Loom dependencies is the main first-run cost. Java 25 is already installed
  locally.
- **Repo hygiene.** The current `.gitignore` has no `.cache/` entry. Adding the
  task without the ignore rule would be a real risk; land both together.

## References

- [Minecraft Wiki: Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1)
- [Minecraft Wiki: Protocol version](https://minecraft.wiki/w/Protocol_version)
- [Mojang: Removing obfuscation in Java Edition](https://www.minecraft.net/en-us/article/removing-obfuscation-in-java-edition)
- [Minecraft EULA](https://www.minecraft.net/en-us/eula)
- [26.1 version JSON](https://piston-meta.mojang.com/v1/packages/90d81d9cd00c1ce55eb2b40aad4f1112bb58f12a/26.1.json)
- [26.1 client jar](https://piston-data.mojang.com/v1/objects/191771837687b766537a8c4607cb6fad79c533a1/client.jar)
- [Fabric: Migrating Mappings](https://docs.fabricmc.net/develop/porting/mappings/)
- [Fabric: Removing Obfuscation from Fabric](https://fabricmc.net/2025/10/31/obfuscation.html)
- [Fabric example mod, 26.1](https://github.com/FabricMC/fabric-example-mod/tree/26.1)
- [Loom 1.19 decompile configuration](https://github.com/FabricMC/fabric-loom/blob/1.19/src/main/java/net/fabricmc/loom/configuration/decompile/SingleJarDecompileConfiguration.java)
- [Loom 1.19 source mappings service](https://github.com/FabricMC/fabric-loom/blob/1.19/src/main/java/net/fabricmc/loom/task/service/SourceMappingsService.java)
- [Loom 1.19 decompiler versions](https://github.com/FabricMC/fabric-loom/blob/1.19/gradle/runtime.libs.versions.toml)
- [MCP-Reborn 26.1 branch](https://github.com/Hexeption/MCP-Reborn/tree/26.1)
- [MinecraftDecompiler](https://github.com/MaxPixelStudios/MinecraftDecompiler)
- [Vineflower 1.12.0](https://github.com/Vineflower/vineflower/releases/tag/1.12.0)
- [Vineflower #560: Minecraft 26.1.1 output bug](https://github.com/Vineflower/vineflower/issues/560)
- [mineflayer #3888: protocol 775 packet IDs](https://github.com/PrismarineJS/mineflayer/issues/3888)
- [minecraft-data](https://github.com/PrismarineJS/minecraft-data)
- [minecraft-protocol](https://github.com/PrismarineJS/minecraft-protocol)
