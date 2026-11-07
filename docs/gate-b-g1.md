# Gate B G1 runbook — auth / identity readiness

This is the runbook for the **G1 auth slice**: token custody, the puppet's
device-code bootstrap + silent refresh, real sessionserver `hasJoined`, the
embeddable attach gate, the attach whitelist, and the read-only auth health
CLI. It is the deliverable for criterion **G1** in the plan (`docs/gate-b-plan.html`:
*"Auth readiness: device code, silent refresh, two distinct UUIDs, real
`hasJoined`; same UUID across refresh; allow/deny before Login Success"*).

G0 is already green (`docs/gate-b-g0.md`). G1's code and its offline tests are
complete; the **live** steps still need the one user device-code approval and
are listed in [The G1 live sequence](#the-g1-live-sequence).

## What exists (src/auth/)

| File | Role |
|---|---|
| `src/auth/cache.js` | Atomic token-cache custody: 0700 dir, 0600 cache files, temp-write + fsync + rename, prismarine-auth-compatible cache factory (same `<sha1(username).slice(0,6)>_<family>-cache.json` naming), one-writer lock, path-only API. |
| `src/auth/msa.js` | prismarine-auth `Authflow` (flow `live`, per-title device type) wrapper: device-code bootstrap with **authTitle `00000000441cc96b` (MinecraftNintendoSwitch) + `Nintendo` first** and the Java title `00000000402b5328` + `Win32` as fallback; silent refresh that never waits for a user; returns **identity only** (name, UUID, entitlement names, multiplayer privilege) — never tokens. |
| `src/auth/status.js` | Read-only cache/lock health (`collect`), guarded `--refresh` (refuses with `writer_lock_held`), redaction-enforced report helpers (`redactForReport`, `scanForLeaks`). |
| `src/auth/hasjoined.js` | Real `GET sessionserver.mojang.com/session/minecraft/hasJoined?username=&serverId=` with injectable fetch, username/profile + optional expected-UUID cross-checks, UUID normalization, short TTL cache, fail-closed on any transport failure. `computeServerId` = vanilla handshake sha1. |
| `src/auth/attach.js` | The one embeddable gate: `async ({ client, store, verify }) => { ok, reason, stage }`, run inside `beforeLogin` so a denial happens **before Login Success**; emits `attachAllowed` / `attachDenied` with sanitized payloads. |
| `src/auth/store.js` | Attach whitelist file `{ version: 1, players: [{ uuid, name, addedAt }] }` in `.secrets/attach-whitelist.json`: add/remove with name→UUID resolution at add time (injectable lookup: minecraftservices, then legacy api.mojang.com), UUID-keyed `has/find`, atomic 0600 writes. `createBackendWhitelist` drives the **existing** `src/gate-b/rcon.js` adapter for the puppet-only backend whitelist. |
| `src/auth/cli.js` | `device-code` / `status [--refresh]` / `whitelist attach|backend add|remove`. |
| `src/auth/fixture.js` | Minimal `mc.createServer` fixture embedding the gate (optional; not run in tests, no live login). |

Unit tests: `node --test test/auth-*.test.js` — 68 pure tests (no network, no
real account): cache atomicity + modes, stale/contended writer lock, refresh
UUID stability against the ledger, silent-refresh guard, hasJoined
allow/deny/cross-check, attach allow/deny, whitelist semantics, and the
**redaction sentinel** (synthetic token strings never survive a report).

## Custody rules (enforced by src/auth/cache.js)

- Token lives **only** in `.secrets/puppet/` (gitignored): `<hash>_live-cache.json`
  holds the refresh token ("the password"), `<hash>_xbl-cache.json` the XSTS
  chain, `<hash>_mca-cache.json` the ~24 h Minecraft access token.
- Directory `0700`; every cache/lock/meta file `0600`; writes are
  temp + fsync + rename; a failed write leaves the previous cache intact.
- **One writer.** `writer.lock` (pid + random owner id, dead holders are
  stale-stealable) is held by whichever process may rotate the token: the
  proxy during its life; the CLI during device-code or `--refresh`. A second
  writer is refused (`writer_lock_held`), never queued.
- **No restore of old caches.** After a refresh the old refresh token is
  invalid; recovery is always: sign-out-everywhere / password change →
  re-run `device-code`.
- `.secrets/`, `*.token-cache.json`, `*_live-cache.json`, `*_xbl-cache.json`,
  `*_mca-cache.json` are already in `.gitignore`.
- Non-secret ledger: `identity.meta.json` records the last bootstrapped
  `{ uuid, name, authTitle, deviceType, updatedAt }` — this is what makes
  "same UUID across refresh" a pass claim instead of an observation.

## authTitle policy (live result)

The live bootstrap on 2026-11-07 showed the known prismarine-auth issue: the
public Java launcher title `00000000402b5328` (`Titles.MinecraftJava`) with
`deviceType: 'Win32'` reaches Microsoft sign-in and then returns **HTTP 403
from Xbox titleAuth**. The working pair for this account is
`00000000441cc96b` (`Titles.MinecraftNintendoSwitch`) with
`deviceType: 'Nintendo'`.

The wrapper therefore tries Switch/Nintendo first and keeps Java/Win32 as the
fallback, recording the title and device type that worked in both the CLI
output and the custody ledger. Device-code failures (timeout, user decline,
poll stall) are **not** retried with a different title — the first device code
may already be approved, and research 03 §2.2 documents why `sisu` is off the
table. The live G1 verdict records `authTitle=00000000441cc96b`.

## The exact user device-code action

One command, one interactive approval, then the account is headless forever
(until the refresh chain is revoked):

```bash
node src/auth/cli.js device-code --account puppet
```

1. The command refuses immediately if the writer lock is held (proxy running)
   — exit code 2.
2. It prints to **stderr**: the verification URL
   (`https://www.microsoft.com/link`-style page), the short user code, and
   Microsoft's message. Stderr only — device codes never touch stdout, files,
   reports, or logs.
3. **User action:** open the URL in any browser/phone, sign in **as the
   puppet** (never as the player), complete 2FA, approve. The code expires in
   15 minutes; the command polls and exits when Microsoft answers.
4. The command then fetches the Java token (used in-memory only), profile,
   entitlements, and the multiplayer privilege from
   `api.minecraftservices.com/player/attributes`, and prints to **stdout**
   exactly one safe line, e.g.
   `name=<puppet-name> uuid=<uuid> java=owned multiplayer=allowed authTitle=00000000402b5328`
5. `identity.meta.json` and the token caches land in `.secrets/puppet/`.

Failure notes printed, never retried blind: `device_code_not_completed_or_timed_out`
(user did not approve in time) → just run the command again;
`auth_failed_after_all_titles` with the per-title attempts;
`invalid_grant`/`AADSTS70008` on later refreshes → the rolling token was
consumed or revoked → re-bootstrap; XErr `2148916233/238` → missing Xbox
profile / child account (fix the account, not the code).

## status (read-only) and silent refresh

```bash
node src/auth/cli.js status                     # read-only custody report
node src/auth/cli.js status --json              # machine-readable
node src/auth/cli.js status --refresh           # silent refresh, guarded
```

- Read-only status shows: cache dir + mode, which cache files exist, whether
  the live cache has a refresh token (presence only — never values), access
  token expiry meta, the ledger identity, and writer-lock state.
- `--refresh` **refuses** (exit 2, reason `writer_lock_held`) if the proxy
  holds the lock. It never shows a device code: no cached refresh token →
  `needs_bootstrap`; a mid-flow prompt → `needs_reauthentication`.
- On success it prints the identity line and compares the UUID against the
  ledger; a change is a hard warning (exit 1) — G1's "same UUID across
  refresh" claim depends on that comparison.
- Keep the window rolling: while the stack is idle, run `status --refresh`
  with the proxy stopped at least monthly (research 03 §2).

## Whitelists: two gates, two UUIDs

```bash
# attach whitelist (player only; Monoplayer front leg, after hasJoined):
node src/auth/cli.js whitelist attach add <player-name-or-uuid>
node src/auth/cli.js whitelist attach remove <name-or-uuid>

# backend whitelist (puppet only; through the existing gate-b rcon adapter):
node src/auth/cli.js whitelist backend add <puppet-name>          # add + reload
node src/auth/cli.js whitelist backend remove <puppet-name>
```

- Names are resolved to UUIDs **at add time** (`minecraftservices.com`
  profile lookup first, legacy `api.mojang.com` fallback); the file stores
  `{uuid, name, addedAt}` normalized lowercase-hyphenated. Display names are
  cosmetic; all decisions are UUID-keyed.
- Never merge: the attach whitelist answers "may this client control the
  puppet?", the backend whitelist "may the puppet occupy a player slot?".
  Adding a UUID present on the other role's whitelist prints a warning to
  stderr.
- The researched file shape and reload-without-restart behavior are already
  what `src/proxy.js` will consume (`store.has(uuid)`), so B1/B4 wiring is
  additive.

## Embedding the gate in Monoplayer's front leg

```js
import { createAttachGate } from './src/auth/attach.js'
import { createHasJoined } from './src/auth/hasjoined.js'
import { createWhitelistStore } from './src/auth/store.js'

const store = createWhitelistStore({ file: '.secrets/attach-whitelist.json' })
const gate = createAttachGate({ log: line => proxyLog(line) })

// minecraft-protocol's beforeLogin is synchronous and, in online-mode, has
// ALREADY completed the real sessionserver hasJoined and set client.uuid /
// client.profile. Use the synchronous gateVerified check.
// inside mc.createServer({ 'online-mode': true, ...
beforeLogin: client => {
  const result = gate.gateVerified({ client, store })
  if (!result.ok) {
    // minecraft-protocol still tries to write compress + Login Success after
    // beforeLogin. Drop those packets so a denied client never receives Login
    // Success, then close with the login-stage reason.
    const originalWrite = client.write.bind(client)
    client.write = (name, ...args) =>
      (name === 'compress' || name === 'success') ? false : originalWrite(name, ...args)
    client.monoplayerDenied = true
    client.end(`attach denied (${result.reason})`)
  }
  return client
},
```

If a custom front leg can await async work before Login Success, use
`gate.gate({ client, store, verify })` instead; the synchronous CLI fixture in
`src/auth/fixture-cli.js` is the reference for the online-mode path.

Denial reasons B4 will assert on: `missing_username`, `verify_unavailable`,
`verify_error`, `hasjoined_failed`, `not_joined`, `profile_invalid`,
`profile_name_mismatch`, `not_whitelisted`, `whitelist_unavailable`. Every
decision is duplicated as an `attachAllowed` / `attachDenied` event with
`stage: 'login'` and only username/uuid/reason in the payload.

## The G1 live sequence

The offline tests prove the logic; these live steps are what turns G1 green.
Everything except step 2 is unattended.

1. **Bootstrap** — run the device-code command above; record the identity
   line (name, UUID, entitlement summary, multiplayer privilege, working
   authTitle) into the evidence bundle. `multiplayer=allowed` and `java=owned`
   are preconditions; a `multiplayer=blocked` here means the Xbox privacy
   setting `InsufficientPrivilegesException` story, fixed at account level.
2. **User approves the device code once.**
3. **Silent refresh twin** — with the proxy not running:
   `node src/auth/cli.js status --refresh` twice in a row. Pass = both print
   the **same UUID** as the bootstrap line (`uuidStable: true`), and the live
   cache file rotated (lock acquired/released; `mca` expiry advanced).
4. **Two distinct UUIDs** — bootstrap provides the puppet UUID; the player's
   UUID enters the vault through `whitelist attach add <player>` (record the
   resolved UUID). The two UUIDs must differ; a missing multi-account
   situation is a smoke, never a pass (`twoAccount=false` in reports).
   Backend whitelist (`whitelist backend add <puppet>`) then holds exactly
   the puppet; the attach whitelist exactly the player.
5. **Attach allow (live fixture)** — run the Monoplayer front leg (or the
   minimal `src/auth/fixture.js` fixture) with the attach whitelist as
   configured; log into `127.0.0.1:25565` from Prism as the player. Pass =
   `attachAllowed` event with the **player** UUID, then normal login; the
   backend log shows only the puppet session.
6. **Attach deny (the B4 dress rehearsal)** — `whitelist attach remove
   <player>`, reconnect. Pass = TCP login-stage disconnect BEFORE Login
   Success, `attachDenied reason=not_whitelisted stage=login` in the log, no
   play packets relayed, **no change in backend login count**, puppet stays
   online. `whitelist attach add <player>` restores.
7. **Capture** — `status --json` before/after each step goes into the
   evidence bundle (the report helpers already tag anything token-shaped; the
   redaction sentinel test is the tripwire, but do not paste raw caches).

## Current limitations / follow-ups

- No live step has run yet: the user device-code approval (steps 2–3) is
  deliberately not automated and not started by this slice.
- The multiplayer privilege check is best-effort (`player/attributes`); if
  Microsoft rate-limits it, reports `multiplayer=unknown` rather than lying.
- The writer lock is a local custody lock for one host; the cluster Secret
  write-back (post-Gate B) needs its own locking story.
- `mise.toml` task wiring (`auth:device-code`, `auth:status`,
  `whitelist:add`) is left to the orchestrator — the `node src/auth/cli.js`
  invocations above are the underlying commands.
- The frontend fixture (`src/auth/fixture.js`) is intentionally NOT wired
  into `src/proxy.js`; that is the M0/monoplayer workstream's integration
  point, together with `verifyFromHasJoined`.
