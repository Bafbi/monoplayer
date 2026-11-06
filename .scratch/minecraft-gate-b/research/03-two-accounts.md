# Research: two-account setup and auth

**Ticket:** `.scratch/minecraft-gate-b/issues/03-research-two-accounts.md`
**Status:** resolved (research only; nothing implemented)
**Target:** Minecraft Java 26.1 / protocol 775
**Scope:** safe provisioning and operation of the **puppet** and the **attaching player** account for Gate B.

---

## Summary

Use **two separate, owner-operated Microsoft accounts**, each owning Java Edition:

- **Puppet** — a dedicated headless account, logged in only by the Monoplayer
  process through `prismarine-auth`/`minecraft-protocol`. It is the only account
  the backend ever sees.
- **Player** — the human's normal account, added to Prism Launcher and connected
  to the Monoplayer front leg. It never logs into the backend.

The recommended stack is:

1. **Puppet auth:** Microsoft device code once, then a rolling refresh token in a
   writable cache. Local cache in `.secrets/puppet/` (gitignored, mode `0700`/`0600`);
   cluster cache in the architecture's `monoplayer-puppet-auth` Secret with a
   single-writer write-back.
2. **Player client:** Prism Launcher 11.x, one 26.1 vanilla instance, per-instance
   account override, launched with
   `prismlauncher -l gate-b-player -a "<player>" -s 127.0.0.1:25565`.
   Do **not** add the puppet account to Prism.
3. **Two whitelists:** the backend whitelist contains **only the puppet**; the
   Monoplayer attach whitelist contains **only the player**. Both are keyed by
   Mojang UUID, resolved at add time from the username.
4. **One writer:** exactly one proxy process may own the puppet token cache.
   Two replicas, two proxy processes, or a GUI client logged in as the puppet
   will fight over refresh-token rotation and/or kick the backend session.
5. **Fallback:** offline mode for protocol tests, or one real account as both
   roles for a smoke test. Neither can pass Gate B's real-attach assertions.

The smallest falsifying experiment is at the end: device-code bootstrap → silent
refresh → two distinct real accounts against a minimal online-mode whitelist
gate, one admitted and one denied before `Login Success`.

**Secrets rule:** no token, refresh token, device code, password, or real account
identifier belongs in git. This note uses placeholders only; the runtime cache
lives in `.secrets/` or the cluster Secret.

---

## What is proven, and what is recommendation

| Claim | Status | Evidence |
|---|---|---|
| Java 26.1 and 26.1.2 are protocol **775**; 26.1 requires **Java SE 25** | Proven | [Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1), [Protocol version](https://minecraft.wiki/w/Protocol_version) |
| Device code gives the user **15 minutes** to approve; polling interval is server-supplied (commonly 5 s) | Proven | [Microsoft device-code doc](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) |
| MSA access tokens default to 60–90 min; refresh-token max inactive time is **90 days** and is not configurable | Proven | [Microsoft token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes) |
| `prismarine-auth` uses `live` or `msal`/`sisu` flows, caches tokens as JSON files, and updates the cache on refresh | Proven | [prismarine-auth README](https://github.com/PrismarineJS/prismarine-auth), [`LiveTokenManager.js`](https://github.com/PrismarineJS/prismarine-auth/blob/master/src/TokenManagers/LiveTokenManager.js) |
| `minecraft-protocol`'s `auth: 'microsoft'` uses `prismarine-auth`; if no `authTitle` is supplied it defaults to the **Nintendo Switch** title, not the Java launcher title | Proven | [`microsoftAuth.js`](https://github.com/PrismarineJS/minecraft-protocol/blob/master/src/client/microsoftAuth.js), [`Titles.js`](https://github.com/PrismarineJS/prismarine-auth/blob/master/src/common/Titles.js) |
| `Titles.MinecraftJava` (`00000000402b5328`) currently has open `403 Forbidden` reports at `getTitleToken()` | Proven reports; cause not settled | [prismarine-auth #182](https://github.com/PrismarineJS/prismarine-auth/issues/182), [#140](https://github.com/PrismarineJS/prismarine-auth/issues/140) |
| Prism supports multiple accounts, per-instance account override, and `-d/-l/-s/-a` CLI options | Proven | [Prism CLI wiki](https://prismlauncher.org/wiki/getting-started/command-line-interface/), [Prism #341](https://github.com/PrismLauncher/PrismLauncher/issues/341), [#2642](https://github.com/PrismLauncher/PrismLauncher/issues/2642) |
| Prism expects **one process per instance**; launching the same instance twice is not supported | Proven | [Prism #250](https://github.com/PrismLauncher/PrismLauncher/issues/250) |
| Prism stores Microsoft tokens as **plain text** in its config (currently `accounts.json`) | Proven, open security issue | [Prism #4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073) |
| Two *different* Prism instances can run at once, each with its own account | Proven in practice; verify once on the target machine | Prism #250 implies only the same instance is blocked; [user reports](https://www.reddit.com/r/admincraft/comments/16u84yn/two_accounts/) confirm the two-instance/two-account workflow |
| `-s` takes a full address and parses `host:port`; Prism has no separate `--port` option | Proven | [Prism CLI wiki](https://prismlauncher.org/wiki/getting-started/command-line-interface/), [`MinecraftTarget.cpp`](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/launch/MinecraftTarget.cpp) |
| Vanilla client `--server`/`--port` were removed in 1.20; current equivalent is `--quickPlayMultiplayer host:port` | Proven | [Client command line arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments) |
| A second login with the same account kicks the older session with “You logged in from another location” | Proven | [Minecraft Wiki: Server disconnects](https://minecraft.wiki/w/Server) |
| Usernames are case-insensitive and changeable; UUIDs are stable. Resolve names to UUIDs when adding | Proven | [Mojang API](https://minecraft.wiki/w/Mojang_API) |
| Vanilla `whitelist.json` stores `{uuid, name}`; `white-list=true` enforces it; ops are auto-whitelisted | Proven | [Server.properties](https://minecraft.wiki/w/Server.properties), [Whitelist.json](https://minecraft.wiki/w/Whitelist.json) |
| Offline-mode servers derive a different UUID from the username; Mojang UUIDs do not apply | Proven | [Server.properties: online-mode](https://minecraft.wiki/w/Server.properties), `minecraft-protocol` `nameToMcOfflineUUID` |
| Owner-operated, single-tenant, no account sharing is the legal/ops boundary | Prior research | [security/legal/ops research 04](../../minecraft-puppet-proxy/research/04-security-legal-ops.md), [architecture auth section](../../../docs/architecture.html#auth) |

**Not proven / must be measured:** whether the Java launcher title works for the
puppet's account today; whether Prism 11.x runs two different instances cleanly
on the target Linux desktop; whether the exact 26.1.2 packet mappings in
`minecraft-data` are correct (there is an open `pc26_1_2` mapping issue:
[mineflayer #3888](https://github.com/PrismarineJS/mineflayer/issues/3888)).
Pin **26.1** for Gate B's protocol path unless 26.1.2 is separately verified.

---

## 1. Account topology and safety

### Roles

| Role | Who owns it | Where it logs in | What the backend sees |
|---|---|---|---|
| **Puppet** | Operator; dedicated alt | Headless Monoplayer only | Puppet's UUID/name/skin, one TCP session |
| **Player** | Operator (normal account or second alt) | Prism → Monoplayer front leg | Nothing; only the puppet is in the backend session |
| **Backend admin** | Operator | Server console/RCON | Not a player |

The player's account is only proof of permission to attach. The front leg calls
Mojang `hasJoined`, gets the player's UUID, checks it against the attach
whitelist, then sends `Login Success` with the **puppet's** profile. The player's
credentials never reach Monoplayer, and the player never logs into the backend.
This is the architecture's existing trust boundary
([architecture auth](../../../docs/architecture.html#auth)).

### What to verify on both accounts

Run these checks before Gate B, and have `auth:status` repeat them for the puppet:

1. **Java ownership.** With the account's Minecraft bearer token,
   `GET https://api.minecraftservices.com/entitlements/mcstore` (or the newer
   `/entitlements/license?requestId=<uuid>`) must return `game_minecraft` and
   `product_minecraft`. Empty items means no Java ownership or a Game Pass
   entitlement that does not satisfy the test
   ([Mojang API](https://minecraft.wiki/w/Mojang_API)).
2. **Profile.** `GET https://api.minecraftservices.com/minecraft/profile`
   returns `id` (UUID) and `name`. Record both.
3. **Multiplayer allowed.** `GET /player/attributes` must show
   `privileges.multiplayerServer.enable = true`, and must not show a
   `banStatus.bannedScopes.MULTIPLAYER` entry. A `false` here produces the
   documented `InsufficientPrivilegesException` on backend join.
4. **Xbox profile and region.** The account must have an Xbox profile and be in a
   supported region. Device auth failure codes are diagnostic: `2148916233` (no
   Xbox profile), `2148916235` (region blocked), `2148916238` (child account),
   `2148916227` (Xbox ban). See prior research 04 §1.
5. **2FA and recovery.** Enable 2FA on both accounts. Use distinct passwords and
   recovery methods. Do not put the puppet in a shared family group.

### Avoiding accidental account sharing

- Do not transfer credentials, buy accounts, or use someone else's account. The
  Microsoft Services Agreement makes the account owner responsible for all
  activity and forbids transferring credentials; the Minecraft EULA forbids
  unfair/unreasonable access distribution. Owner-operated, single-tenant use is
  the boundary the prior research accepted.
- Treat the **device code itself** as sensitive. Anyone who can approve it can
  grant a refresh token for that account.
- Do not add the puppet account to Prism, a browser profile, or any other
  launcher. Every extra client is another token holder and another potential
  duplicate session.
- Do not sync `.secrets/` or the Prism root to cloud storage. Prism's
  `accounts.json` is plaintext today ([#4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073)).
- Do not share screenshots/logs without checking for email, gamertag, UUID, or
  token fragments.

### Duplicate-session rules

A backend allows one online player per UUID. A second login with the same account
kicks the older connection with “You logged in from another location”
([Minecraft Wiki: Server](https://minecraft.wiki/w/Server)). Therefore:

| Scenario | Result | Rule |
|---|---|---|
| One proxy, one puppet | Normal | Required |
| Two proxy replicas / two processes sharing the puppet cache | Token rotation race; one backend session is kicked; reconnect loop | **Never**; one writer, one replica |
| GUI client logged in as the puppet while the proxy runs | Backend kicks one of them | **Never** during Gate B |
| Player client connects to the **backend** directly | Backend sees the player, not the puppet; if the player is not whitelisted it is rejected; if whitelisted it is a separate player | Always point the client at Monoplayer, never the backend |
| Same account used as puppet and player, and the player joins the backend directly while the backend admits it | Backend kicks the puppet | One-account fallback is operationally dangerous; see §5 |
| Player account used on another server while Gate B runs | No effect on the puppet | Allowed |

If you see a duplicate-login kick, check for: a stray Prism instance, a previous
Java process, a second proxy process, a second pod, or a copied token cache.
`pgrep -af 'java|node'`, the backend log, and `auth:status` should identify it.

---

## 2. Puppet: device-code auth and token custody

### Bootstrap flow

The user-facing flow is:

1. `mise run auth:device-code --account puppet`
2. The task prints the Microsoft verification URL and a short user code.
3. The operator opens the URL on any browser/phone, signs in as the puppet,
   completes 2FA, and approves.
4. The task polls until Microsoft issues the token set, then calls
   `getMinecraftJavaToken({ fetchProfile: true, fetchEntitlements: true })`.
5. The task writes the cache and prints **name, UUID, Java ownership, multiplayer
   privilege** — never a token.

The user has 15 minutes to approve. The code is short-lived and the flow cannot be
completed unattended; after this one human step, the refresh token is what makes
the puppet headless.

### Library configuration

`minecraft-protocol` already wraps `prismarine-auth`. The proxy's back leg can use:

```js
mc.createClient({
  host: backendHost,
  port: backendPort,
  username: 'puppet',                 // stable cache key, not the display name
  auth: 'microsoft',
  version: '26.1',
  profilesFolder: '.secrets/puppet',  // writable; do not use the default ~/.minecraft/nmp-cache
  authTitle: '00000000402b5328',      // Titles.MinecraftJava, try first
  deviceType: 'Win32',
  flow: 'live',
  onMsaCode: data => console.error(data.message)
})
```

**Local repo note:** `prismarine-auth` is currently a transitive dependency of
`minecraft-protocol` and is not resolvable from the pnpm root (`require.resolve`
fails). If `auth:device-code`/`auth:status` import it directly, add it explicitly
to `package.json`; otherwise use `minecraft-protocol`'s `auth: 'microsoft'` path.
This is a dependency change, not a Gate B decision.

**Important caveat:** `minecraft-protocol`'s default when `authTitle` is omitted is
the **Nintendo Switch** title (`00000000401cc96b` / `Nintendo`), not the Java
launcher title ([`microsoftAuth.js`](https://github.com/PrismarineJS/minecraft-protocol/blob/master/src/client/microsoftAuth.js)).
`Titles.MinecraftJava` is the architecturally correct public launcher ID, but
there are open reports of `403 Forbidden` at `getTitleToken()` in 2026
([#182](https://github.com/PrismarineJS/prismarine-auth/issues/182)). Recommendation:

- Try `authTitle: '00000000402b5328'`, `deviceType: 'Win32'`, `flow: 'live'`.
- If `getTitleToken()` returns 403, retry with the library default
  `Titles.MinecraftNintendoSwitch` / `Nintendo`; this is the path the Prismarine
  ecosystem exercises and it still produces a Java token via
  `login_with_xbox`.
- Do **not** use `sisu` as a workaround unless measured; the same issue reports a
  profile 404/empty entitlements with `sisu` for an affected account.
- Make the title/device type a config value and record which one worked in the
  Gate B evidence. A one-line 403 must not be allowed to look like a backend bug.

A custom Azure app is not a Gate B option: `login_with_xbox` requires Mojang
approval via <https://aka.ms/mce-reviewappid>, otherwise 403. The public client ID
is the MVP path.

### Cache shape and what is secret

`prismarine-auth`'s file cache (default `~/.minecraft/nmp-cache` for
`minecraft-protocol`) writes one JSON file per cache family, named
`<hash(username)>_<family>-cache.json`. For the `live` flow the important file is
`*_live-cache.json`:

```json
{
  "token": {
    "access_token": "...",     // MSA access token, ~60-90 min
    "refresh_token": "...",    // password-equivalent, rolling, 90-day inactivity
    "expires_in": 3600,
    "obtainedOn": 1760000000000
  }
}
```

`*_xbl-cache.json` holds Xbox/XSTS tokens; `*_mca-cache.json` holds the Minecraft
access token (~24 h). The **refresh token is the only value that must survive a
restart**. It bypasses 2FA for its lifetime. The architecture already says this:
“The refresh token is the password” (`docs/architecture.html#auth`).

### Storage

**Local Gate B (recommended first):**

```
.secrets/
  puppet/
    <hash>_live-cache.json     # mode 0600
    <hash>_xbl-cache.json
    <hash>_mca-cache.json
  attach-whitelist.json        # UUIDs; not a secret, but keep out of git
```

- `.secrets/` must be gitignored. The repo already ignores
  `*.token-cache.json`; add `.secrets/` before the first bootstrap.
- `chmod 700 .secrets .secrets/puppet`; `umask 077` before the task.
- Full-disk encryption is the real protection if the laptop is lost.
- Do not put the token in an environment variable. Pass the **path** in
  `PUPPET_AUTH_CACHE` or a CLI flag; environment variables leak through
  `/proc`, crash dumps, and child processes.
- Do not put the token in `.scratch/`; that tree is intended for notes and may be
  committed.

**Cluster (later):** keep the architecture's design:

- Secret `monoplayer-puppet-auth` in the puppet namespace, applied by a mise task,
  not tracked by ArgoCD.
- Mount read-only; copy to a writable `emptyDir` at startup; set
  `profilesFolder` to the `emptyDir`.
- Patch the Secret through the Kubernetes API after each refresh with a scoped
  ServiceAccount.
- Do not assume the cluster encrypts Secrets at rest. Verify the Talos setting,
  or use an external secret store. This is still a Gate B prerequisite in
  `docs/architecture.html#auth`.
- Use `strategy: Recreate` (or a leader lock). A rolling update that starts a
  second pod before the old one exits is a duplicate-session and token-rotation
  race.

### Rotation, write-back, and locking

The refresh token is rolling/single-use in practice: each refresh consumes the
old token and issues a new one. The cache **must** be updated atomically before
the new token is used again. Rules:

1. **One writer.** The proxy is the only process allowed to refresh the puppet
   cache. `auth:status` must be read-only by default; `--refresh` must take an
   exclusive lock and refuse if the proxy holds it.
2. **Atomic write.** Write to a temp file in the same directory, `fsync`, then
   `rename` over the cache. The library's `FileCache` writes directly with
   `writeFileSync`; wrap it with a cache factory or accept the small corruption
   window for Gate B. Prefer the wrapper.
3. **No restore of old caches.** After a successful refresh, the old token is
   invalid. A `.bak` is forensic only; restoring it will fail. If the write was
   lost, re-bootstrap with a device code.
4. **Keep the window rolling.** While the proxy runs, its access-token refresh
   uses the refresh token about hourly and rolls the 90-day inactivity window. If
   the stack is idle, run `auth:status --refresh` with the proxy stopped at least
   monthly. A read-only status that never consumes the refresh token may not roll
   the window.
5. **Revocation.** Changing the MSA password or “sign out everywhere” revokes the
   refresh chain. Recovery is always: sign out everywhere / change password →
   `auth:device-code` again. There is no portable “revoke this refresh token”
   API for consumer MSAs that a testbed should depend on.
6. **Never run `auth:status` concurrently with the proxy** unless it is the
   read-only mode. Two refreshers can invalidate each other and produce a
   confusing `invalid_grant`.

### Failure diagnostics

- `403 Forbidden` at `getTitleToken()` → auth-title fallback (§2.2).
- `invalid_grant` / `AADSTS70008` → refresh token expired, revoked, or already
  consumed by another writer. Re-bootstrap; do not retry in a loop.
- `404` on `/minecraft/profile` with a token → account does not own Java or the
  token is for the wrong profile; check entitlements.
- `InsufficientPrivilegesException` on backend join → multiplayer disabled in Xbox
  privacy settings.
- `UserBannedException` → multiplayer ban; surface it as health, do not retry.
- XErr `2148916233/35/38` → no Xbox profile / region / child account.

---

## 3. Attaching player: Prism Launcher vs MultiMC, accounts, instances, roots

### Recommendation: Prism Launcher

Use **Prism Launcher 11.x** (11.0.3 at the time of writing). It is the actively
maintained MultiMC fork, supports multiple Microsoft accounts, has a per-instance
account override, and exposes the CLI Gate B needs. MultiMC also supports
Microsoft device-flow login since 0.6.13 and `--launch`/`--server`
([MultiMC 0.6.13](https://multimc.org/posts/0-6-13-update.html)), but Prism is the
better-tested path for concurrent accounts and current versions. Do not run both
launchers against the same instance root.

### Accounts, instances, and roots

- **Accounts are launcher-global** in Prism; instances normally use the selected
  account. Use **Edit → Settings → Miscellaneous → Override default account** on
  the Gate B instance to pin the player account
  ([#2642](https://github.com/PrismLauncher/PrismLauncher/issues/2642)).
- **One process per instance.** Prism does not support launching the same
  instance twice ([#250](https://github.com/PrismLauncher/PrismLauncher/issues/250)).
  If you need two identical clients, duplicate the instance.
- **Two different instances can run at once.** That is the supported way to run a
  player and a second GUI client on one machine. Verify once on the target
  desktop; the launcher's process/log bookkeeping is per instance.
- **Separate user-data roots** use `-d/--dir <root>`. Each root has its own
  `instances/`, `accounts.json`, logs, and caches. This is the strongest isolation
  if you ever need a GUI puppet: keep the puppet in a second root (or a second OS
  user) and never run it while the proxy is live. Do not assume two Prism
  *launcher* processes coexist in one desktop session; for two simultaneous GUI
  clients, prefer two instances in one root with per-instance account overrides.
- **For normal Gate B, do not put the puppet in Prism at all.** The only Prism
  account is the player. The puppet's only token holder is `.secrets/puppet` or
  the cluster Secret. This avoids the plaintext `accounts.json` exposure and the
  accidental-launch kick.

### Exact CLI

Prism's documented options are `-d/--dir`, `-l/--launch`, `-s/--server`,
`-a/--profile`, `-I/--import`, `--show`, `--alive`
([Prism CLI wiki](https://prismlauncher.org/wiki/getting-started/command-line-interface/)).
There is **no `--port`**; put the port in the server address:

```bash
prismlauncher \
  -l gate-b-player \
  -a "<player profile name>" \
  -s 127.0.0.1:25565
```

`-s` is only valid with `-l`. The source parses `host:port` and defaults to 25565
([`MinecraftTarget.cpp`](https://github.com/PrismLauncher/PrismLauncher/blob/develop/launcher/minecraft/launch/MinecraftTarget.cpp)).
If you launch the raw client instead of Prism, the current argument is
`--quickPlayMultiplayer 127.0.0.1:25565`; vanilla `--server`/`--port` were removed
in 1.20 ([client arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments)).

For a second root:

```bash
prismlauncher -d /path/to/prism-puppet -l gate-b-puppet -a "<puppet>" -s 127.0.0.1:25565
```

Do not run that while the proxy is connected as the puppet. Use it only for a
deliberate duplicate-kick experiment, then stop it.

### Two clients on one machine

The normal Gate B topology needs **one GUI client** (player) and **one headless
Node process** (puppet). That is not a two-GPU workload.

If you need two GUI clients (for example, to prove the duplicate-login kick):

- Duplicate the instance; do not launch the same instance twice.
- Budget roughly 2–4 GB heap per client plus GPU/OpenGL. Two clients on llvmpipe
  or a small iGPU will be slow but can still prove login/attach.
- Use two windows or two X displays; Prism's `-s` autoconnect reduces focus
  fiddling. Do not rely on keyboard focus for assertions.
- A second GUI client logged in as the puppet is a **test fixture**, not part of
  the normal run. It must be closed before the proxy starts.

### Prism token safety

Prism currently stores Microsoft tokens in plaintext in its config
([#4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073)). Therefore:

- Keep the Prism root at `0700`, disk encrypted, not cloud-synced.
- Do not commit or share `accounts.json` or logs.
- Remove the player account from Prism after Gate B if the machine is shared.
- Treat a stolen `accounts.json` as a stolen Minecraft session and refresh token;
  rotate the account (sign out everywhere / password change) if it leaks.

---

## 4. Whitelists: two gates, two UUIDs

### The two gates are not the same thing

| Gate | Where | Contains | Enforced by | Denial effect |
|---|---|---|---|---|
| **Backend whitelist** | `server.properties` + `whitelist.json` (or Paper/RCON) | **Puppet only** | Backend | Puppet cannot join; the backend session never exists; Monoplayer health must report a join failure |
| **Monoplayer attach whitelist** | Monoplayer config (UUID set) | **Player only** | Monoplayer front leg, after `hasJoined` | Client is disconnected during login, before `Login Success`; the puppet's backend session is unaffected |
| **Ops** | `ops.json` | Nobody for Gate B (or a test admin, not the puppet) | Backend | Ops are auto-whitelisted; do not op the puppet |

The backend whitelist answers “may the puppet occupy a player slot?”. The attach
whitelist answers “may this client control the puppet?”. Do not merge them, and do
not add the player to the backend whitelist: the clean Gate B assertion is that
the backend never sees the player at all.

### Username → UUID resolution

Usernames are case-insensitive and changeable. Resolve once when adding, then
store the UUID:

```http
GET https://api.minecraftservices.com/minecraft/profile/lookup/name/<name>
# fallback:
GET https://api.mojang.com/users/profiles/minecraft/<name>
```

Both return `{ id, name }` (the legacy UUID may be undashed; normalize to the
hyphenated lowercase form). The Mojang API has a per-IP rate limit of roughly 200
requests per 2 minutes; cache results and do not resolve on every connection
([Mojang API](https://minecraft.wiki/w/Mojang_API)). Names can be changed; a stale
display name in the whitelist is harmless as long as the UUID is stable. For
offline-mode backends, the server derives a different UUID from
`OfflinePlayer:<name>`; do not use offline UUIDs for the Monoplayer attach
whitelist, which is always checking a Mojang-issued `hasJoined` UUID.

### Backend whitelist

For vanilla 26.1:

```properties
online-mode=true
white-list=true
enforce-whitelist=true
enforce-secure-profile=true
```

`whitelist.json` (server root, not git):

```json
[
  { "uuid": "<puppet-uuid>", "name": "<puppet-name>" }
]
```

Use the server's own `/whitelist add <name>` and `/whitelist reload` when
possible; it resolves names using the server's online-mode UUID logic and writes
the file correctly. `enforce-whitelist=true` kicks online players removed from the
list on reload, which is useful for the denial test. Ops are automatically
whitelisted; do not op the puppet.

If `prevent-proxy-connections=true`, the backend compares the IP used for
`/join` with the IP of the TCP connection. In this topology both should be the
proxy's egress; NAT asymmetry will reject the puppet. Leave it `false` for Gate B
unless you are deliberately testing that check.

### Monoplayer attach whitelist

Recommended runtime shape (not a secret, but keep out of git because it contains
account identifiers):

```json
{
  "version": 1,
  "players": [
    {
      "uuid": "<player-uuid>",
      "name": "<player-name>",
      "addedAt": "2026-11-05T00:00:00Z"
    }
  ]
}
```

The proxy should:

- Normalize UUIDs to lowercase hyphenated form and compare UUIDs, never names.
- Reload the file without restarting the pod (watch or SIGHUP).
- Deny during login, before `Login Success`, and log `{event:"attachDenied", uuid, stage:"login"}`.
- Keep the puppet session untouched on denial.
- Never include the puppet UUID in the attach whitelist for Gate B (except the
  one-account fallback, which is explicitly not a Gate B pass).

### Denial tests

**Attach denial (must happen before Login Success):**

1. `mise run whitelist:add attach <player> --remove` (or edit the config).
2. Launch the player client again.
3. Expect a login-stage disconnect, `attachDenied` in the proxy log, no
   `login`/`Login Success`, and no change in backend login count. The puppet stays
   online.
4. Re-add the player.

**Backend denial (must prevent the puppet session):**

1. Remove the puppet from the backend whitelist (`/whitelist remove <puppet>` or
   edit `whitelist.json` + `/whitelist reload`).
2. Start/restart the proxy.
3. Expect the backend to reject the puppet join (“You are not white-listed on
   this server!” or a Paper equivalent), a `backendJoinRejected` health event, and
   no attach path. Do not loop reconnects.
4. Re-add the puppet.

**Duplicate-session check (optional, destructive to the session):**

Start a second process with a **copy** of the puppet cache against the same
backend. One session must be kicked. This proves why the single-writer lock and
one-replica rule exist. Stop the second process immediately; the copy's refresh
token may already be invalid.

---

## 5. One-account fallback

### Offline / Gate A fallback

`src/proxy.js` currently uses `auth: 'offline'` and a fake
`PUPPET_PROFILE` (`00000000-0000-0000-0000-000000000001`) at
`src/proxy.js:86-92`, and the front leg is `'online-mode': false` at
`src/proxy.js:140`. That is the correct fast path for protocol tests and is what
Gate A uses. It proves nothing about Microsoft auth, encryption, `hasJoined`, or
real identity.

### One real account as both roles

If only one Java account is available:

1. Bootstrap that account as the puppet.
2. Start Monoplayer with that account as the back-leg puppet.
3. Launch Prism with the **same** account against the front leg.
4. Run the attach/render/control smoke.

This can prove that a real client completes the front-leg login, receives the
puppet profile, and controls the backend session. It **cannot** prove Gate B's
real attach path:

- There is only one UUID, so “player admitted, puppet denied” cannot be
  distinguished. The attach whitelist test degenerates to “the only account is or
  is not listed.”
- The backend session and the attaching identity are the same account; you cannot
  show that the backend never sees the player.
- Chat signatures are made by the same account whose profile is presented, so a
  broken strip/re-sign path would falsely pass. With two accounts, the attaching
  client's signatures are for the player while the presented profile is the
  puppet — the real failure mode.
- Any accidental direct backend login kicks the puppet (same UUID). The
  two-account setup makes that mistake harmless to the puppet.
- Token custody is not isolated: the same account may be refreshed by Prism and
  the proxy, which is exactly the multi-writer problem.

Mark the run `twoAccount=false` and do not count the two-account assertions as
passed. The fallback is for unblocking local bring-up, not for the Gate B verdict.

---

## 6. Recommended user-manual steps

Placeholders: `<puppet>`, `<player>`, `<puppet-uuid>`, `<player-uuid>`,
`<backend-host>`, `<backend-port>`.

### 0. Prerequisites

- Two Microsoft accounts, each owning Java Edition (not Game Pass), each with 2FA.
- Java 25 for Minecraft 26.1 (`java -version` shows 25).
- Prism Launcher 11.x installed.
- Node 26.7 via `mise`; `pnpm install` already run.
- A 26.1 vanilla backend on `<backend-host>:<backend-port>` with
  `online-mode=true`.

### 1. Verify both accounts

Sign in to each account at <https://www.minecraft.net/en-us/login> once, create
the Xbox profile if prompted, accept the Xbox terms, and confirm multiplayer is
allowed in the Xbox privacy settings. Record each Minecraft name and UUID (the
profile page or `auth:status`).

### 2. Bootstrap the puppet

```bash
mise run auth:device-code --account puppet
```

Open the printed URL, enter the code, approve as **the puppet** (not the player).
The task must print:

```
account: puppet
profile: <puppet> / <puppet-uuid>
java: owned (game_minecraft, product_minecraft)
multiplayer: enabled
cache: .secrets/puppet/<hash>_live-cache.json (0600)
```

If it reports `403` at title auth, rerun with the documented fallback title
(`auth:device-code --account puppet --auth-title default`) and record which one
worked.

### 3. Configure the backend whitelist

In the backend console:

```text
whitelist add <puppet>
whitelist reload
```

Confirm `whitelist.json` contains only the puppet (plus any ops, which are
auto-whitelisted). Do **not** add the player.

### 4. Configure the Monoplayer attach whitelist

```bash
mise run whitelist:add attach <player>
```

This resolves `<player>` to `<player-uuid>` and writes the runtime attach
whitelist. It must not add the puppet.

### 5. Configure Prism for the player

1. Add only the **player** Microsoft account in Prism.
2. Create a vanilla **26.1** instance named `gate-b-player`.
3. Edit the instance → Settings → Miscellaneous → **Override default account** →
   select the player.
4. Set the instance memory to 2–4 GB.
5. Do not add the puppet account.

### 6. Start the stack

```bash
# terminal A: backend
# terminal B: start the Gate B orchestrator once ticket 05 names it, then:
mise run auth:status --account puppet
```

Wait until `auth:status` says the profile is valid and the backend log shows the
puppet joined. The proxy front leg should be listening on `127.0.0.1:25565`.

### 7. Launch the player

```bash
prismlauncher -l gate-b-player -a "<player>" -s 127.0.0.1:25565
```

Assert: the client leaves “Loading terrain…”, renders, moves, and the backend log
shows no second player. The client should render the **puppet's** name/skin (the
architecture's deliberate profile presentation).

### 8. Run the denial checks

```bash
mise run whitelist:add attach <player> --remove
# relaunch the client; expect login-stage denial, puppet still online
mise run whitelist:add attach <player>
```

Then, in the backend console, remove the puppet and reload; restart the proxy and
confirm the backend rejects the join and Monoplayer reports it rather than
reconnecting forever. Re-add the puppet.

### 9. Shut down

```bash
mise run down              # stop proxy/backend; keep .secrets and worlds
mise run down --forget     # also delete local token cache / cluster Secret
mise run down --revoke     # also print manual Microsoft revocation steps
```

`down` must not silently revoke the refresh token. Revocation is a human action
(sign out everywhere / change password) and forces a new device-code bootstrap.

---

## 7. `mise` task shape

Add four tasks to `mise.toml` (sketch; not implemented):

```toml
[tasks."auth:device-code"]
description = "Bootstrap the puppet Microsoft account with a device code; writes .secrets/puppet (gitignored)."
run = "node src/auth/cli.js device-code"

[tasks."auth:status"]
description = "Show puppet profile, Java ownership, multiplayer privilege, and token health. Never prints tokens."
run = "node src/auth/cli.js status"

[tasks."whitelist:add"]
description = "Resolve a Mojang username to UUID and add/remove it from the attach or backend whitelist."
run = "node src/auth/cli.js whitelist-add"

[tasks.down]
description = "Stop Gate B processes; keep the token cache unless --forget/--revoke."
run = "node src/gate-b/down.js"
```

### CLI contract

```bash
mise run auth:device-code --account puppet [--auth-title java|default] [--cache <dir>] [--cluster]
mise run auth:status --account puppet [--json] [--refresh] [--cache <dir>]   # --refresh requires the writer lock
mise run whitelist:add attach <username> [--remove] [--uuid <uuid>] [--dry-run]
mise run whitelist:add backend <username> [--remove] [--rcon <host:port>] [--dry-run]
mise run down [--forget] [--revoke]
```

Behavior contracts:

- `auth:device-code` is interactive on first run and **only** first run. It must
  refuse to overwrite an existing cache without `--force`. It writes with
  `umask 077`, prints the URL/code to stderr, and never prints tokens.
- `auth:status` is read-only by default. It reports the profile, UUID, Java
  entitlement names, `multiplayerServer.enable`, whether a refresh token is
  present, and the cache path/mode. It exits non-zero on missing/expired/revoked
  cache. `--refresh` is allowed only when the proxy is not running (lock).
- `whitelist:add attach` resolves the name via the Mojang API, normalizes the UUID,
  writes the runtime attach whitelist atomically, and optionally signals the proxy
  to reload. `--uuid` is the fallback when the API 403s/404s.
- `whitelist:add backend` prefers the server's `/whitelist add` via RCON; otherwise
  writes `whitelist.json` only for an online-mode server. It never guesses an
  offline UUID.
- `down` defaults to stop-only. `--forget` deletes local cache and (with
  confirmation) the cluster Secret. `--revoke` does `--forget` plus prints the
  manual Microsoft revocation steps; it does not automate a password change.
- All tasks redact `access_token`, `refresh_token`, `Authorization`, and device
  codes from logs. Only name/UUID/expiry are printed.

`mise` forwards extra arguments to the `run` command, so the examples above work
without a `--` separator ([mise task arguments](https://mise.jdx.dev/tasks/task-arguments.html)).

---

## 8. Risk register (Gate B auth only)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| A1 | Refresh-token theft from git/logs/laptop | Critical | `.secrets/` gitignored; mode 0600/0700; full-disk encryption; no env vars; redaction; K8s Secret + RBAC |
| A2 | Two writers rotate the same refresh token | High | Single proxy; `auth:status` read-only; exclusive lock; atomic write; one replica |
| A3 | Duplicate-session kick | High | Distinct accounts; no GUI puppet during proxy; one replica; never point player at backend |
| A4 | Prism `accounts.json` plaintext leak | High | Separate root, 0700, full-disk encryption, no cloud sync; puppet not in Prism |
| A5 | Username change / stale whitelist | Medium | Resolve to UUID at add time; store UUID; re-resolve on rename |
| A6 | Offline-mode UUID mismatch | Medium | Gate B identity lanes use `online-mode=true`; never use offline UUIDs for attach |
| A7 | Java title 403 / auth regression | Medium | Configurable `authTitle`; fallback to library default; record result; test in the smallest experiment |
| A8 | 90-day refresh inactivity | Low | Run the proxy, or `auth:status --refresh` with the proxy stopped, at least monthly; documented re-bootstrap |
| A9 | Dev cluster has no Secret encryption at rest | High if cluster | Verify Talos config; otherwise use an external secret store before storing tokens |
| A10 | Accidental account sharing / ToS | Critical | Owner-operated only; no third-party accounts; no selling; no anti-cheat bypass |

---

## 9. Recommendation

1. **Two accounts, two trust boundaries.** Dedicated puppet alt; player is the
   human's account. Both owner-operated, both Java-owned, both 2FA.
2. **Puppet is headless only.** `prismarine-auth`/`minecraft-protocol` with
   `flow: 'live'`, `profilesFolder: .secrets/puppet`, stable cache key, Java title
   first with a documented fallback. One writer, atomic cache updates.
3. **Player is Prism only.** Prism 11.x, one 26.1 instance, per-instance account
   override, `-s host:port`. Do not add the puppet to Prism.
4. **Backend whitelist = puppet; attach whitelist = player.** Resolve names to
   UUIDs at add time; test both denials; never compare usernames at runtime.
5. **`down` is stop-only by default.** Token revocation is explicit and human.
6. **One-account/offline is a smoke test, not a Gate B pass.** Record
   `twoAccount=false` and skip the identity-separation assertions.

---

## 10. Smallest falsifying experiment

**Goal:** falsify the two assumptions Gate B auth depends on — silent refresh and
distinct-identity admission — with two real accounts and no Monoplayer product
code.

**Setup:** two owner-operated Java accounts (`puppet`, `player`); Node 26.7;
`minecraft-protocol` 1.68.0; Prism 11.x; a throwaway 26.1 server fixture on
`127.0.0.1:25565`.

**Steps:**

1. `mise run auth:device-code --account puppet`; approve in a browser; record the
   printed UUID and confirm `game_minecraft`/`product_minecraft`.
2. Prove silent refresh: copy the cache to `/tmp/puppet-cache-test`, shift the
   MSA `token.obtainedOn` back by two hours (or wait for the ~1 h MSA access token
   to expire), then run
   `auth:status --cache /tmp/puppet-cache-test --refresh`. It must refresh without
   a device code and return the **same UUID**. Repeat once more to prove the
   rotated token is usable. Do not run this while the proxy holds the cache.
3. Start a minimal `minecraft-protocol` 26.1 server with `online-mode: true` and a
   `beforeLogin`/login check that admits only `<player-uuid>`. It must perform the
   real Mojang `hasJoined` check (not a stub).
4. Launch the player:
   `prismlauncher -l gate-b-player -a "<player>" -s 127.0.0.1:25565`.
   Expected: `Login Success`, client reaches play.
5. Remove `<player-uuid>` from the fixture whitelist and relaunch. Expected:
   disconnect **before** `Login Success`.
6. Optionally launch the puppet account as a second client against the same
   fixture. Expected: denied, because its UUID is not in the fixture whitelist.

**Falsified if any of these happens:**

- Silent refresh requires a new device code, or the profile UUID changes.
- Both accounts are admitted, or both are denied.
- The official 26.1 client cannot complete an online-mode login to the local
  fixture at all (protocol/encryption/client-runner problem).
- Denial happens after `Login Success` or after any play packet is relayed.
- The puppet's UUID equals the player's UUID (account provisioning mistake).

**Why this is the smallest useful experiment:** it exercises the exact three
things Gate B cannot fake — a real Microsoft refresh chain, a real official-client
`hasJoined`, and two distinct Mojang UUIDs at the gate — in one short run, before
any Monoplayer auth code is written. It does not test the backend whitelist; add
that as a five-minute follow-up by removing the puppet from a vanilla
`whitelist.json` and confirming the backend rejects the proxy's join.

---

## Sources

- [Java Edition 26.1](https://minecraft.wiki/w/Java_Edition_26.1) — protocol 775, Java 25, release data.
- [Protocol version](https://minecraft.wiki/w/Protocol_version) — 26.1/26.1.1/26.1.2 = 775.
- [Microsoft: device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code) — 15-minute code, polling, refresh token.
- [Microsoft: configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes) — 60–90 min access, 90-day refresh inactivity.
- [wiki.vg Microsoft Authentication Scheme](https://wikivg.booky.dev/Microsoft_Authentication_Scheme) — full chain, XErr codes, public client ID caveat.
- [wiki.vg Protocol Encryption](https://wikivg.booky.dev/Protocol_Encryption) — `join`/`hasJoined`, server hash.
- [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) — README/API, cache, `Titles`.
- [prismarine-auth `LiveTokenManager.js`](https://github.com/PrismarineJS/prismarine-auth/blob/master/src/TokenManagers/LiveTokenManager.js) — device code and refresh-token cache behavior.
- [prismarine-auth `Titles.js`](https://github.com/PrismarineJS/prismarine-auth/blob/master/src/common/Titles.js) — `MinecraftJava` = `00000000402b5328`.
- [prismarine-auth #182](https://github.com/PrismarineJS/prismarine-auth/issues/182), [#140](https://github.com/PrismarineJS/prismarine-auth/issues/140) — `Titles.MinecraftJava` 403 reports.
- [minecraft-protocol `microsoftAuth.js`](https://github.com/PrismarineJS/minecraft-protocol/blob/master/src/client/microsoftAuth.js) — default Nintendo title, `profilesFolder`.
- [Prism Launcher](https://prismlauncher.org/) — current release line (11.0.3 at time of writing).
- [Prism Launcher CLI](https://prismlauncher.org/wiki/getting-started/command-line-interface/) — `-d/-l/-s/-a`, no `--port`.
- [Prism Launcher data locations](https://prismlauncher.org/wiki/getting-started/data-location/) — launcher root, `instances/`, `accounts.json`.
- [Prism #250](https://github.com/PrismLauncher/PrismLauncher/issues/250) — one process per instance.
- [Prism #341](https://github.com/PrismLauncher/PrismLauncher/issues/341), [#2642](https://github.com/PrismLauncher/PrismLauncher/issues/2642) — per-instance account override.
- [Prism #4073](https://github.com/PrismLauncher/PrismLauncher/issues/4073) — plaintext Microsoft tokens.
- [MultiMC 0.6.13](https://multimc.org/posts/0-6-13-update.html) — Microsoft device flow, `--launch`/`--server`.
- [Minecraft Wiki: Server](https://minecraft.wiki/w/Server) — duplicate-login disconnect message.
- [Minecraft Wiki: Server.properties](https://minecraft.wiki/w/Server.properties) — `white-list`, `enforce-whitelist`, `online-mode`, ops.
- [Minecraft Wiki: Whitelist.json](https://minecraft.wiki/w/Whitelist.json) — `{uuid, name}` format.
- [Minecraft Wiki: Mojang API](https://minecraft.wiki/w/Mojang_API) — name→UUID, profile, entitlements, attributes, rate limits.
- [Minecraft Wiki: client command line arguments](https://minecraft.wiki/w/Java_Edition_client_command_line_arguments) — `--quickPlayMultiplayer`, `--server`/`--port` removed.
- [mineflayer #3888](https://github.com/PrismarineJS/mineflayer/issues/3888) — `pc26_1_2` packet-mapping concern.
- [architecture auth section](../../../docs/architecture.html#auth) — refresh-token-as-password, write-back, attach gate.
- [security/legal/ops research 04](../../minecraft-puppet-proxy/research/04-security-legal-ops.md) — token lifetimes, legal boundary, deepmine ops.
