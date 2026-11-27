# Run the panel

The panel is one page, its own assets, one stream and the JSON routes an agent reads
on the tailnet, showing what each puppet it may touch is doing, which control
ConfigMap it may write for it, and which copy Git commits it falls back to. It runs
beside the proxy: same image, second entrypoint, and since #609 the proxy's
namespace.

| Route | Answers |
|---|---|
| `GET /` | the page: one card per puppet, and the actions |
| `GET /api/puppets` | the registry document, as JSON |
| `GET /api/puppets/<name>` | one puppet's facts, as JSON |
| `GET /api/puppets/<name>/stream` | the live region, one fragment every 5 s |
| `GET /api/puppets/<name>/whitelist` | the attach whitelist, as JSON |
| `POST /api/puppets/<name>/whitelist` | add one entry, by uuid or by name |
| `DELETE /api/puppets/<name>/whitelist/<uuid>` | remove one entry |
| `GET /api/puppets/<name>/allowed-servers` | the allowed-server list, as JSON |
| `POST /api/puppets/<name>/allowed-servers` | add one server, by host and port |
| `DELETE /api/puppets/<name>/allowed-servers/<host>:<port>` | remove one server |
| `GET /static/…` | the page's own files: the stylesheet, htmx, the font |
| `GET /healthz` | the probe, which never reads the registry |

    http://monoplayer.tail41e568.ts.net

That name comes from `tailscale.com/hostname: monoplayer` on the Service in
`deploy/panel/service.yaml`, the way `glowsquidye` names the front. There is no
public route and no bearer token: the tailnet is the transport and the tailnet ACL
is the authorization, so whoever may reach that device may read the page. The
panel is never published through the playit tunnel ([public-access.md](public-access.md)).

## What the page shows

Per puppet, one card: what it is doing, read from the records the puppet already
writes to its JSONL log on stdout. The card adds no state anywhere.

The panel makes three reads to fill a card:

| Read | Request |
| --- | --- |
| the Deployment's pod selector | `GET /apis/apps/v1/namespaces/<ns>/deployments/<deployment>` |
| the pods that selector matches | `GET /api/v1/namespaces/<ns>/pods?labelSelector=…` |
| the log of the pod that serves | `GET /api/v1/namespaces/<ns>/pods/<pod>/log?container=monoplayer&tailLines=400` |

The records are the ones [telemetry.md](telemetry.md) documents: `heartbeat` every
30 s, `startLive` once at start, `attach` once per attach, and the
`preAuthRefused` and `preAuthExpired` lines the pre-auth window writes when it
bites.

**Every number carries the timestamp of the line it came from.** The `Heartbeat`
heading prints the record's own `t`, and every row under it is that record's. The
page's read time is printed once, at the bottom, labelled `read at`; nothing else
is rendered as "now". A heartbeat older than three intervals says so in words. A
stale record shown as live is the failure this page exists to prevent.

**A puppet that is not serving says why**, in one of seven sentences:

| State | Sentence |
| --- | --- |
| `read-refused` | `read refused: …`, with the status the API server answered |
| `no-pod` | `no pod: Deployment <namespace>/<name> has no pod …` |
| `not-ready` | `pod not ready: <pod> is not Ready (<reason>) …` |
| `log-refused` | `log fetch refused: …` |
| `no-heartbeat` | `no heartbeat in the last N lines of <pod> …`, with the newest line's timestamp |
| `stale` | `stale: the newest heartbeat was written N s ago …` — older than three intervals |
| `serving` | `serving: the newest heartbeat was written N s ago …` |

Some facts are stated only by the lines that carry them, and the card says so
rather than guessing:

- **The attach whitelist at start and the effective backend** come from the
  `startLive` record. The tail is 400 lines, so a pod older than that has no start
  record in it: the card prints `unknown, and no start record is in the tail`, and
  shows the registry's own backend beside it, labelled `registry` with no
  timestamp.
- **The `attach whitelist at start` row names the entries it counts.** The count and
  the rows are one read: the list the start record names, and its length.
  `Whitelist entries at start`, below the row, holds one row per entry: the uuid, and
  the UUID decision `uuidRefusalReason` in `src/custody/util.js` gave it, in the
  words the "Who may attach" block prints. The answer is the one the start record
  wrote, so the panel prints a decision and never makes a second one, and the count
  carries the fault when an entry admits nobody. The startup list holds uuids and no
  names, so a row names the uuid and never the name a login would claim. A record
  written before the field existed, or a tail whose only start line is the core
  `start` one, shows the count and says where the per-entry answer is.
- **That row and the block under the card are two different facts.** The control
  document re-reads the whitelist at each login (#229), so an edit made after start is
  invisible in the rows above. The block is the list itself, read on every tick, so an
  edit shows there within five seconds. The page never merges them: one is what the
  lane started with, the other is what the file holds now.
- **The effective backend is the last successful dial**, so a puppet that followed a
  transfer shows where it is now rather than where it started. `last dial` shows the
  newest dial of either outcome with `connected` or `failed`, because a reconnect
  that failed in the tail is the difference between "on play2" and "on play2 until
  three minutes ago".
- **`preAuth.maxConnections` and `preAuth.deadlineMs` are not in the heartbeat.** A
  refusal line carries the cap and an expiry line carries the deadline, so each cap
  is shown with the timestamp of the last line that stated it. A healthy lane writes
  neither, so the fallback is the Deployment's own environment
  (`MONOPLAYER_PREAUTH_MAX_CONNECTIONS`, `MONOPLAYER_PREAUTH_DEADLINE_MS`), labelled
  `Deployment env` with no timestamp. When both are silent the row says unknown: the
  compiled default applies and the panel cannot see it.
- **The journal's caps are the same shape.** `journal.stats()` reports what the
  journal did, not its caps, so the card shows the journal's effects and the three
  `MONOPLAYER_JOURNAL_MAX_BYTES`, `..._MAX_TOTAL_BYTES`, and `..._MAX_AGE_MS` values
  from the Deployment's environment, or says they are not set there. A journal a full
  volume stopped before its first write does report `freeBytes` and
  `requiredBytes`, and those rows appear.

**The front leg's counters are drawn whole and not from a list in the panel.** The
`Front` group is every counter the heartbeat's `front` group carries, in the order the
record carries them, which is the order `src/legs/live-front.js` declares them in. Its map
of refusals is drawn after them, under a heading of its own, as the core's maps are. A
counter the leg adds is a row on the page with no edit here and no edit in the panel.
That is the point of #743: the field list the panel kept named only the counters
somebody had written into it, so a login the sessionserver refused was counted,
recorded and charted, and never appeared on the card. That row reads `sessionserver
refused the login`, and the order it appears in is the leg's: the panel imposes none, so
a row's neighbours are whatever `src/legs/live-front.js` declares beside it. The
refusal it counts is one an operator tells apart from `pre-auth refused`, which is in
the same group: that one is this lane turning a login away, and this one is Mojang
refusing it before the lane reviews the client
([#722](https://github.com/Bafbi/monoplayer/issues/722)).

A label is a lookup, and it is not a filter. A counter with no entry in it is drawn under
its own name spaced out, so a bad word costs a reader a label and never a number. A
counter group holds numbers, and one level of map from a key to a number, which is how
the picker's refusals by reason are drawn: a group of its own, one row per reason, with
the reason as the leg wrote it. A string never reaches the page from a counter group,
whatever the field is called, because a string is where a secret lives and a counter is
not one.

**The core's counters are drawn beside the front leg's, under `Core`.** The group is
every counter the heartbeat's `metrics` group carries, in the order
`src/service/monoplayer.js` declares them, with its name-keyed maps drawn after the row
set, each under a heading of its own. It is where the process keeps what it has done
since it started, and
[telemetry.md](telemetry.md) defines its fields, except six it does not name yet
([#850](https://github.com/Bafbi/monoplayer/issues/850)). Until
[#833](https://github.com/Bafbi/monoplayer/issues/833) the panel projected eight groups
and not this one. Every core counter reached the pod log, the journal and OTLP and never
the card. The refused replay frame an operator went looking for was among them. It is the
group [#743](https://github.com/Bafbi/monoplayer/issues/743) left behind: `front` and
`sizes` were generalised to carry whatever the record holds, and the projection is the
same one, so a counter the service adds is a row here with no edit in the panel and none
in this page.

Its label lookup is the front group's rule with the core's own words: `frontKicks` reads
"clients kicked", because "front kicks" reads as though the front were the thing kicked,
and `noticeGhosts` reads "ghost states answered". Every other core counter is its own
name spaced out.

**Each name-keyed map is a group of its own.** `serverboundByName`,
`serverboundDroppedByName` and `clientboundBlockedByName` hold a count per name the
service counted: a packet name, or `transfer` for the transfer frame the proxy withholds.
Each map is one row per name under a heading named by the field, and the names are drawn
as the service wrote them. The picker's refusals by reason are drawn the same way. These
are the only rows in the group that can grow: a map is bounded by the packet vocabulary
the client speaks and by the cap the service counts names under (`MAX_NAMES` in
`src/service/monoplayer.js`), and every name in it is a row, because a count per name is
what the map is for. A map the record carries empty is drawn nowhere, which is a lane
that has counted no name yet.

**The core's counters are one row set, and not one heading per family.** This is the
card's longest row set, and it stays whole for a reason that outlives its length: every
way of shortening it spends a number. A heading per family does not shorten it by a line,
because the declaration already puts a family's counters beside each other, so a heading
would repeat the order rather than add to it. The families the declaration does split,
such as the transfers' and the notices', are the ones a heading table would have to
reorder, which is the second opinion about the record's order this page never takes. Such
a table is also a field list by another name: a counter the service adds lands in a group
nobody chose, and its number is then drawn in the wrong place. Nothing here is collapsed,
and nothing is hidden at zero. The stream replaces this region's `innerHTML` every five
seconds, so a row set the operator folded open would close under their hand, and a
cumulative counter at zero is the answer "this process has not done it", which a card
that dropped it would print as the same silence as a counter it had lost.

`Cache` is projected the same way and drawn as one row: `domains` joins whatever domains
the record holds, so a cache domain the panel has never heard of is still a number on
the page.

The two groups #415 added to the heartbeat are drawn beside the cache rows: one row
set per body and one per channel. [telemetry.md](telemetry.md) defines every field of
both, and the card's labels are its
own words for them. A lane older than #415 writes neither group, and the card then says
nothing about them rather than drawing a group of zeros. A group the record carries but
the card cannot read says nothing either, which is the other reason a row set is
missing. An empty group is its own
sentence: the process holds no body cache, or the front holds no channel open. A body
nobody claimed has no claim age, and a spectator holds none. A connection the lane
admitted itself names no body. Those rows say so in words instead of printing a zero
or a blank (#263 D2).

**The `Last attach` card draws the attach stream's two numbers side by side.** `replayed`
is the frames a socket took, and `refused` is the frames the front leg refused or threw
on. [telemetry.md](telemetry.md) defines both (#717, #735). Neither number is the total,
and the card never adds them. A refusal is not a fault: the card says what the gap is
instead of letting a reader take it for a lane to repair
([the ADR](adr/a-refused-replay-frame-is-not-retried.md)). A record written before the
field existed says it carries no refusal count. A record that carries neither count
draws no row.

`account.expiresAt` is projected from the custody cache at each heartbeat, so the
card's date is at most 30 s old. Inside seven days the card adds a warning
sentence. `null` means the custody cache does not say, which is not "no expiry".

`GET /api/puppets/<name>` serves the same facts as one JSON object, for an agent
that would rather not parse the page. A name the registry does not hold is a 404.

## The page updates itself, without a reload

A card has three parts, and the order is the contract:

| Part | What it holds | Does it change while the page is open? |
|---|---|---|
| the head | the name, and the registry rows: namespace, Deployment, front, control ConfigMap | no, and no tick touches it |
| the live region | the scene, the state sentence, and every number with the timestamp of its record | yes, replaced whole every 5 s |
| the actions | the attach whitelist's block and the allowed servers' block | no: a tick must not overwrite a half-typed name, and it must not disarm a remove button |

The live region is filled by `GET /api/puppets/<name>/stream`, server-sent events
([#248](https://github.com/Bafbi/monoplayer/issues/248)):

| Header | Why |
|---|---|
| `content-type: text/event-stream` | nothing buffers it as a document that has not finished |
| `cache-control: no-store` | a cached tick is a page that lies about when it was read |
| `x-accel-buffering: no` | a proxy in front of this must not wait for a buffer before forwarding |
| no `content-length` | the answer has no end until the client goes |
| no `content-encoding` | a compressor buffer is one more place a tick waits |

One fragment per tick, as `data:` lines. A comment line every 15 s is the heartbeat:
`EventSource` ignores it, and it keeps the socket alive through anything that closes a
quiet connection. The stream ends when the client closes, and nothing else ends it: a
puppet that stopped writing still gets a fragment every five seconds that says so.

A tick reads a Deployment, a pod list, a pod log, and the control ConfigMap's two keys,
`attach-whitelist.json` and `allowed-servers.json`. A puppet whose live
`allowed-servers.json` key is absent adds one read of its seed ConfigMap, which is the copy
that answers. The reads run together, so a tick waits for the slowest of them and not for
each in turn. A tick that finds the previous read still pending is **skipped** and logged as
`panelStreamTickSkipped`: a slow API server can outlast a tick, and overlapping reads
would answer out of order. A skipped tick costs one interval of freshness. An out-of-order
one costs trust in the page.

A stream that ends is logged as `panelStreamEnd`, with the puppet's name and the ticks
and beats it wrote. Both intervals are cleared before that record is written, so the
record is the point after which the stream starts no new read. A read a tick had already
started still finishes. A test waits on that record instead of on a clock, which is why
the order matters.

Both control lists travel in the same frame as an out-of-band swap, so each block
redraws with the card while the form beside it keeps what the operator typed. A failed
read is a sentence in that block, and the rest of the card still arrives.

The cadence is deliberately not a setting. The page says "every 5 s" in words, and a
Deployment detail behind that sentence is a sentence that can be wrong.

## The page's own files

Everything the browser loads is served by the panel from `src/panel/public/`, under
`/static/`. No CDN: a panel on a tailnet must not fetch its assets from the public
internet, and a page that breaks when a CDN is down is a page nobody can debug.

| File | What it is |
|---|---|
| `app.css` | compiled from `app.css.in` by `mise run panel:css`. The bundle is committed |
| `panel.js` | the one write the page makes: a JSON `fetch` per form |
| `vendor/htmx.min.js` | htmx 2.0.11, Zero-Clause BSD, licence beside it |
| `vendor/htmx-ext-sse.min.js` | its SSE extension, 2.2.4, Zero-Clause BSD, licence beside it |
| `fonts/VT323-Regular.ttf` | the pixel font, SIL Open Font License, `fonts/OFL.txt` beside it |

**No Mojang asset is in this repository.** The scene is three isometric blocks per
card, clipped out of a square by `clip-path` and textured with repeating gradients: a
grass top face and dirt sides, hard 2 px edges, no border-radius anywhere, and a
grass/dirt/stone palette. The top face of the puppet's block is the state, and the
scene is `aria-hidden` because a colour is not a fact: the sentence beside it says
which state the colour means, and every number stays in the lists with its record's
timestamp.

**The stylesheet is compiled, and the bundle is committed.** The image ships a
stylesheet and no compiler (`pnpm install --prod` drops the devDependencies):

```bash
mise run panel:css              # rewrite src/panel/public/app.css
mise run panel:css -- --check   # recompile and fail when the committed bundle is stale
```

`--check` is part of `mise run lint`, so a stale bundle is a red gate instead of a
silent drift. The comparison is byte for byte: Tailwind's output is deterministic for
a given input, so a difference is a bundle compiled from a different tree.

## What the panel can and cannot touch

It writes one object per puppet, and the registry names it. Everything else it
holds is a read.

| Object | Verbs | Where |
|---|---|---|
| the control ConfigMaps the registry names | `get`, `patch`, `update` | each puppet's namespace: two keys, `attach-whitelist.json` and `allowed-servers.json` |
| the seed ConfigMaps the registry names | `get` | each puppet's namespace: the `allowed-servers.json` copy Git commits, which answers when the live key cannot |
| `pods`, `pods/log` | `get`, `list` | each puppet's namespace |
| `deployments` | `get`, `list` | each puppet's namespace: the pod selector, the pods' readiness, and the caps its environment sets |

And, by design:

- **No `create`.** RBAC cannot scope a create by name, so a create grant on
  ConfigMaps would be a grant to invent any ConfigMap in that namespace. The
  control ConfigMap is created once, by you, below.
- **No `delete`.** The panel corrects a document; it never removes an object.
- **No `secrets`.** The custody volume and the GHCR pull secret are not its to
  read.
- **No wildcard resource, and no ClusterRole.** The Role lives in the namespace it
  grants on, and `test/tooling/panel-manifests.test.js` fails the gate when a
  `resourceNames` entry is not a `controlConfigMap` the registry names, when a rule
  grants `create`, `delete`, `secrets` or a wildcard, or when the Service stops
  being the tailscale class.

The page uses the three read rules and the `get` on the control ConfigMap. Four
routes exercise the write rule, and they patch one object: `attach-whitelist.json`
for the two attach whitelist writes, and `allowed-servers.json` for the two
allowed-server writes. Each patches its own key, and a merge patch of one key
leaves the other where it was.

The seed rule is `get` alone, and it exists because one key has a fallback. A
missing or unreadable attach whitelist denies every login, which is safe and loud. A
missing or unreadable server list offers a joining player nothing, so the list Git
commits answers instead. While the live key is absent the panel reads the same copy,
so it lists the servers the lane is offering rather than an empty list, and it builds
the first write on that copy rather than on nothing.
`test/tooling/panel-manifests.test.js` keeps the two `resourceNames` lists in step
with the registry in both directions.

## Add or remove an attach whitelist entry

The page does this, and so does `curl`. The block under each card lists the entries the
lane admits with the uuid and the time each was added, then the form that adds one:

- **one field, two shapes.** A uuid is sent as `{"uuid": "..."}` and anything else as
  `{"name": "..."}`. A name the panel cannot resolve comes back as a 400 asking for the
  uuid, and the block prints that as an instruction rather than as a failure: it is
  something to do next, not a rejection. A uuid comes back as a 400 when no Mojang
  session could answer for it, which is any version but 4.
- **removing asks twice.** The first press arms the button and sends nothing. The second
  sends the `DELETE`. An arm nobody uses disarms itself after ten seconds, because a
  control that deletes on a stray tap is not one to put on a page a phone opens. The arm
  is held by the page, not by the button: the stream replaces the list, so a confirmation
  stored in the DOM would be lost between the two presses and the second one would only
  arm it again. The page paints the confirmation back onto the button a redraw replaced,
  keyed by the entry's uuid, and the test of that is a press, a tick, and a second press.
- **a conflict is never a success.** A 409 is printed as the refusal it is, in the
  route's own words, and the list keeps showing the version that was read.
- **the list refreshes through the stream**, not through a reload: the entries are part
  of the tick as an out-of-band swap, and a row appears or goes within five seconds of
  the write.
- **the answers sit outside the list**, one area per block, because a refusal printed in
  a row would be taken away with the row it was about. The instant the list was read and
  the ConfigMap's version are in the card's footer, which is rewritten every tick: a
  clock inside the list would be the time of the last change, and a reader would take it
  for the time of the read.

```bash
curl http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist
curl -X POST http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist \
  -H 'content-type: application/json' -d '{"uuid": "6eb73524-ff88-4a62-a8d0-c63905e7afba"}'
curl -X POST http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist \
  -H 'content-type: application/json' -d '{"name": "Bafbi"}'
curl -X DELETE http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/whitelist/6eb73524-ff88-4a62-a8d0-c63905e7afba
```

That rewrites one key of the control ConfigMap, `attach-whitelist.json`, and
nothing else. The document is the shape the puppet already reads, so no second
shape exists:

```json
{
  "version": 1,
  "players": [
    { "uuid": "6eb73524-ff88-4a62-a8d0-c63905e7afba", "name": "Bafbi", "addedAt": "2026-11-07T13:04:51.092Z" }
  ]
}
```

The body must be sent as `application/json`, and that requirement is the guard
against a cross-site write: a browser has to preflight it, and the panel answers no
preflight. A form body is refused rather than parsed.

| Answer | Meaning |
|---|---|
| 200 | written, or already the document you asked for |
| 400 | a body that is not JSON, neither a uuid nor a name, both at once, a uuid that is not one, a uuid no Mojang session can answer for, a name the resolver could not answer, or a path segment that is not valid percent-encoding |
| 404 | no such puppet in the registry, or no such uuid in the attach whitelist |
| 405 | a verb this route does not take, with `allow` naming the ones it does |
| 409 | the uuid is the puppet's own account, or the write lost three races |
| 413 | a body over 4 KiB |
| 500 | the registry could not be read, or the attach whitelist document could not be parsed |
| 503 | no cluster client, the cluster refused the read or the patch, or the Deployment names no `MONOPLAYER_PUPPET_UUID` to check the entry against |

**A change takes effect on the next login with no restart and no deploy.** The
puppet re-reads the file at each login (#229), so it is one file read away. A client
already mid-login may be picked up on the following attempt.

Five refusals are deliberate, and each one is a refusal rather than a repair:

- **A document that does not parse is never rewritten.** The answer is a 500 with the
  parse error, and the key is left byte for byte. The same holds for a document of
  the wrong shape, an entry whose uuid is not one, a field that is not the type the
  shape gives it, and a `version` this panel does not write.
- **A lost race is re-read, not clobbered.** The patch carries the
  `resourceVersion` it read, so the API server answers 409 when somebody else wrote
  the document in between. The panel patches at most three times, each attempt over a
  fresh read, so at most two re-reads. Then it reports the conflict by name. The
  other writer's entry survives, because the second attempt applies your change to
  the document they left.
- **The puppet's own uuid is refused** with a 409. The uuid is the one the puppet's
  Deployment sets in `MONOPLAYER_PUPPET_UUID`, and it appears in neither the answer
  nor the log line: it is the puppet's account identifier, not the caller's. A
  Deployment that names no uuid gets a 503 instead, because the check cannot run and
  the panel does not skip a rule it cannot apply.
- **A uuid no Mojang session can answer for is refused** with a 400 (#704). A name is
  resolved through Mojang, so a name that is not an account is refused already. A uuid
  skipped that resolver, so any 32 hex digits of the right shape were written. A uuid
  Java derived from a name, which is `md5("OfflinePlayer:<name>")`, is exactly that
  shape. The dev lane carried one until #677 removed it, and it admits nobody while it
  reads like a controller. Both paths ask `uuidRefusalReason` in `src/custody/util.js`
  now. **The version is necessary and not sufficient.** The panel does not ask Mojang
  about a supplied uuid, so a mistyped version-4 uuid is still written, and only the
  login tells the two apart. An entry already in the document is left where it is,
  because this route rewrites nothing it did not author. Remove one with a DELETE.
- **Removal takes a uuid**, so renaming an account cannot remove a different one. A
  uuid that is not in the list is a 404, and nothing is written.

`{"name": "..."}` is resolved through `createNameLookup` from
`src/custody/store.js`: Minecraft services first, then the legacy Mojang API. That
needs egress from the panel namespace. When the endpoints answer nothing, the route
says so and asks for the uuid rather than writing nothing and reporting success. A
name that does not exist is a 400 that names it.

Every write leaves one JSONL line on the panel's own log, because the ConfigMap keeps
no history:

```json
{"t":"2026-11-18T10:00:00.000Z","event":"panelWhitelistAdd","puppet":"glowsquidye","namespace":"monoplayer","controlConfigMap":"monoplayer-control","key":"attach-whitelist.json","uuid":"6eb73524-ff88-4a62-a8d0-c63905e7afba","name":"Bafbi","count":2,"changed":true,"attempts":1,"address":"100.64.0.9"}
```

`panelWhitelistRemove` is its twin. The address is the tailnet peer, which is the
only actor the panel can name.

The control ConfigMap is not in Git, so the 200 also carries the `data:` block of
`deploy/manifests/configmap.yaml` to paste, under `yaml` and `pasteInto`. Replace
that file's `data` block with it when a change should survive the next deploy.
Then delete the ConfigMap the panel patched, because the two copies now disagree.

**The write lands in a document the lane reads, and only while its variable names
that file.** A puppet reads this key only when `MONOPLAYER_ATTACH_WHITELIST` names it,
and `deploy/manifests/deployment.yaml` names `/control/attach-whitelist.json`, the
copy the panel patches. So a write is read at the next login. A lane whose variable
names another file — `/config/attach-whitelist.json`, the ConfigMap in Git, which is
the file the whitelist shipped as before #229 — reads none of it, and its 200 means
"written", not "read". Check it before you trust an answer:

```bash
kubectl -n monoplayer get deployment monoplayer \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="MONOPLAYER_ATTACH_WHITELIST")].value}'
```

## Add or remove an allowed server

An allowed server is one game server the picker offers a joining player
([GLOSSARY.md](../GLOSSARY.md)). The list is a key of the same control
ConfigMap, `allowed-servers.json`, and it is its own file: its own environment
variable, its own reader, and its own route.

The page does this, and so does `curl`. The allowed servers' block sits under each card,
beside the attach whitelist's, and it is the same block: the servers with the time each
was added, then the form that adds one.

- **one field, two fields.** The list, the removal's path, and a picker row all name a
  server by its `host:port` address, so the form asks for that one name and the page splits
  it into the `host` and `port` the route takes. A value the route refuses comes back in
  the route's own sentence, behind the value that was sent: the sentence names the rules for
  a host and a port, and an address it could not parse is not one it can name.
- **removing asks twice.** The first press arms the button and sends nothing, the second
  sends the `DELETE`, and an arm nobody uses disarms after ten seconds. The arm is held by
  the page, keyed by the card and the row, because a tick replaces the row it sits in and one
  address can be listed by two puppets.
- **the list refreshes through the stream**, as an out-of-band swap: a server appears or
  goes within five seconds of the write, without a reload.
- **the answers sit outside the list**, one area per block, and a refusal is printed whole,
  in the route's words. A 404 names the address it did not find, and the block prints it.
- **the block says which file answered.** While the live key is absent the lane offers the
  copy Git commits, so the list names that ConfigMap and says the next write is built on it.
  That sentence sits in the list, where a phone shows it, and it goes away once the live key
  exists.

```bash
curl http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/allowed-servers
curl -X POST http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/allowed-servers \
  -H 'content-type: application/json' -d '{"host": "paper.example.net", "port": 25565}'
curl -X DELETE http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/allowed-servers/paper.example.net:25565
```

The removal takes the `host:port` address the row is called, so a host rename cannot
remove a different server. The document is:

```json
{
  "version": 1,
  "servers": [
    { "host": "paper.example.net", "port": 25565, "addedAt": "2026-11-23T12:00:00.000Z" }
  ]
}
```

A host is a hostname of at least two labels or an IPv4 address, with every octet
between 0 and 255: no scheme, no port inside the host, no trailing dot, no bare single
label. A port is an integer from 1 to 65535. A body that sends `"25565"` as text is
refused rather than coerced, so the file the lane reads never holds a port as a
string.

Those rules are what the route accepts on a **write**. A document already in the
ConfigMap is read as written: the lane dials what the operator put there, so a host no
dial reaches fails at the socket under its own name instead of taking the whole list
down at boot, and the panel lists such an entry instead of refusing to show a document
it could then not repair. Only the document's shape is refused on a read, never the
reachability of one host in it.

| Answer | Meaning |
|---|---|
| 200 | written, or already the document you asked for |
| 400 | a body that is not JSON or does not declare itself JSON, an address a dial cannot target, or a path segment that is not `host:port` or not valid percent-encoding |
| 404 | no such puppet in the registry, or no such address in the list |
| 405 | a verb this route does not take, with `allow` naming the ones it does |
| 409 | the write lost three races |
| 413 | a body over 4 KiB |
| 500 | the registry could not be read, or the live or seed document could not be parsed |
| 503 | no cluster client, the cluster refused the read or the patch, or the seed ConfigMap could not be read |

**This key has a fallback, and the other two do not.** A missing or unreadable
attach whitelist denies every login: safe, and loud. A missing or unreadable server
list offers a joining player nothing, so **the lane** offers the copy Git commits
instead. Two consequences follow, and both are visible in the answers:

- **`GET` says which file answered.** `source` is `control` for the live key and
  `seed` for `deploy/manifests/configmap.yaml`, which the lane mounts at `/config` and
  `MONOPLAYER_ALLOWED_SERVERS_SEED` names. `none` means neither file holds a list.
- **The first write is built on the seed.** Adding a server while the live key is
  **absent** writes the seed's entries and the new one, because the lane is offering
  the seed and a write that started from an empty document would silently stop
  offering every committed server.

The panel falls back on an absent key and refuses on a broken one, and that is
deliberate: a live key that exists and does not parse is a 500 that names the file, not
a list of the seed. Showing the seed there would hide the file that needs fixing behind
an answer that looks normal, and every write would refuse anyway. The lane keeps serving
the seed while that file is broken, so the operator has one file to repair and no
outage.

Four rules are deliberate, and each is a decision rather than an accident:

- **A document that does not parse is never rewritten.** The answer is a 500 with the
  refusal, and the key is left byte for byte. That holds for the live key and for the
  seed, and the seed's refusal names the seed object so the operator knows which file
  to fix.
- **A lost race is re-read, not clobbered.** The patch carries the
  `resourceVersion` it read, and the panel patches at most three times, each attempt
  over a fresh read, before it reports the conflict by name. The other writer's
  entries survive.
- **The seed is read and never written.** The panel's Role grants `get` on it and
  nothing else, because that object is Argo's: a write to it would be reverted by the
  next sync, which is the same reason the control ConfigMap is not in Git.
- **Nothing here stops a session.** This route writes one key of one ConfigMap.
  Removing a server stops it being offered, and a body already running on it is left
  alone until its claim ends.

**A write is stored, and whether a client is offered it depends on one switch.** The
picker landed in #265 behind `MONOPLAYER_PICKER`, and it reads this list at each offer, so
a write reaches a joining player's next attempt on a lane that sets it. Both lanes this
repo deploys set it since #579, so a write reaches a player on either. The route's answer
still says that in `takesEffect`, in the sentence #262 settled, and the block says it too:
a lane whose `MONOPLAYER_PICKER` is off offers nothing. The start record reports the key,
inside its `control` object:

```json
"allowedServers": {
  "file": "/control/allowed-servers.json",
  "seed": "/config/allowed-servers.json",
  "source": "seed",
  "count": 1
}
```

Every write leaves one JSONL line on the panel's log, because the ConfigMap keeps no
history:

```json
{"t":"2026-11-23T12:00:00.000Z","event":"panelAllowedServerAdd","puppet":"glowsquidye","namespace":"monoplayer","controlConfigMap":"monoplayer-control","key":"allowed-servers.json","server":"paper.example.net:25565","source":"seed","count":2,"changed":true,"attempts":1,"address":"100.64.0.9"}
```

`panelAllowedServerRemove` is its twin. The address is the tailnet peer, which is the
only actor the panel can name.

The live key is not in Git, so the 200 also carries a `data:` block holding this one
key, under `yaml`, with `pasteInto` naming `deploy/manifests/configmap.yaml`. Replace
that file's `allowed-servers.json` key with it when a change should survive the next
deploy: the seed is what an unedited lane offers, and what a first write is built on.

## It ships with the proxy

The panel is not a second Argo CD Application. One Application syncs
`deploy/kustomization.yaml`, which includes `deploy/manifests` (the proxy) and
`deploy/panel` (this panel). Merging to `main` deploys both, and the operator
runs no bootstrap command for the panel. A second Application would mean two
deploys, two rollbacks, and two places a tree can drift.

So the panel arrives on the next sync after the merge, in the same `deploy`
revision the proxy runs, with `prune` and `selfHeal` on.

Argo applies before it prunes within that sync, so the panel's pod is created while
the old namespace is still there. It does not wait for the pod to be Ready before
the old objects go, so watch the sync: `Deployment/panel` Ready in `monoplayer` is
the thing to confirm, and a pod that would not start is worth seeing before the
objects it replaced are gone.

It runs in `monoplayer` (#609), so its pod pulls with the proxy's own `ghcr-pull`
Secret, which [deployment.md](deployment.md) step 3 creates.

The panel had a namespace of its own until then, and that namespace bought no
separation. Its Role and its RoleBinding were always the proxy's, so its
ServiceAccount reached the control ConfigMap from outside the namespace it lived
in either way. All the second namespace added was a second copy of that Secret.

**The tailnet name survives the move. The device's address does not.** The name is
what a human types, and it comes from `tailscale.com/hostname: monoplayer`, so it
is the same name in either namespace. The address Tailscale gives the device is
new. One thing to check after the merge: if the panel's device is named
`monoplayer-1`, Tailscale had not released the old one when the new Service
registered. [testbed-transfer.md](testbed-transfer.md#verifying-a-cycle) records that
suffix happening to the testbed's front for the same reason. If the page stops
answering at `http://monoplayer.tail41e568.ts.net`, the panel is up and its device
is suffixed. The release is on the operator's clock, so wait until `monoplayer` is
gone from `tailscale status` first: a Service recreated while the old device still
holds the name takes the suffix again. Then delete it and let `selfHeal` put it
back, which reclaims the name while it is free:

```bash
kubectl -n monoplayer delete svc panel
```

One prerequisite is not in Git, and it is one command:

1. **The control ConfigMap, once per puppet.** Not in Git, and never in Git:
   Argo's `selfHeal` would revert a tracked object to its committed content within
   minutes of the first panel write. Create it yourself, for the single puppet the
   registry names, **before the Deployment that mounts it rolls**:

   ```bash
   kubectl create configmap monoplayer-control -n monoplayer \
     --from-file=attach-whitelist.json
   ```

   The whitelist's current content is `deploy/manifests/configmap.yaml`, so copy
   `attach-whitelist.json` out of it rather than retyping it.

   **Do not seed `allowed-servers.json` either.** That key has a fallback the
   whitelist does not: the lane offers the copy Git commits, mounted at `/config`,
   while the live key is absent, and the panel's first write is built on that copy.
   An empty live key would be a second list to keep in step for nothing.

   **The order matters.** The Deployment mounts this object at `/control` with
   `optional: true`, so a missing object does not keep the pod from starting — it
   starts and denies every login, because its whitelist is the file that is not
   there. Create the object first, then let the rollout read it.

   Creating the object once is the whole cost of `create` being out of reach: after
   that the panel only patches it.

## Change the registry

The registry is `deploy/panel/registry.yaml`: a ConfigMap whose `puppets.json` key
names, per puppet, its `name`, `namespace`, `deployment`, `controlConfigMap`,
`seedConfigMap`, `frontHostname` and `backend`. Edit it on
`main` and merge.

`controlConfigMap` is the object the panel writes. `seedConfigMap` is the object it
reads and never writes: the copy Git commits, which answers when the live
`allowed-servers.json` key is absent. `deploy/panel/role.yaml` grants `get`, `patch`
and `update` on the first and `get` alone on the second, and
`test/tooling/panel-manifests.test.js` fails the gate when either list disagrees with
this document.

The pod mounts the ConfigMap and reads the file on every request, so an edit
reaches the page within a minute of the kubelet rewriting the projection. No
restart is needed, and none is wanted: a missing restart is invisible, and a
restart on every registry change would make the page's freshness a deployment
detail.

`src/panel/registry.js` refuses a document it cannot act on, and the panel fails
its start with the field that broke it — a misspelled key, a name that is not a DNS
label, a backend with no port, two puppets writing one ConfigMap, or a
`seedConfigMap` that names the object the panel writes. A document that
passes is a document the panel will act on.

Adding a puppet in a new namespace means four things, and the gate enforces the
first three: a registry row in this file, a `Role` and a `RoleBinding` in that
namespace, a destination entry for the namespace in `deploy/argocd/project.yaml`,
and, for a manifest tree the root does not include yet, a line in
`deploy/kustomization.yaml`.

A puppet in a second namespace is the one case where the binding crosses one: its
Role grants on the namespace it lives in, and its subject stays the panel's
ServiceAccount in `monoplayer`, wherever the panel runs. The subject names that
namespace, and `test/tooling/panel-manifests.test.js` fails when it names another.

## Roll it back

The panel is not an Argo object of its own, so there is nothing to delete with
`kubectl`. Take it out of the tree and let Argo prune it:

```yaml
# deploy/kustomization.yaml
resources:
  - manifests
  # - panel
```

Merge that, and the next sync prunes the panel's objects. The namespace stays,
because it is the proxy's: same Application, same revision, one directory fewer.

The control ConfigMap survives. Argo never created it and it carries no tracking
annotation, so nothing prunes it, and the puppet keeps the document it was reading.
Delete it by hand only if you mean to lose the whitelist it holds.

To stop the panel temporarily, the same one-line change is the durable way:
`selfHeal` puts a replica back within about three minutes of a manual scale to
zero. The difference matters. Scaling to zero leaves the Service, so the tailnet
name still resolves and refuses; removing the tree removes the name with it.

## Check it

```bash
curl http://monoplayer.tail41e568.ts.net/healthz             # {"ok":true}
curl http://monoplayer.tail41e568.ts.net/api/puppets         # the registry
curl http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye
curl -N http://monoplayer.tail41e568.ts.net/api/puppets/glowsquidye/stream
```

The third is one puppet's facts, the same object the card is rendered from. The fourth
is the same card body, once every five seconds, as `data:` lines. `-N` is what stops
`curl` from holding them until its buffer fills.

`/healthz` never reads the registry, so it answers while the document is broken and
all three content routes return 500 with the reason. The first log line of the pod
says what the panel read:

```json
{"t":"2026-11-17T22:41:07.512Z","event":"panelStart","registry":"/etc/panel/registry/puppets.json","puppets":1,"port":8080,"serviceAccountToken":true}
```

`serviceAccountToken` is whether a token is mounted, never the token. A panel with
`false` serves the page and would fail its first write, which is worth seeing before
the write route exists.

To see the page without a cluster, run it from a checkout against the registry this
repository ships:

```bash
mise run panel:run    # http://127.0.0.1:8080
```

It reads `deploy/panel/registry.yaml` through the same parser the pod uses, so a
registry edit is visible here before it is merged.

A panel run from a checkout has no ServiceAccount token, so every card reads
`read refused: no service account token at
/var/run/secrets/kubernetes.io/serviceaccount/token: …` and the registry facts are
still on it. That sentence is the point: a panel that cannot read the cluster
names the read that failed instead of showing a spinner.

## Review the page before it is merged

A branch has to be reviewable before it is merged, and a screenshot of a page that
reads a cluster nobody can reach proves nothing. Fixture mode serves a recorded
document instead:

```bash
mise run panel:fixture                      # test/panel/fixtures/panel.json
node src/panel/start.js --fixture <file> --host 127.0.0.1 --port 8080
```

The document is a registry's puppets, the facts each one answered, and both control keys:

```json
{
  "version": 1,
  "puppets": ["...the registry rows, exactly as the registry validates them..."],
  "facts": { "<name>": "...what GET /api/puppets/<name> answered..." },
  "whitelist": { "<name>": { "resourceVersion": "41221", "puppetUuid": "…", "document": { "version": 1, "players": [] } } },
  "allowed": { "<name>": { "document": { "version": 1, "servers": [] },
                           "seed": { "version": 1, "servers": [] } } }
}
```

`document` is the live key in the control ConfigMap and `seed` is the copy Git commits,
which answers when the live key is absent. A record names at least one of the two, and both
when the recording should show which file answered. That record holds no
`resourceVersion`, because a version belongs to the ConfigMap and not to a key. The
whitelist record names the object's version, and both keys are read from that one object.

`src/panel/fixture.js` validates it: the puppets go through the registry's own parser, the
whitelist document through the whitelist route's, and the allowed servers through the lane's
own reader. A puppet with no recorded document, a record whose `name` disagrees, a fact
without a state sentence, a control key with no recording, or an unknown field is refused
by name.

The committed fixture holds the states worth looking at: a puppet with a heartbeat and one
with none, an attach whitelist with two entries and one with none, allowed servers with two,
and a puppet whose live key is absent so the copy Git commits answers, with nothing in it.

A fixture's cluster is the recording, so each block reads its recorded document through the
same reader a pod uses, and a name resolves to nothing: the whitelist route then answers the
400 that asks for the uuid, which is the instruction the block has to render. Every write is
refused by name ("fixture mode is a recording, so no document was written"), and an entry or
a server the recording already holds answers 200 with `changed: false`, exactly as it does
against a cluster.

**It refuses to start when the in-cluster ServiceAccount token is mounted**, and that
check runs before the socket exists. A fixture is a development aid. A pod that served
one would be a panel showing a recording while the lane it describes runs on.

The file is re-read on every request, like the registry. That is also how the stream is
shown to update: rewrite the file, wait one tick, and the open page shows the new
numbers without a reload.

The page says it is a recording, above the title. A screenshot of a branch served from a
fixture must not read like a lane that is running, and neither the start line nor a
refused write is on the page.

## The image, and one known skew

The panel runs `ghcr.io/bafbi/monoplayer:main` — the same image as the proxy,
started as `node src/panel/start.js`. No second Dockerfile and no second build:
`.dockerignore` ships `src/` except the rungs, so `src/panel/` is in the image.

`.github/workflows/image.yaml` appends its digest pin to
`deploy/panel/kustomization.yaml` in the same commit it pins the proxy (#234). On
the `deploy` branch both trees therefore run one pinned build, and the two can
never be a build apart. On `main` neither carries a pin.

That is not cosmetic. Before #234 the panel ran the moving `main` tag with
`imagePullPolicy: IfNotPresent`, so a node that had cached the tag kept running a
build the checkout did not contain: the pod crashlooped on a module its image
never shipped, and the manifest looked correct.
