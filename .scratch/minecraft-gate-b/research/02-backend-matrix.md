# Research: backend matrix and network harness

**Ticket:** `.scratch/minecraft-gate-b/issues/02-research-backend-matrix.md`
**Status:** resolved (research only; nothing implemented)
**Target:** Minecraft Java **26.1 / protocol 775**
**Date:** 2026-11-05

This note answers what is actually available for 26.1, what each backend and
proxy proves, where the testbed should run, and the smallest matrix that can
expose real Monoplayer defects. It does **not** settle Gate B acceptance
thresholds; that is ticket 05.

---

## Verdict

**Recommended minimum Gate B matrix:** three direct backends (**Vanilla,
Paper, Fabric + Fabric API + Carpet**) with the backend in online mode and
secure profiles enforced, **one Paper-behind-Velocity row** (proxy online,
backend offline/insecure, modern forwarding), and **one fault row** on Paper
(latency/jitter/loss, a blackhole, RCON kick, and a backend restart).

**Where it runs:** the backends, RCON, and fault proxy belong in a dedicated
`monoplayer-gate-b` namespace on the homelab cluster. The official client,
Monoplayer, and the scenario controller belong on a display/GPU host on the
tailnet. This workspace cannot run the official client: it has no display, no
`/dev/dri`, no `docker`, 8 GB total RAM (~4 GB free), and 4 cores. A direct-Java
backend alone fits here; a real client plus backend does not.

**Two version facts change the ticket's wording:**

1. **There is no Paper version `26.1`.** Paper's 26.1 line is `26.1.1` and
   `26.1.2`; `26.1.2` supersedes both and is also protocol 775. Pin
   **Paper 26.1.2 build 74** (`sha256:1d70b1…`) and accept that it is marked
   unsupported since 2026-07-26, or the matrix silently drifts to 26.3.
2. **Java 25 is the required runtime; Java 21 fails immediately.** Java 26
   starts Vanilla 26.1.2 in a smoke test, but 25 is the supported pin for
   Paper, Fabric, and the itzg image.

**Proxy placement is non-negotiable:** a server-side proxy goes **behind**
Monoplayer, on the puppet leg. It must never sit in front of Monoplayer's front
leg. Velocity/BungeeCord/ViaProxy all terminate or translate the client login;
putting one in front would hide the attaching player's address from
Monoplayer's `hasJoined` check and require Monoplayer to implement proxy
forwarding.

**Fault layer:** use **Toxiproxy 2.13.0** as the primary TCP fault proxy
(latency ± jitter, packet loss with correlation, down, reset, timeout,
bandwidth), driven by the scenario. Keep `tc netem` as an optional
kernel-realism check only; it needs root and is interface-wide. Backend restart
and kick use the process supervisor and RCON, not a chaos framework.

---

## Proven facts

### Versions, Java, and exact pins

| Thing | Exact pin | Java | Protocol | Evidence |
|---|---|---|---|---|
| Vanilla server | **26.1.2**, `server.jar` sha1 `97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51`, 60,417,480 bytes | **25** | 775 | [26.1.2 version JSON](https://piston-meta.mojang.com/v1/packages/4e49d699db7dba839226d0ed1fcf36c465c2edbe/26.1.2.json) |
| Paper | **26.1.2 build 74**, `paper-26.1.2-74.jar`, `sha256:1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7`, 52,893,229 bytes | **25 minimum** | 775 | [Paper fill API, 26.1.2 builds](https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds) |
| Fabric Loader | **0.20.1** (stable) | 25 | 775 | [Fabric meta for 26.1](https://meta.fabricmc.net/v2/versions/loader/26.1) |
| Fabric installer | **1.1.2** | 25 | — | [Fabric installer meta](https://meta.fabricmc.net/v2/versions/installer) |
| Fabric API | **0.155.3+26.1.2** (version ID `3dM0X6ou`), supports 26.1/26.1.1/26.1.2 | 25 | — | [Modrinth version](https://modrinth.com/mod/fabric-api/version/3dM0X6ou) |
| Carpet | **26.1**, `fabric-carpet-26.1+v260402.jar` (version ID `ygtmLbO3`), supports 26.1/26.1.1/26.1.2 | 25 | — | [Modrinth version](https://modrinth.com/mod/carpet/version/ygtmLbO3) |
| Velocity | **4.3.1 build 45**, `velocity-4.3.1-45.jar`, `sha256:0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75` | **25 minimum** | supports 26.1.2 (release notes include 26.4 snapshots) | [Paper fill API, Velocity 4.3.1](https://fill.papermc.io/v3/projects/velocity/versions/4.3.1/builds) |
| BungeeCord | Jenkins build **2111**, 2026-10-31 | **17 minimum** | supports 26.1.2 | [Spigot 26.1/26.1.1/26.1.2 announcement](https://www.spigotmc.org/threads/spigot-bungeecord-26-1-26-1-1-26-1-2.718646/), [build 2111](https://hub.spigotmc.org/jenkins/job/BungeeCord/2111/) |
| ViaProxy | **3.4.14**, 2026-09-27 | 17 | supports release 1.0.0–26.3 | [ViaProxy releases](https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.14), [README](https://github.com/ViaVersion/ViaProxy#supported-server-versions) |
| Toxiproxy | **2.13.0**, 2026-10-14 | static binary | n/a | [Toxiproxy release](https://github.com/Shopify/toxiproxy/releases/tag/v2.13.0) |

Direct download URLs for the two server jars:

- Vanilla:
  `https://piston-data.mojang.com/v1/objects/97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51/server.jar`
- Paper:
  `https://fill-data.papermc.io/v1/objects/1d70b1dab9cf4a6de615209a536f3a45a2186240253c428213ce2188ab95e5f7/paper-26.1.2-74.jar`

**Protocol 775:** 26.1, 26.1.1, and 26.1.2 are all 775; 26.2 and later are
not. See [Protocol version](https://minecraft.wiki/w/Protocol_version).
`minecraft-data` 3.119.0 / `minecraft-protocol` 1.68.0 in this repo already map
26.1 to 775; Gate A's pin remains valid.

**Java 21 vs 25 vs 26 (measured locally):**

- Java 21.0.2 + Vanilla 26.1.2 fails at launch:
  `UnsupportedClassVersionError: net/minecraft/bundler/Main ... class file version 69.0 ... up to 65.0`.
- Java 25.0.2 starts Vanilla 26.1.2 (`Done (0.140s)` on a warm world).
- Java 26.0.2 also starts Vanilla 26.1.2. Treat that as a smoke-test fact, not
  a support statement: Mojang requires 25, and Paper/Fabric/plugins may not
  have tested 26.

**Vanilla 26.1.2 and 26.1 both require Java 25** in Mojang's version JSON
(`javaVersion.majorVersion: 25`).

### What each direct backend proves

| Backend | What it proves | What it does not prove |
|---|---|---|
| **Vanilla 26.1.2** | The reference implementation. Monoplayer can join a real Mojang server with encryption, online-mode `hasJoined`, secure profiles, vanilla config/registry/join/chunk/keep-alive behaviour. | Paper/plugin quirks, modded registries, proxy forwarding. |
| **Paper 26.1.2 build 74** | The most common production server. Paper's config rewrites, plugin-message traffic, `spigot.yml`/`paper-global.yml`, Paper's `pause-when-empty` default, and Paper's chunk/keep-alive behaviour. | Fabric/modded servers, proxy forwarding. |
| **Fabric 26.1.2 + API + Carpet** | Modded server path: Fabric loader, Fabric API registries, modded custom payloads, and Carpet's deterministic controls (`/player`, tick control). | Paper/plugin servers, and Carpet itself changes tick behaviour; do not let it stand in for vanilla timing. |

Fabric is cheap enough to be mandatory: it started in 9.8 s and loaded both
mods in the local measurement below. If the matrix must be cut, Fabric is the
first backend to defer; Vanilla + Paper are the irreducible pair.

### Packaging: direct Java vs itzg vs Kubernetes

**Direct Java (recommended for the fast/local lane).** Download the pinned
jar, write `server.properties` and `eula.txt` into a temp directory, run
`java -Xms512M -Xmx1G -jar … nogui`, stop with `stop` on stdin. No image pull,
no Docker, no setup wrapper. RCON is optional; if disabled, stdin is enough
for a clean stop. This is the lightest way to reproduce a backend on the
8 GB workspace.

**itzg/docker-minecraft-server (recommended inside Kubernetes, or once Docker
exists).** Proven from the image docs:

- `latest`, `stable`, and `java25` are **Java 25** today; `java21` is the old
  runtime. Pin **`itzg/minecraft-server:2026.10.1-java25`**
  (`sha256:d12aed7e35981dfe259b60fbfee77d23a19b5898a7a31dca298d18b47b7b5776`),
  which is currently the same digest as `stable`. `latest` is a moving tag
  (`sha256:29d72b…` on 2026-11-05). See
  [Java tags](https://docker-minecraft-server.readthedocs.io/en/latest/versions/java/).
- `MEMORY` defaults to **1 GB**; set `MEMORY=2G` (or `INIT_MEMORY`/`MAX_MEMORY`)
  for Paper/plugins. See [Variables](https://docker-minecraft-server.readthedocs.io/en/latest/variables/).
- `TYPE=VANILLA|PAPER|FABRIC`, `VERSION=26.1.2`, `PAPER_BUILD=74`,
  `FABRIC_LOADER_VERSION=0.20.1`, and
  `MODRINTH_PROJECTS=fabric-api:0.155.3+26.1.2,carpet:26.1` for Fabric. itzg
  resolves Modrinth files at startup and removes mods that are no longer
  listed. See
  [Paper type](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/server-types/paper/),
  [Fabric type](https://github.com/itzg/docker-minecraft-server/blob/master/docs/types-and-platforms/server-types/fabric.md),
  [Modrinth downloads](https://github.com/itzg/docker-minecraft-server/blob/master/docs/mods-and-plugins/modrinth.md).
- **RCON is enabled by default** in itzg, with a random password and port
  25575. This is convenient but must not be exposed. See
  [RCON docs](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/server-properties/#rcon).
- **Whitelist:** `WHITELIST` accepts usernames and/or UUIDs and auto-enables
  whitelisting; `ENFORCE_WHITELIST=true` kicks players removed from the list;
  usernames are resolved through PlayerDB or Mojang (`USER_API_PROVIDER`).
  See [whitelist docs](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/server-properties/#whitelist-players).
- **Server-property mappings:** `ONLINE_MODE`, `ENFORCE_SECURE_PROFILE`,
  `VIEW_DISTANCE`, `SIMULATION_DISTANCE`, `NETWORK_COMPRESSION_THRESHOLD`,
  `PAUSE_WHEN_EMPTY_SECONDS`, `MAX_PLAYERS`, `ENFORCE_WHITELIST`. See
  [server properties](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/server-properties/).
- `STOP_DURATION` defaults to **60 s**; lower it for a testbed and still send
  RCON `stop` first. See [Variables](https://docker-minecraft-server.readthedocs.io/en/latest/variables/).
- `PRE_START_SCRIPT` runs after setup and immediately before the JVM starts;
  Deepmine already uses this hook to assert platform-owned keys
  (`deploy/images/minecraft-base/Dockerfile`, `assert`). Gate B can use the
  same hook to force testbed-owned keys after itzg rewrites configs.
- **Image size:** the `2026.10.1-java25` amd64 image is ~362 MB compressed;
  budget 800 MB–1 GB uncompressed and a cold pull on first run.
- **The image does not include a world.** `/data` starts empty, so the first
  Paper/Vanilla boot generates a world. For repeatability, either accept the
  first-boot cost or pre-seed a flat world in a small derived image/PVC.

**Kubernetes (recommended for the real-client matrix).** The cluster already
runs the relevant patterns: BuildKit in `deepmine-build`, zot in
`deepmine-core`, Longhorn as the default StorageClass, and a deepmine demo
tenant in `deepmine-dev-net-demo` with `survival`, `hub`, and `proxy` pods plus
a Tailscale `LoadBalancer` Service. The deepmine `minecraft-base` image is
**not** suitable as-is for Gate B: its `assert` script forces
`online-mode=true`, `server-port=25565`, `enable-status=true`, and
`management-server-enabled=false`, which blocks offline/proxy rows. Build a
clean `gate-b/minecraft-base` from the pinned itzg image, or run raw
`Deployment`/`StatefulSet` manifests with the pinned image and a Gate B
`PRE_START_SCRIPT`.

**Docker is not available here.** `docker` is not installed on this workspace,
and installing it is out of scope. The Docker lane is therefore an optional
convenience for a developer laptop, not the Gate B path.

| Lane | Startup | Memory | World persistence | RCON | Isolation | Verdict |
|---|---|---|---|---|---|---|
| Direct Java | 7–14 s | 0.7–0.9 GB RSS at 1 G heap | temp directory | optional; stdin for stop | process only | Fast/local lane; fits this workspace for backend-only checks |
| itzg Docker | +5–15 s cold setup, plus image pull | same JVM + container overhead | `/data` volume | built-in, default on | container | Convenient on a Docker host; unavailable here |
| Kubernetes (`monoplayer-gate-b`) | image pull + scheduling, then same JVM | same JVM + pod overhead | `emptyDir` or Longhorn PVC | ClusterIP/exec only | namespace + NetworkPolicy | Gate B acceptance lane; reproducible and remote-client friendly |

### Measured startup and memory (local, direct Java)

Method: this workspace (4 cores, 8 GB RAM, Java 25.0.2), flat world,
`view-distance=4`, `simulation-distance=4`, `-Xms512M -Xmx1G`, one pre-generated
world. "RSS" is `/proc/<pid>/status` at the first `Done (…)` line; it is not
under player load and not with plugins.

| Backend | Warm start | Cold start | RSS at ready | World on disk |
|---|---:|---:|---:|---:|
| Vanilla 26.1.2 | **6.8 s** | **7.7 s** | **673 MB** | 2.2 MB |
| Paper 26.1.2 b74 | **9.0 s** | **14.2 s** (first run includes setup/config generation) | **843 MB** | 6.5 MB |
| Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 | **9.8 s** | **10.0 s** | **732 MB** | 2.2 MB + 3.9 MB mods |
| Velocity 4.3.1 | **1.5 s** | — | **196 MB** | small |

These are direct-JVM numbers. itzg adds its setup pass (image pull, config
generation, Modrinth resolution, world creation) before the JVM starts; budget
**+5–15 s cold** and **+2–5 s warm** on top. Cluster scheduling and the first
image pull add more; a first row can take 30–90 s end to end. These overheads
are estimates, not measured.

### Client footprint (why the matrix cannot be all-local)

Minecraft 26.1's official requirements are **8 GB RAM with a discrete GPU or
12 GB with integrated graphics, a 4-core CPU, and a Vulkan 1.3-capable GPU**;
the client now allocates **4 GB of RAM by default**. See
[Java Edition hardware requirements](https://minecraft.wiki/w/Java_Edition_hardware_requirements)
and the [26.1 release article](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1).
This workspace is headless, has no `/dev/dri`, no `DISPLAY`, 8 GB total RAM
(~4 GB free), and 4 cores. A single backend runs here; an official client plus
backend plus proxy does not fit reliably. The client host is therefore a
separate machine/display, or a software-rendered VM (llvmpipe/lavapipe) that
should be treated as a fallback, not the primary proof.

### Configuration semantics that shape the matrix

| Key | Proven default | Testbed implication |
|---|---|---|
| `online-mode` | `true` | Direct real-client rows use `true`. `false` disables Mojang auth and encryption; only a fast protocol pre-check, never a Gate B proof. |
| `enforce-secure-profile` | `true` | With `online-mode=false`, clients lack a Mojang-signed key and are rejected; **do not run offline + secure-profile=true**. Direct online rows can keep `true`. Proxy rows set the backend to `false`. |
| `white-list` | Set explicitly; do not rely on defaults | Backend whitelist contains **only the puppet**; the Monoplayer attach whitelist contains **only the player**. Use UUIDs, not display names, where possible. |
| `enforce-whitelist` | `false` | Set `true` for the denial test so a reload kicks non-whitelisted players immediately. |
| `prevent-proxy-connections` | `false` | Leave `false`. `true` compares the player's connection IP with Mojang's auth IP and can kick the puppet when Monoplayer's egress differs. A separate auth/IP row can prove the production setting later. |
| `view-distance` | `10` (min 3) | Set **4** for Gate B. This is 81 chunks around the player, enough to render and exercise chunk batching without a 21×21 burst. |
| `simulation-distance` | `10` (min 3) | Set **4** with view distance. |
| `network-compression-threshold` | `256` bytes; `-1` disables; `0` compresses everything | Keep **256** in the mandatory rows. Add one `-1` variant only if compression handling is in scope; it is a known class of per-leg bugs. |
| `pause-when-empty-seconds` | Vanilla `60`; **Paper default `-1`** (disabled) | Vanilla: set `0` for the testbed. Paper: leave its default. A detached front client still leaves the puppet connected, but a restart or kick can empty the server. |
| `enable-rcon` | Vanilla `false`; itzg `true` | Enable explicitly for the testbed, bind it to ClusterIP/localhost only, and generate a password per run. Never expose 25575. |
| `max-tick-time` | Vanilla `60000` | Consider `-1` only for fault rows so the watchdog does not kill a deliberately stalled server; document that this can mask a hang. |

Sources: [Minecraft Wiki server.properties](https://minecraft.wiki/w/Server.properties),
[Paper server.properties reference](https://docs.papermc.io/paper/reference/server-properties/),
[Paper global configuration](https://docs.papermc.io/paper/reference/global-configuration/).

**Front leg vs backend leg.** Monoplayer has two independent `online-mode`
settings. Gate B's **front leg** must be `online-mode=true` with a real
`hasJoined` check so the attaching player is proven; Gate A used an offline
front leg. The **backend leg** is the matrix dimension below. Do not conflate
them.

### Valid online-mode / secure-profile combinations

| Backend online | Backend secure-profile | Proxy | Valid? | Use |
|---|---|---|---|---|
| `true` | `true` | none | **Yes** | M1–M3, M5 |
| `true` | `false` | none | Yes, weaker | Not needed; insecure chat, no extra proof |
| `false` | `false` | none or Velocity/Bungee | **Yes** | M0 protocol pre-check; M4 backend |
| `false` | `true` | none or proxy | **No** | Login rejection: offline clients have no Mojang-signed key |

For Velocity: proxy `online-mode=true` and `force-key-authentication=true`;
backend `online-mode=false`, `enforce-secure-profile=false`,
`proxies.velocity.enabled=true`, `proxies.velocity.online-mode=true`, and a
shared secret. The backend still needs the puppet on its whitelist; Velocity
forwards the puppet's UUID/profile. See
[Velocity forwarding docs](https://docs.papermc.io/velocity/player-information-forwarding/)
and [Paper global config](https://docs.papermc.io/paper/reference/global-configuration/).

### The current Gate A proxy cannot join an online-mode backend as written

This is a local-code fact, not a backend fact. `src/proxy.js` creates the
backend client with `online-mode: false` and no Microsoft auth. Gate A never
exercises encryption, `hasJoined`, or secure profiles. `minecraft-protocol`
1.68.0 *does* support profile certificates (`src/client/microsoftAuth.js`
fetches them unless `disableChatSigning` is set), so the matrix is feasible,
but the auth gate (ticket 03) must land before M1–M5. Sequence the first
implementation as:

1. Gate A proxy → **Paper offline** (`online-mode=false`,
   `enforce-secure-profile=false`): protocol pre-check only.
2. Add puppet Microsoft auth and encryption to the backend leg.
3. Gate A proxy → **Paper online/secure**: the first real Gate B row.

Do not report a pass on step 1 as a Gate B backend result.

---

## Recommendations

### 1. Put a server-side proxy behind Monoplayer, never in front

```
official client
  -> Monoplayer front leg (server role, online-mode=true, hasJoined)
     -> Monoplayer backend leg (client role, puppet, Microsoft auth)
        -> Toxiproxy (fault layer)
           -> [Velocity 4.3.1]  (optional server-side proxy)
              -> Paper / Vanilla / Fabric (backend)
```

- **Velocity** is the recommended proxy lane: modern forwarding, MAC-signed
  player info, online-mode split, UUID/skin/IP consistency. It is the closest
  public analogue to Deepmine's Gate proxy and is version-current for 26.1.2.
- **BungeeCord** is the legacy lane: `ip_forward=true`, backend
  `bungeecord=true`, backend `online-mode=false`, no MAC unless BungeeGuard.
  It is common but insecure; defer it.
- **ViaProxy** is a version translator, not an identity proxy. It supports
  26.1.2 on both sides, but using it to translate a 26.1 front to an older
  backend is a version matrix, which the map explicitly defers. Defer it.
- **Deepmine Gate** (`proxies/go-proxy`) is a Velocity-compatible proxy, not
  Velocity. If Gate B later needs to mimic the Deepmine path, add one Gate row
  after the Velocity row; do not make Gate the mandatory proxy, because
  Monoplayer must not replace Deepmine's Gate proxy and the map says so.
- **Fabric behind Velocity** needs **FabricProxy-Lite 2.12.0** (supports
  26.1/26.1.1/26.1.2). Defer it; Paper has native modern forwarding and is the
  cheaper proxy backend.
- **Vanilla behind Velocity** has no native modern forwarding. It needs a
  forwarding plugin/mod and is not worth a Gate B row.

**Why not in front:** a proxy in front of Monoplayer terminates the client's
login before Monoplayer's `hasJoined`, so Monoplayer would see the proxy as the
client, not the player. Its attach whitelist and identity checks would be
meaningless, and it would have to implement Velocity forwarding itself. That is
a different product.

### 2. Use Toxiproxy for deterministic faults; do not start with `tc netem`

**Toxiproxy 2.13.0** is a single static Go binary with an HTTP API and a CLI.
Proven from its README:

- `latency` = `latency` ± `jitter`, per stream; add it on both `upstream` and
  `downstream` for symmetric RTT.
- `packet_loss` = `loss_rate` + `correlation` for bursty loss.
- `down`, `timeout`, `reset_peer`, `bandwidth`, `slicer`, `slow_close`,
  `limit_data`.
- No root, no Docker; the proxy and API are separate from the application.

Sources: [Toxiproxy README](https://github.com/Shopify/toxiproxy#toxics),
[release 2.13.0](https://github.com/Shopify/toxiproxy/releases/tag/v2.13.0).

**`tc netem`** is the kernel alternative. It supports delay, jitter, loss,
corrupt, duplicate, reorder, rate, and a seed, but it requires root/CAP_NET_ADMIN
and applies to an interface or class; selective per-flow faults need filters or
a network namespace. Use it only as an optional "kernel qdisc" realism row, not
the primary harness. Source:
[`tc-netem(8)`](https://www.man7.org/linux/man-pages/man8/tc-netem.8.html).

**Fault scenarios to run on the Paper row:**

| Phase | Fault | What it should expose |
|---|---|---|
| Attach | `latency 100ms ± 30ms`, both directions | Login/config/join timeouts, keep-alive timing, chunk-burst pacing |
| Steady | `packet_loss 0.5% correlation 25%` | Retransmit/reorder handling, cache consistency, chat/position loss |
| Freeze | `down` for 5 s, then restore | Front-client freeze vs disconnect and recovery; do **not** expect keep-alive expiry at 5 s |
| Timeout | `down` for 35–60 s, then restore | Keep-alive expiry, front-client disconnect reason, no silent stale cache |
| Reset | `reset_peer` on the upstream | Abrupt backend loss, error classification, no reconnect loop |
| Kick | RCON `kick <puppet> gate-b` | Backend-initiated disconnect; expected front-client behaviour is a Gate B decision |
| Restart | RCON `stop`, wait, start; then `kill -TERM`/`-KILL` variants | One backend login vs reconnect, cache invalidation, detach survival |
| Queue | `timeout` or hold the first backend bytes for 10–60 s | Client stuck on "Joining world…"; no crash or premature kick |

For restart, use a fresh `emptyDir` world for most rows and a Longhorn PVC only
for a persistence-specific row. For kick, use RCON, not a console keystroke.
For "crash", `kill -KILL` the JVM; for "graceful", RCON `save-all flush` then
`stop`. Record backend login count before and after every fault; a silent
second login is the defect Gate B is looking for.

Do **not** add a chaos framework. Toxiproxy + a process supervisor + RCON is
enough, and it keeps the fault schedule in the scenario log.

### 3. Recommended matrix

**Mandatory rows (recommended for Gate B v1).** Every row assumes the
**Monoplayer front leg** is `online-mode=true` with a real `hasJoined` check;
the "Backend online" column is the separate puppet-leg setting.

| # | Backend | Backend online | Secure profile | Proxy | Fault | Reps | Why |
|---|---|---|---:|---|---|---:|---|
| M1 | Vanilla 26.1.2 | `true` | `true` | none | none | 1 | Reference implementation; encryption, `hasJoined`, secure profile, vanilla config/join/chunks |
| M2 | Paper 26.1.2 b74 | `true` | `true` | none | none | 1 | Most common production server; Paper config/messages/chunk behaviour |
| M3 | Fabric 26.1.2 + API 0.155.3 + Carpet 26.1 | `true` | `true` | none | none | 1 | Modded loader/registry/custom payloads; Carpet deterministic control |
| M4 | Paper 26.1.2 b74 | `false` | `false` | Velocity 4.3.1 modern forwarding; proxy online | none | 1 | Forwarding, UUID/profile identity, online-mode split, real server-side proxy |
| M5 | Paper 26.1.2 b74 | `true` | `true` | none | latency/jitter/loss + 5 s freeze + 35–60 s timeout + RCON kick + restart | 3 | Resilience, detach survival, keep-alive expiry, restart/kick semantics, no silent second login |

**Cheap add-on, not a separate backend:** M2b = Paper 26.1.2, direct,
`network-compression-threshold=-1`, online/secure. Run it only if compression
handling is in scope. Default `256` is already exercised by M1–M5, so this is
the first row to defer.

**Protocol pre-check, not a Gate B row:** M0 = Paper 26.1.2, `online-mode=false`,
`enforce-secure-profile=false`, Gate A's fake client. This isolates protocol
regressions before spending a real client/account run.

**Deferred rows and reasons:**

| Row | Why deferred |
|---|---|
| BungeeCord 2111 + Paper legacy forwarding | Insecure legacy forwarding; low product value once Velocity passes. Revisit only if a real target server uses BungeeCord. |
| ViaProxy 3.4.14 + older backend | Version translation is out of scope; the map says do not design a version matrix yet. |
| Fabric + Velocity (FabricProxy-Lite 2.12.0) | Extra mod/loader interaction; Paper's native forwarding is the cheaper proxy proof. |
| Vanilla + Velocity | No native modern forwarding; needs a plugin/mod that changes what is being tested. |
| Deepmine Gate proxy (`proxies/go-proxy`) | Deepmine-specific; Monoplayer must not replace it. Optional compatibility lane later. |
| Paper 26.3 / 26.2 | Protocol drift away from 775; a new gate, not this one. |
| Direct offline mode | Already covered by Gate A/L2; not a real-client proof. |
| `online-mode=true` + `secure-profile=false` | Works but proves less; no need for a mandatory row. |
| `online-mode=false` + `secure-profile=true` | Invalid: login rejection. |
| `prevent-proxy-connections=true` | A separate auth/IP row; can kick a legitimate puppet. |
| Queue simulation, 5-minute detach soak | Gate B scenarios, not backend rows; add after M1–M5. The 5-minute window is an acceptance decision (ticket 05). |
| Multiple simultaneous clients, chat signing, resource packs, IPv6/SRV/TLS | Separate compatibility lanes; not backend matrix rows. |

Repetition: baseline rows once; fault row three times (3/3) to distinguish a
real failure from a one-off. Keep the same world seed and config across reps.

### 4. Topology

```
DISPLAY HOST / TAILNET                         HOMELAB CLUSTER: monoplayer-gate-b
┌──────────────────────────────┐               ┌────────────────────────────────────────────┐
│ Prism 26.1.2 (player)        │               │                                            │
│   │ TCP 25565                │               │                                            │
│   ▼                          │               │                                            │
│ Monoplayer front leg         │               │                                            │
│   online-mode=true           │               │                                            │
│   hasJoined, attach whitelist│               │                                            │
│   │                          │               │                                            │
│ Monoplayer backend leg       │               │                                            │
│   puppet, Microsoft auth     │               │                                            │
│   │ TCP 25570                │               │                                            │
│   ▼                          │               │                                            │
│ Toxiproxy 2.13.0 ~~~~~~~~~~~~┼── tailnet ───▶│ [Velocity 4.3.1 :25566]                    │
│   latency/jitter/loss/down   │               │        │                                   │
│   reset/timeout              │               │        ▼                                   │
│                              │               │ Paper / Vanilla / Fabric :25565            │
│ scenario controller ─────────┼── kube API ──▶│   RCON :25575 (ClusterIP only)             │
│   attach/detach, RCON,       │               │   SLP :25565 readiness                     │
│   restart, assertions        │               │   emptyDir world (PVC only for persistence) │
└──────────────────────────────┘               └────────────────────────────────────────────┘
```

Key points:

- The fault layer is on the **puppet leg**, between Monoplayer and the first
  server-side hop. If Velocity is present, the fault layer is before Velocity;
  otherwise it is before Paper.
- RCON is ClusterIP/`kubectl exec` only. Never put 25575 on the Tailscale
  Service or a public port.
- Use a Tailscale `LoadBalancer` Service for the fault proxy or backend, as
  the deepmine demo does for its proxy
  (`deploy/components/gateway/gateway.yaml` is the HTTPS pattern; the demo's
  `proxy` Service is the TCP pattern). Do not rely on `kubectl port-forward`
  for latency-sensitive rows: it is a userspace stream and adds its own jitter.
- The scenario controller can run on the display host and reach the cluster API
  for restart/delete; or a small in-cluster Job can own RCON and Kubernetes
  lifecycle while the display host only runs the client.
- The cluster currently has **no `monoplayer-dev` namespace**. Use a dedicated
  `monoplayer-gate-b` namespace for test resources; keep `monoplayer-dev` for
  the product if/when it exists. This avoids a gate backend restart colliding
  with the product's single replica.

### 5. Startup and teardown plan

**One-time cache (gitignored, no credentials):**

- `.cache/gate-b/vanilla/26.1.2/server.jar` + sha1.
- `.cache/gate-b/paper/26.1.2/build-74/paper.jar` + sha256.
- `.cache/gate-b/fabric/26.1.2/loader-0.20.1/` + installer 1.1.2; mods
  `fabric-api-0.155.3+26.1.2.jar` and `fabric-carpet-26.1+v260402.jar`.
- `.cache/gate-b/velocity/4.3.1/build-45/velocity.jar`.
- A `gate-b.lock.json` in git with URLs and checksums only; jars, worlds, logs,
  tokens, whitelists, and RCON passwords stay out of git.

**Backend config template (per row):**

```
server-port=25565
server-ip=
online-mode=<row>
enforce-secure-profile=<row>
white-list=true
enforce-whitelist=true
level-name=world
level-type=minecraft:flat
generate-structures=false
level-seed=775
spawn-protection=0
view-distance=4
simulation-distance=4
max-players=4
difficulty=peaceful
gamemode=creative
enable-status=true
enable-rcon=true
rcon.port=25575
rcon.password=<runtime secret>
broadcast-rcon-to-ops=false
pause-when-empty-seconds=0
sync-chunk-writes=false
network-compression-threshold=256
motd=gate-b <row>
```

For Paper, leave `pause-when-empty-seconds` at Paper's `-1` unless the scenario
needs a pause; Paper rewrites its own configs. For Fabric, add
`MODRINTH_PROJECTS`/mod jars and `FABRIC_LOADER_VERSION=0.20.1`. For Velocity,
set `online-mode=true`, `force-key-authentication=true`,
`player-info-forwarding-mode="modern"`, `forwarding-secret-file`, and a
`servers` entry pointing at the backend; the backend gets
`online-mode=false`, `enforce-secure-profile=false`,
`proxies.velocity.enabled=true`, `proxies.velocity.online-mode=true`, and the
same secret.

**Lifecycle:**

1. Create `monoplayer-gate-b` (or a per-run `gate-b-<id>` namespace). Apply a
   ConfigMap with the row's `server.properties`, a temp Secret with the RCON
   password and whitelist, and one backend Deployment/StatefulSet.
2. Wait for SLP: `minecraft-protocol` ping or `mc-monitor` until `version` is
   non-empty and matches 26.1.2. Do not rely on a TCP connect alone.
3. Start Toxiproxy (and Velocity, if the row has it). Verify the proxy path
   with a protocol ping before starting Monoplayer.
4. Start Monoplayer with the puppet auth cache mounted read-only and the
   attach whitelist for the player. Start the official client on the display
   host.
5. Run the scenario with timestamps. Before teardown, `save-all flush`, then
   `stop` via RCON. Wait up to 30 s; SIGTERM; SIGKILL after 30 s. Delete the
   namespace; archive redacted logs and the report.
6. `mise run gate-b:down` must also kill Toxiproxy, Velocity, and any local
   Monoplayer/client process, and must delete temp Secrets. A failed run leaves
   the namespace only if `--keep` is set.

**Timing budget:** warm backend ready 7–10 s; cold direct 10–15 s; itzg cold
+5–15 s; first image pull 30–90 s; scenario 60–300 s; teardown 10–30 s. A
five-row matrix with one repetition is roughly 10–30 minutes plus client
launch; three fault repetitions add a few minutes.

**Security:** no Microsoft credentials, tokens, real UUIDs, or RCON passwords
in git. Use a runtime Secret for RCON and whitelist; use the puppet auth cache
from ticket 03; redact UUIDs/names in archived logs if they are owner
identifiers. Run the testbed with no public ingress and a default-deny
NetworkPolicy.

### 6. Resource estimates

| Component | Request | Limit | Measured/estimated RSS | Disk |
|---|---:|---:|---:|---:|
| Vanilla 26.1.2 | 500m / 1Gi | 1 / 2Gi | 673 MB at ready, 1G heap | ~2 MB world + 60 MB jar |
| Paper 26.1.2 b74 | 1 / 1.5Gi | 2 / 3Gi | 843 MB at ready, 1G heap | ~7 MB world + 53 MB jar |
| Fabric + API + Carpet | 1 / 1.5Gi | 2 / 3Gi | 732 MB at ready, 1G heap | ~2 MB world + 58 MB server/libs + 4 MB mods |
| Velocity 4.3.1 | 250m / 256Mi | 1 / 512Mi | 196 MB at ready, 512M heap | ~42 MB jar |
| Toxiproxy 2.13.0 | 50m / 32Mi | 250m / 128Mi | <20 MB (estimate) | static binary |
| Monoplayer (Node) | 100m / 128Mi | 1 / 512Mi | ~100–300 MB (estimate; Gate A not measured under load) | small |
| Official client | 2 cores / 4Gi | 4 cores / 6Gi | 2–4 GB RSS; 4 GB default allocation | ~1 GB install |

- **Per row:** one backend + one proxy + Toxiproxy + Monoplayer requests under
  **2 CPU / 2 GiB** (limits sum to ~4 GiB), so rows can be sequential on a
  single node.
- **Cluster headroom:** two nodes, each ~5950m allocatable CPU and ~32 GiB
  allocatable memory; current usage is roughly 2 CPU / 12 GiB total. The
  matrix fits with a wide margin even if all three backends run at once.
- **Local:** direct Java backend fits in the ~4 GiB free; client + backend +
  proxy does not. The client's minimum is 8 GB system RAM (discrete GPU) or
  12 GB (integrated), plus Vulkan 1.3.
- **Storage:** use `emptyDir` for matrix rows (no Longhorn latency, no cleanup
  risk). Use a 2 GiB Longhorn PVC only for a restart/persistence row. The
  itzg image is ~362 MB compressed; cache jars and images outside git.

### 7. Risks and things to verify before committing to the matrix

1. **Paper 26.1.2 is EOL.** Build 74 is the last 26.1.2 build and is marked
   unsupported since 2026-07-26. The testbed must stay isolated; do not use it
   for a public server. If a security fix is required, the target protocol
   must move, which is a new gate.
2. **The puppet must satisfy secure profiles.** `minecraft-protocol` supports
   profile certificates, but Gate A's proxy does not request them. Verify M1
   with a real Microsoft-auth puppet before scheduling M2–M5. If the puppet
   cannot get a certificate, the fallback is `enforce-secure-profile=false`;
   that is a weaker Gate B and must be recorded as a limitation.
3. **The front leg must be online-mode.** Gate A's front leg is offline. If
   Gate B keeps it offline, it does not prove attaching-player auth even if the
   backend is online. This is a scope trap.
4. **Cluster image availability.** The demo uses
   `registry.internal/deepmine/minecraft-base`, not `itzg/minecraft-server`.
   Build/push a pinned Gate B image through BuildKit or mirror the itzg digest
   into zot. Do not assume Docker Hub pulls work from every pod.
5. **No display/GPU here.** Do not schedule the official client on this
   workspace. Use a display host or accept software rendering as a fallback.
6. **Velocity is not Deepmine Gate.** They are both Velocity-compatible, but
   Gate is a different implementation. A Velocity pass is not a Gate pass.
7. **World format changed in 26.1.** Do not reuse a 1.21 world; use a fresh
   26.1.2 flat world. The Spigot announcement explicitly warns about internal
   world-file location changes.

---

## Smallest falsifying experiment

Run this **before** building the full matrix. It catches the largest real
backend incompatibility with one backend and two accounts.

**Setup:**

1. On the display host, a Prism Launcher 26.1.2 instance with the **player**
   account. Do not add the puppet account to Prism.
2. In `monoplayer-gate-b`, one **Paper 26.1.2 build 74** pod:
   `online-mode=true`, `enforce-secure-profile=true`,
   `white-list=true`, `enforce-whitelist=true`, whitelist = `<puppet-uuid>`,
   `view-distance=4`, `simulation-distance=4`, `spawn-protection=0`,
   RCON on 25575 with a runtime password.
3. Monoplayer with:
   - front leg `online-mode=true`, attach whitelist = `<player-uuid>`;
   - backend leg `auth: microsoft` for the **puppet**, with profile
     certificates enabled (do not set `disableChatSigning`);
   - no server-side proxy and no fault proxy.
4. Connect the client to Monoplayer and perform: join → wait for terrain →
   walk → break one block → place one block → disconnect → wait 30 s →
   reattach.

**Pass:** the client leaves "Loading terrain…", renders, moves, and edits a
block; the backend log shows exactly **one** login for `<puppet>`, with
encryption and no secure-profile error; after detach/reattach the backend
login count is still **one**, and the client sees its current position/world.

**Fail:** any client disconnect, `Invalid session`, "Cannot verify secure
profile", the backend sees the player account, a second backend login on
reattach, or a stale position/chunk replay.

If this passes, the Paper row (M2) is covered; add M1 (Vanilla), M3 (Fabric),
M4 (Velocity), and M5 (fault). If it fails, the failure class tells you which
lane to fix first: auth/encryption, secure profile, Paper config, or the
synthesized join/cache.

---

## Evidence links

- [Minecraft 26.1.2 version JSON](https://piston-meta.mojang.com/v1/packages/4e49d699db7dba839226d0ed1fcf36c465c2edbe/26.1.2.json)
- [Minecraft 26.1 version JSON](https://piston-meta.mojang.com/v1/packages/90d81d9cd00c1ce55eb2b40aad4f1112bb58f12a/26.1.json)
- [Protocol version list](https://minecraft.wiki/w/Protocol_version)
- [Minecraft Wiki: Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1)
- [Minecraft Wiki: server.properties](https://minecraft.wiki/w/Server.properties)
- [Minecraft Wiki: Java Edition hardware requirements](https://minecraft.wiki/w/Java_Edition_hardware_requirements)
- [Minecraft.net: 26.1 release](https://www.minecraft.net/en-us/article/minecraft-java-edition-26-1)
- [Paper downloads](https://papermc.io/downloads/paper)
- [Paper fill API: 26.1.2 builds](https://fill.papermc.io/v3/projects/paper/versions/26.1.2/builds)
- [Paper global configuration](https://docs.papermc.io/paper/reference/global-configuration/)
- [Paper server.properties](https://docs.papermc.io/paper/reference/server-properties/)
- [Fabric loader meta for 26.1](https://meta.fabricmc.net/v2/versions/loader/26.1)
- [Fabric installer meta](https://meta.fabricmc.net/v2/versions/installer)
- [Fabric API 0.155.3+26.1.2](https://modrinth.com/mod/fabric-api/version/3dM0X6ou)
- [Carpet 26.1](https://modrinth.com/mod/carpet/version/ygtmLbO3)
- [Velocity downloads](https://papermc.io/downloads/velocity)
- [Velocity forwarding](https://docs.papermc.io/velocity/player-information-forwarding/)
- [Velocity configuration reference](https://docs.papermc.io/velocity/configuration/)
- [BungeeCord 26.1/26.1.1/26.1.2 announcement](https://www.spigotmc.org/threads/spigot-bungeecord-26-1-26-1-1-26-1-2.718646/)
- [BungeeCord build 2111](https://hub.spigotmc.org/jenkins/job/BungeeCord/2111/)
- [ViaProxy 3.4.14](https://github.com/ViaVersion/ViaProxy/releases/tag/v3.4.14)
- [ViaProxy supported versions](https://github.com/ViaVersion/ViaProxy#supported-server-versions)
- [itzg Java tags](https://docker-minecraft-server.readthedocs.io/en/latest/versions/java/)
- [itzg variables](https://docker-minecraft-server.readthedocs.io/en/latest/variables/)
- [itzg server properties](https://docker-minecraft-server.readthedocs.io/en/latest/configuration/server-properties/)
- [itzg Paper type](https://docker-minecraft-server.readthedocs.io/en/latest/types-and-platforms/server-types/paper/)
- [itzg Fabric type](https://github.com/itzg/docker-minecraft-server/blob/master/docs/types-and-platforms/server-types/fabric.md)
- [itzg Modrinth downloads](https://github.com/itzg/docker-minecraft-server/blob/master/docs/mods-and-plugins/modrinth.md)
- [Toxiproxy README](https://github.com/Shopify/toxiproxy#toxics)
- [Toxiproxy 2.13.0](https://github.com/Shopify/toxiproxy/releases/tag/v2.13.0)
- [`tc-netem(8)`](https://www.man7.org/linux/man-pages/man8/tc-netem.8.html)
- Local context: `deploy/images/minecraft-base/Dockerfile`, `assert`,
  `entrypoint.sh`; `examples/demo/`; `proxies/go-proxy/config.yml`;
  `proxies/voice-server/adr/0001-blind-udp-relay.md`;
  `docs/gate-a.md`; `src/proxy.js`.
