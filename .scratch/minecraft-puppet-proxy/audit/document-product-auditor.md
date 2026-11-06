# Audit memo — document/product auditor

**Role:** document-product-auditor (clarity, completeness, product decision quality)
**Date:** 2026-11-05
**Subject:** `docs/architecture.html` — "Monoplayer — Architecture Proposal" (draft for decision)
**Inputs read:** `docs/architecture.html` (1,257 lines); `map.md`; `research/01-protocol-auth-prior-art.md`; `research/02-late-attach.md`; `research/03-runtime-validation.md`; `research/04-security-legal-ops.md`; `council/protocol-architect.md`; `council/reliability-security-architect.md`; `council/delivery-product-architect.md`; `issues/01-*` and `issues/05-*` (spot-check of link targets).
**Method:** line-by-line read of the HTML; every quantitative and technical claim cross-checked against the research notes and council memos; load-bearing external claims independently verified on the web.

## Verdict

The document answers map.md's destination completely — approach, lifecycle, auth/security, validation loop, MVP slice, and kill criteria are all present with decision-grade specificity. The decision-relevant content (D1–D8, the risk table, the numeric kill criteria, the six questions) is a faithful and honest distillation of the three council memos, and in several places it is *more* honest than its sources (the "honest caveat" callout, the dissent quoted in full, the corrected egress allowlist that includes OTel and the K8s API, the chunk-eviction trade-off explicitly labeled "not demonstrated by the cited projects").

**No P0 findings.** No false claim, no broken internal link, no decision-reversing misrepresentation found. Every load-bearing external claim I spot-checked verified (see Verification log). The problems are P1/P2: one underspecified gate condition, one internal contradiction about how many questions gate it, one diagram that draws the opposite of its own caption, one undefined lifecycle transition, and a set of completeness/attribution/print issues.

## Verification log (independent web checks)

- **Protocol versions:** 26.1 = protocol 775 (released 2026-03-24, "Tiny Takeover"); 26.3 = 777 (latest release); 26.4 snapshots current dev. Matches HTML lines 792–794 and research 02/03. ✓
- **Node library support:** PrismarineJS/minecraft-data issue #1159 "Support Minecraft PC 26.1" closed 2026-07-28 → the claim "Node library support ≤ 26.1 / 775; 26.3 in flight" (line 793) is accurate. ✓
- **ZenithProxy:** repo exists; README confirms "A Minecraft bot that players can also log into and control ingame", secure whitelist, spectator mode, persistence, ViaVersion, Baritone, Discord, <300 MB RAM (README: "<300MB RAM per java instance or <200MB on linux"). GitHub API reports license `AGPL-3.0`. All prior-art table claims (line 381) verify. ✓
- **azalea-reflection-proxy:** exists (crates.io/docs.rs); source confirms cached config frames + synthesized FinishConfiguration, Login/Respawn, Game Event 13, raw chunk cache, world snapshot, and controllerless keep-alive/teleport stand-in. Line 391 verifies. ✓
- **Pork2b2tBot:** exists ("A minecraft bot thing, also works as a proxy!"); last activity ~2022, abandoned → "Frozen development, behind on protocol versions" (line 387) verifies. GitHub classifies its license as "Other" — consistent with the research note's "MIT + attribution" (a modified MIT reads as "Other" to GitHub's classifier); not independently confirmable, not contradicted.
- **Dead link found:** `https://wiki.vg/Protocol_Encryption` (line 1200). wiki.vg is defunct/parked; the research notes themselves already use mirrors (c4k3.github.io, wikivg.booky.dev). See P2-3.

## P0 — must fix

None.

## P1 — should fix

### P1-1. Gate A (the go/no-go experiment) is underspecified on the exact setting most likely to kill the project, and its two statements don't agree

- Locations: `#validation` "Gate A — the 2-day falsifier" (lines 826–843) vs `#risks` "Kill criteria" (lines 1002–1007).
- The falsifier says the build is falsified by "the client is kicked on secure-chat/session verification" (line 840), yet the plan targets backends with `enforce-secure-profile=false` (relay rules, line 702; question 5, line 1147). On such a backend that falsifier branch is inert by design. Research 01's original falsifier explicitly specified "enforce-secure-profile **on**" (research/01 §8); the HTML dropped that condition without replacing it. The councils themselves split: protocol-architect says the operator's own 26.1 server with secure profile **off**; delivery says a fake backend is acceptable. The HTML papers over this by allowing "a fake backend with a local `hasJoined` stub" (line 832) while still claiming the gate falsifies secure-chat behavior — a fake backend cannot falsify chat-signature handling at all, and step 3's "send chat" then proves nothing about the #2 risk the gate exists to test.
- Also inconsistent: Gate A's falsifier list includes "reattach is stuck on 'Loading terrain…'" (line 841), but the kill-criteria box omits reattach entirely and substitutes "kicked within 60 s" for the secure-chat-specific kick (line 1004). Two authoritative statements of the same gate, disagreeing.
- **Recommendation:** state one authoritative Gate A contract, and in it pin: (a) whether the backend is the operator's real online-mode server or a fake backend, and (b) the `enforce-secure-profile` setting(s) to test — ideally both, since question 5's answer may not be known when Gate A runs. Align the two falsifier lists verbatim, or have the kill-criteria box reference Gate A instead of restating it.

### P1-2. "Six decisions before Gate A" contradicts "Answer 1–3, then run Gate A"

- Locations: section heading line 1119 vs "Recommended next action" lines 1160–1163; provenance callout line 1211 says the HITL ticket follows "once the six questions above are answered".
- The reader is told the gate requires six answers, then told it requires three. Worse, Q5 (chat / `enforce-secure-profile`) is not in the 1–3 subset, but P1-1 shows Gate A's chat falsifier depends on exactly that setting. The three statements together leave the actual go/no-go condition undefined — the one thing a decision gate may not be vague about.
- **Recommendation:** retitle the section (e.g. "Six decisions; three block Gate A") and mark which questions gate which stage: Q1–Q3 gate Gate A, Q4–Q5 gate slice 1, Q6 gates the live smoke — or state explicitly that Q5 must be answered before Gate A's chat step. Make the provenance sentence match whatever you choose.

### P1-3. The lifecycle SVG draws DETACHING → RECONNECTING, contradicting its own caption

- Location: line 608 (`<line x1="588" y1="249" x2="552" y2="249" ... marker-end>`).
- The DETACHING box (x 588–730, y 220–278) has exactly one outbound arrow, ending at (552, 249) — adjacent to the **RECONNECTING** box (x 384–548, y 220–278). The caption (line 614) and the events table (line 622) correctly state that detach returns to CONNECTED_UNATTACHED (x 384–548, y 100–162) and never touches the backend. The diagram draws the opposite of the architecture's central invariant — the one property a skimming decision-maker will read off the picture.
- The nearby "attach fails" arrow (line 610) is also sloppy: it terminates at (770, 220), outside the DETACHING box's bounds (right edge is x=730).
- **Recommendation:** redraw the DETACHING outbound arrow to terminate at the CONNECTED_UNATTACHED box, and correct the "attach fails" arrowhead to actually touch DETACHING. Cheap fix, high signal value.

### P1-4. Backend-drops-while-attached is undefined

- Location: lifecycle events table, "Backend drops the puppet" row (line 624), against the two-state-machine claim (lines 561–565).
- The doc claims two independent state machines but never defines the cross-event: what does an attached client see when the backend leg dies? The reliability-architect memo explicitly added "deterministic kick of any attached client with a clear reason if the backend leg dies" — the HTML dropped it. As written, a client can sit attached to a dead session through the RECONNECTING window with no defined behavior.
- **Recommendation:** add one row or sentence: backend drop while attached → the client is disconnected with the backend's reason or a proxy message, and may reattach once RECONNECTING completes. This is the only gap in an otherwise complete lifecycle contract.

## P2 — nice to have

### P2-1. Sources section links to ticket stubs, not the evidence

- Location: `#sources` internal list (lines 1179–1187), against the claim at lines 1170–1173 that the linked notes "contain the full evidence, links, packet tables, risk register, and test plans".
- The linked `issues/*.md` files are ticket definitions with one-paragraph answers that point onward; the full evidence (packet tables, risk register, test plans) lives in `research/*.md`, which the HTML never links.
- **Recommendation:** link the `research/` notes directly (they are the "working notes" the sentence describes), keep the issues as a secondary layer, or rewrite the sentence to match what the linked files actually contain.

### P2-2. Prior-art attribution: mineflayer-reflection-proxy row absorbs IceTank/mineflayer-proxy-inspector

- Location: prior-art table, line 396.
- "World persistence from bot memory and attach/link behavior" is attributed in research 02's sources to IceTank/mineflayer-proxy-inspector, not 0xjimmy/mineflayer-reflection-proxy (research/02 lines 206, 10). The HTML merges two distinct projects into one row and drops IceTank.
- **Recommendation:** split the row or re-attribute the persistence claim. Minor, but the document's credibility rests on precise prior-art attribution.

### P2-3. Dead external link: wiki.vg

- Location: line 1200, `https://wiki.vg/Protocol_Encryption`.
- wiki.vg is defunct/parked; the research notes already link mirrors. A decision-maker following the "how hasJoined works" link lands on nothing useful.
- **Recommendation:** point at the mirror the research actually used (e.g. c4k3.github.io/wiki.vg or wikivg.booky.dev).

### P2-4. Unexpressed operator prerequisites

- (a) The puppet is "another official account" (line 331), but the doc never states the operator must own a **second, Java-licensed** Microsoft account. Research 04's checklist #1 requires proving Java ownership via `/entitlements/mcstore`; neither surfaces in the HTML. One line in the auth section (or a bullet in the questions) would close it.
- (b) The "operator logs into the puppet account manually from the launcher" duplicate-login kick (research/02 §1.1; Paper #5303 / MC-172541) is not mentioned. Only the second-pod variant is covered (line 626). Manual login is the most likely accidental way to kill the puppet session in daily use; a one-line warning in `#lifecycle` would pay for itself.
- (c) `prevent-proxy-connections` verification (research/04 checklist #13 — `/join` IP must match the connection IP through the proxy's egress) is not carried into the live smoke. Cheap to add to the Live smoke row in the plan table.

### P2-5. Known failure modes from research 02 §6 silently dropped

- Backend re-enters CONFIGURATION mid-play (`Start Configuration`) — listed in research 02's failure table, explicitly out-of-MVP per the delivery memo §3, and stated nowhere in the HTML. Same for: non-state packets (chat/sounds/particles) dropped while unattached/attaching (the coalesce bullet at line 661 says live frames "update the cache semantically" but never says the rest are dropped); respawn handling when the puppet dies while detached (the synthesized join covers Login, but the Respawn packet path is unstated); pre-spawn movement swallowing (research/01 §3).
- **Recommendation:** either state these as explicit non-goals with defined behavior, or add them to the "packet-level details worth pinning" list. A smart engineer will ask "what happens when the backend sends Start Configuration mid-play?" on the first read; the document should not be silent on it.

### P2-6. Print and disclosure mechanics

- Closed `<details>` elements (packet details line 711, legal position line 768, dissent line 1076) do not print their content. A printed copy loses the legal position and the dissent — two of the most decision-relevant passages.
- Only the hero has `print-color-adjust: exact` (line 216); the severity pills and callouts lose their backgrounds in print, flattening the risk table's signal.
- **Recommendation:** add a small `beforeprint` handler (or ship the dissent/legal blocks `open`) and apply `print-color-adjust: exact` to callouts/pills/stat blocks in the print media query.

### P2-7. Small accessibility nits

- Tables have no `<caption>`, and `th` elements lack `scope="col"`.
- `.toc-title`, `.stat .k`, `.callout .label`, `.section-kicker` are 0.72–0.78rem in `--faint` (#667085 on white ≈ 4.6:1) — below AA for that size/weight under strict reading.
- On mobile the TOC is `display: none` with no replacement (acceptable for a decision artifact; the skip link partially compensates).
- Positive: both SVGs have `role="img"` + `aria-label`, the skip link exists, and headings are hierarchically sound. Keep that pattern.

### P2-8. Tone: three spots read as marketing, not engineering

- H2 "This is not speculative. Somebody already shipped it." (line 367) — true for the *pattern*, but the document's own caveat admits the Node implementation is a bet. A skimming reader will over-read the heading. Suggest: "Prior art: the pattern is proven in production; the Node implementation is not."
- "The cache is the product." (line 530) — pithy and defensible, and the following table carries the substance. Fine to keep.
- Keep exactly as-is: the eyebrow "draft for decision", "Status: proposed, not built" (line 246), "confidence is per delegate, not a vote count" (line 1017), and the "honest caveat" callout — these are the right honesty markers.

### P2-9. The one missing question: what is this *for*?

- Q3 (build vs deploy) is framed as an engineering-ownership choice, but the reliability memo's strongest counter identifies the real driver: if the job is queue-waiting or always-on presence, ZenithProxy-as-config wins on every pure metric; if it is daily remote play plus future extension, the build pays off. The six questions never ask what the operator wants the puppet to do day-to-day — which is the question that decides whether D1/D5's persistence-driven complexity (a live TCP session as pod memory) is even earned.
- **Recommendation:** add a seventh question ("primary use: always-on presence, queue waiting, remote play, future multi-account?") or fold it into Q3's framing.

### P2-10. "Must" overstates the back-leg auth settlement

- "What the prior art settles" says the back leg "must authenticate as the puppet with Microsoft device-code auth" (line 406). ZenithProxy ships several auth types (device code is the default, not the only one); prior art settles "Microsoft-authenticated", not "device-code". The auth section itself (lines 738–739) correctly treats device-code as the chosen flow. Harmonize the two.

## What is right (worth preserving)

- Answers map.md's destination completely, with all "Not yet specified" items either resolved or explicitly deferred.
- Decision log D1–D8 accurately reflects the three council memos, including the honest 78–80 confidence range and the full dissent.
- Numeric claims survive verification: protocol versions, ZenithProxy feature set and license, <300 MB RAM, ~1–3 s attach, chunks 79% / entity deltas 86% traffic shares, 30 s keep-alive deadline, one-in-flight chunk batches, 90-day rolling refresh token.
- Kill criteria are numeric and borrowed verbatim from the reliability memo (95% first-try attach, 24 h median lifetime, second token incident) — unusually honest for an architecture doc.
- The chunk-eviction MVP trade-off is labeled as not demonstrated by any cited project; the legal position correctly stays in "gray zone, unquantified risk" language; the non-negotiables list is concrete.
- Self-contained single-file HTML, no external assets, all TOC anchors resolve, skip link works, print media query present.

## Not audited

- Cryptographic correctness of the hasJoined serverId construction (protocol-architect's domain; note the cited wiki.vg link is dead — P2-3).
- Kubernetes manifests referenced by name only (none exist in this repo yet).
- Whether the synthesized-join packet order is tolerated by a real 26.1 client — correctly assigned by the document to Gate A, an experiment rather than a prose claim.
