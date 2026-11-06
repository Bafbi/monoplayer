# Council memo — Gate B testbed architecture

**Role:** testbed-architect
**Date:** 2026-11-05
**Target:** Minecraft Java **26.1.2 / protocol 775**
**Inputs:** `map.md`, tickets 01–05, `research/01`–`04`, `docs/gate-a.md`,
`docs/architecture.html` (§Validation loop, §Late attach, §Auth, §Lifecycle,
§Operations, §Risks).
**Status:** decision memo only. Nothing here is implemented.

---

## Recommended plan (one paragraph)

Run Gate B as a **single-host testbed on a dedicated, tailnet-visible display
host**: the real 26.1.2 official client (Prism 11.1.1, Java 25.0.2, Fabric
**Loader only** plus a small repo-owned `gate-b-driver` client mod) drives the
scenario over a loopback control socket, while **Monoplayer, Toxiproxy, and one
direct backend run on the same host** so the measured path contains only
injected latency. The **Fabric driver is mandatory as the assertion instrument**
(it is the only way to assert "left `DownloadingTerrainScreen`, level/player
alive, chunks rendered, hit result and block state" deterministically), but **one
unmodded vanilla Prism run is mandatory once per gate** as the anti-masking
witness. Mandatory backends are **Vanilla 26.1.2 and Paper 26.1.2 build 74**,
both direct, online-mode, secure-profile; **Fabric + Fabric API + Carpet is a
scheduled but non-gate-blocking third row**, and **Velocity is deferred to Gate
B.1** because it is a backend-compatibility claim, not a core attach claim. The
fault set is a small Toxiproxy subset on Paper: 100 ms ± 30 ms attach latency, a
5-second data-freeze, a JVM kill/restart, an RCON kick, and the **5-minute
detached soak with one world mutation** — because "the puppet outlives the
client and reattach lands on current state" is the product claim Gate B exists to
prove. The gate passes only when all mandatory rows pass twice consecutively
(fault rows three times), the identity-denial tests fire before `Login Success`,
the unmodded witness passes, and the evidence pack is complete. The homelab
cluster is **not in the Gate B v1 acceptance path**; it is the repeatability/soak
lane for Gate B.1. Decompiled source is a **local engineering convenience, not a
gate requirement**.

---

## What I actually verified (and the honest local constraint)

I re-checked the workspace rather than trusting the inherited notes:

| Check | Result | Consequence |
|---|---|---|
| `prismlauncher`, `xvfb-run`, `glxinfo`, `nvidia-smi` | none on PATH | No client lane here |
| `/dev/dri` | absent | No hardware GPU here |
| `free -h` | 7.9 GiB total, **3.0 GiB available**, 6.8 GiB swap used | Cannot host client + backend |
| `nproc` | 4 | llvmpipe client will be CPU-bound |
| `docs/gate-b-plan.html` | does not exist | This memo is input, not output |
| `deploy/` | does not exist in this repo | Cluster manifests are inherited research, not verified here |
| `git log` | one commit, Gate A harness | No product code to gate yet |
| `src/proxy.js` | `auth: 'offline'`, front `'online-mode': false`, forged profile | Every Gate B identity claim is new code |

So: **all client claims in this memo are plans against a host that does not yet
exist.** The cluster is asserted by research 02, but this repo has no manifests
and I did not verify cluster access. Confidence is set accordingly.

---

## Correction resolved: 26.1.2 is OpenGL, not Vulkan

`research/02-backend-matrix.md` §"Client footprint" says the 26.1 client needs a
**Vulkan 1.3-capable GPU**. That is wrong for the pinned client. The 26.1.2
version JSON contains only `lwjgl-opengl` and `lwjgl-glfw`; there is no
`lwjgl-vulkan`, and `--graphicsBackend` does not exist until **26.2**.
`research/01` is correct and supersedes it.

Consequences I am locking into the Gate B plan:

1. **Host qualification is OpenGL, not Vulkan.** The gate host must produce a
   GL context of **OpenGL 4.6 (or at least the version the 26.1.2 jar requests)
   via a real GPU or Mesa llvmpipe**. Run `glxinfo -B` and record the renderer
   string in the report. A Vulkan-only host is unqualified; do not substitute
   `--graphicsBackend`, and do not add it to launch commands.
2. **Software rendering is viable** (`LIBGL_ALWAYS_SOFTWARE=1`, llvmpipe), which
   removes the GPU from the critical path. It does **not** remove the RAM/CPU
   requirement: 4 cores and 8 GiB total is still not a client host.
3. The published "8 GB / 12 GB + Vulkan" system-requirements text is not
   authoritative for what the 26.1.2 jar loads. Pin the jar and test the jar.
4. Keep the host's renderer pinned and recorded. Screenshot comparisons are
   fuzzy (`assertScreenshotContains` / colour histogram); exact golden images are
   valid only on a pinned driver + Mesa image.

This correction is the one place where I override a research note and expect the
other council members to adopt it.

---

## Topology: where each piece sits

```
ONE GATE HOST (tailnet, display, 16 GiB+ recommended, OpenGL qualified)
┌───────────────────────────────────────────────────────────────────────────┐
│                                                                           │
│  Prism 11.1.1  ── real player MSA ──►  26.1.2 client + gate-b-driver      │
│        │  TCP 127.0.0.1:25565                                            │
│        ▼                                                                 │
│  Monoplayer (Node)                                                       │
│    front leg: online-mode=true, hasJoined, UUID attach whitelist          │
│    back leg:  puppet MSA, encryption, online-mode=true (M1/M2)            │
│        │  TCP 127.0.0.1:25570                                            │
│        ▼                                                                 │
│  Toxiproxy 2.13.0  (puppet leg only; loopback in, loopback out)           │
│        │  TCP 127.0.0.1:25571                                            │
│        ▼                                                                 │
│  One backend (Vanilla or Paper) :25565, RCON 127.0.0.1:25575             │
│    flat world, RD/SD 4, emptyDir-style temp world per row                 │
│                                                                           │
│  scenario controller (Node) ── driver socket 127.0.0.1:25599             │
│                             ── RCON 127.0.0.1:25575                      │
│                             ── Toxiproxy API 127.0.0.1:8474              │
└───────────────────────────────────────────────────────────────────────────┘

CLUSTER (NOT Gate B v1 acceptance path)
  namespace `monoplayer-gate-b` (never `monoplayer-dev`)
  Gate B.1 only: parallel rows, longer soaks, multi-node backend restarts
```

Rules that follow from this placement:

- **Toxiproxy is always on the puppet leg**, between Monoplayer and the first
  server-side hop. It is never on the front leg: faulting the client leg tests
  the client's tolerance, not Monoplayer's backend handling.
- If Velocity is ever added, it sits **behind** Monoplayer: Monoplayer →
  Toxiproxy → Velocity → Paper. The fault layer stays **before** Velocity, so
  the row faults the Monoplayer↔proxy hop. Faulting the Velocity↔Paper hop is a
  separate deferred row.
- **Front leg is loopback** in v1. This is deliberate: a tailnet front leg adds
  uncontrolled jitter to attach timing and doubles the ambiguity when the gate
  fails. A tailnet front-leg row is a deferred realism row, not v1.
- **RCON, Toxiproxy API, driver socket, Prism root, and token cache are loopback
  only.** No tailnet/pubic listener. Backend `enable-status` may be true on
  loopback only.
- The gate host needs egress to Microsoft/Mojang (Prism login, front-leg
  `hasJoined`, puppet refresh), so this lane is **inherently online** and cannot
  be reproduced in an offline CI worker.

Why single-host rather than the research-02 cluster split: the gate's failure
modes are timing/rendering/attach, and a two-machine split puts the tailnet
inside the exact intervals being asserted. The cluster is the right place for
repeatability and soak, not for the first real-client proof. This is a
deliberate dissent from research 02's topology.

---

## D1 — Official-client control strategy

**Decision:** **Prism 11.1.1 + 26.1.2 + Fabric Loader 0.20.1 + a loopback
`gate-b-driver` client mod is mandatory**, and **one unmodded vanilla Prism run
is mandatory once per gate**. `xdotool` is the input fallback inside the
unmodded witness, not the primary runner. Fabric Client Gametest, HeadlessMc,
and protocol bots are **pre-checks only** and can never produce a Gate B pass.

| Lane | Role | Gate B status |
|---|---|---|
| Prism 11.1.1 → 26.1.2 Fabric + `gate-b-driver` | Deterministic join/render/move/edit/disconnect/reattach assertions | **Mandatory instrument** |
| Prism 11.1.1 → 26.1.2 vanilla, `xdotool`/manual | Anti-masking witness; proves the unmodded input path and loader-free client | **Mandatory once per gate run** |
| Fabric Client Gametest (`runProductionClientGameTest`, `useXVFB`) | Fast offline regression; validates driver logic | Pre-check only |
| HeadlessMc 3.0.0-RC8 + hmc-specifics | State-machine smoke, no framebuffer | Pre-check only |
| `minecraft-protocol` bot | Protocol regression / proxy counters | Pre-check only (M0) |

**Why the driver is mandatory, not a fallback.** Without in-process state,
Gate B cannot distinguish "left `DownloadingTerrainScreen`" from "frozen loading
frame with a window". RCON + OCR + process liveness is exactly the anti-pattern
list in research 01. The driver gives `mc.screen`, `level`, `player`,
`hitResult`, block state, connection state, and a framebuffer screenshot at a
fixed size. That is the difference between a gate and a demo.

**Why the driver is kept minimal.** It must be a **client-only** mod that:

- builds against **Fabric Loader only** — do **not** add Fabric API; no
  `fabric-client-gametest` entrypoint is needed for the driver socket;
- adds **no mixins** into `Connection`, `ClientLoginNetworkHandler`,
  `ClientPlayNetworkHandler`, packet codecs, or the Netty pipeline;
- binds `127.0.0.1:25599` with a per-run random token and rejects non-loopback;
- injects movement through the **vanilla key-binding path** where possible and
  uses `MultiPlayerGameMode.startDestroyBlock` / `continueDestroyBlock` /
  `useItemOn` only for interaction (these are the same calls the vanilla input
  handler makes; they bypass the mouse event, not the protocol path);
- emits JSONL state and PNG screenshots into a run directory.

The remaining "modded client" risk is covered by the mandatory unmodded witness.
If the driver passes and the witness fails, the driver is masking; if the
driver fails and the witness passes, the driver is broken. Neither result may be
reported as a pass.

**Pins:** client 26.1.2 SHA-1 `4e618f09a0c649dde3fdf829df443ce0b8831e65`;
Java 25.0.2; Fabric Loader 0.20.1; Fabric Installer 1.1.2; Prism 11.1.1; Loom
1.19.3, Gradle 9.8.2, Vineflower 1.12.0 for the driver build. Do not add the
puppet account to Prism.

**What the driver must assert (the contract):**

1. `mc.screen == null && mc.level != null && mc.player != null` and connection
   not disconnected = left Loading terrain.
2. Chunks downloaded **and rendered** (`waitForChunksRender` if the gametest API
   is available in the driver's own code; otherwise a client tick + framebuffer
   sample). A non-blank screenshot alone is not enough.
3. Position delta on both client and backend (RCON `data get entity … Pos`).
4. `hitResult` is a block hit at the expected `BlockPos`/face before a click;
   block becomes air/stone on both client and backend; exactly **one** completed
   dig and one place/use-item action.
5. Disconnect reaches `DisconnectedScreen`/title; front leg ends; backend session
   persists; `backendLogins` unchanged.
6. Reattach reaches null screen + rendered chunks; pose matches pre-disconnect;
   the detached block mutation is visible; `attachCount + 1`,
   `backendLogins` still 1.

**Hard rule:** the driver never gets to be the only evidence. Every claim needs
client state + an independent server/proxy assertion + an artifact.

---

## D2 — Backend, proxy, and fault matrix

**Decision:** two mandatory direct backends (Vanilla, Paper), a small mandatory
Toxiproxy fault subset on Paper, and **no mandatory proxy**. Fabric is a
scheduled stretch row. Velocity, BungeeCord, ViaProxy, Deepmine Gate, and
`tc netem` are deferred.

### Backend rows

| ID | Row | Backend config | Status | Reps | What it buys |
|---|---|---|---:|---:|---|
| M0 | Paper direct, offline/insecure, Gate A fake client | `online-mode=false`, `enforce-secure-profile=false` | Prerequisite | 1 | Protocol regression before spending a real client |
| M1 | **Vanilla 26.1.2 direct** | `online-mode=true`, secure `true`, whitelist=puppet | **Mandatory** | 2 | Reference implementation; encryption, `hasJoined`, config/registry/chunk/keep-alive |
| M2 | **Paper 26.1.2 b74 direct** | `online-mode=true`, secure `true`, whitelist=puppet | **Mandatory** | 2 | Dominant production server; Paper config/chunk/message behaviour |
| M3 | Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 | `online-mode=true`, secure `true` | Scheduled, **not gate-blocking** | 2 | Modded registries/custom payloads. Carpet changes tick behaviour, so it cannot stand in for vanilla timing |
| M4 | Paper behind Velocity 4.3.1 modern forwarding | proxy online, backend offline/insecure | **Deferred (B.1)** | — | Backend-side proxy/forwarding identity |

**Is Fabric mandatory? No.** Research 02 argues it is cheap enough to be
mandatory; cheap to *run* is not the same as necessary to *claim*. The MVP
promise is "your own server on a pinned version", and Paper is the dominant
server. Fabric adds an independent failure source (loader, mod resolution,
Carpet tick changes) and proves a compatibility surface the product has not
promised. **Decision rule:** if a Fabric server is an advertised target at demo
time, M3 becomes mandatory; otherwise run it if it fits in 30 minutes and record
"Fabric server not covered" if it does not. A Fabric failure is a compatibility
finding, not a Gate B failure.

**Is Velocity mandatory? No.** It requires an offline/insecure backend plus a
forwarding secret, i.e. it stops testing the online-mode backend leg and starts
testing Velocity's forwarding. It sits *behind* Monoplayer, so it cannot
threaten the front-leg `hasJoined` claim. Add it only when a real target server
uses Velocity. When added: Monoplayer → Toxiproxy → Velocity → Paper, and the
fault layer stays before Velocity.

**Exact pins:** Vanilla server 26.1.2 SHA-1
`97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51`; Paper **26.1.2 build 74** SHA-256
`1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7` (there is no
Paper "26.1"; its line is 26.1.1/26.1.2, and 26.1.2 is EOL — keep it isolated);
Fabric Loader 0.20.1; Fabric API 0.155.3+26.1.2; Carpet 26.1. Java **25** only
(Java 21 fails `UnsupportedClassVersionError`; Java 26 is a smoke-test fact, not
a support statement).

**Required common config:** flat world, seed 775, `spawn-protection=0`,
`view-distance=4`, `simulation-distance=4`, `difficulty=peaceful`,
`gamemode=creative`, `white-list=true`, `enforce-whitelist=true`,
`advanced`/Paper defaults otherwise, `network-compression-threshold=256`,
`prevent-proxy-connections=false`, `pause-when-empty-seconds=0` on Vanilla
(Paper's default `-1` is acceptable), RCON on 127.0.0.1 with a per-run password,
`max-tick-time=-1` only on deliberate-stall rows with a documented caveat.

### Fault rows (all on M2/Paper, Toxiproxy on the puppet leg)

| ID | Fault | Exact toxic | Expectation | Status |
|---|---|---|---|---:|
| F1 | **5-minute detached soak** | none | Front leg ends; backend leg stays in play; proxy answers keep-alives; **RCON `setblock` while detached is visible after reattach**; pose current; `backendLogins == 1` | **Mandatory** |
| F2 | Attach latency | `latency` 100 ms ± 30 ms on upstream **and** downstream | Join/render within budget; no login/config timeout; no duplicate action | **Mandatory** |
| F3 | 5-second data freeze | `timeout` toxic with `timeout=0`, then remove | No backend drop; client freezes then resumes; no duplicate login; reattach state current | **Mandatory** |
| F4 | Backend process death | `SIGKILL` JVM while **detached**, restart | Exactly one reconnect (total logins 2), backoff, no hot loop; a client that attaches during the gap gets a clear failure | **Mandatory** |
| F5 | Backend kick | RCON `kick <puppet> gate-b` while attached | Clean client disconnect with reason; Monoplayer reconnects once (logins 2), no loop; no stale cache | **Mandatory** |
| — | 0.5 % loss / correlation | `packet_loss` | Retransmit/reorder, cache consistency | Deferred |
| — | Reset | `reset_peer` | Abrupt backend loss classification | Deferred (F4 covers the class) |
| — | 35–60 s timeout | `timeout` with a close timer | Keep-alive expiry, no silent stale cache | Deferred |
| — | Bandwidth / slow close | `bandwidth`, `slow_close` | Pacing | Deferred |
| — | `tc netem` | kernel qdisc | Realism check | Deferred; root-only, interface-wide |

Correction to research 02's fault table: **`down` is not a freeze.** Toxiproxy's
`down` closes the connection; use `timeout(0)` for a hold/freeze and reserve
`down`/`reset_peer` for drop scenarios. If you want a "server down for 5 s" test,
expect a backend reconnect, not a frozen-but-alive session — those are different
product claims.

**Reps:** baseline rows 2/2 consecutive; fault rows 3/3. A pass on one run is a
demo, not a gate. Keep the same world seed and config across reps.

**Why no chaos framework:** Toxiproxy + the process supervisor + RCON keeps the
fault schedule in the scenario log and is enough. Adding a framework adds a
failure surface without adding a claim.

---

## D3 — Two-account setup, token custody, whitelist, duplicate sessions

**Decision:** two **owner-operated** Microsoft accounts. **Puppet** = dedicated
alt, headless only, token held by Monoplayer. **Player** = the human's normal
account, Prism only, token held by Prism. The backend whitelist contains **only
the puppet**; the Monoplayer attach whitelist contains **only the player**. Both
keyed by Mojang UUID, resolved once at add time. For Gate B v1, the puppet token
lives **on the gate host** (`.secrets/puppet/`, `0700`/`0600`, gitignored, full
disk encryption, one writer, atomic write), **not** in the cluster. Move it to
the `monoplayer-puppet-auth` Secret only when Gate B actually runs in-cluster,
and only after verifying Talos secret-at-rest (or using an external store).

| Concern | Rule |
|---|---|
| Account topology | Two distinct MSAs, both own Java (not Game Pass), both 2FA, never shared/sold/transferred |
| Puppet login | `auth: 'microsoft'`, `flow: 'live'`, `profilesFolder: .secrets/puppet`, Java title `00000000402b5328` first, documented fallback to the library default if 403; record which worked |
| Puppet in Prism | **Never.** Prism's `accounts.json` is plaintext; a GUI puppet is also a duplicate session |
| Player in Monoplayer | Never. The player's credentials never reach the proxy; only `hasJoined` does |
| Token env vars | No. Pass the cache **path** (`PUPPET_AUTH_CACHE`), never the token |
| Writers | Exactly one process refreshes the puppet cache. `auth:status` is read-only; `--refresh` takes an exclusive lock and refuses while the proxy runs |
| Cache write | temp file + `fsync` + rename; never restore an old `.bak`; re-bootstrap on `invalid_grant` |
| Rotation window | Keep the refresh chain rolling; at least monthly with the proxy stopped |
| Attach deny | Close during login, **before `Login Success`**, log `attachDenied`, puppet untouched |
| Backend deny | Puppet off the backend whitelist → backend rejects the join; Monoplayer surfaces a health event and does **not** reconnect-loop |
| Single attach | One attached client at a time (architecture invariant); a second attach is rejected, not queued |
| One replica | One Monoplayer process; `replicas: 1`, `strategy: Recreate` if in-cluster; alert if pod count ≠ 1 |
| Duplicate kick test | Optional and destructive: a second process with a **copy** of the puppet cache. One session is kicked. This is a fixture, not a normal row, and it invalidates the copied cache |
| One-account fallback | Allowed for bring-up only; report `twoAccount=false`; it cannot pass the identity-separation assertions |

**Why local custody for v1:** Gate B is a testbed, not production. Keeping the
refresh token on the same single-user host as the proxy removes the cluster
Secret-at-rest problem and the write-back race from the critical path. The
cluster custody design is correct for Gate B.1/production, not for the first
pass.

**Honest limitation:** the player's token in Prism is plaintext on disk
(Prism #4073). Mitigate with a dedicated OS user, `0700`, disk encryption, no
cloud sync, and a separate Prism root (`-d .gate-b/prism-player`). This is an
accepted risk, not a solved problem.

---

## D4 — Decompiled-source workflow, repo layout, legal boundary, scope

**Decision:** **not Gate B scope.** It is a local engineering convenience with a
**30-minute timebox**, used only if the driver's 26.1.2 method signatures are
unclear. `minecraft-data` 3.119.0 + `javap` on the unobfuscated client jar are
the primary reference.

If used:

- **Decompile 26.1.2, not 26.1.** Research 04 pins 26.1 because protocol 775 is
  shared, but the driver and client under test are 26.1.2; class/method drift
  between patches is exactly the risk. Pin the patch the gate runs.
- Recipe lives in `tools/mc-source/{settings.gradle,build.gradle,gradle.properties}`;
  output lives in **`.cache/minecraft/26.1.2/`**; `.cache/` is gitignored.
- Plugin `net.fabricmc.fabric-loom` 1.19.3, Gradle 9.8.2, Java 25.0.2, no
  `mappings` line (26.1+ is unobfuscated and Yarn has no 26.1 branch),
  `genSourcesWithVineflower` (Vineflower 1.12.0), `jar xf` because `unzip` is
  missing.
- Do not commit the generated source, the jars, CI artifacts, container images,
  or large excerpts in issues. Commit the **recipe**, not the output. The
  decompiled code is Mojang's copyrighted code; local inspection on a licensed
  machine is the intended modding use, redistribution is not. This is not legal
  advice.
- Repo layout: `tools/gate-b-driver/` (tracked Gradle project, original code),
  `tools/mc-source/` (tracked recipe), `src/gate-b/` (Node scenario/auth),
  `.cache/` and `.gate-b/` (ignored runtime/evidence). The driver jar and the
  decompiled source are **build/cache outputs**, never tracked.

**Gate B can pass without a full decompile.** If a driver API is unclear, use
`javap -p` on the client jar first; it is faster and has no redistribution
question.

---

## D5 — Acceptance criteria, order of work, non-goals

### Pass definition

Gate B v1 **passes only if every mandatory item below passes**, with the stated
repetitions, and the evidence pack is complete.

| ID | Criterion | Threshold |
|---|---|---|
| **G0.1** | Protocol pre-check M0 still green | Gate A path against real Paper offline, 37/37-equivalent assertions |
| **G0.2** | **Plain-server client falsifier** (no Monoplayer) | Join → render → move → break → place → disconnect → reconnect, **2/2** |
| **G0.3** | Auth falsifier (ticket 03 §10) | Device code once, silent refresh twice with same UUID, two distinct UUIDs admitted/denied at a real `hasJoined` fixture |
| **G0.4** | Unmodded witness on the plain server | Join/render/move/disconnect/reattach, 1/1 |
| **B1** | **Vanilla 26.1.2 direct**, full scenario | 2/2 consecutive; `backendLogins == 1`; pose and block edit persist |
| **B2** | **Paper 26.1.2 b74 direct**, full scenario | 2/2 consecutive; same assertions |
| **B3** | Resilience block F1–F5 on Paper | 3/3 each; F1 includes the detached `setblock` visibility assertion |
| **B4** | Identity denial | Attach denied before `Login Success`, no relay, puppet untouched; backend denial prevents the puppet session, no reconnect loop |
| **B5** | **Unmodded witness through Monoplayer** | 1/1: join/render/move/disconnect/reattach; block edit optional/manual |
| **B6** | Evidence pack | Report JSON with pins/host/renderer/`clientLane`/`twoAccount`/fault schedule, screenshots, client log, proxy/backend logs, Toxiproxy state, redacted identifiers |

**Fatal anomalies — any one fails the gate:**

1. Client stuck on "Loading terrain…" or in configuration past **120 s** on a
   mandatory row, when the plain-server baseline passed.
2. A second backend login caused by attach/detach (F1–F3), or more than one
   reconnect on F4/F5.
3. Movement or a block edit reaching the backend **zero or twice**.
4. The backend ever seeing the **player's** UUID/name.
5. A detached world mutation not visible after reattach.
6. Any token, refresh token, device code, or RCON password in logs/artifacts.
7. A crash of Monoplayer/backend on a mandatory row that is not the injected
   fault.
8. Driver passes but the unmodded witness fails (masking) — gate blocked until
   reconciled.

**Explicit descopes (do not fail the gate, must be reported):** Fabric row
missing; Velocity/Bungee/ViaProxy missing; chat blocked; no secure-chat
re-signing; no resource packs; no multi-client; no 60-minute soak; no
performance numbers.

### Order of work (one week if the host exists)

| Step | Work | Exit criterion | Time |
|---:|---|---|---:|
| 0 | Provision the gate host; Java 25.0.2, Prism, GL/GLX libs, Xvfb+Mesa fallback, tailnet; `glxinfo -B` recorded | OpenGL qualified; client launches to title | 0.5 d |
| 1 | Build `tools/gate-b-driver` (Loader only, loopback socket, no mixins); install in the Prism instance | Driver answers `status`; no network modification | 0.5–1 d |
| 2 | **G0.2 plain-server falsifier** (no Monoplayer) | 2/2 in one session | 0.5–1 d |
| 3 | **G0.3 auth falsifier**; bootstrap puppet; resolve both UUIDs; whitelists | Silent refresh + two-UUID admission/denial | 0.5 d |
| 4 | Wire Gate A proxy to real Paper: puppet Microsoft auth + encryption, front `online-mode=true` + `hasJoined` + UUID whitelist, **cached config replay** | First real client reaches play through Monoplayer | 1–2 d |
| 5 | B1 Vanilla, then B2 Paper, full scenario incl. **5-minute soak + detached mutation** | 2/2 each, `backendLogins == 1` | 1 d |
| 6 | B3 faults F1–F5 | 3/3 each | 1 d |
| 7 | B5 unmodded witness through Monoplayer; B6 evidence pack; verdict | Pass or documented fail | 0.5–1 d |
| B.1 | Fabric row, Velocity row, cluster repeat lane | Separate gate | later |

**The unknown that can eat the week is step 4: config-phase replay.** Gate A
explicitly did not exercise it, and the front server auto-configures from
`minecraft-data`. A real 26.1.2 client validates registry data, tags, known
packs, and resource-pack state during configuration; if the replay is wrong, the
client hangs before play and the failure looks identical to a join-synthesis
bug. Budget for it; do not treat it as a detail.

### Non-goals (explicit)

- No version matrix: no 26.2+, no 26.3, no ViaProxy translation, no older backend.
- No BungeeCord, no Fabric-behind-Velocity, no Deepmine Gate proxy, no Velocity
  in v1.
- No chat: blocked/read-only; no secure-chat re-signing, no `last_seen` state
  machine.
- No modded **client** compatibility; the Fabric driver is test instrumentation,
  not a supported client, and Carpet is a server test fixture.
- No multiple simultaneous clients, no attach-token second factor, no resource
  packs, no IPv6/SRV/TLS, no Bedrock.
- No online-mode runs with real tokens in CI; no tokens in CI at all.
- No production deploy, public ingress, HA, multi-account pooling, billing.
- No performance/load/soak gate beyond the 5-minute window (that is a later
  soak gate).
- No decompiled code or Minecraft jars in git, CI artifacts, images, or issues.
- No anti-cheat, ban, or access-control evasion.

---

## D6 — Biggest risk and kill criterion

**Biggest risk: the gate's measurement instrument is itself the unproven thing.**
The client lane does not exist on any verified host, the driver is new code
against a new (unobfuscated) API, and the only anti-masking control is a single
manual unmodded run. A flaky or masking client lane produces the worst outcome:
a confident pass or a confident failure that says nothing about Monoplayer. The
product-side risk this gates is **config-phase replay + synthesized join
acceptance**: if the real client rejects the replayed configuration, the core
architecture claim is in question.

**Kill / block criterion (instrument):**

- If **G0.2 (plain-server client falsifier) does not pass 2/2 within 3 working
  days** on the provisioned host, **stop Gate B**. Fix or replace the client
  lane; do not run Monoplayer rows. This is a *block*, not a product verdict.
- If the **unmodded witness fails while the driver passes**, treat driver-only
  evidence as invalid and block the gate until reconciled. Do not average them.
- If the **driver cannot be built** against 26.1.2 within 2 days, switch the
  primary to the unmodded `xdotool` lane, accept manual block-edit checks, and
  lower the gate's claim — do not add network mixins to "fix" it.

**Kill criterion (product, at B1):**

- If B1 (Vanilla direct) cannot get the real 26.1.2 client to a null screen with
  rendered chunks after the instrument is green and config replay has had a
  bounded 2-day fix window, **treat the synthesized-join path as failed** and
  escalate the Gate A substrate pivot (Java/MCProtocolLib or ZenithProxy). This
  is the architecture's original kill criterion, now measured on the real
  client.

Do not let a chat failure, a Fabric failure, or a Velocity failure trigger
either kill; those are descopes.

---

## Decision table

| ID | Question | Call | Mandatory | Fallback / deferred | Conf. |
|---|---|---|---|---:|---:|
| **D1** | Official-client control | Prism 11.1.1 + 26.1.2 + **Fabric Loader-only driver** as the assertion instrument; one **unmodded vanilla witness** per gate | Driver, witness, online front leg | `xdotool` input; gametest/HeadlessMc/protocol bot pre-checks | 78 |
| **D2** | Backend/proxy/fault matrix | **Vanilla + Paper direct** mandatory; Toxiproxy fault subset F1–F5; **no mandatory proxy** | M1, M2, F1–F5, M0 pre-check | Fabric row (non-blocking), Velocity/Bungee/ViaProxy, loss/reset/bandwidth/netem | 72 |
| **D3** | Accounts, custody, whitelist | Two owner-operated MSAs; puppet headless only; **local `.secrets/` custody** for v1; two UUID whitelists; one writer/one replica | Two accounts, two whitelists, denial tests, single writer | One-account smoke (`twoAccount=false`); cluster Secret + external store for B.1 | 85 |
| **D4** | Decompiled source | **Not gate scope**; recipe-only, `.cache/`, 26.1.2, local inspection, never commit | `minecraft-data` + `javap` | Full Loom/Vineflower decompile, 30-min timebox | 88 |
| **D5** | Acceptance/order | G0.1–G0.4 prerequisites; B1–B6; 2/2 baseline, 3/3 faults; fatal-anomaly list; ~1 week | G0.2, G0.3, B1–B6 | Fabric/Velocity/cluster repeat in B.1 | 74 |
| **D6** | Risk/kill | Instrument credibility is the top risk; product kill is config replay at B1 | Plain-server 2/2 in 3 days; witness reconciliation; B1 2-day config-replay window | — | 76 |

---

## Strongest argument against my recommendation

**"A gate whose instrument modifies the client is not a gate on the official
client."** The Fabric driver is a mod. It changes classloading, adds a mod
loader, and calls `MultiPlayerGameMode` directly, bypassing the mouse/keyboard
path a real player uses. If the vanilla client rejects Monoplayer's config replay
or synthesized join in a way Fabric Loader happens to tolerate — or if the
driver's direct interaction calls mask a client-side prediction bug — Gate B
passes while the product fails for every real user. The unmodded witness is one
manual run, which is exactly the kind of single sample that cannot carry the
gate's credibility. On this argument, the honest primary is the unmodded client
driven manually or with `xdotool`, with the driver demoted to a debugging aid.

**Why I still recommend the driver as mandatory:** the alternative is not a
purer gate; it is a manual, flaky gate that cannot assert block edits or
"chunks rendered" reliably, and therefore cannot produce a falsifiable verdict
at all. The witness is not there to be a statistically strong sample; it is
there to detect a *categorical* masking effect (driver passes / vanilla fails),
which one run can do. The correct response to the argument is to make the driver
as thin as possible (Loader only, no mixins, no Fabric API, vanilla interaction
calls), record `clientLane` in every report, and treat any driver/witness
disagreement as a block rather than a vote. I accept the residual risk and
would rather have a thin instrument plus a categorical witness than a manual
gate.

**Second-strongest argument:** the single-host topology is less production-like
than the cluster split, so a pass may not transfer to the deployed shape. I
accept that; the cluster shape is a deployment concern already covered by L3/L4,
and putting the tailnet inside the measured attach interval would make failures
ambiguous. Gate B.1 adds the cluster repeat.

---

## Evidence that would change my mind

1. **Plain-server falsifier fails 2/2** on a qualified host → client lane/host is
   the problem; stop and fix, do not proceed. If it cannot be fixed in the
   timebox, Gate B is blocked and the whole real-client gate needs a different
   host.
2. **Unmodded witness fails while the driver passes** (or vice versa) → driver is
   masking or broken; demote/replace the driver and re-run. If the unmodded lane
   is the only one that works, make it primary and accept manual edit checks.
3. **Prism + llvmpipe joins in < 60 s and survives 5 minutes repeatedly** →
   software rendering becomes the default, and the GPU requirement disappears
   from the host spec.
4. **Config replay passes on Vanilla but fails on Paper** (or vice versa) →
   Paper-specific config differences become the priority; keep both mandatory
   and add a config-diff investigation before more rows.
5. **A real target server is behind Velocity** → promote M4 to mandatory and
   move the fault layer before Velocity.
6. **The gate host has ≥ 16 GiB and a GPU** → single-host is obviously correct;
   if it has 8 GiB, the backend must move to the cluster and the topology splits
   (with the tailnet-jitter caveat recorded).
7. **The driver cannot be built in 2 days** → switch to the unmodded primary and
   lower the gate's claims; do not add network mixins.
8. **Fabric row passes in < 30 minutes** → keep it in the evidence pack but do
   not make it gate-blocking; the marginal claim is still small.
9. **Paper 26.1.2 build 74 becomes unavailable or a security issue forces a
   version move** → that is a new gate (protocol 775 pin is broken); do not
   silently drift to 26.2/26.3.

---

## Confidence

**76 / 100.**

The topology, the OpenGL correction, the two-account custody, and the
decompiled-source boundary are high confidence (85–90). The backend set and the
single-host choice are medium (70–75) because they depend on what the product
actually promises and on an unverified host. The overall number is held down by
one fact: **this workspace cannot run the client, and no Gate B host,
manifests, driver, or config replay exists yet.** The plan is decision-ready,
not evidence-ready. If G0.2 passes 2/2 on a provisioned host, I would raise this
to the mid-80s; if config replay fails at B1, the substrate question reopens and
the number is irrelevant.

---

## Open items for the grilling / council

1. **Host ownership:** who provisions the display host, and is a GPU available?
   This is the only prerequisite that cannot be solved by code.
2. **Product claim for Fabric servers:** if modded servers are a target, M3
   becomes mandatory. The map does not say.
3. **Fault policy semantics:** for F5 (kick) and F4 (restart), is "reconnect
   once with backoff" the intended product behaviour, or should Monoplayer
   surface a terminal state and wait for the client? Gate B needs one answer.
4. **Detached mutation:** is cache-coherence for a block changed while detached
   in Gate B, or a later gate? I put it in F1 because "current state" is the
   architecture's promise; if the council descopes it, Gate B is weaker.
5. **Evidence retention:** Gate B reports contain owner UUIDs/names. Confirm the
   evidence directory is gitignored and only redacted summaries are committed.
