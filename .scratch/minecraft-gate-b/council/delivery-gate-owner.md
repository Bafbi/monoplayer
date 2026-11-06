# Council memo — delivery / gate ownership

**Role:** delivery-gate-owner (acceptance criteria, sequencing, effort, evidence, scope control)
**Gate:** B — real-client / testbed gate after protocol-level Gate A (37/37, `testdata/gate-a-report.json`)
**Target:** Minecraft Java 26.1.2 client, protocol 775, backends pinned to the same patch
**Date:** 2026-11-05
**Status:** recommendation only; nothing implemented

---

## Recommendation (one paragraph)

Run Gate B as a **one-week, verdict-first falsifier with an explicit hardening tail**, not as a certification programme. The gate's pass claim is one sentence: *one owner-operated official 26.1.2 client joins through Monoplayer (online front leg, real `hasJoined`, UUID whitelist) to a real online-mode Paper 26.1.2 backend, leaves “Loading terrain…”, renders, moves, breaks and places a block, disconnects for five minutes while the puppet stays in world, and reattaches at its current pose with exactly one backend login for the whole run and the player identity never visible to the backend* — plus one **unmodded** vanilla confirmation run and a redacted evidence bundle, repeated twice. Control the client with **Prism 11.1.1 + a tiny client-only Fabric `gate-b-driver`** (loopback JSON, no network-stack hooks), with **Xvfb + Mesa llvmpipe** as the headless display fallback and **unmodded Prism + xdotool** as the anti-masking fallback; protocol bots are a per-run pre-check, never evidence. Make **Paper 26.1.2 direct** the mandatory pass row and **Vanilla 26.1.2 direct** the mandatory reference confirmation; **defer Fabric and Velocity**; keep the mandatory fault set to the four that test Monoplayer's own promises (5-minute detach, backend kick, backend restart, 60 s keep-alive timeout) with latency/loss as an attempt-but-descopable row; require **two distinct accounts** with the puppet headless-only in `.secrets/` and one writer; treat decompiled source as an **engineering convenience outside the gate**. Start with a **host-readiness gate** because this workspace physically cannot run the client (no display, no GPU, no X/GL libraries, no root, 4 cores, ~3.4 GiB free); if the host is not ready in two days, Gate B is **blocked, not failing**, and must not be replaced by protocol-bot evidence.

---

## The pass claim (write this at the top of the report)

> Gate B passes when an official Minecraft Java 26.1.2 client, launched from a Prism instance with a real Microsoft session, connects to Monoplayer's front leg (`online-mode=true`, real `hasJoined`, UUID attach whitelist), is admitted and controls the puppet, completes **join → render → move → break → place → 5-minute detach → reattach-at-current-pose**, with **exactly one backend login**, the **player UUID never reaching the backend**, a non-whitelisted account **denied before Login Success**, and the same core scenario observed once with an **unmodded** client — with all assertions backed by client state **and** backend/proxy state **and** a visual artifact.

Anything not in that sentence is not Gate B. Anything in that sentence cannot be descoped without changing the claim and therefore re-opening the council decision.

---

## Decision table

| ID | Decision | Recommendation | Mandatory | Descopable without failing the gate | Primary evidence | Effort |
|---|---|---|---|---|---|---|
| **D1** | Official-client control | Prism 11.1.1 + client-only Fabric `gate-b-driver` on a display host; one unmodded confirmation run | Driver lane for every row; unmodded on M2; `screen==null + level + player + waitForChunksRender` | Unmodded **block-edit** precision; driver if it cannot be built (→ Gate B-Partial) | Driver JSONL + client screenshots + RCON/backend state | 2–4 d |
| **D2** | Backend / proxy / fault matrix | M1 Vanilla + M2 Paper mandatory. M3 Fabric deferred. M4 Velocity deferred. Faults: 5-min soak, kick, restart, 60 s timeout; latency/loss attempt-only | M1, M2, soak, kick, restart, timeout | Fabric, Velocity, BungeeCord, ViaProxy, latency/loss row, compression `-1`, 26.2/26.3 | Backend login count, RCON, proxy report, SLP version, reports | 2–3 d |
| **D3** | Two accounts, tokens, whitelists | Two distinct owner-operated MS accounts; puppet headless-only; separate backend / attach whitelists by UUID; one writer, one replica | Two accounts; online front leg; separate whitelists; denial before Login Success | Cluster Secret write-back (local file is enough for B); second-factor attach token | `auth:status`, UUIDs, denial log, backend list | 0.5–1 d |
| **D4** | Decompiled source | Not a Gate B criterion. `tools/mc-source` + `.cache/`, safe-default Vineflower, no mappings, never committed. 2 h spike only if a packet question blocks work | Legal boundary: zero generated source or jars in git/CI/images | The whole workflow | `git check-ignore .cache/...`, spike log | 0–0.5 d |
| **D5** | Acceptance, order, non-goals | Verdict-first week, hardening tail, explicit AC table, 2/2 core and 3/3 fault | The AC table below | See non-goals | One report JSON + screenshots + redacted logs | 6–10 d |
| **D6** | Biggest risk / kill | Client-lane environment and 26.1 driver API, not the protocol; kill on host readiness, driver timebox, and two failed fix cycles on M2 | Numeric kill rules below | — | Host benchmark, M2 attempt log | — |

---

## D1 — Official-client control

### Recommendation

**Primary lane (mandatory):** Prism Launcher 11.1.1, one 26.1.2 Fabric *production* instance named `gate-b-player`, the real **player** account pinned per-instance, and a client-only `gate-b-driver` mod exposing newline-delimited JSON on `127.0.0.1:25599` with a per-run token. Commands: `status`, `look`, `move`, `break`, `place`, `disconnect`, `reconnect`, `screenshot`, `quit`. The mod reads `Minecraft.getInstance()` and calls `MultiPlayerGameMode` / the vanilla disconnect path; it must not mix into `Connection`, the login/play network handlers, packet codecs, or Netty.

**Why mandatory:** only this lane can assert `screen == null`, `level != null`, `player != null`, `waitForChunksRender()`, hit result, and predicted-then-reconciled block state. That is the difference between “JVM alive” and “left Loading terrain”.

**Unmodded lane (mandatory once, on M2):** Prism vanilla 26.1.2 under Xvfb + llvmpipe + xdotool, or a human on a physical display. Required for **join → render → move → disconnect → reattach** only. Block edits stay driver-only. Rationale: the driver is a mod; a mod can mask a vanilla problem, and the product claim is about the unmodded client. This run is cheap (30–60 min) and it is the single best defence against over-claiming.

**Fallback hierarchy:**

| Situation | Fallback | Verdict impact |
|---|---|---|
| Driver cannot compile against 26.1 within the timebox | Unmodded Prism + xdotool/manual, AC1/AC2/AC4/AC5 only | **Gate B-Partial**; block-edit ACs recorded as unproven |
| No GPU/display host | Xvfb + Mesa llvmpipe (26.1.2 is OpenGL, not Vulkan) | None, if the host benchmark passes |
| Prism cannot run on the host | Fabric Client Gametest (`useXVFB`) for harness validation only | **Cannot pass the gate** (offline, no real auth) |
| Real auth unavailable | HeadlessMc / protocol bot | **Does not count**; bring-up only |

**Anti-patterns that must fail the run, not be retried:** `pgrep`/`jps` liveness, window-exists, a single non-black screenshot, “no error in last N log lines”, or serverbound packet counts without backend state.

### Local constraint (honest)

This workspace cannot host this lane: no `DISPLAY`, no `/dev/dri`, no X11/GL libraries, no Xvfb/xdotool/Prism, no `sudo`, 4 cores, ~3.4 GiB free RAM. The client lane is therefore a **user-provided host**, and “host ready” is the first gate. The workspace keeps the backend cache, M0 protocol pre-check, scenario logic, and report generation.

### Effort

- Host provisioning + benchmark: 0.5–1 d (user-owned; highest variance).
- Driver v0 (status/move/break/place/screenshot/disconnect): 1.5–3 d. 26.1 is unobfuscated, which removes the mapping problem but not the API-shape problem.
- Scenario runner + report: 1–1.5 d.

---

## D2 — Backend / proxy / fault matrix

### Mandatory rows

| Row | Backend | Backend online | Secure profile | Proxy | Fault | Reps | What it buys |
|---|---|---|---:|---|---|---:|---|
| **M2** | Paper 26.1.2 b74 | true | true | none | none | 2/2 | The pass row. Encryption, `hasJoined`, secure profile, Paper config/messages/chunks |
| **M1** | Vanilla 26.1.2 | true | true | none | none | 2/2 | Reference implementation parity; catches Paper-specific masking |
| **M5a** | Paper 26.1.2 b74 | true | true | none | 5-min front detach | 3/3 | The architecture's stated window; Gate A only proved 5 s |
| **M5b** | Paper 26.1.2 b74 | true | true | none | RCON kick of puppet | 3/3 | Defined front-client behavior; no reconnect loop |
| **M5c** | Paper 26.1.2 b74 | true | true | none | graceful stop + start, and `SIGKILL` | 3/3 | One login per backend session, cache reset, no duplicate session |
| **M5d** | Paper 26.1.2 b74 | true | true | none | Toxiproxy `down` 60 s then restore | 3/3 | Keep-alive expiry, no silent stale cache, honest front disconnect |

**Attempt, may descope to Gate B.1:** M5e latency 100 ms ± 30 ms + 0.5 % loss with 25 % correlation for 60 s. It is the cheapest realism row and may expose pacing bugs, but it is not an invariant in the architecture's five.

**M0 (per run, not a row):** Paper 26.1.2, `online-mode=false`, `enforce-secure-profile=false`, Gate A fake client. Runs in this workspace in seconds and triages protocol regressions before spending a real client run. Report it as `clientLane: "protocol-precheck"`; it never counts as a pass.

### Deferred

| Row | Verdict | Reason |
|---|---|---|
| **M3 Fabric 26.1.2 + API + Carpet** | Defer to Gate B.1 | Cheap to run but proves loader/modded registries; not an invariant, and Carpet changes tick behavior. Note it as a recorded gap. |
| **M4 Velocity 4.3.1 + Paper** | Defer to Gate C / compat lane | Forwarding/UUID proof matters only if the real target uses a proxy. It is not the product's risk in B, and it doubles config surface. |
| BungeeCord, ViaProxy, Fabric+Velocity, Vanilla+Velocity | Defer indefinitely | Legacy, version translation, or extra mods. |
| Compression `-1`, `prevent-proxy-connections=true`, `online+insecure` | Defer | Cheap variants, no new invariant. |
| 26.2 / 26.3, Bedrock, modded clients, resource packs, chat signing | Out of scope | Separate gate / explicitly deferred product scope. |

### Configuration that is part of acceptance

Flat world, seed 775, `view-distance=4`, `simulation-distance=4`, `spawn-protection=0`, `difficulty=peaceful`, `gamemode=creative`, `pause-when-empty-seconds=0` (Vanilla), `network-compression-threshold=256`, RCON on ClusterIP/localhost with a runtime password, whitelist = puppet UUID only, `enforce-whitelist=true`. Record exact jar checksums and patch versions in the report. **Pin client and backend to 26.1.2** and set `minecraft-protocol` to `version: '26.1'` (775); record the patch mismatch as a known limitation and verify it with M0.

### Effort

Backend cache + M2 bring-up: 0.5 d locally/direct Java; cluster path adds 0.5–1 d. M1 row: 0.5 d once the harness exists. Faults: 1–2 d including Toxiproxy wiring and three reps.

---

## D3 — Two accounts, token custody, whitelists, duplicate sessions

### Verdict

**Two distinct owner-operated Microsoft accounts are mandatory for a Gate B pass.** The one-account fallback is a bring-up smoke and must be reported `twoAccount=false`; it cannot carry the identity-separation claim because there is only one UUID, and it makes an accidental backend login kick the puppet.

**Roles**

| Role | Owner | Logs in via | Backend sees |
|---|---|---|---|
| Puppet | Operator, dedicated alt | Headless Monoplayer only (`prismarine-auth` / `minecraft-protocol`, `auth: 'microsoft'`, `flow: 'live'`, `profilesFolder: .secrets/puppet`) | Puppet only, one TCP session |
| Player | Operator's normal account | Prism → Monoplayer front leg | Nothing |

**Token custody**

- `.secrets/puppet/` gitignored, `0700`/`0600`, full-disk encryption, no cloud sync, never in `.scratch/`.
- Pass the **path**, never the token, via `PUPPET_AUTH_CACHE`. No env-var secrets.
- **One writer.** The proxy is the only process allowed to refresh. `auth:status` is read-only by default; `--refresh` takes an exclusive lock and refuses while the proxy runs. Atomic temp-write + `fsync` + `rename`.
- Do not restore a `.bak` after refresh; it is invalid. Re-bootstrap with a device code.
- Cluster Secret write-back is **not** required for Gate B; local file custody is sufficient and avoids the unverified Talos at-rest encryption issue. Record that as a Gate B limitation for the later deploy gate.

**Whitelists — two gates, two UUIDs**

| Gate | Contains | Denial |
|---|---|---|
| Backend `whitelist.json` | Puppet UUID only | Puppet cannot join; no backend session; health event; no reconnect loop |
| Monoplayer attach whitelist | Player UUID only | Client closed **before** Login Success; puppet session untouched |

Resolve usernames to UUIDs at add time; compare UUIDs only. Never put the player in the backend or the puppet in the attach list.

**Duplicate-session rules (hard)**

1. One proxy process, one replica, `strategy: Recreate`. A rolling update that overlaps pods is a token-rotation race and a kick.
2. Never run a GUI client as the puppet while the proxy is live.
3. Never point the player at the backend directly; if whitelisted it becomes a second player, if not it proves nothing.
4. First-line triage for a duplicate kick: `pgrep -af 'java|node'`, second pod, copied cache, stray Prism instance.

### The user's manual steps (each one can block a day)

1. **Confirm two accounts**, each owning Java Edition (not Game Pass alone), 2FA enabled, Xbox profile created, multiplayer allowed in privacy settings. Record both UUIDs.
2. **Provide the display host** (Linux, Java 25, ≥16 GB RAM recommended, Prism 11.1.1, GPU or Xvfb + Mesa). Without this Gate B does not start.
3. **Approve the puppet device code once** within its 15-minute window. Never add the puppet to Prism.
4. **Sign into Prism once with the player account** (Microsoft + 2FA); pin the account to the instance.
5. **Run the two whitelist commands** (`whitelist:add backend <puppet>`, `whitelist:add attach <player>`) and paste the resulting UUIDs into the run record.
6. **Approve the auth-title fallback** if `Titles.MinecraftJava` returns 403 (record which title worked).
7. **Visually review the final screenshots** once, and confirm the run targeted an owner-controlled server only.
8. **Decide the secure-profile fallback** only if the puppet cannot obtain a profile certificate; that is a recorded weaker claim.

### Effort

Auth ready 0.5 d (runbook already exists), plus 15 minutes of user time; Prism setup 0.5 d. Denial tests 0.5 d.

---

## D4 — Decompiled source: not Gate B scope

**Verdict: not a Gate B acceptance criterion.** 26.1 is unobfuscated, `minecraft-data` 3.119.0 already has 69 serverbound / 141 clientbound packet IDs for 775, and `javap` answers packet-registration questions without any decompilation. Decompiling is an **engineering convenience** that belongs to the implementation slice, not to the gate.

**If and when it is needed:**

- `tools/mc-source/{settings.gradle,build.gradle,gradle.properties}` tracked; output in `.cache/minecraft/26.1/`; `.cache/` gitignored; Loom 1.19.3, Gradle 9.8.2, Java 25.0.2, `genSourcesWithVineflower`, **no mappings line**.
- Pin the **exact patch** the client runs (26.1 vs 26.1.2 differ), SHA-1 the client jar.
- **Legal boundary:** generated source is Mojang's copyrighted code. Local inspection on a licensed machine only. Never commit, publish, ship, put in CI artifacts/images, or attach to issues. Commit the recipe, not the output. No 26.1 mappings exist, so the old “commit mappings, not code” workaround is unavailable. This is not legal advice.
- **Hygiene is a stop-the-line rule, not an AC:** if `.cache/` or a jar is ever tracked, stop, remove, and audit history; treat it as a security/hygiene incident.
- **Timebox:** 2 hours, only when a specific packet question blocks work. Do not build a source pipeline during Gate B.

---

## D5 — Acceptance criteria, order of work, non-goals

### AC table (all must pass for Gate B, except marked descopable)

Evidence rule: every AC needs **client state + independent server/proxy state + artifact**. No AC is satisfied by one of the three.

| ID | Criterion | Pass threshold | Evidence | Fatal? |
|---|---|---|---|---|
| **G0** | Host ready | Direct-backend benchmark (join → render → move → edit → disconnect → rejoin on plain Paper) passes **2× consecutively** | Benchmark report + screenshots | Blocks gate (not product failure) |
| **G1** | Auth ready | Device-code bootstrap; silent refresh returns **same UUID**; Java entitlement + multiplayer privilege; two distinct UUIDs | `auth:status --json` (redacted) | Blocks gate |
| **AC1** | Join & render (M2) | `screen == null`, `level != null`, `player != null`, chunks rendered; ≤10 s target, 120 s hard timeout | Driver state, backend `list`, screenshot | **Yes** |
| **AC2** | Movement | Forward 20 ticks; client delta and backend `Pos` delta both 1.0–6.0 blocks on the expected axis; no duplicate position stream | Driver state, RCON `data get entity`, proxy counters | **Yes** |
| **AC3** | Break + place | Target becomes air then stone on client **and** RCON; exactly one completed dig and one use-item action; hotbar decremented | Before/after screenshots, RCON `execute if block`, proxy counters | **Yes** |
| **AC4** | 5-minute detach | 300 s ± 5 s detached: front leg ended, puppet still in backend `list`, backend keep-alives observed, `backendLogins` unchanged | Proxy report, backend log, RCON `list` at start/end | **Yes** |
| **AC5** | Reattach at current pose | Chunks rendered ≤120 s; pose within 0.5 block of pre-detach; block edit persists; `attachCount == 2`; `backendLogins == 1` | Driver state, RCON, proxy report, screenshot | **Yes** |
| **AC6** | Identity separation + attach denial | Backend never sees player UUID; client renders puppet profile; non-whitelisted UUID denied **before Login Success**, no play packet relayed, puppet unaffected | Proxy log `attachDenied`, backend log, client disconnect screen | **Yes** |
| **AC7** | Backend denial | Puppet removed from backend whitelist → backend rejects, health event, no reconnect loop; puppet restored afterwards | Backend log, proxy health, RCON | No (recorded gap if flaky) |
| **AC8** | M1 Vanilla parity | AC1–AC5 on Vanilla 26.1.2 | Same bundle | **Yes** |
| **AC9** | Unmodded confirmation | Unmodded 26.1.2 client: join/render/move/disconnect/reattach on M2 | Screenshots + RCON + client log | **Yes** |
| **AC10** | Fault set | Kick / restart / 60 s timeout: defined front behavior, no duplicate login, no reconnect storm >3 attempts; 3/3 reps | Proxy report, backend log, timings | **Yes** (for M5b–d) |
| **AC11** | Reproducibility | AC1–AC5 pass **2/2 consecutive clean runs** from the documented start state; fault rows 3/3 | Two report files | **Yes** |
| **AC12** | Evidence bundle | One JSON report per run: versions/checksums, `clientLane`, `twoAccount`, `secureProfile`, timings, attach count, backend login count, per-AC results, screenshots, redacted logs, exact commands | `testdata/gate-b-report.json` + artifacts | **Yes** |

**Descope rules.** A lane can be dropped only if the pass claim survives verbatim. You may descope Fabric, Velocity, latency/loss, block-edit precision in the unmodded lane, cluster custody, and chat. You may **not** descope AC1, AC2, AC4, AC5, AC6, AC9, one backend login, online front leg, or encryption/secure profile on the mandatory rows. `enforce-secure-profile=false` is a recorded weaker claim, not a free pass.

### Order of work (dependency order, not preference order)

| Phase | Days | Work | Exit |
|---|---:|---|---|
| **0. Prerequisites** | 1–2 | Host ready benchmark; auth bootstrap + silent refresh; backend cache + M2/M1 start + SLP ping; M0 precheck | G0/G1 pass or gate **blocked** |
| **1. Driver spike** | 1–3 | `status`/`screenshot`/`move`/`break`/`place`/`disconnect`; join a plain Paper server; no Monoplayer | Driver + unmodded both join direct |
| **2. M2 end-to-end** | 1–2 | Monoplayer front/back legs, AC1–AC5, 5-min soak | Core claim works or kill rule fires |
| **3. Identity** | 0.5–1 | AC6/AC7, whitelist reload, dedupe | Denial before Login Success |
| **4. Parity** | 1 | M1 Vanilla AC1–AC5; unmodded confirmation AC9 | Reference parity |
| **5. Faults** | 1–2 | M5a–M5d, 3/3; optional latency/loss | No duplicate login, no stale cache |
| **6. Evidence** | 0.5–1 | Report, redaction, second clean run, one-page verdict | Gate B pass / partial / fail |

### One-week shape (the gate)

Day 0: user confirms accounts + host; this workspace caches M2/M1 and runs M0. Days 1–2: host benchmark and driver v0; auth. Days 3–4: M2 AC1–AC5 + 5-min soak; AC6. Day 5: M1 parity + unmodded confirmation; fault kick/restart if time; report and second run. **Output: Gate B pass on Paper + Vanilla, or a documented block/fail.** Fabric, Velocity, latency/loss, cluster custody, and decompiled source are explicitly not in this week.

### Three-week shape (hardening, only if the week suggests value)

Weeks 1–2: everything above with 2/2 and 3/3. Week 2: M3 Fabric, M5e latency/loss, AC7 denial robustness. Week 3: Velocity lane if the user's real target needs it, cluster path, evidence polish, and a deliberate re-run on a second host. **The three-week shape is hardening, not the gate.** If week 1 passes, Gate B is already passed; the extra lanes reduce residual risk and should be scheduled only if the user intends to deploy behind a proxy or on a modded server.

### Minimum demo (the thing a human watches)

Three minutes, M2 through Monoplayer: attach and render (screenshot), walk >1 block (RCON delta), break and place (screenshot + RCON), disconnect, wait a short interval (the real gate uses 5 minutes; the demo may show a 60 s cut with the soak run attached), reattach at the current pose, and show the report line `backendLogins == 1, attachCount == 2`. Then one unmodded run and the screenshot review.

### Non-goals (explicit)

- No production deployment, ingress, billing, multi-account pooling, or Deepmine Gate replacement.
- No Bedrock, cross-edition, modded-client compatibility, or resource-pack support.
- No chat beyond blocked/read-only; no secure-chat re-signing; no reporting/social UI.
- No version matrix, ViaProxy translation, 26.2/26.3, or protocol bump.
- No multiple simultaneous attaches, no second replica, no HPA.
- No decompiled-source pipeline, no generated Mojang code in git or CI.
- No public servers, anti-cheat bypass, or third-party accounts.
- No new product features during the gate; fixes are limited to what an AC exposes.

### Evidence bundle

`testdata/gate-b-report.json` plus `testdata/gate-b/artifacts/` (screenshots, redacted client/proxy/backend logs). Include: client + backend + Paper + Fabric/loader versions and checksums; `clientLane`; `twoAccount`; `secureProfile`; attach count; backend login count; per-AC result with measured values and timings; the exact commands; and a one-line verdict plus every descope. Artifacts containing account names/UUIDs stay out of git.

---

## D6 — Biggest risk and kill criteria

**Biggest risk: the client lane, not the protocol.** Monoplayer's protocol behavior is already proven at Gate A. What is unproven and expensive is whether an official 26.1.2 client can be run, driven, and observed deterministically on a host that does not exist yet, and whether the driver's 26.1 API calls produce exactly one serverbound action. The secondary risk is **gate drift**: accepting protocol-bot output or a modded-client pass as if it were the official-client claim.

**Kill criteria (numeric, pre-committed):**

| # | Trigger | Action |
|---|---|---|
| **K0** | Host readiness (G0) not achieved within **2 working days** of starting | Gate B **blocked**. Escalate host (rent a GPU/desktop VM). Do not substitute the bot lane. |
| **K1** | Driver cannot compile and run `status` + `move` + `break` + `screenshot` within **3 working days** of a ready host | Drop to **Gate B-Partial** (unmodded, no block-edit precision), record the reduced claim. Not a product failure. |
| **K2** | Official client cannot leave Loading terrain through Monoplayer on M2 while the direct-backend benchmark passes, after **2 fix cycles / 3 working days** | **Gate B FAIL.** Stop Node changes; re-open the substrate decision (Java/ZenithProxy). Do not extend the timeline to “just one more join field”. |
| **K3** | Movement desync or duplicate serverbound action persists after 2 fix cycles; or reattach is stale / second backend login appears | **Gate B FAIL** for that AC; if AC2 or AC5, the gate fails. |
| **K4** | Total spend exceeds **3 weeks** | Stop. Publish the honest partial report; decide deploy-vs-build with the evidence in hand. |
| **K5** | Any token, client/server jar, or decompiled source committed; or two writers on the puppet cache | **Stop-the-line** security/hygiene incident; rotate if needed; no further gate work until fixed. |

Descoping is not failing. **Failure** means a claimed invariant is false: no render, desync, stale reattach, second login, player identity at the backend, denial after Login Success. **Descope** means a lane that adds no invariant was not run.

---

## The strongest argument against my recommendation

*“You have turned a two-day falsifier into a three-week certification project.”* The decisive question is binary — can one official client attach to and drive the puppet's live session? — and the plan answers it on day 3 of week 1 with M2 alone. Everything after that (Vanilla parity, unmodded confirmation, five fault scenarios, two-account denial, evidence discipline, a display host, a driver mod) is insurance against failures that either (a) cannot happen once M2 passes, or (b) would not change the go/no-go. The unmodded lane is redundant because the driver never touches the network stack and every assertion is already cross-checked against RCON and the proxy. And the host is the expensive part: renting a GPU VM plus installing Prism, Xvfb, Mesa, Java 25, and a Fabric driver is likely more work than the product change the gate is meant to protect. A leaner gate — M2, driver only, AC1/AC2/AC4/AC5, one week — would produce the same decision with half the surface and none of the fault-matrix maintenance.

**My answer:** that critique is correct about the *three-week* shape and I have structured the memo around it — the gate is the one-week shape, and the extra lanes are explicitly a hardening tail that can be dropped. But the critique is wrong to drop the unmodded run and the 5-minute soak: those are the two claims the driver and Gate A respectively cannot make. Five seconds of Gate A soak does not prove the 5-minute window; a modded client does not prove the vanilla client. Those two are cheap and load-bearing. Vanilla parity and the fault matrix are the parts I would cut first if the week slips, and the AC table says so.

---

## What evidence would change my mind

1. **The direct-backend benchmark fails on the target host** (client never leaves Loading terrain, blank framebuffer, reconnect hangs). Then the host/client install is the problem, Gate B is blocked, and no Monoplayer run is interpretable.
2. **The driver produces duplicate or phantom serverbound actions** (e.g. one `break` yields two completed digs). Then the driver is not a valid measurement instrument; I would drop to Gate B-Partial and require unmodded evidence.
3. **M2 passes AC1–AC5 on the first attempt with no join-synthesis changes.** Then the three-week tail is unjustified; cut to the one-week shape and spend the time on the product slice.
4. **The user's real target backend is fixed behind Velocity or at 26.2/26.3.** Then M2 is not representative, the matrix changes, and Gate B must add the proxy or a translation decision before any pass claim.
5. **A second account is genuinely unavailable.** Then the identity-separation claim is impossible; Gate B-Partial (`twoAccount=false`) is the ceiling, and the council should explicitly accept that reduced claim or stop.
6. **`minecraft-data` 26.1.2 mappings prove wrong in M0.** Then pin the client to 26.1 exactly (still 775) or fix the protocol path before spending a client run.

---

## Confidence

**74 / 100** that Gate B, as scoped, is achievable in **one week** on a ready host with the stated evidence, and **85 / 100** that the scope and acceptance criteria are the right ones. The gap is entirely the unproven client lane: host provisioning, Prism/llvmpipe behavior, and 26.1 driver API fit are the three unknowns that no amount of research settles. If the host is available today and the driver compiles on day 2, I would raise this to 85. If the host is not available, the plan is still correct but the gate is blocked, and the honest status is “not started”, not “in progress”.

---

## Open items the user must decide (blocking)

1. **Host:** which machine runs the client, and when? GPU or Xvfb/llvmpipe? This is the only true schedule risk.
2. **Accounts:** confirm two Java-owned accounts, or accept `twoAccount=false` and the reduced claim.
3. **Proxy lane:** is the real target behind Velocity/Deepmine Gate? If yes, M4 moves into the mandatory set; if no, it stays deferred.
4. **Fabric:** is a modded server a real target? If yes, M3 is mandatory; if no, record the gap.
5. **Secure profile:** accept `enforce-secure-profile=false` as a recorded limitation if the puppet's certificate path fails, or treat it as a gate failure.
6. **Timeline:** accept the one-week gate with a three-week cap, or fund the three-week shape up front.
