# Research: security, legal, and operations

**Ticket:** 04-research-security-legal-and-ops.md
**Researcher:** research delegate
**Status:** resolved

## Summary

Monoplayer can be safe as a single-account, single-tenant dev service if four
things hold: (1) the puppet's Microsoft refresh token is treated as the
password-equivalent it is and lives only in a namespaced Kubernetes Secret with
encryption at rest; (2) the attach gate proves client identity with the Mojang
session server (`hasJoined`) and a UUID whitelist, not with a shareable token
alone; (3) the data plane is exposed only through Tailscale with a
default-deny NetworkPolicy, so nothing but the owner can reach it; (4) the
service never automates play, bypasses anti-cheat, or shares the account with a
third party, so it stays inside the owner-operated-bot gray zone rather than
crossing the clear ToS lines.

Proven: the full auth chain, token lifetimes, the `hasJoined` identity proof,
the ToS clauses that matter, and the deepmine ops patterns (default-deny
NetworkPolicy, Tailscale `loadBalancerClass`, secrets-outside-git, in-cluster
zot registry). Speculative: Microsoft enforcement risk for a personal
headless proxy (real but unquantified), and whether specific public servers
flag proxied connections.

---

## 1. Microsoft/Mojang authentication for the puppet

### The chain (proven, documented)

Login is a five-step chain; only the first step involves the user:

1. **MSA device-code flow** — `POST
   https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode` with
   `client_id` and `scope=XboxLive.signin offline_access`, poll
   `.../oauth2/v2.0/token` with
   `grant_type=urn:ietf:params:oauth:grant-type:device_code`. The `consumers`
   tenant is mandatory; `/common` or an AAD tenant errors out. The user has
   **15 minutes** to complete the browser login (default `expires_in`), the
   client polls every **5 seconds**, and no client secret is involved.
   Source: [wiki.vg Microsoft Authentication Scheme](https://wikivg.booky.dev/Microsoft_Authentication_Scheme),
   [Microsoft device-code doc](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code).
2. **Xbox Live** — `POST https://user.auth.xboxlive.com/user/authenticate` with
   `RpsTicket: d=<msa_token>`, `RelyingParty: http://auth.xboxlive.com`.
3. **XSTS** — `POST https://xsts.auth.xboxlive.com/xsts/authorize` with
   `SandboxId: RETAIL`, `RelyingParty: rp://api.minecraftservices.com/`.
   Returns `uhs` (user hash) and the XSTS token. XErr codes (2148916233 no
   Xbox account, 2148916235 region blocked, 2148916236/37 South Korea adult
   verification, 2148916238 child account, 2148916227 Xbox-banned) are the
   join-failure diagnostics.
4. **Minecraft token** — `POST
   https://api.minecraftservices.com/authentication/login_with_xbox` with
   `identityToken: XBL3.0 x=<uhs>;<xsts>`.
5. **Profile/ownership** — `GET /entitlements/mcstore` proves Java Edition
   ownership; `GET /minecraft/profile` returns the UUID and name.

### Token lifetimes (proven, from documented examples and Microsoft docs)

| Token | Lifetime | Notes |
|---|---|---|
| MSA access token | 60–90 min (variable) | Entra default; CAE may extend to 24–28 h |
| MSA refresh token | 90-day max inactive, rolling on use; non-configurable | Requires `offline_access`; single-use (each refresh issues a replacement) |
| XBL token | ~14 days | `NotAfter = IssueInstant + 14d` in wiki.vg example |
| XSTS token | ~16 h | `NotAfter = IssueInstant + 16h` in wiki.vg example |
| Minecraft access token | 24 h | `expires_in: 86400` |
| Chat profile key | ~48 h | From `/player/certificates`, cached client-side |

Sources: [wiki.vg Microsoft Authentication Scheme](https://wikivg.booky.dev/Microsoft_Authentication_Scheme),
[Configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes)
(refresh-token defaults are fixed since Jan 2021).

### 2FA, revocation, and what the refresh token means

- 2FA happens inside the device-code browser step. The resulting refresh token
  **bypasses 2FA for its whole life** — that is inherent to OAuth refresh, so
  the refresh token is the security boundary, not the password.
- Revocation paths (proven, documented): changing the MSA password revokes
  refresh tokens; Microsoft account "sign out everywhere" / device removal
  revokes device sessions; each refresh consumes the old refresh token
  (rolling, single-use). So: treat "puppet got stolen" as "rotate = change
  password (or sign out everywhere) + new device-code bootstrap".
- Practical re-auth cadence: with a refresh token used at least once per
  90 days, the device-code prompt happens once, ever; a stale cache forces a
  human to redo the browser step. (Proven; LightyLauncherLib documents the
  same "once per ~90 days" behavior:
  [lighty docs](https://github.com/Lighty-Launcher/LightyLauncherLib/blob/production/crates/auth/docs/microsoft.md).)

### Client-ID strategy (proven, with a decision to make)

- A **custom Azure app registration** cannot call `api.minecraftservices.com`
  unless Mojang approves it via <https://aka.ms/mce-reviewappid>; otherwise
  `login_with_xbox` returns 403. (wiki.vg, updated Nov 2024, citing
  [Minecraft help article](https://help.minecraft.net/hc/en-us/articles/16254801392141).)
- The **public launcher client ID `00000000402b5328`** works without
  registration and is what the ecosystem defaults to (`prismarine-auth` `live`
  flow, RaphiMC `MinecraftAuth`). Child-account XErr 2148916238 also only
  triggers with custom app IDs, evidence custom IDs take a different code
  path.
- Decision for MVP: use the public launcher client ID (zero friction, standard
  practice for personal bots). Register our own app + mce-reviewappid approval
  is the compliant path if Monoplayer ever becomes a multi-user product —
  cross-link to the map's "end-user identity provider" open question.

### Where tokens may live (recommendation, grounded in deepmine ADRs)

- **Kubernetes Secret in a dedicated namespace, applied by a mise task, not
  tracked by ArgoCD.** This is exactly deepmine's `secrets-outside-git` pattern
  ([ADR](file:///home/neudeline/code/deepmine/adr/secrets-outside-git.md)):
  a `mise run ...:secret:apply` task writes the Secret, `--rotate` replaces it,
  the object carries no `argocd.argoproj.io/tracking-id` so syncs neither diff
  nor prune it. Nothing in git, nothing rendered by Helm, nothing in ArgoCD
  diffs.
- Contents: `{refresh_token, minecraft_token, uuid, name, xbl?, xsts?}`. Cache
  the short tokens opportunistically in the Secret (or rederive on restart);
  the refresh token is the only value that must survive restarts.
- Not needed at MVP: External Secrets Operator, SOPS, or Vault — deepmine
  rejected them for a handful of values, and the puppet is one value family.
  Revisit only when multi-tenant.
- Hard requirements around the Secret: encryption at rest on the dev cluster
  (Talos: secret encryption in machine config / KMS; if the homelab were k3s:
  `--secrets-encryption`) — **verify the actual cluster setting**, see
  checklist. Tight RBAC (only the puppet workload's ServiceAccount reads it),
  no `kubectl` wildcards, never logged or emitted to OTel.

## 2. Attaching a client: what identity is trustworthy

The proxy is simultaneously: (a) a *server* to the whitelisted client, and
(b) a *client* to the backend on behalf of the puppet. Each side has a
Mojang-verified login:

- **Client → proxy (attach gate):** the proxy runs the online-mode handshake
  with its own RSA keypair, then calls
  `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=...&serverId=<sha1>`
  (serverId = Minecraft-style SHA-1 of server-ID string + shared secret +
  public key). A non-empty response containing the player's **UUID** is proof,
  issued by Mojang itself, that this TCP connection belongs to an official
  client logged in as that account. No credentials are ever handed to the
  proxy. (Proven:
  [wiki.vg Protocol Encryption](https://wikivg.booky.dev/Protocol_Encryption).)
- **Proxy → backend (puppet):** the proxy calls
  `POST .../session/minecraft/join` with the puppet's 24 h Minecraft token,
  then the backend verifies via `hasJoined`. Note the documented 403s the
  puppet itself can hit — `InsufficientPrivilegesException` (Xbox profile has
  multiplayer disabled) and `UserBannedException` (banned from multiplayer) —
  which must surface as health/status, not silent retry loops.

**Recommendation: UUID whitelist verified by `hasJoined`.** The whitelist is a
set of Minecraft UUIDs (config, not git). This is the strongest option that
needs no extra identity provider, no shared secrets, and nothing the official
client doesn't already do. Weaknesses and alternatives:

- *Xbox identity directly:* infeasible without running an OAuth browser flow
  for the attaching user; the client never reveals MS tokens to a server.
- *Service-issued attach token only:* workable as a second factor (single-use,
  short TTL), but alone it proves possession of a string, not Minecraft
  identity; replayable if leaked. Use as an optional belt-and-braces layer,
  not the primary gate.
- *Whitelist by username:* names are case-insensitive and changeable; always
  resolve to UUID (`/minecraft/profile`), never compare strings.
- *Chat profile key continuity:* 1.19+ clients fetch a Mojang-signed keypair
  from `POST /player/certificates` and the server learns the public key at
  login ([wiki.vg Chat](https://wikivg.booky.dev/Chat),
  [yushijinhun discussion](https://github.com/yushijinhun/authlib-injector/discussions/158)).
  Not a whitelist mechanism, but: on servers with `enforce-secure-profile`,
  chat the relayed client signs with *its* key will fail verification against
  the *puppet's* profile key — a protocol wrinkle for ticket 02, and a reason
  some anti-cheats might flag the account. The proxy *can* fetch the puppet's
  certificates with the puppet's bearer token if it must sign as the puppet.

**Whitelist semantics (single-tenant MVP):** the whitelist answers "which
accounts may attach to this puppet", not "who may own the puppet". The puppet
account itself stays the operator's. Multi-account pooling, quotas, and
per-user attach policies are later concerns (map.md), and each later tenant
must get its own namespace/Secret — see §5 cross-tenant.

## 3. Legal and acceptable-use boundary

### What the terms actually say (proven, quoted)

- **Microsoft Services Agreement** (applies to the MSA behind the puppet):
  *"You cannot transfer your Microsoft account credentials to another user or
  entity. To protect your account, keep your account details and password
  confidential. You are responsible for all activity that occurs under your
  Microsoft account."*
  [MSA](https://www.microsoft.com/en-us/servicesagreement), section 4.a.i.
- **Minecraft EULA** (applies to the game; MSA + EULA together cover all
  Minecraft services): *"The one major rule is that you must not distribute
  anything we've made… give copies of our game software or content to anyone
  else; make commercial use of anything we've made; try to make money from
  anything we've made; or let other people get access to our game and its
  parts in a way that is unfair or unreasonable."* The same EULA also permits
  tooling: *"You may develop tools, plug-ins and services as long as they do
  not seem official or approved by us"* and explicitly allows hosting the Java
  server. [minecraft.net/eula](https://www.minecraft.net/en-us/eula).
- **Historical Mojang position** on sharing (2015, via Mojang support quoted
  on
  [Arqade](https://gaming.stackexchange.com/a/209988)): parent/child use is
  "fair and reasonable"; sharing between friends "would not" be. Marked
  historical; the live instruments are the two above.

### What it means for Monoplayer (assessment — partly judgment, flagged)

- **Clear line (do not cross):** handing the puppet (or its tokens) to a third
  party, selling attach slots, or running puppets for other people's accounts
  without each user's own consent flow. The map already puts multi-user
  account sharing out of scope.
- **Gray zone (we stay in it):** the operator driving their *own* account
  through their *own* infrastructure with their *own* whitelisted client is
  structurally indistinguishable from running a launcher + bot you already
  own. The MSA clause quoted above is about transfer to *another user or
  entity* — not violated while it stays a self-service tool. Headless bots on
  official accounts are widespread (mineflayer ecosystem, dozens of
  libraries), and enforcement against such personal use appears rare —
  **speculative**: Microsoft could at any time treat automated use or the
  proxy as an MSA violation and lock the account.
- **Per-server rules are the real, immediate risk (proven in kind, magnitude
  speculative):** public servers ban accounts their anti-cheat flags or whose
  behavior breaks their rules, and several blanket-ban bots/VPNs. A faithful
  packet relay is behaviorally invisible, but added latency, IP reputation
  (datacenter egress), or signature mismatches from §2 can still trip
  detection. **Constraint: the MVP must only target the operator's own server
  or servers that explicitly permit it; no anti-cheat bypass, no automation
  features, no input synthesis.** Bypassing anti-cheat is already out of
  scope in the map; this research makes the positive rule: nothing in the
  proxy may exist to evade detection or punishment.
- Vanilla `prevent-proxy-connections` checks that the IP the backend saw
  matches the IP of the `/join` call. In our topology both are the proxy pod's
  egress, so it *should* hold (verify once against a live backend; NAT
  asymmetry on the egress path is the falsifier).

## 4. Risk register

Severity: C critical / H high / M medium / L low. Likelihood applies to the
dev deployment as specified in §5.

| # | Threat | Sev | Likelihood | Mitigation |
|---|---|---|---|---|
| R1 | **Refresh-token theft** (git leak, log leak, RBAC hole, compromised pod) | C | L–M | Secrets outside git (deepmine ADR); Secret in dedicated namespace; RBAC only the puppet ServiceAccount; redaction in logs/OTel; encryption at rest; `--rotate` task; plan = password change + re-bootstrap |
| R2 | **Minecraft bearer token theft** (24 h window) | H | L–M | Same storage; token short-lived by design; never surfaced to the attached client |
| R3 | **Session hijack — non-whitelisted client attaches** | H | M | Online-mode `hasJoined` + UUID whitelist; optional single-use attach token; Tailscale ACL limits who reaches the proxy at all |
| R4 | **Attach-token replay** (if used) | M | M | Single-use, 60 s TTL, bound to the UUID it was issued for |
| R5 | **DoS / resource exhaustion** (fan-in of connect attempts) | M | M | Per-connection handshake timeout, attach rate limit, one attach at a time, pod CPU/mem limits, backlog caps |
| R6 | **Cross-tenant leakage** (future multi-puppet) | C | L (now) | One namespace + one Secret per puppet from day one; environment label; never share a cache; NetworkPolicy default-deny per namespace |
| R7 | **Proxy abuse by third parties** | H | L | Tailscale-only exposure, no public ingress/Gateway route for the data plane; default-deny NetworkPolicy |
| R8 | **Puppet account banned/locked** (server or Microsoft action) | H | L | Only operator's own servers / servers with permission; faithful relay, no automation; loud health signal on `UserBannedException`/`InsufficientPrivilegesException`; fallback = second account is out of scope, so the register accepts this as residual |
| R9 | **EULA/ToS breach via sharing or automation features** | C | L | Single-tenant, owner-operated MVP only; no automation/anti-cheat features; documented boundary in README |
| R10 | **Token expiry drift** (refresh token goes inactive 90 d) | L | M | Health check pings profile daily (rolls the window); alert before expiry; documented re-bootstrap task |
| R11 | **Secret pruned by ArgoCD / namespace deleted mid-session** | M | L | Secrets untracked (no tracking-id); cleanup task rotates tokens *before* namespace delete |

## 5. Dev-cluster operations (deepmine patterns)

Everything below mirrors proven deepmine homelab practice (links point at the
ADRs; the cluster is Talos + Cilium + Longhorn + ArgoCD + Tailscale + zot).

- **Namespace.** One namespace per puppet from day one, e.g.
  `monoplayer-dev` (single-tenant MVP; later `monoplayer-preview-<slug>` /
  per-tenant naming follows deepmine's vocabulary ADR
  [deployment-vocabulary](file:///home/neudeline/code/deepmine/adr/deployment-vocabulary.md)).
  Label it (`deepmine.eu/environment=dev` style) so telemetry can separate it.
  Pod Security: restricted except where the runtime needs more — keep the
  proxy in the restricted default.
- **NetworkPolicy.** Replicate the per-Network pattern from deepmine's
  `network_controller.go`: `default-deny-ingress` whose peers are the
  namespace itself plus the `tailscale` namespace (Tailscale's L4 proxy
  injects traffic). Add an **egress policy**: allow DNS, HTTPS 443 to
  `login.microsoftonline.com`, `user.auth.xboxlive.com`,
  `xsts.auth.xboxlive.com`, `api.minecraftservices.com`,
  `sessionserver.mojang.com`, the backend server, and the registry/DNS alias
  (`registry.internal`); deny the rest. This kills exfiltration by default.
- **Exposure.** `Service` with `loadBalancerClass: tailscale` in front of the
  attach port — the exact S3 slice pattern
  ([issue 44](file:///home/neudeline/code/deepmine/.scratch/platform/issues/44-network-owns-the-proxy.md)).
  No Gateway/Ingress route for the data plane; the tailnet ACL admits only
  the operator. The shared deepmine Gateway stays untouched (map out of
  scope).
- **PVCs.** Not needed for MVP: the token cache is small and lives in the
  Secret. Longhorn is the default StorageClass if a later slice persists
  session/world state (ticket 02's call).
- **BuildKit / registry.** Reuse the homelab's in-cluster zot registry:
  build with rootless daemonless BuildKit (`buildctl-daemonless.sh`, the
  deepmine preview-pipeline pattern) pushing to `zot.zot.svc:5000` in-cluster,
  or the homelab `buildkitd` StatefulSet in `deepmine-build`; nodes pull the
  `registry.internal` containerd alias; the control machine pushes over
  Tailscale (`registry.cluster.bafbi.fr`). No pull secrets — proven by
  [issue 36](file:///home/neudeline/code/deepmine/.scratch/platform/issues/36-provision-cluster-registry.md).
- **Secrets.** mise task family per deepmine: `secret:apply` (device-code
  bootstrap prints the code, the human approves in a browser, the task writes
  the Secret), `secret:show` (masked), `secret:rotate` (new device code).
  Secrets carry no ArgoCD tracking-id.
- **Cleanup.** `down` task: rotate/revoke tokens first (sign out everywhere or
  password change on the MSA), then delete the namespace; verify no Secret,
  Service, or NetworkPolicy remains. Branch-preview namespaces delete with the
  branch, deepmine-style.

## 6. Must be true before dev deploy (checklist)

1. [ ] Puppet account is the operator's own MSA; Java ownership proven
      (`/entitlements/mcstore` returns `product_minecraft` + `game_minecraft`).
2. [ ] Device-code bootstrap works from the control machine against the
      `consumers` tenant with the public launcher client ID
      `00000000402b5328`; profile UUID recorded.
3. [ ] No token, UUID, or Secret value exists in git, logs, OTel attributes,
      or ArgoCD diffs (secrets-outside-git pattern).
4. [ ] Secret lives in the puppet namespace with RBAC restricted to the
      puppet workload; ArgoCD does not track it.
5. [ ] Encryption at rest for Secrets verified on the dev cluster (Talos
      machine-config secret encryption — confirm actual setting).
6. [ ] `default-deny-ingress` NetworkPolicy installed (peers: own namespace +
      `tailscale`); egress limited to DNS + the four Microsoft/Mojang hosts +
      backend + registry.
7. [ ] Data plane exposed only via Tailscale `LoadBalancer`; tailnet ACL
      admits only the operator; no public ingress.
8. [ ] Attach gate = online-mode handshake + `hasJoined` UUID check against a
      configured whitelist; non-whitelisted UUID is denied before any packet
      relay.
9. [ ] Rate limit + handshake timeout on the attach port; single-attach
      invariant; pod resource limits set.
10. [ ] Puppet join errors (`UserBannedException`,
      `InsufficientPrivilegesException`, XErr 2148916233/35/38) surface as
      health/alert, not silent retry.
11. [ ] Backend server is the operator's own or explicitly permits a proxied
      client; no anti-cheat-bypass or automation code exists in the tree.
12. [ ] `down` cleanup task exists and rotates tokens before namespace
      deletion.
13. [ ] Target backend verified with `prevent-proxy-connections` semantics:
      `/join` IP == connection IP (both the proxy's egress).

## 7. Recommendation

Use `hasJoined`-verified UUID whitelisting as the attach identity (proven,
credential-free, no IdP), the public launcher client ID for the puppet's
device-code auth (proven, zero-friction), one namespaced untracked Secret
managed by mise tasks (deepmine-proven), Tailscale-only exposure behind a
default-deny NetworkPolicy (deepmine-proven), and a hard single-account,
owner-operated scope with no automation features (keeps us inside the ToS gray
zone). Registering a custom Azure app via mce-reviewappid becomes a
prerequisite only when the project turns multi-user.

## 8. Smallest falsifying experiment

Two parts, both cheap and no live account for the second:

1. **Auth lifecycle smoke (falsifies the client-ID and refresh assumptions):**
   a headless script (prismarine-auth `live` flow or RaphiMC `MinecraftAuth`)
   runs device code for the puppet, obtains the Minecraft token + profile UUID,
   persists the refresh token, then (after forcing access-token expiry or on
   restart) silently refreshes without a new device code. Falsified if: (a)
   `login_with_xbox` 403s (would indicate the public client ID path changed,
   forcing the mce-reviewappid route), or (b) silent refresh fails inside the
   90-day window.
2. **Whitelist gate (falsifies the identity proof end-to-end):** a minimal
   online-mode proxy fixture (node `minecraft-protocol`) performs the handshake
   and `hasJoined` against two real accounts: a whitelisted one (admitted, UUID
   logged) and a non-whitelisted one (denied before relay). Falsified if the
   gate cannot distinguish them, or if `hasJoined` cannot be made to succeed
   from the proxy's pod (which would also pre-falsify the whole
   terminate-and-verify design).

---

## Sources

- [wiki.vg Microsoft Authentication Scheme](https://wikivg.booky.dev/Microsoft_Authentication_Scheme) (mirror; flow, XErr codes, example token expiries, mce-reviewappid note)
- [Microsoft: device authorization grant](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-device-code)
- [Microsoft: configurable token lifetimes](https://learn.microsoft.com/en-us/entra/identity-platform/configurable-token-lifetimes) (refresh-token defaults, non-configurable)
- [wiki.vg Protocol Encryption](https://wikivg.booky.dev/Protocol_Encryption) (join/hasJoined, server hash, join 403 errors)
- [wiki.vg Chat](https://wikivg.booky.dev/Chat) and [yushijinhun authlib-injector discussion](https://github.com/yushijinhun/authlib-injector/discussions/158) (profile keypair, `/player/certificates`, `enforce-secure-profile`)
- [Microsoft Services Agreement](https://www.microsoft.com/en-us/servicesagreement) (account clauses)
- [Minecraft EULA](https://www.minecraft.net/en-us/eula) (distribution rule, tools clause, server hosting)
- [Mojang support on sharing, via Arqade](https://gaming.stackexchange.com/a/209988) (historical position)
- [prismarine-auth](https://github.com/PrismarineJS/prismarine-auth) (public client IDs, disk token cache)
- [LightyLauncherLib microsoft.md](https://github.com/Lighty-Launcher/LightyLauncherLib/blob/production/crates/auth/docs/microsoft.md) (90-day silent re-auth, scopes)
- Deepmine ADRs/issues (local): secrets-outside-git, deployment-vocabulary, remote-dev-cluster-and-preview-tenants, proxy-owned-aes-key-and-blind-relay, issues 36/44/46, `network_controller.go` default-deny peers
