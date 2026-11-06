# Research: two-account setup and auth

**Type:** research
**Status:** resolved
**Blocked by:** none

## Question

How should we provision and operate the two official Minecraft accounts Gate B
needs — the **puppet** and the **attaching player** — safely and repeatably?

Cover:

- Separate Microsoft accounts, each owning Java Edition; what to verify and how
  to avoid accidental account sharing or duplicate-session kicks.
- Puppet auth: `prismarine-auth` device-code flow, token cache, refresh-token
  storage, rotation, and how the testbed injects it without committing secrets.
- Attaching client auth: Prism Launcher/MultiMC account profiles, multiple
  instances, separate user-data directories, `--server`/`--port` launch, and
  whether two clients can run on one machine.
- Whitelist flow: username → UUID resolution, backend whitelist for the puppet,
  Monoplayer attach whitelist for the player, and how to test denial.
- A one-account fallback for local protocol tests, and why it cannot prove the
  real attach path.
- Operational UX: `mise run auth:device-code`, `auth:status`, `whitelist:add`,
  `down`, secret storage, and what the user has to do manually.

Deliverable: a recommended two-account setup, a secrets/runbook sketch, and the
smallest auth experiment. Do not implement.

## Answer

<!-- filled on resolution -->

## Answer

Use **two separate owner-operated Microsoft accounts**: a dedicated headless
**puppet** and the operator's normal **player** account, both owning Java
Edition. The puppet logs in only through `prismarine-auth` /
`minecraft-protocol`; the player logs in only through Prism. The backend
whitelist contains the puppet only; the Monoplayer attach whitelist contains the
player only; both are UUID-keyed and resolved at add time.

Puppet bootstrap is a one-time device-code approval (15-minute window), then a
rolling refresh token in `.secrets/puppet/` (`0700`/`0600`, atomic write,
single writer). Pass the cache path, never the token. Try the public Java title
`00000000402b5328` first; on a 403 at `getTitleToken()`, record and fall back to
the library default. Never add the puppet to Prism; Prism stores tokens in
plaintext. One proxy, one replica, one writer; a second session or GUI puppet
causes a duplicate-login kick. A one-account run is a labelled smoke, never a
Gate B pass. Full note:
[`research/03-two-accounts.md`](../research/03-two-accounts.md).
