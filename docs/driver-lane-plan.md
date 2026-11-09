# Monoplayer driver lane

*Driver lane · testbed plan · draft for decision*

> **Historical plan, written for 26.1.2 / protocol 775.** The lane moved to
> 26.2 / 776 in [#71](https://github.com/Bafbi/monoplayer/issues/71); the
> present-tense facts below describe the environment as it stood when this plan
> was written. [driver-lane.md](driver-lane.md) is the runbook that tracks it.

Real client, real accounts, real backends. The next gate is not another
protocol harness; it is the first time the product has to survive Minecraft as
a player experiences it. This plan separates the instrument from the evidence,
keeps the matrix small, and names the host that has to exist before anything
can pass.

- Draft for decision
- 26.1.2 / 775
- Official client + Prism
- Vanilla + Paper core
- Paper behind Velocity is the target

Prepared 5 November 2026 · Updated 6 November 2026 · Research: 4 delegates ·
Decision council: 3 delegates · Status: G0 PASS · G1 PASS · M4 proxy lane up ·
Gate A: 37/37 protocol assertions

## Executive summary

**Gate B is a testbed, not a feature**

Gate A proved the relay mechanics with protocol clients. Gate B must prove the
thing a player will actually do: an official 26.1.2 client, with a real
Microsoft session, attaches through Monoplayer, renders the puppet's world,
controls it, detaches, and reattaches without a second backend login.

| Aspect | Value | Note |
| --- | --- | --- |
| Client | Prism + driver | Unmodded witness mandatory |
| Backends | Vanilla + Paper | Fabric compatibility lane |
| Network | Toxiproxy | Proxy lane behind Monoplayer |
| Accounts | Two MSAs | Puppet + player, separate UUIDs |

> **The recommendation in one paragraph**
>
> Put the official client on `nath` with Prism 11.0.3 (11.1.1 is current) and
> a thin client-only Fabric driver. Because the real target is **Paper behind
> a proxy**, make **Monoplayer → Toxiproxy → Velocity → Paper 26.1.2** the
> pass path; the direct Paper client row is only the G0 host baseline. Keep
> **Vanilla 26.1.2 direct** as reference parity and the **Fabric** server as a
> required compatibility report. Require an **unmodded** Prism run as the
> anti-masking witness. Keep the decompiled-source workflow outside the gate.
> The gate is a one-to-two-week verdict, with a separate hardening tail.

> **What changed since Gate A**
>
> Gate A passed 37/37 on loopback. It did not exercise encryption, online-mode
> `hasJoined`, Microsoft auth, secure chat, config-phase replay, or a real
> client. Gate B is where those become falsifiable. The biggest product risk
> is no longer the relay; it is whether a real client accepts the synthesized
> configuration and join on a real backend.

## Live status · 6 November 2026

**G0 passed: host readiness**

The host and cluster are no longer hypothetical. A Paper 26.1.2 backend is
running in `monoplayer-gate-b`, exposed on Tailscale, and an official 26.1.2
Prism client has joined it directly.

| Item | Actual | Note |
| --- | --- | --- |
| Display host | nath | Omarchy, Hyprland, AMD Radeon, 14 GiB |
| Backend | Paper 26.1.2 | `monoplayer-gate-b`, online-mode |
| Client | Prism 11.0.3 | 26.1.2, Java 25, joined |
| Next | B1 live / B2-B3 | Monoplayer + Vanilla + faults |

> **Proven now**
>
> - `nath` is a qualified display host: Hyprland Wayland, XWayland `:0`, AMD
>   Radeon (OpenGL 4.6), 12 cores, 14 GiB RAM.
> - Prism 11.0.3 has a 26.1.2 instance and a Java 25 runtime; the official
>   client launched.
> - Paper 26.1.2 build 74 is running in `monoplayer-gate-b`, online-mode and
>   secure-profile, at `monoplayer-gate-b-paper.tail41e568.ts.net:25565`.
> - The official client connected and the backend saw `Bafbi` join; the client
>   log says “Bafbi joined the game”.

> **G0 result**
>
> G0 passed on 2026-11-06. The repeatable driver-lane runner passed 2/2
> consecutive runs with 38/38 assertions each, including server-side movement,
> break, place, disconnect, and rejoin checks. The mandatory unmodded Prism
> witness also passed join, render, move, break, place, screenshot,
> disconnect, and rejoin. Runbook and evidence: `docs/driver-lane.md`,
> `testdata/driver-verdict.md`.

> **G1 + M4 · 7 November 2026**
>
> The puppet is bootstrapped headlessly as `GlowSquidye` with the working
> Switch/Nintendo title, java=owned, multiplayer=allowed, and a stable UUID
> across silent refreshes. The real online-mode hasJoined + attach whitelist
> allowed the player and denied it before play after removal. Velocity 4.3.1
> b45 is in front of Paper 26.1.2 b74 with modern forwarding; the
> authenticated puppet joined through the proxy. Evidence:
> `testdata/custody-verdict.md`, `testdata/m4-verdict.md`.

Backend launcher: [deploy/driver/README.md](../deploy/driver/README.md).
Client instance: `gate-b-player` under Prism's instance directory.

## The host

**The host exists. The workspace still cannot run the client.**

Gate B now has two machines: the display host `nath` and the cluster namespace
`monoplayer-gate-b`. The coding workspace still cannot run the official
client; that is fine, because it no longer has to.

| Check | Actual | Gate B consequence |
| --- | --- | --- |
| Display host | `nath`, Omarchy/Arch, Hyprland Wayland, XWayland `:0` | Official client runs here; `grim`, `wtype`, `ydotool` available. |
| GPU / renderer | AMD Radeon (Rembrandt), OpenGL 4.6 via Mesa `radeonsi` | Hardware-accelerated 26.1.2; no llvmpipe needed. |
| CPU / RAM | 12 cores, 14 GiB total, ~8 GiB available | Client + local proxy fits; backend is on the cluster. |
| Launcher | Prism 11.0.3; Java 25 runtime (epsilon 25.0.1); `gate-b-player` 26.1.2 instance created | Real Microsoft session; official client launches. |
| Cluster | Talos, 2×32 GiB nodes; `monoplayer-gate-b` created; Paper 26.1.2 b74 running | Backends, Monoplayer, Toxiproxy can run here; client stays on `nath`. |
| Coding workspace | No display/GPU/launcher; ~3.4 GiB free | Keep it for code, protocol tests, reports, and cluster access. |

> **G0 evidence bundle**
>
> Driver lane: two consecutive reports with 38/38 assertions each,
> server-verified move, break, place, disconnect, and rejoin, plus
> screenshots. Unmodded witness: the official client joined Paper 26.1.2
> through `monoplayer-gate-b-paper.tail41e568.ts.net:25565`, rendered, moved,
> broke, placed, disconnected, and rejoined; the Paper log shows the
> disconnect/rejoin pair. Renderer: AMD Radeon Graphics (radeonsi, Rembrandt),
> OpenGL 4.6 Mesa 26.2.2. Route: Tailscale direct. Verdict:
> `testdata/driver-verdict.md`.

> **Correction: 26.1.2 is OpenGL**
>
> The 26.1.2 version JSON contains only `lwjgl-opengl` and `lwjgl-glfw`.
> Vulkan and `--graphicsBackend` arrive in 26.2. The host reports OpenGL 4.6
> via Mesa; record the renderer from `glxinfo -B` in the evidence. Do not add
> a Vulkan requirement or a graphics-backend flag.

## The pass claim

**One sentence, no ambiguity**

**Gate B passes when** an official Minecraft Java 26.1.2 client, launched from
Prism with a real Microsoft session, joins Monoplayer's `online-mode=true`
front leg, is admitted by real `hasJoined` and the UUID attach whitelist,
controls the puppet through **join → render → move → break → place → 5-minute
detach → reattach at current pose** against a real **Paper 26.1.2 server
behind Velocity**, with **exactly one backend login across the attach/detach
cycle** (fault rows may have one deliberate reconnect, total two, never a
loop), the player UUID never reaching the backend or proxy as a separate
player, and a non-whitelisted account denied **before Login Success**; the
core scenario is also observed once with an **unmodded** client, and every
claim is backed by client state, independent server/proxy state, and a visual
artifact.

### What the sentence deliberately excludes

- Chat, resource packs, and secure-chat re-signing.
- Multiple simultaneous clients or multi-account pooling.
- 26.2/26.3, ViaProxy, Bedrock, and version translation.
- Production deployment and public ingress.
- Fabric results as gate-blocking claims.

### What cannot be descoped

- The official client, not a protocol bot.
- Online-mode `hasJoined` on the front leg.
- Two distinct accounts and two separate whitelists.
- Exactly one backend login across attach/detach.
- Five-minute detach and current-pose reattach.
- The unmodded witness.

## Topology

**Client on nath, backend on the cluster**

The split is now real: Prism and the official client stay on the laptop; the
backend, Monoplayer, and Toxiproxy live in `monoplayer-gate-b`. The cluster is
on the same LAN, and Tailscale currently routes directly, so the path is
acceptable for Gate B. Record the route and latency in every report.

```text
nath - display host                    monoplayer-gate-b - cluster
  Prism 11.0.3                           Monoplayer -> Toxiproxy -> Paper 26.1.2 b74
  official 26.1.2 client                 front leg: online-mode, hasJoined, whitelist
  real player Microsoft session          back leg: puppet Microsoft auth
  optional gate-b-driver                 faults: latency, freeze, timeout
    loopback JSON, screenshots           scenario controller: RCON, reports
  grim, wtype/ydotool

G0:     Prism --direct------------------------> Paper
Gate B: Prism --Tailscale--> Monoplayer --> Toxiproxy --> Paper
```

The client stays on `nath`; the cluster holds the backend and, later,
Monoplayer and Toxiproxy. A server-side proxy, if used, goes behind
Monoplayer, never in front.

### Why this split works

The laptop has the GPU, display, and Prism; the cluster has the CPU, memory,
and stable backend lifecycle. The cluster is on the same LAN and Tailscale
currently routes directly, so the extra hop is acceptable for the first
real-client gate. Record the route; do not pretend it is loopback.

### Measurement note

Every report must record the client host, the backend node, the Tailscale path
(`direct` vs `relay`), and the measured attach time. If the path relays or the
LAN becomes noisy, the fault-latency rows are the first ones to distrust.

## Client control

**The driver is the instrument. The unmodded run is the witness.**

A process being alive is not a pass. Gate B needs to know the client left
`DownloadingTerrainScreen`, has a level and player, rendered chunks, aimed at
a real block, and sent a vanilla interaction. That is a client-state
assertion, not a screenshot.

| Lane | What it proves | Gate B status |
| --- | --- | --- |
| **Prism 11.0.3 + 26.1.2 + `gate-b-driver`** | Real Microsoft session; official client; deterministic join/render/move/edit/disconnect/reattach; screenshots. | Mandatory instrument |
| **Prism vanilla 26.1.2 + Xvfb + xdotool** | Unmodded client path; anti-masking witness; real render and input. | Mandatory once per gate |
| **Fabric Client Gametest** | Tick-stepped input, chunk render waits, screenshots; offline/in-process. | CI pre-check only |
| **HeadlessMc + hmc-specifics** | Headless state machine, console commands; no framebuffer. | Pre-check only |
| **Protocol bots** | Packet legality, proxy/backend counters, cache contents. | Pre-check only |

### The driver contract

A client-only Fabric mod. Loader only; no Fabric API; no mixins into
`Connection`, `ClientLoginNetworkHandler`, `ClientPlayNetworkHandler`, packet
codecs, or Netty. It binds `127.0.0.1:25599` with a per-run token and exposes
newline-delimited JSON: `status`, `look`, `move`, `break`, `place`,
`disconnect`, `reconnect`, `screenshot`, `quit`.

It reads `Minecraft.getInstance()` and calls the vanilla interaction path for
block edits. It does not receive, log, or store the player's access token.
Every assertion records `clientLane: driver | unmodded | offline-precheck`.

> **Anti-masking rule**
>
> The driver is a mod, so it can mask a vanilla bug. One unmodded Prism run is
> mandatory. If the driver passes and the unmodded run fails, the gate is
> **blocked**, not passed. If the driver fails and the unmodded run passes,
> the driver is broken; fix it or demote it, do not average the results.

### Why not xdotool as the primary?

`xdotool` sends XTEST events to the focused window. Minecraft's GLFW window
can lose focus, the pointer is grabbed in-game, mouse-look is relative, and
the loading/disconnect screens change what a click means. Synthetic
`XSendEvent` is often ignored by GLFW. The result is a runner that fails on
window-manager timing, not on Monoplayer. `xdotool` is the unmodded witness
fallback, not the primary instrument.

## Backend matrix

**Paper behind Velocity is the pass path**

Your real target is a Paper server behind a proxy, so that path is the pass
path. Direct Paper is only the G0 host baseline. Vanilla is reference parity;
Fabric answers “does the modded server path break?” and stays a compatibility
report.

| ID | Row | Config | Status | Why |
| --- | --- | --- | --- | --- |
| M0 | Paper 26.1.2, offline, Gate A fake client | `online-mode=false`, insecure | Pre-check | Protocol regression before spending a real client run. |
| M1 | Vanilla 26.1.2 direct | online + secure, whitelist = puppet | Mandatory parity | Reference implementation: encryption, `hasJoined`, config, chunks, keep-alive. |
| M2 | Paper 26.1.2 build 74 direct | online + secure, whitelist = puppet | G0 baseline | Proves host/client/Paper before Monoplayer and Velocity are involved. |
| M3 | Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 | online + secure | Required report, not gate-blocking | Modded loader/registries/custom payloads; Carpet changes ticks, so it cannot stand in for vanilla timing. |
| M4 | Paper behind Velocity 4.3.1 | proxy online; backend offline/insecure, modern forwarding | Mandatory pass path | Your real target: forwarding/UUID identity, online-mode split, server-side proxy. |
| M5 | Paper behind Velocity + faults | as M4 | Mandatory subset | Five-minute detach, kick, restart, keep-alive expiry, latency/freeze on the proxy path. |

### Pins that matter

| Term | Detail |
| --- | --- |
| Vanilla | 26.1.2, SHA-1 `97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51` |
| Paper | 26.1.2 build 74, SHA-256 `1d70b1…e5f7` (no Paper “26.1”; 26.1.2 is EOL but protocol 775) |
| Fabric | Loader 0.20.1, API 0.155.3+26.1.2, Carpet 26.1 |
| Java | 25 — host has 25.0.1; 25.0.2 is the build pin. Java 21 fails class-file 69. |
| Velocity | 4.3.1 build 45 (core proxy; modern forwarding) |
| Toxiproxy | 2.13.0 |

### Common server config

Flat world, seed 775, `view-distance=4`, `simulation-distance=4`,
`spawn-protection=0`, `difficulty=peaceful`, `gamemode=creative`,
`white-list=true`, `enforce-whitelist=true`,
`network-compression-threshold=256`, `prevent-proxy-connections=false`, RCON
on localhost with a per-run password. Paper's `pause-when-empty-seconds=-1` is
fine; Vanilla should use `0`.

> **Fabric is compatibility; Velocity is core**
>
> Run Fabric and report the result. A Fabric failure is a compatibility
> finding; it does not fail the core Gate B pass unless the product claims
> Fabric servers. Velocity is now part of the pass path because your real
> target is Paper behind a proxy. Configure modern forwarding, keep the
> backend offline/insecure, and keep Velocity behind Monoplayer.

## Proxy & faults

**Faults belong on the puppet leg**

A fault on the client leg tests the client's tolerance. A fault on the puppet
leg tests Monoplayer's session ownership. Gate B cares about the latter.

Monoplayer back leg → Toxiproxy → Velocity → Paper / Vanilla / Fabric

| Fault | Shape | What it proves | Reps |
| --- | --- | --- | --- |
| **F1 — five-minute detach** | No fault; client closes; backend stays; RCON `setblock` while detached | Puppet survives; keep-alives answered; reattach sees the mutation and current pose; one backend login. | 3/3 |
| **F2 — attach latency** | `latency 100ms ± 30ms` both directions | Login/config/join timeouts; chunk pacing; no duplicate action. | 3/3 |
| **F3 — five-second freeze** | `timeout(0)`, then remove | Client freezes and resumes; no backend drop; no duplicate login. | 3/3 |
| **F4 — backend death** | `SIGKILL` JVM while detached; restart | Exactly one reconnect; backoff; no hot loop; clear failure if attach arrives during the gap. | 3/3 |
| **F5 — backend kick** | RCON `kick <puppet> gate-b` | Defined front disconnect; one reconnect; no stale cache. | 3/3 |
| **F6 — keep-alive expiry** | `down` 60 s, then restore | Front disconnect reason; no silent stale cache; one backend login. | 3/3 |

> **Hard rule**
>
> A server-side proxy goes **behind** Monoplayer, on the puppet leg. In front,
> it terminates the player's login before Monoplayer's `hasJoined`, which
> makes the attach whitelist meaningless. A proxy in front is a configuration
> error, not a variant.

### Why not a chaos framework or `tc netem` first?

Toxiproxy is a single static binary with an HTTP API and deterministic toxics.
It keeps the fault schedule in the scenario log and needs no root. `tc netem`
is the optional kernel-realism check: root-only, interface-wide, and harder to
make per-flow. Add it later if you need qdisc realism, not for the first gate.

## Two accounts

**The backend sees the puppet. The front leg sees the player.**

Gate B needs two distinct, owner-operated Microsoft accounts. One account
cannot prove identity separation: the same UUID on both sides masks the exact
failure the gate exists to catch.

### Puppet

- Dedicated alt; headless only; never in Prism.
- Device-code bootstrap, then rolling refresh token in `.secrets/puppet/`.
- One writer: the proxy. `auth:status` is read-only; `--refresh` needs a lock.
- Backend whitelist contains the puppet only.
- Owns Java Edition and has multiplayer enabled.

### Player

- Your normal account; added to Prism only.
- Never logs into the backend; only the front leg.
- Attach whitelist contains the player only.
- Prism stores tokens in plaintext today; keep the root private and
  disk-encrypted.
- One Prism instance per account; no duplicate GUI puppet.

### The user flow

1. **Verify both accounts:** Java ownership, profile UUID, multiplayer
   privilege, 2FA, Xbox profile.
2. **Bootstrap the puppet:** `mise run auth:device-code --account puppet`;
   approve in a browser/phone within 15 minutes.
3. **Sign into Prism** with the player account only; create the 26.1.2
   instance; pin the account.
4. **Add the two whitelists:** backend = puppet UUID; attach = player UUID.
   Never merge them.
5. **Run the gate:** Prism joins `127.0.0.1:25565`; the scenario drives the
   rest.
6. **Review evidence:** screenshots, report JSON, redacted logs.

> **Duplicate-session rules**
>
> - One proxy process, one replica, one token writer. Two refresh loops race
>   the rolling token.
> - Never run a GUI client as the puppet while the proxy is live.
> - Never point the player at the backend directly.
> - A one-account run is a labelled smoke (`twoAccount=false`), never a Gate B
>   pass.

> **Token boundary**
>
> The refresh token is the password. It lives only in `.secrets/` (local Gate
> B) or the untracked `monoplayer-puppet-auth` Secret (later deploy). Pass the
> cache **path**, never the token. No token, device code, or real account
> identifier in git, logs, traces, images, or artifacts. Gate B v1 uses local
> custody; cluster custody waits until Talos secret-at-rest is verified.

## Decompiled source

**A recipe, not a gate criterion**

26.1 is unobfuscated. `minecraft-data` already has protocol 775, and `javap`
can answer packet-registration questions without a decompiler. Decompiled
source is an engineering convenience for implementation details, not a Gate B
acceptance criterion.

### Recommended workflow

- Tiny Loom project in `tools/mc-source/`: Loom 1.19.3, Gradle 9.8.2, Java
  25.0.2.
- Minecraft **26.1.2** (match the client), **no mappings line**.
- `genSourcesWithVineflower`; Vineflower 1.12.0.
- Output only in `.cache/minecraft/26.1.2/`; `.cache/` gitignored.
- Commit the recipe; never the output, jars, or CI artifacts.

### Order of reference

1. `minecraft-data` protocol JSON.
2. `minecraft-protocol` source.
3. `javap -c -p` on the pinned client jar.
4. Vineflower/decompiled source only for validation, ordering, or behavior the
   JSON cannot express.

> **Legal boundary**
>
> Decompiled Minecraft code is Mojang's copyrighted code. Removing obfuscation
> did not relicense it. Local inspection on a licensed machine is the intended
> modding use; committing, publishing, shipping, or attaching the source or
> jars is redistribution. Commit the recipe, not the output. This is not legal
> advice.

**Implementation note:** the current `.gitignore` does not ignore `.secrets/`,
`.reports/`, or `.cache/`, and its `*.token-cache.json` rule does not match
prismarine-auth's `_live-cache.json`/`_xbl-cache.json`/`_mca-cache.json`
names. Fix that before the first token or decompile task lands.

## Acceptance

**What has to be true, and what kills the run**

Every criterion needs three kinds of evidence: client state, independent
server/proxy state, and an artifact. One of the three is not enough.

| ID | Criterion | Threshold | Fatal? |
| --- | --- | --- | --- |
| G0 | Host readiness: official client joins a plain Paper server, renders, moves, edits, disconnects, rejoins | 2/2 consecutive | Blocks gate |
| G1 | Auth readiness: device code, silent refresh, two distinct UUIDs, real `hasJoined` | Same UUID across refresh; allow/deny before Login Success | Blocks gate |
| B1 | Paper 26.1.2 behind Velocity: join, render, move, break, place, detach 5 min, reattach current pose | 2/2; `backendLogins=1`; player UUID never backend as a separate player | Yes |
| B2 | Vanilla 26.1.2 parity | 2/2; same assertions; `backendLogins=1` | Yes |
| B3 | Fault set F1–F6 on Paper | 3/3 each; no duplicate login; F4/F5 allow exactly one reconnect (total 2), never a loop | Yes |
| B4 | Identity separation and denial | Player denied before Login Success; backend sees puppet only; puppet unaffected | Yes |
| B5 | Unmodded witness through Monoplayer | 1/1 join/render/move/disconnect/reattach | Yes |
| B6 | Evidence bundle | Report JSON, screenshots, redacted logs, pins, renderer, client lane | Yes |

### Fatal anomalies

- Stuck on “Loading terrain…” or in configuration past 120 s after the
  plain-server baseline passed.
- A second backend login caused by attach/detach on a no-fault row, or more
  than one reconnect on F4/F5.
- Movement or a block edit reaching the backend zero times or twice.
- The backend ever seeing the player's UUID or name.
- A detached world mutation not visible after reattach.
- Any token, refresh token, device code, or RCON password in logs or
  artifacts.
- Driver passes / unmodded witness fails.

### Explicit descopes

- Fabric not gate-blocking.
- Chat blocked/read-only; no re-signing.
- No resource packs, multi-client, or 60-minute soak.
- No performance benchmark.
- No cluster token custody.
- No decompiled source in Gate B.

> **Kill criteria**
>
> - **Host:** G0 not 2/2 within 3 working days → stop; fix/replace the client
>   lane. Gate blocked, not failed.
> - **Driver:** cannot build against 26.1.2 within 2 days → switch primary to
>   unmodded + xdotool, accept manual block-edit checks, lower the claim.
> - **Product:** B1 cannot get a real 26.1.2 client to a null screen with
>   rendered chunks after a bounded 2-day config-replay fix → treat the
>   synthesized-join path as failed and escalate the substrate pivot.

## Order of work

**One to two weeks for the verdict, three only for hardening**

The first week is a falsifier, not a certification programme. If the host and
driver land inside their timeboxes, the core gate is a five-day sequence; if
they slip, the gate is blocked rather than stretched. Everything else is a
later lane.

| Phase | Effort | Exit |
| --- | --- | --- |
| **0. Prerequisites** — host, Java 25, Prism, GL, auth bootstrap, backend cache, M0 | 1–2 d | G0/G1 pass, or gate blocked. |
| **1. Driver spike** — status, screenshot, move, break, place, disconnect; plain Paper only | 1–3 d | Driver + unmodded both join direct. |
| **2. Paper end-to-end** — Monoplayer front/back, AC1–AC5, 5-minute soak | 1–2 d | Core claim works or kill rule fires. |
| **3. Identity** — AC6/AC7, whitelist denial, duplicate-session checks | 0.5–1 d | Denied before Login Success; backend sees puppet only. |
| **4. Vanilla parity + unmodded witness** | 1 d | Reference parity; anti-masking check. |
| **5. Faults** — F1–F6, 3/3 | 1–2 d | No duplicate login, no stale cache. |
| **6. Evidence** — report, redaction, second clean run, verdict | 0.5–1 d | Gate B pass / partial / fail. |
| **B.1 hardening** — Fabric, cluster repeat rows, latency/loss, compressed variants | 1–2 weeks | Compatibility evidence, not core gate. |

| Day | Milestone | Note |
| --- | --- | --- |
| Day 0 | Host + auth | No host, no gate |
| Day 1–2 | Driver + baseline | Plain Paper first |
| Day 3–5 | Gate verdict | Paper + Vanilla + witness |

> **First implementation change**
>
> Before any token or decompile task: add `.secrets/`, `.reports/`, and
> `.cache/` to `.gitignore`, and replace the token-cache glob with rules that
> actually match prismarine-auth's cache files. This is a stop-the-line
> hygiene item.

### Repo changes this plan implies

- **`.gitignore`:** `.secrets/`, `.reports/`, `.cache/`, and the
  `_live-cache.json`/`_xbl-cache.json`/`_mca-cache.json` names. Done now; keep
  it that way.
- **`mise.toml`:** pin `java 25.0.2` and `gradle 9.8.2`; add `mc-source`,
  `gate-b:backend`, `gate-b:driver`, `gate-b:run`, `gate-b:down`,
  `auth:device-code`, `auth:status`, and `whitelist:add`. The host already has
  Java 25; the workspace still needs the pins.
- **`tools/mc-source/`:** the Loom recipe; output only in `.cache/`, never
  tracked.
- **`tools/driver/`:** the client-only Fabric driver; original code, no
  network-stack mixins.
- **`src/driver/`:** scenario controller, backend lifecycle, Toxiproxy/RCON
  clients, report writer, redaction.
- **`deploy/driver/`:** created and applied. The namespace `monoplayer-gate-b`
  now runs Paper 26.1.2 with a Tailscale Service; it is never
  `monoplayer-dev`.

## Decision log

**The council's calls, and the dissent**

### D1 — Client: Prism + driver as instrument, unmodded run as witness

The driver is the only practical way to assert `screen == null`, level/player,
rendered chunks, hit result, and block state. The unmodded run is the only way
to detect masking. Both are mandatory; neither alone is a pass.

**Resolved.** Auth council wanted unmodded primary.

### D2 — Backends: Paper behind Velocity is the pass path; Vanilla parity; Fabric compatibility

The real target is Paper behind a proxy, so Velocity is core. Paper direct is
the G0 host baseline; Vanilla is reference parity. Fabric is required to
report, but a Fabric failure is a compatibility finding unless the product
claims modded servers.

**Resolved.** Testbed architect wanted Fabric mandatory.

### D3 — Network: Toxiproxy on the puppet leg; any proxy behind Monoplayer

Faulting the client leg tests the client. Faulting the puppet leg tests
Monoplayer's session ownership. A proxy in front would terminate the player's
login and make the attach whitelist meaningless.

**Vote:** unanimous.

### D4 — Accounts: two owner-operated MSAs, local custody for v1

Puppet headless only; player in Prism only; backend whitelist = puppet; attach
whitelist = player; one writer; one replica. Cluster Secret custody is
deferred until Talos secret-at-rest is verified.

**Vote:** unanimous.

### D5 — Decompiled source: recipe, not gate

26.1 is unobfuscated; `minecraft-data` and `javap` answer most questions. If
needed, Loom/Vineflower to `.cache/26.1.2`, never committed. It cannot falsify
a Gate B claim.

**Vote:** unanimous.

### D6 — Gate: one-to-two-week verdict, host-first, numeric kill rules

The gate is blocked if the host or second account is missing. The instrument
is the top risk. The product kill is config replay on the first real row, not
chat or Fabric.

**Resolved.**

### Strongest dissent

The auth/security council argued that an unmodded client is the only true
evidence and the Fabric driver should be a debugging aid, not a mandatory
instrument. The testbed and delivery councils argued the driver is mandatory
because the alternatives cannot assert block edits and rendered chunks
reliably. The synthesis keeps both: driver for precision, unmodded for
anti-masking. If the two disagree, the gate is blocked.

The second dissent is Fabric. The testbed architect wanted Fabric mandatory
because it is cheap; the delivery owner deferred it because it is a
compatibility claim, not a core promise. This plan requires the Fabric run and
reports it, but does not let it block the core verdict unless the product
claims modded servers.

## What I need from you

**Two answers and a host**

**Confirmed:** `Bafbi` is the player, `GlowSquidye` is the puppet, the target
is Paper behind a proxy, and read-only/blocked chat is acceptable.

1. **Bring `nath` back online.** Tailscale reports it offline after the last
   session. The Fabric driver is built; installation and G0 driving need the
   host up.
2. **Fabric.** Is a modded (Fabric) server an advertised target? If yes, M3
   becomes gate-blocking; if no, it remains a compatibility report.
3. **Decompile.** Do you want the repo-local `tools/mc-source` recipe now, or
   after G0? We already used Vineflower on the 26.1.2 classes to verify the
   driver APIs.

> **Recommended next action**
>
> G0, G1, and the M4 proxy lane are green. Next is the B1 live front/back leg:
> GlowSquidye on the backend, Bafbi through the online-mode front, cached
> configuration replay, detach/reattach, and one backend login, direct Paper
> first. Then B2 Vanilla parity and the B3 fault rows through the
> Toxiproxy/Velocity seam.

## Sources

**Research and decision trail**

### In this repo

- `.scratch/` — the map, research, and council memos behind this plan. Local
  only, never in git.
- [Fabric client driver](../tools/driver/README.md)
- [Protocol spike runbook](protocol-spike.md) · [Architecture
  proposal](architecture.md)

### External

- [Prism Launcher
  CLI](https://prismlauncher.org/wiki/getting-started/command-line-interface/)
- [Fabric client gametest
  API](https://docs.fabricmc.net/26.1.2/develop/automatic-testing)
- [Minecraft client
  arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments)
- [Toxiproxy](https://github.com/Shopify/toxiproxy)
- [Velocity
  forwarding](https://docs.papermc.io/velocity/player-information-forwarding/)
- [Server properties](https://minecraft.wiki/w/Server.properties)
- [Fabric Loom](https://github.com/FabricMC/fabric-loom)
- [Minecraft EULA](https://www.minecraft.net/en-us/eula)

> **Provenance**
>
> Four research delegates and a three-delegate decision council produced this
> plan. It is a proposal for decision, not a claim that Gate B passes. The
> local workspace cannot run the official client; G0 is the first gate and it
> requires a host.

---

Monoplayer driver-lane testbed plan · 5 November 2026 · Draft for decision.
Stage names inside (Gate A, Gate B, G0, M4) are kept as the record of when
each row was decided. Built from research notes and council memos that live in
`.scratch/`, local only.
