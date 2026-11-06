# Ops & Security Audit — Monoplayer Architecture Proposal

**Role:** ops-security-auditor
**Date:** 2026-11-05
**Target:** `docs/architecture.html` (draft for decision)
**Inputs read:** architecture.html (full); map.md; research 01–04; council memos ×3; issue 05
**Method:** line-by-line audit of the doc against the research notes and council memos; homelab claims verified against `/home/neudeline/code/deepmine` (manifests, ADRs, operator source, fleet-contract); key external claims (release version/protocol, library currency, ZenithProxy, Pork2b2tBot) spot-checked on the web 2026-11-05.

---

## Verdict

The proposal is defensible, and the document is unusually honest about what is speculative. The protocol architecture, the single-pod topology, and the ops loop are consistent with the underlying research and — where I could check — with the actual homelab. The problems from my lens are **not** in the protocol design. They are:

1. **The primary kill test (Gate A) is written so that it can falsify the project on a condition the MVP explicitly configures away.**
2. **At least one asserted security control — Secret encryption at rest — is unverified and most likely false.**
3. **The riskiest operational component (rolling refresh-token write-back) is the one thing the three-week plan never validates.**

Fix those three, plus the P1 list below, and the document is decision-ready from an ops/security standpoint.

---

## What checked out (verified, not just plausible)

- **Registry / BuildKit** — `zot.deepmine-core.svc:5000` is the correct push target (zot chart deploys a `zot` Service in `deepmine-core`, `fullnameOverride: zot`; buildkitd's `registry.insecure` stanza names exactly this host). Pull-side `registry.internal/…` is correct (Talos mirror maps `registry.internal` → zot's pinned ClusterIP `10.96.255.50:5000`; the OCI repository path excludes the host, so the two names address one repository — `docs/fleet-contract.md`).
- **buildkitd** — StatefulSet in `deepmine-build`, service port 1234, `moby/buildkit:v0.33.1`; `kubectl -n deepmine-build port-forward svc/buildkitd 1234:1234` is the deepmine task.
- **Tailscale exposure** — `loadBalancerClass: "tailscale"` is the exact deepmine operator pattern (`network_proxy.go`, tailscaleLBClass = `"tailscale"`), per issue 44.
- **Telemetry** — `otel-collector.deepmine-shared.svc.cluster.local:4317` and `openobserve.deepmine-shared.svc.cluster.local:5080` both exist as claimed (collector values, operator controller defaults).
- **Tool pins** — node 26.7.0, pnpm 11.25.0, kubectl 1.37.1, buildkit 0.33.1 all match deepmine's root `mise.toml`.
- **External claims** — Java 26.3 "Wilderness Bound" released 2026-09-15, latest release as of the doc date ✓; `minecraft-data` supports through 26.1 (26.3 "in flight") ✓; ZenithProxy: AGPL-3.0, "players can also log into and control ingame", secure whitelist, spectator mode, ViaVersion, "<300MB RAM per java instance" ✓; Pork2b2tBot: "also works as a proxy", attribution-style license, effectively frozen ✓.
- **Internal consistency** — badges (78–80 confidence; 4 research + 3 council delegates) match the memos; D1–D8 in the doc match the council decisions; the version pin 26.1/775 is consistent across doc and all notes; the egress list in the doc correctly includes OTel and the K8s API (closing the gap the reliability memo found in note 04); the lifecycle/relay/attach tables faithfully summarize research 02 §4.

---

## P0 — must fix before Gate A / before the decision

### P0-1. Gate A can falsify the build on the exact condition the MVP configures away
`#validation` (Gate A) says: stand up "an online-mode backend at the pinned version" (no `enforce-secure-profile` setting specified), and "Falsified if: the client is kicked on secure-chat/session verification".

Vanilla `server.properties` defaults `enforce-secure-profile=true`. On such a server the puppet's chat — signed by the *client* with the client's key, then stripped to unsigned by the proxy — is rejected/disconnecting, because the backend learned the *puppet's* chat key at login (research 01 §2, 04 §2). So Gate A step 3 ("send chat"), run against a default-config vanilla server, will near-certainly produce exactly the falsification condition — while the MVP's own risk table says the answer is to "target `enforce-secure-profile=false`". The council memos are explicit that the live experiment runs with `enforce-secure-profile` **off** (protocol-architect D6); research 01 §8 ran it *on* to probe chat stripping. The doc silently merged the two and dropped the setting.

**Fix:** state in Gate A that the backend must have `enforce-secure-profile=false` (or the proxy must block chat), and reclassify "chat kicked under enforce-secure-profile=true" as a *chat-descope* signal (block chat until puppet-key re-signing), not a falsification of the Node substrate. The falsifier should kill the build only on join/movement failure — the things the MVP posture doesn't avoid.

### P0-2. "Encrypted at rest" is asserted but unverified — and most likely false
`#auth` (Puppet login → Storage) states the Secret is "encrypted at rest". Research 04's own checklist item 5 marks this as an open verification: "Encryption at rest for Secrets verified on the dev cluster (Talos machine-config secret encryption — **confirm actual setting**)". I found no evidence anywhere in the deepmine repo that the cluster sets Talos's `secretboxEncryptionSecret` (or any KMS/EncryptionConfig); Talos does **not** encrypt Secrets at rest by default. The doc promoted an open checklist item into an asserted security property of the system's most sensitive credential.

**Fix:** either verify the cluster setting before the doc is decided on, or strike the claim and say "encryption at rest: TBD — verify Talos `secretboxEncryptionSecret` before storing the token" (and add it to the deploy checklist).

---

## P1 — should fix

### P1-1. "No Microsoft account until the final smoke" is false for Gate A's first path
`#validation` claims the whole loop runs "with no Microsoft account until the final smoke", but Gate A step 1's first option ("stand up an online-mode backend at the pinned version") requires a genuine Microsoft login for the puppet leg on **day 2** — an injected fake session cannot pass a real online-mode backend's `hasJoined` (which is the entire point of the back leg). The observer also needs the server console or a second (real) account. This contradicts map.md's constraint ("a live Microsoft account is only needed for the final auth smoke test"). The doc's "or injected puppet login / fake backend" hedge makes it survivable, but the unqualified headline is wrong as written.

**Fix:** either pin Gate A to the fake-backend + local-`hasJoined`-stub path for the go/no-go, or move the MS prerequisites (research 04 checklist #1–2: operator's own MSA, Java entitlement proof, device-code bootstrap) explicitly into Gate A's preconditions.

### P1-2. The refresh-token write-back loop is Critical risk #2 — and the plan never validates it
The doc's risk table rates "Refresh-token chain broken — failed write-back" **Critical** and the kill criteria count "a second refresh-token incident within 90 days" as project-ending. Yet the only live-account activity in the plan is "Live smoke — 1 day: Real Microsoft account + real backend + official client. The 60-second demo." Nothing in the plan tests *restart pod → silent refresh → replacement token persists to the Secret → chain survives*. Research 04 §8(1) (the silent-refresh falsifier) exists in the notes but is absent from the doc's validation loop. A broken write-back fails silently for up to 90 days, then bricks the login with a human re-bootstrap.

**Fix:** add an explicit validation scenario (at minimum: refresh → restart → refresh again without device code) to the live smoke or as its own ½-day gate; pull 04 §8's two auth falsifiers into the plan table.

### P1-3. `enforce-secure-profile=false` is a server-wide security downgrade, not a checkbox
`#rewrites` and `#risks` present "target `enforce-secure-profile=false`" as a local configuration detail. It is a **global** setting on the operator's backend: disabling it weakens chat-reporting/verification for *every player* on that server, and the vanilla default is true. The doc should state that cost explicitly and note the alternative that preserves the setting: the proxy blocks/read-onlys the puppet's chat until puppet-key re-signing lands (the doc's own question 5 hints at this, but the body doesn't).

### P1-4. The single-pod invariant is discipline, not mechanism — and the promised alert doesn't exist
The "Hard invariant" callout (`#lifecycle`) says "use `replicas: 1`, `strategy: Recreate`, no HPA, **and an alert if the pod count ever exceeds one**". The reliability council memo honestly notes nothing in the cluster *prevents* `replicas: 2` — a node-reboot double-start, a stray apply, or a second Deployment would silently brick the rolling token. The doc omits that caveat, and the promised pod-count alert appears **nowhere** in the observability table (`#observability`). As written, the alert is promised and unspecified.

**Fix:** add the pod-count signal (e.g. alert on `kube_deployment_spec_replicas != 1` / running-pod count ≠ 1), state the residual risk, and consider an admission guard (the memo's own fallback) before any wider deployment.

### P1-5. The egress allowlist is new surface presented inside "the proven homelab loop"
`#operations` leads with "reuses the Deepmine homelab patterns" and lists the egress allowlist as a topology fact. The proven deepmine pattern is **ingress-only** default-deny (`network_controller.go`: `PolicyTypes = [Ingress]`, peers = own namespace + tailscale). The default-deny **egress** policy — DNS + four Microsoft/Mojang hosts + backend + registry + OTel + K8s API — is new work proposed by note 04, and FQDN-based egress needs Cilium `toFQDNs` (or pinned IPs), plus careful DNS scoping (UDP/TCP 53 to cluster DNS only, or the FQDN rules won't resolve). Budget for it in the 4-day ops slice and don't imply it's a copy-paste.

### P1-6. Secret write-back mechanics are under-specified in the doc
The doc says "RBAC-scoped" and "pod write-back" (`#auth`, `#operations`) but not *how*: Kubernetes Secret volumes are read-only, so prismarine-auth's on-disk token cache cannot live directly in the Secret — the pod must write to a scratch volume and patch the Secret via the K8s API (which is why the egress list needs the K8s API). The reliability memo specifies the right shape ("RBAC scoped to *patch exactly* `monoplayer-puppet-auth`"); the doc should carry at least that one line, since the write-back path is the token's lifeline.

### P1-7. The kill criteria reference a soak phase that isn't in the plan
`#risks` kill criteria: "Daily-use soak: first-try attach success <95%, puppet median lifetime <24 h…, or a second refresh-token incident within 90 days." The three-week plan (`#plan`) contains **no soak phase** — it ends at "Accept, or deploy ZenithProxy". As written, the criteria are unevaluable by the plan. Either schedule a post-demo soak (the reliability memo implies a 2-week daily-use soak) or explicitly label these as post-acceptance operational criteria.

### P1-8. Observability defects
- `monoplayer_backend_login_total` is described as "Must be exactly one per puppet session" — a monotonic counter cannot express that; use a per-session gauge/delta (the invariant is real — research 02 T4 — the metric type is wrong).
- `monoplayer_refresh_token_age_days` ("Alert at 60 days") cannot alert in the scenario that actually ages the token: a **dead pod**. No emitter, no gauge, no alert. Needs an out-of-band check (mise task / external cron / last-write timestamp on the Secret), not only a pod metric.
- **L4** appears in the test-layer table but is never scheduled anywhere in the plan table.

### P1-9. Ops hardening items present in the research but absent from the doc
- Attach-port rate limiting and handshake timeout (research 04 R5, checklist #9 — the tailnet is the outer ring but the tailnet isn't one user).
- Readiness probe definition (reliability memo D7: puppet leg in PLAY ∧ cache warm ∧ auth healthy).
- Pod Security `restricted` / nonroot (reliability memo D7).
- `prevent-proxy-connections` verify-once against the real backend (research 04 checklist #13) — trivially true for the operator's own server, but the one-line check is cheap insurance.

---

## P2 — nice to have

- **map.md says "k3s"; the actual cluster is Talos** (research 03/04, fleet-contract, Talos mirror config). The doc itself is clean, but anyone executing from map.md should ignore "k3s" — and note 04's k3s-vs-Talos framing ("if the homelab were k3s…") is hypothetical.
- Attach target "<2 s at RD 8" (`#observability`) vs "~1–3 s" UX expectation (`#attach`) — align the wording.
- L3 assumes the **production image** exposes an auth seam (injectable/offline AuthProvider) at runtime — implied by the fixtures, never stated as a runtime feature; the L3 job cannot run without it.
- The ring-buffer frame capture "attached to the error trace" (`#observability`) can contain third-party players' chat and the puppet's coordinates from a shared backend; define retention/redaction expectations.
- Puppet-account prerequisites (operator's own MSA, Java Edition ownership via `/entitlements/mcstore`) are assumed but never stated in the doc's questions or plan (research 04 checklist #1–2).
- Forged Login Success must carry the puppet's skin/properties — cached Mojang profile properties expire; the doc doesn't say where the proxy gets them (trivial: `/minecraft/profile` with the puppet token — but worth one line).
- Whitelist storage: Secret vs ConfigMap is unspecified (research 03 says "ConfigMap/Secret"; UUIDs are not secret — pick ConfigMap, easier reload).
- ZenithProxy "<300 MB" (README-verified) vs research 01's "<250 MB" — pick one number in the pack.
- Mojang sessionserver rate limits per egress IP — negligible at one-attach-at-a-time scale, but the front-leg `hasJoined` failure mode (5xx/timeouts) deserves a log-with-reason line, since it degrades to "attach unavailable".

---

## Cannot be validated as written

- **Gate A's go/no-go is not runnable until the six questions are answered.** "Stand up an online-mode backend at the pinned version" presupposes question 1 (own server, pinnable to 26.1). The doc does acknowledge "Answer 1–3, then run Gate A" — this is consistent, just worth stating as a hard precondition.
- **The performance/UX numbers** (~1–3 s attach, <2 s target, tens-of-MB cache) are extrapolations the research itself flags as medium confidence (research 02 §7b). The doc inherits them as expectations, which is fair for a draft — but they should be re-labeled "to be measured at Gate A / L2", not treated as proven.
- **The legal gray-zone framing** (MSA/EULA) is judgment, with enforcement risk explicitly unquantified. The doc is honest about this; nothing further is fixable without counsel.
- **Secure-chat re-signing ("re-sign with puppet certs later")** has no design or estimate anywhere in the pack; it's fine to defer, but question 5's "chat is read-only/blocked" fallback should be pre-agreed so the demo has a defined chat story.

---

*Adversarial but fair: the document is better than most drafts at separating proven from speculative. The P0s are all in the "claims and gates" layer, not the "architecture" layer — that is fixable with edits, not redesign.*
