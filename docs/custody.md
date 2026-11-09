# Check B G1 runbook — auth / identity readiness

This is the runbook for the **G1 auth slice**: token custody, the puppet's
device-code bootstrap + silent refresh, real sessionserver `hasJoined`, the
embeddable attach check, the attach whitelist, and the read-only auth health
CLI. It is the deliverable for criterion **G1** in the plan (`docs/driver-lane-plan.md`:
*"Auth readiness: device code, silent refresh, two distinct UUIDs, real
`hasJoined`; same UUID across refresh; allow/deny before Login Success"*).

G0 is already green (`docs/driver-lane.md`). G1's code and its offline tests are
complete; the **live** steps still need the one user device-code approval and
are listed in [The G1 live sequence](#the-g1-live-sequence).

## What exists (src/custody/)

| File | Role |
|---|---|
| `src/custody/cache.js` | Atomic token-cache custody for one account directory: 0700 dir, 0600 files, temp-write + fsync + rename, readable `<family>-cache.json` names (the cache factory owns the path), `profile.json`, one-writer lock, path-only API. A legacy hashed file in the same directory is adopted on first touch. |
| `src/custody/accounts.js` | The account tree: `listAccounts`, `resolveAccount` (UUID, then alias, then name), `accountDir`, `createStagingDir`, `finalizeStaging`, `detectLegacyLayout`. Pure filesystem logic; no token values. |
| `src/custody/migrate.js` | One-shot plan/apply for the old single-account layout: rename the directory, rename hashed caches, write `profile.json`, quarantine the failed bootstrap. Dry-run by default. |
| `src/custody/msa.js` | prismarine-auth `Authflow` (flow `live`, per-title device type) wrapper: device-code bootstrap with **authTitle `00000000441cc96b` (MinecraftNintendoSwitch) + `Nintendo` first** and the Java title `00000000402b5328` + `Win32` as fallback; silent refresh that never waits for a user; returns **identity only** (name, UUID, entitlement names, multiplayer privilege) — never tokens. Refuses a login whose UUID differs from the account directory. |
| `src/custody/status.js` | Read-only cache/lock health (`collect`), guarded `--refresh` (refuses with `writer_lock_held`), redaction-enforced report helpers (`redactForReport`, `scanForLeaks`). `collect()` never creates a directory. |
| `src/custody/hasjoined.js` | Real `GET sessionserver.mojang.com/session/minecraft/hasJoined?username=&serverId=` with injectable fetch, username/profile + optional expected-UUID cross-checks, UUID normalization, short TTL cache, fail-closed on any transport failure. `computeServerId` = vanilla handshake sha1. |
| `src/custody/attach.js` | The one embeddable check: `async ({ client, store, verify }) => { ok, reason, stage }`, run inside `beforeLogin` so a denial happens **before Login Success**; emits `attachAllowed` / `attachDenied` with sanitized payloads. |
| `src/custody/store.js` | Attach whitelist file `{ version: 1, players: [{ uuid, name, addedAt }] }` in `.secrets/attach-whitelist.json`: add/remove with name→UUID resolution at add time (injectable lookup: minecraftservices, then legacy api.mojang.com), UUID-keyed `has/find`, atomic 0600 writes. `createBackendWhitelist` drives the **existing** `src/driver/rcon.js` adapter for the puppet-only backend whitelist. |
| `src/custody/cli.js` | `accounts` / `device-code` / `status [--refresh]` / `migrate [--apply]` / `whitelist attach|backend add|remove`. |
| `src/custody/fixture.js` | Minimal `mc.createServer` fixture embedding the check (optional; not run in tests, no live login). |

Unit tests: `node --test 'test/custody/*.test.js'` (no network, no real account):
cache atomicity + modes, legacy file adoption, stale/contended writer lock,
account listing/resolution, staging finalize, migration plan/apply, the
identity-mismatch guard, silent-refresh guard, hasJoined
allow/deny/cross-check, attach allow/deny, whitelist semantics, and the
**redaction sentinel** (synthetic token strings never survive a report).

## Custody layout (enforced by src/custody/cache.js + src/custody/accounts.js)

One directory per Minecraft UUID:

```text
.secrets/
  accounts/
    <uuid>/                      selectable account (mode 0700)
      profile.json               uuid, name, alias, authTitle, deviceType, updatedAt
      live-cache.json            refresh token ("the password") + access token
      xbl-cache.json             XSTS chain
      mca-cache.json             ~24 h Minecraft access token
      writer.lock                transient, one writer per account
  staging/<16-hex>/              pre-login bootstrap; never selectable
  retired/                       quarantined legacy directories
  .accounts.lock                 short structure lock for finalize/migrate
```

**The layout changed after the dated evidence.** The live G1 run on
2026-11-06/07 used the old single-account directory `.secrets/puppet/` with
`<sha1(username).slice(0,6)>_<family>-cache.json` file names and
`identity.meta.json`. That evidence describes the account, not the current
paths. Today the same token files live under
`.secrets/accounts/<uuid>/` with readable `<family>-cache.json` names, and the
profile is `profile.json`. Do not point commands at `.secrets/puppet/`; run
`node src/custody/cli.js accounts` to see whether a legacy directory is still
waiting for migration.

### Selector rules

A selector is resolved before any custody object is built:

1. A UUID (dashed or undashed) matches only that UUID.
2. Otherwise an alias matches case-insensitively.
3. Otherwise a profile name matches case-insensitively.
4. No selector is allowed only when exactly one account exists.

A path-like selector never becomes a path. `--dir <accountDir>` is the raw
escape hatch: the directory must already contain a readable `profile.json`.
`--dir` and `--account` are mutually exclusive.

### Custody rules

- Directory `0700`; every cache/lock/profile file `0600`; writes are
  temp + fsync + rename; a failed write leaves the previous cache intact.
- **One writer per account.** `writer.lock` (pid + random owner id, dead
  holders are stale-stealable) lives inside the account directory, so account
  A's lock never blocks account B. It is held around a device-code bootstrap or
  a silent refresh, then released (`src/custody/msa.js`); the proxy does not hold
  it for its life. A second writer is refused (`writer_lock_held`), never queued.
- **UUID is the identity.** A login that resolves to a different UUID is
  refused (`identity_mismatch`) and `profile.json` is not overwritten.
- **No restore of old caches.** After a refresh the old refresh token is
  invalid; recovery is always: sign-out-everywhere / password change →
  re-run `device-code`.
- `.secrets/` and the cache file patterns are already in `.gitignore`.
- **One secrets directory, many worktrees.** `mise run secrets:link` symlinks the
  main working copy's `.secrets` into the worktree it runs in. It never copies:
  the refresh token rotates on use, so two copies of one account invalidate each
  other, and the writer lock only means anything when the directory is shared.
  The task is idempotent, refuses to replace a real `.secrets` directory, exits 0
  when there is nothing to link, and never prints file contents. Outside a git
  work tree that has no source it links nothing, and the live rungs then fail
  with their own message.
- `profile.json` records the last bootstrapped
  `{ uuid, name, alias, authTitle, deviceType, updatedAt }` — this is what
  makes "same UUID across refresh" a pass claim instead of an observation.

### Sessions, copies, and refresh

Three rules, written down because guessing at them has already cost a wrong
runbook. They are separate: the first is about game sessions, the second and
third are about the token.

1. **Sessions are not exclusive.** Several clients may play one account at the
   same time. A second login to the **same** server disconnects the first
   (`multiplayer.disconnect.duplicate_login`); logins to different servers
   coexist. That is a rule of the game server, not of the account, and it holds
   while every client shares one token.
2. **Refresh is exclusive.** `writer.lock` is held around a device-code
   bootstrap or a silent refresh, then released (`src/custody/msa.js`). It
   serializes the token rotation, and it says nothing about how many sessions may
   be open. Two processes pointed at one account directory take turns; the second
   gets `writer_lock_held` rather than a corrupted chain.
3. **One live copy per account.** The refresh token is rolling and single-use, so
   a refresh returns a new one and invalidates the old. Two *directories* holding
   one account therefore cannot both stay usable: the copy that refreshed last is
   live, and the other is dead until a `device-code` bootstrap. This is the rule
   the `one-account-one-writer-one-replica` decision rests on.

What follows for a live rung:

- A local `mise run online` needs the copy that holds the live token. When the
  deployed proxy owns it, a second copy on a laptop is stale unless nothing else
  has refreshed that account.
- The deployment does **not** need to stop for a run that uses a different
  backend and a fresh enough access token. A cached Minecraft access token is
  valid for about a day; while it is, a login reuses it and rotates nothing.
- Stopping it *is* needed when the run would use the same account directory (the
  lock is held during its own refresh, and the token chain is shared) or the same
  server as a live session (duplicate login).

The session rule was checked, not assumed: two `minecraft-protocol` clients with
one custody directory, logged into the same server, and the first was kicked with
`multiplayer.disconnect.duplicate_login` while the second stayed in game. The
cached files under the account directory were byte-identical afterwards, so that
run rotated nothing.

- `profile.json` records the last bootstrapped
  `{ uuid, name, alias, authTitle, deviceType, updatedAt }` — this is what
  makes "same UUID across refresh" a pass claim instead of an observation.

### Accounts

Two UUID directories exist:

| Name | UUID | Alias | Role |
|---|---|---|---|
| GlowSquidye | `73e0e19b-d4e4-4cc1-a553-a3952f0c1aed` | `glowsquidye` | puppet backend session |
| Bafbi | `6eb73524-ff88-4a62-a8d0-c63905e7afba` | `bafbi` | attaching player, on the attach whitelist |

With more than one account there is no default: `--start` must pin the puppet
with `MONOPLAYER_PUPPET_ACCOUNT=glowsquidye` (or the UUID/name). The CLI
resolves `--account` by UUID, then alias, then name. A text selector that does
not exist never creates an account by accident.

### Commands

```bash
node src/custody/cli.js accounts                      # list usable, broken, pending, legacy
node src/custody/cli.js accounts --json               # machine-readable
node src/custody/cli.js migrate --dry-run             # plan the old-layout move
node src/custody/cli.js migrate --apply               # perform it (quarantines puppet-java-403)
node src/custody/cli.js migrate --apply --no-quarantine
```

`accounts` is read-only: it never creates an account directory. `migrate`
defaults to dry-run, prints the UUID, target, files by family/size,
`sameFilesystem`, `targetExists`, the legacy lock, and the quarantine
candidate. Exit codes: `0` ok or dry-run, `1` failed apply, `2` refused
(lock held, cross-device, target conflict). Run the real migration only after
taking the proxy down; it renames the legacy directory, so it cannot run while
the old leg holds a lock.

`--accounts-dir` (or `GATEB_ACCOUNTS_DIR`) moves the account tree. `--from`
names the legacy directory under `.secrets/` (default `puppet`).

The real GlowSquidye tree was migrated on 2026-11-07 with `migrate --apply`.
Every token file kept the same SHA-256 before and after, `profile.json` keeps
`updatedAt` from the last identity write and records `migratedAt`, the alias is
`puppet`, and `puppet-java-403` is under `.secrets/retired/`. A read-only
`status --account glowsquidye` finds the refresh token without a device code.

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
(until the refresh chain is revoked).

Add a **new** account (no selector): the login runs in
`.secrets/staging/<16-hex>/` and is renamed to
`.secrets/accounts/<uuid>/` only after it succeeds. `--alias` is optional; a
lowercase name that matches `^[a-z0-9][a-z0-9._-]{0,31}$` becomes the alias
when you omit it.

```bash
node src/custody/cli.js device-code                  # new account, alias from the name
node src/custody/cli.js device-code --alias glowsquidye   # new account, explicit alias
```

Re-authenticate an **existing** account (UUID guard: a different login UUID is
refused):

```bash
node src/custody/cli.js device-code --account glowsquidye
node src/custody/cli.js device-code --account <uuid>
node src/custody/cli.js device-code --dir .secrets/accounts/<uuid>
```

An unknown UUID bootstraps that UUID as a new account; an unknown alias or
name is refused with the candidate list, never turned into an accidental
login.

1. The command refuses immediately if the writer lock for that account is held
   (proxy running) — exit code 2.
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
   the safe identity line plus `uuid=… name=… alias=… dir=…`.
5. `profile.json` and the token caches land in
   `.secrets/accounts/<uuid>/`. A failed bootstrap leaves its staging
   directory for inspection; it is never selectable.

Failure notes printed, never retried blind: `device_code_not_completed_or_timed_out`
(user did not approve in time) → just run the command again;
`auth_failed_after_all_titles` with the per-title attempts;
`identity_mismatch` when the token cache belongs to another account → stop and
investigate, the profile was not touched;
`invalid_grant`/`AADSTS70008` on later refreshes → the rolling token was
consumed or revoked → re-bootstrap; XErr `2148916233/238` → missing Xbox
profile / child account (fix the account, not the code).

## status (read-only) and silent refresh

```bash
node src/custody/cli.js status                     # one account, if only one exists
node src/custody/cli.js status --account glowsquidye    # selector: uuid, alias, or name
node src/custody/cli.js status --dir .secrets/accounts/<uuid>
node src/custody/cli.js status --json              # machine-readable
node src/custody/cli.js status --refresh           # silent refresh, guarded
```

- Read-only status shows: `uuid`, `name`, `alias`, the account directory and
  its mode, which cache files exist, whether the live cache has a refresh token
  (presence only — never values), access token expiry meta, the profile
  identity, and writer-lock state. `collect()` never creates the directory;
  status against a missing account reports absence.
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
node src/custody/cli.js whitelist attach add <player-name-or-uuid>
node src/custody/cli.js whitelist attach remove <name-or-uuid>

# backend whitelist (puppet only; through the existing gate-b rcon adapter):
node src/custody/cli.js whitelist backend add <puppet-name>          # add + reload
node src/custody/cli.js whitelist backend remove <puppet-name>
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
  what `src/spike/proxy.js` will consume (`store.has(uuid)`), so B1/B4 wiring is
  additive.

## Embedding the check in Monoplayer's front leg

```js
import { createAttachCheck } from './src/custody/attach.js'
import { createHasJoined } from './src/custody/hasjoined.js'
import { createWhitelistStore } from './src/custody/store.js'

const store = createWhitelistStore({ file: '.secrets/attach-whitelist.json' })
const check = createAttachCheck({ log: line => proxyLog(line) })

// minecraft-protocol's beforeLogin is synchronous and, in online-mode, has
// ALREADY completed the real sessionserver hasJoined and set client.uuid /
// client.profile. Use the synchronous checkVerified check.
// inside mc.createServer({ 'online-mode': true, ...
beforeLogin: client => {
  const result = check.checkVerified({ client, store })
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
`check.check({ client, store, verify })` instead; the synchronous CLI fixture in
`src/custody/fixture-cli.js` is the reference for the online-mode path.

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
   `node src/custody/cli.js status --refresh` twice in a row. Pass = both print
   the **same UUID** as the bootstrap line (`uuidStable: true`), and the live
   cache file rotated (lock acquired/released; `mca` expiry advanced).
4. **Two distinct UUIDs** — bootstrap provides the puppet UUID; the player's
   UUID enters the vault through `whitelist attach add <player>` (record the
   resolved UUID). The two UUIDs must differ; a missing multi-account
   situation is a smoke, never a pass (`twoAccount=false` in reports).
   Backend whitelist (`whitelist backend add <puppet>`) then holds exactly
   the puppet; the attach whitelist exactly the player.
5. **Attach allow (live fixture)** — run the Monoplayer front leg (or the
   minimal `src/custody/fixture.js` fixture) with the attach whitelist as
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
  write-back (post-Check B) needs its own locking story.
- `mise.toml` task wiring (`auth:device-code`, `auth:status`,
  `whitelist:add`) is left to the orchestrator — the `node src/custody/cli.js`
  invocations above are the underlying commands.
- The frontend fixture (`src/custody/fixture.js`) is intentionally NOT wired
  into `src/spike/proxy.js`; that is the M0/monoplayer workstream's integration
  point, together with `verifyFromHasJoined`.
