# Council memo — Gate B: auth & security architect

**Role:** auth-security-architect
**Inputs:** `map.md`, issues 01–05, `research/01–04`, `docs/gate-a.md`, `docs/architecture.html` §Late attach / §Auth / §Validation loop
**Date:** 2026-11-05
**Constraint:** design only, no implementation. Placeholders only; no real account identifiers appear in this memo.

---

## Recommended plan (one paragraph)

Run Gate B as an **identity gate first and a compatibility matrix second**. Provision two distinct, owner-operated Java-owned Microsoft accounts — a dedicated headless **puppet** and the operator's **player** — and make the puppet's cache a single-writer secret under `.secrets/puppet/` (0700/0600, atomic writes, `flock`, path-not-value injection), with **no cluster Secret and no second token holder in Gate B**. The gate's headline evidence is an **unmodded official 26.1.2 client through Prism**, logged in as the player, attaching to a **front leg with real online-mode `hasJoined`**, over a puppet backend leg with real Microsoft auth, against **Vanilla 26.1.2 and Paper 26.1.2 b74 in online + secure-profile mode**; the Fabric driver mod is allowed only as a client-only, loopback-only accelerator, never as the sole proof. Keep the two whitelists physically separate and UUID-keyed — backend = puppet only, attach = player only — and treat every path that collapses them (offline front leg, one account, GUI puppet, second proxy writer) as a gate-invalidating event, not a caveat. Decompiled source is **not** a Gate B criterion: ship the recipe and the ignore rules later, never the output, and never in CI. Pass the gate only when two distinct identities are demonstrably admitted and denied at the right stage, exactly one backend login survives the whole scenario, and no token has ever been in git, a log, an image, or an artifact.

---

## Decision table

| # | Decision | Ruling | Mandatory | Deferred / fallback |
|---|---|---|---|---|
| **D1** | Official-client control | Prism 11.1.1 launches the **unmodded** official 26.1.2 client as the player against the online-mode front leg; that lane is the evidence. The Fabric `gate-b-driver` may accelerate block edits/state capture under a strict client-only, loopback-only contract, but never replaces the unmodded run. | One unmodded Prism run per backend row; one full end-to-end unmodded run at verdict time; real `hasJoined`. | Xvfb+xdotool for the unmodded confirm; Fabric client gametest / HeadlessMc as **offline prechecks only**; protocol bot only offline against M0. |
| **D2** | Backend/proxy/fault matrix | Core Gate B = **Vanilla 26.1.2 + Paper 26.1.2 b74**, both `online-mode=true`, `enforce-secure-profile=true`. Velocity is a separate **"proxy-compatible" claim**, not part of the core pass. Faults limited to those that threaten the session/auth boundary. | M1, M2; M5 subset (35–60 s blackhole, RCON kick, graceful restart + `SIGKILL`); one recorded `prevent-proxy-connections` diagnostic. | Fabric (M3), Velocity (M4, only if claiming proxy), BungeeCord, ViaProxy, Fabric+Velocity, jitter/loss/reset/bandwidth, `tc netem`, all offline rows as passes. |
| **D3** | Accounts, custody, whitelists, duplicates | Two distinct owner-operated accounts. Puppet headless only, player Prism only. `.secrets/` single-writer cache; **no cluster custody in Gate B**. Two separate UUID whitelists; the backend sees only the puppet. | Distinct-UUID check; silent refresh across a process restart; atomic write + `flock`; one proxy process; online-mode front leg; deny **before** Login Success; both denial tests. | One-account smoke labelled `twoAccount=false` (never a pass); cluster custody deferred until Talos encryption-at-rest is **verified**, not assumed. |
| **D4** | Decompiled source | **Not a Gate B criterion.** Developer-only, lands after the auth spike and the first real-client row, in its own reviewed change; tracked recipe, output only in gitignored `.cache/`. | `.gitignore` entries + tracked-output guard + README warning must land **before** the task exists. | `javap` + `minecraft-data` first; standalone Vineflower in `/tmp` for a one-off; MCP-Reborn / CFR / committed mappings rejected. |
| **D5** | Acceptance and order | Auth/identity invariants first; a green matrix that cannot show two identities is not a Gate B pass. See A1–A11 and the work order. | A1–A11; order in §D5. | Render/input thresholds owned by the client lens; chat signing, config replay, resource packs out of core. |
| **D6** | Biggest risk / kill | The gate goes green while the identity boundary has collapsed to one account or an offline front leg. | Stop if no second distinct account with silent refresh exists by the end of the auth spike. | Every other finding is a fix-forward limitation **if recorded** in the report. |

---

## D1 — Official client: unmodded is the evidence, the driver is a tool

The auth question is not "can we drive the client" but "does the official client, holding a real Microsoft session, get admitted by a real `hasJoined` and then render the puppet's world". A client mod can hide a vanilla bug and adds a credential-adjacent process to the trust boundary, so it cannot be the only witness.

**Mandatory lane.** Prism 11.1.1, one 26.1.2 vanilla instance, only the player account added, per-instance account override, `-s 127.0.0.1:25565`. Assert: leaves "Loading terrain…", renders, moves, detaches, survives, reattaches. This is the lane that satisfies `docs/architecture.html` §Validation loop's "real official client" requirement.

**Driver rules** (if used at all): client-only; no mixins into `Connection`, login handlers, codecs, or the Netty pipeline; no packet injection that changes the protocol path; control socket bound to `127.0.0.1` with a per-run random token in a 0600 file; no outbound network from the mod; built from pinned in-repo source; never receives or logs the player's access token. Every assertion records `clientLane: unmodded | driver | offline-precheck`.

**Protocol bots.** An *authenticated* protocol bot is **not allowed** in Gate B: the puppet is held by the proxy and the player by Prism, so an authenticated bot would need a third account or would collide and trigger "You logged in from another location". Bots stay offline against the M0 fixture.

**Manual:** first device-code/2FA approval, one unmodded confirmation per gate run, visual review of screenshots, account recovery, ToS review.

---

## D2 — Backend matrix: prove identity, not variety

The rows that matter to this lens are the ones where identity can be spoofed or dropped.

| Row | Backend | Backend online / secure | Verdict | Why |
|---|---|---|---|---|
| M1 | Vanilla 26.1.2 | `true` / `true` | **Mandatory** | Reference encryption, `hasJoined`, secure profile, vanilla join/config |
| M2 | Paper 26.1.2 b74 | `true` / `true` | **Mandatory** | Production default; Paper config/message/chunk behavior |
| M3 | Fabric + API + Carpet | `true` / `true` | **Deferred** | Loader/registry proof, not an auth proof; Carpet changes timing |
| M4 | Paper behind Velocity 4.3.1 | proxy `true`, backend `false`/`false` | **Only for a proxy claim** | Forwarded UUID/identity; never in front of Monoplayer |
| M5 | Paper + faults | `true` / `true` | **Subset mandatory** | Restart/kick/timeout are the duplicate-session and detach-survival threats |
| M0 | Paper offline | `false` / `false` | **Precheck only** | Gate A replay; never a Gate B pass |

**Mandatory fault subset:** 35–60 s `down` (keep-alive expiry), RCON `kick <puppet>`, graceful `stop`, and `kill -KILL`. Record backend login count before and after every fault. **Deferred:** jitter/loss/reset/bandwidth/slicer, `tc netem`, queue simulation, BungeeCord, ViaProxy, Fabric+Velocity, Vanilla+Velocity, Deepmine Gate.

**`prevent-proxy-connections`:** run it once on M2 as a **diagnostic**, not a pass/fail row. Record whether the `/join` egress matches the TCP egress. A NAT asymmetry is a deployment finding, not a Gate B kill.

**Proxy placement is non-negotiable:** any server-side proxy sits **behind** Monoplayer, on the puppet leg. In front, it terminates the player's login and makes the attach whitelist meaningless. A proxy in front is a hard config error in review.

**Secure-profile fallback:** if the puppet cannot obtain profile certificates, `enforce-secure-profile=false` may be recorded as `secureProfile=false` with a reduced claim. It is a limitation, not a silent pass.

---

## D3 — Two accounts, custody, whitelists, duplicate sessions

### Account workflow (exact)

1. **Two accounts, never one.** `<puppet>` = dedicated alt, `<player>` = the operator's normal account. Both owner-operated, both Java-owned (not Game Pass), both 2FA, distinct passwords and recovery. No transfer, purchase, or family sharing of the puppet.
2. **Verify before use.** `/entitlements/mcstore` returns `game_minecraft` + `product_minecraft`; `/minecraft/profile` returns `id` + `name`; `/player/attributes` shows `privileges.multiplayerServer.enable = true` and no `MULTIPLAYER` ban.
3. **Record the UUID pair.** Gate B aborts if `<puppet-uuid> == <player-uuid>`. This single check prevents the most common and most misleading provisioning mistake.
4. **Puppet bootstrap.** `mise run auth:device-code --account puppet`: prints URL/code to **stderr**, polls, then prints name/UUID/entitlements/multiplayer/cache path — never a token. The operator approves as the puppet, on a browser/phone, once. 15-minute code window; this step is irreducibly manual.
5. **Player client.** Add only the player to Prism; create `gate-b-player` (26.1.2 vanilla); pin the account per instance; launch with `-s host:port`. Never add the puppet to Prism, a browser profile, or any other launcher.
6. **Auth title.** Try `authTitle: 00000000402b5328` (`Titles.MinecraftJava`), `deviceType: Win32`, `flow: live`; on `403` at `getTitleToken()`, fall back to the library default Nintendo title and **record which one worked**. Do not use `sisu` as an untested workaround. Make the title a config value so a one-line 403 can never look like a backend bug.

### Secret boundary

```
.secrets/                      0700, gitignored, disk-encrypted only
  puppet/                      0700
    <hash>_live-cache.json     0600  # refresh token = password
    <hash>_xbl-cache.json      0600
    <hash>_mca-cache.json      0600
  writer.lock                  flock held by the proxy
.gate-b/                       0700, gitignored
  prism-player/                Prism root (0700)
  state/attach-whitelist.json  UUIDs, not secrets, still untracked
  state/backend-whitelist.json generated copy for diffing
  logs/                        redacted
```

Rules:

- **Path, not value.** `PUPPET_AUTH_CACHE` carries a path. No token, refresh token, or device code in an env var, CLI arg, `.scratch/`, issue, chat, CI variable, or image layer.
- **One writer.** Only the proxy refreshes. `auth:status` is read-only by default; `--refresh` takes `flock` and refuses while the proxy runs. Never run two refreshers.
- **Atomic write.** Temp file in the same directory → `fsync` → `rename`. A `.bak` is forensic only; restoring a consumed refresh token fails.
- **No restore, no replay.** After a refresh the old token is dead. Lost write = re-bootstrap.
- **Liveness.** Keep the 90-day inactivity window rolling: proxy runs, or `auth:status --refresh` with the proxy stopped, at least monthly.
- **Revocation is human.** `down` is stop-only; `--forget` deletes the cache; `--revoke` prints "sign out everywhere / change password" and does not automate it.
- **Redaction is tested.** Feed a synthetic cache containing sentinel strings through the logger/OTel path and assert they never appear. This is a one-hour test that prevents the class of leak that ends the gate.

**No cluster custody in Gate B.** Talos does not encrypt Secrets at rest by default and this project has not verified the setting. Shipping a token to the cluster would add a write-back controller, a scoped ServiceAccount, RBAC, NetworkPolicy, and a `Recreate`/leader-lock discipline — a large security surface that proves nothing about the product. Backends may run in `monoplayer-gate-b`; the token stays on the machine that runs the proxy. Revisit only when encryption-at-rest is verified.

**Do not bootstrap here.** This workspace's `/` is a loop device on plain ext4; no LUKS is visible. Treat the workspace as unsuitable for the puppet cache until disk encryption is confirmed; prefer the dedicated display/ops host.

### Whitelists: two gates, never merged

| Gate | Contains | Enforced by | Denial effect |
|---|---|---|---|
| Backend `whitelist.json` | **Puppet only** (plus no ops) | Backend | Puppet cannot join; no backend session; Monoplayer reports a join failure and does **not** reconnect-loop |
| Monoplayer attach whitelist | **Player only** | Front leg, after `hasJoined` | Disconnect during login, **before** Login Success and before any relay; puppet session untouched |

- Resolve names → UUID at add time (`/minecraft/profile/lookup/name/<name>`, fallback `api.mojang.com`), normalize lowercase-hyphenated, compare UUIDs only, reload without restart.
- Cross-check Login Start's username against the `hasJoined` profile; deny on mismatch. Never trust a client-supplied UUID.
- **Denial tests are mandatory in both directions**, and both must leave the puppet online.
- Do not add the player to the backend whitelist. The clean assertion is that the backend log never contains the player.
- Do not op the puppet; ops are auto-whitelisted.

### Duplicate-session rules (hard)

| Scenario | Rule |
|---|---|
| One proxy, one puppet | Required |
| Two proxies / two pods / copied cache | **Never** — token rotation race + kick; use one process, `replicas: 1`, `strategy: Recreate` |
| GUI client logged in as the puppet while proxy runs | **Never** during Gate B; test fixture only, closed before the proxy |
| Player points at the backend | **Never**; only the front leg |
| Same account for both roles | **Never** for a Gate B claim; it is the `twoAccount=false` smoke |
| Auth bot on the puppet/player while those sessions live | **Never** |

Before each run: `pgrep -af 'java|node'`, check the backend login count, check `auth:status`. A duplicate kick is always investigated as (1) stray Prism, (2) stale JVM, (3) second proxy, (4) copied cache.

**One-account fallback** is allowed only as a labelled smoke: `twoAccount=false`, identity-separation assertions skipped/failed, never counted as a Gate B pass.

### Must be manual

Device-code approval; Xbox profile/2FA/region setup; entitlement and multiplayer review; confirming `whitelist.json` contains only the puppet; one unmodded confirmation run plus visual review; account recovery/ban handling; revocation; legal review before publishing any decompiled excerpt; owner-operated/ToS sign-off.

---

## D4 — Decompiled source: engineering convenience, not a gate

**Ruling: out of Gate B scope as an acceptance criterion.** It cannot falsify anything the gate asserts, and it adds a legal/redistribution surface plus a Gradle/Java toolchain to a repo that currently needs neither. It lands after the auth spike and the first real-client row, in its own reviewed change, and is never a blocker for the gate.

**Reference order:** (1) `minecraft-data` 3.119.0 `protocol.json` and `minecraft-protocol` 1.68.0 source; (2) `javap -c -p` against the pinned client jar for packet IDs and registration order — no decompiler needed and already validated (69 serverbound / 141 clientbound); (3) decompiled source only for implementation questions JSON and bytecode cannot answer; (4) standalone Vineflower in `/tmp` for a single class as an ad-hoc fallback with no repo change.

**If it lands:** three tracked files under `tools/mc-source/` (Loom 1.19.3, Gradle 9.8.2, Java 25.0.2, Minecraft **26.1.2** — match the client, not 26.1 — no mappings, `genSourcesWithVineflower`). Output only to `.cache/minecraft/26.1.2/`. Do **not** use `build/` (disposable, mixed with artifacts) or `vendor/` (implies shipped third-party code).

**Repo hygiene, landing order matters:**

1. `.gitignore` gains `.secrets/`, `.gate-b/`, `.cache/`, `tools/mc-source/.gradle/`, `tools/mc-source/build/` **before** any task or token exists. The current `*.token-cache.json` rule does **not** match prismarine-auth's `_live-cache.json` / `_xbl-cache.json` / `_mca-cache.json` — a real gap that must be fixed first.
2. A guard in `mise run check` (or CI): `git ls-files -- .cache` and `.secrets` must be empty; fail otherwise.
3. The `mc-source` task refuses to run when `CI` is set (override flag requires a human), so decompiled output never becomes a CI artifact.
4. A README warning naming the EULA, the "no distribution" rule, the license requirement, and "not legal advice".

**Legal boundary (assessment, not advice):** decompiled output is a copy/derivative of Mojang's copyrighted code; removing obfuscation did not relicense it. Local inspection on a licensed machine is the intended modding use; committing, publishing, shipping, or attaching the source or jars is redistribution the EULA does not permit. Cite packet IDs/field layouts from `minecraft-data` in issues; do not paste large decompiled excerpts. There are no 26.1 mappings to commit, so "commit the recipe, not the output" is the whole boundary. Get counsel before publishing an excerpt or shipping a patched client.

**Rejected:** MCP-Reborn (writes decompiled code into `src/main/java`; its own README says you cannot publish the output), MinecraftDecompiler (no 26.1), CFR 0.152 (2021), Yarn/Mojang mappings (none exist for 26.1).

---

## D5 — Acceptance criteria, order, non-goals

### Acceptance criteria (all fatal unless marked)

| # | Criterion | Fatal |
|---|---|---|
| A1 | Two distinct, Java-owned accounts; UUIDs recorded; `twoAccount=true`; puppet ≠ player | Yes |
| A2 | Puppet device-code bootstrap; **silent refresh across a process restart** without a new code; same UUID; cache persisted 0600 | Yes |
| A3 | Single writer: proxy holds `flock`; `auth:status --refresh` refuses while it runs; exactly one cache copy; one proxy process | Yes |
| A4 | Front leg `online-mode=true`, real `hasJoined`, Login Start ↔ profile cross-check; unlisted player denied **before** Login Success; puppet unaffected | Yes |
| A5 | Backend whitelist = puppet only; player never appears in the backend log; puppet removal rejects the join and is reported without a reconnect loop | Yes |
| A6 | Exactly **one** backend login across join / detach / reattach / fault subset | Yes |
| A7 | Identity separation: backend profile/UUID is the puppet, never the player; client displays the puppet's profile | Yes |
| A8 | No token, refresh token, device code, or real identifier in git, logs, traces, artifacts, or images; redaction test passes; `.secrets/` + `.gate-b/` ignored | Yes |
| A9 | Encryption active on the backend leg (M1/M2) | Yes |
| A10 | `enforce-secure-profile=true` passes, **or** `secureProfile=false` is recorded and the claim reduced | No |
| A11 | 5-minute detach soak: puppet session alive, no re-login, front client gone | Yes (cheap: no client needed during soak) |

### Work order (time-boxed)

0. **Day-0 hygiene (0.5 d):** ignore rules for `.secrets/`, `.gate-b/`, `.cache/` and the prismarine cache names; redaction helper + sentinel test; fail-closed secret loader; `umask 077` / `chmod`; disk-encryption check. No token touches disk yet.
1. **Auth spike (0.5–1 d) — the kill point:** device code → entitlements → silent refresh → two-account `hasJoined` fixture with the unmodded Prism client → allow/deny before Login Success. No Monoplayer auth code before this passes.
2. **Puppet into the backend leg (1 d):** Microsoft auth, encryption, profile certs, Paper online + secure. First real row.
3. **Front leg online (0.5–1 d):** real `hasJoined`, attach whitelist, deny-before-Login-Success, Login Start cross-check.
4. **Unmodded client row (1 d):** join → render → move → detach 5 min → reattach; backend whitelist denial.
5. **Fault subset (1 d):** 35–60 s blackhole, RCON kick, graceful restart, `SIGKILL`; count logins.
6. **Velocity row (0.5–1 d):** only if a "proxy-compatible" claim is wanted.
7. **Deferred:** Fabric, decompile tooling, cluster custody, chat, config replay parity.

### Explicit non-goals

- No cluster token custody, Secret write-back, or in-cluster puppet auth in Gate B.
- No second GUI client as the puppet; no multi-account pooling; no third-party accounts.
- No offline front leg, no one-account run counted as a pass.
- No proxy in front of Monoplayer; no BungeeCord/ViaProxy/Fabric+Velocity/prevent-proxy-connections=true pass.
- No chat signing/re-signing, resource packs, or config-phase-replay parity claim.
- No decompiled source or jar in git, CI artifacts, images, releases, docs, or issues; no legal opinion.
- No public ingress; tailnet/localhost only.
- No anti-cheat evasion; only the operator's own server or explicit permission.

---

## D6 — Biggest risk and kill criterion

**Biggest risk: the gate goes green with the identity boundary collapsed.** The failure is quiet, not loud: the front leg is left offline "just for the run", the same account is used for both roles, the player is added to the backend whitelist, or a second proxy quietly refreshes the same cache. Every auth assertion then degenerates into "the one account connected and worked", and the report still says PASS. This is more dangerous than a hard crash because it produces a false positive on the exact thing Gate B exists to prove.

**Kill criterion:** if, by the end of the auth spike (≤1 day), there is **no second distinct, Java-owned account with a working silent refresh and a real online-mode `hasJoined` front leg carrying the unmodded official client**, Gate B cannot claim identity separation. Stop. Either block until the accounts/leg are available, or run a clearly labelled `twoAccount=false` smoke that is **not** a Gate B pass. Do not relabel a single-account run.

**Immediate hard stops (fix before any further row):**

- Any token/refresh token/device code in git history, a log, an artifact, an image, or a public issue → stop, rotate (sign out everywhere / password change), purge, re-bootstrap.
- `<puppet-uuid> == <player-uuid>` → stop.
- An unexplained duplicate-session kick or a second backend login → stop; fix the single-writer/one-replica rule.
- Decompiled output tracked in git → stop, purge, fix the ignore/guard.

---

## Strongest argument against my recommendation

The strongest case is that I am optimizing the wrong risk and paying for it with the only experiment that can kill the Node substrate. Gate A already passes protocol-level; the thing most likely to sink Monoplayer is the attach/reattach data path, not Microsoft auth. By making the auth spike a hard gate and insisting on the slow unmodded Prism lane, I delay the real falsifier by a day or more and force the team to spend its scarcest resource — display-host time and human attention — on account ceremony. Worse, my "no cluster custody" stance may be backwards: a laptop `.secrets/` directory plus a Prism `accounts.json` holding plaintext tokens is plausibly **less** secure than a namespaced Kubernetes Secret with tight RBAC, default-deny NetworkPolicy, and a scoped ServiceAccount. I am choosing the less isolated store because its encryption-at-rest is unverified, which is an argument for verifying it, not for avoiding the cluster. And the driver mod, which I demote, is the only lane that produces deterministic block-edit evidence; forcing the unmodded X11 lane for the headline run buys authenticity at the cost of flakiness and retries that can make the gate look red for reasons unrelated to the product.

That argument is partly right, and I accept the cost knowingly: the auth spike is one day, it is the only thing that can tell us whether the product's core identity claim is even testable, and a wrong green is worse than a late green. The storage objection I concede in part — see the evidence below.

## Evidence that would change my mind

- **Talos secret encryption-at-rest verified**, plus a working leader lock / `Recreate` / scoped ServiceAccount and an egress policy → move puppet custody in-cluster and drop the local-only stance.
- **Prism (or a launcher we adopt) stores accounts in the OS keyring / encrypted store**, or the display host is confirmed full-disk-encrypted and single-user → relax the Prism plaintext-token risk.
- **A second Java account is genuinely unavailable** at acceptable cost → accept a labelled single-account smoke as the deliverable and rewrite D5's claims; do not pretend.
- **The driver mod is unavoidable** because the unmodded lane cannot produce stable block-edit evidence on the target host, and the mod is small, audited, and loopback-only → promote it to co-primary evidence with the unmodded run still required once.
- **`minecraft-protocol` cannot obtain profile certificates for the puppet** on 26.1 → secure profile becomes a recorded limitation; A10 changes from pass/fail to a documented reduction.
- **Loom/Vineflower fails on 26.1.2**, or a packet question is fully answered by `javap`/`minecraft-data` → drop the decompile tooling entirely; it is already optional.
- **Legal counsel says local decompilation is not permitted for this project** → remove the task and the docs.
- **A real duplicate-session-safe multi-writer mechanism** exists and is proven (server-side token broker with rotation fencing) → the one-writer rule could be relaxed for product, though not needed for Gate B.

## Confidence

**80 / 100.** High confidence on D3 (account topology, custody, whitelist separation, duplicate rules), D4 (legal boundary and "recipe not output"), and the D6 kill criterion — these follow directly from the sources and from the repo's own architecture. Lower confidence on D2's "Velocity is optional for the core pass": a reviewer could reasonably argue the forwarded-UUID row is where proxy identity bugs actually appear, and that deferring it lets a real incompatibility ship. I also hold D1's "unmodded is the evidence" with less certainty than I hold the auth rules, because the driver's client-only contract is hard to enforce in review and the unmodded lane may prove too flaky on the available hardware.

---

### Addendum — local constraints I am designing around

- This workspace cannot run the official client: no `DISPLAY`, no `/dev/dri`, missing X/GL libraries, no Xvfb/xdotool, no root, 4 cores, ~3.4 GiB free RAM. Backends and protocol prechecks only. The client lane belongs on a dedicated display host on the tailnet.
- No Docker here; backends are direct Java locally or pods in a dedicated `monoplayer-gate-b` namespace (there is no `monoplayer-dev` namespace today).
- No tracked secret-looking paths exist today, but `.gitignore` is insufficient for prismarine-auth caches and has no `.secrets/`/`.gate-b/`/`.cache/` entries — fix before the first token.
- `package.json` is still named `monoplayer-gate-a`; auth code should land in a clearly separated `src/auth/` + `src/gate-b/` tree rather than growing the spike harness, and should not require rewriting Gate A.
