#!/usr/bin/env bash
# The dev validation lane (#42): bring it up, take it down, report on it, and run
# a branch image on it (#43).
#
#   scripts/dev-lane.sh up        apply the dev lane and wait for the backends
#   scripts/dev-lane.sh down [--purge]
#                                 stop the dev lane, keeping the dev account;
#                                 --purge removes the account too
#   scripts/dev-lane.sh status    what is running, and what the live lane runs
#   scripts/dev-lane.sh image TAG the image reference the dev lane should run
#   scripts/dev-lane.sh set-image TAG
#                                 put that image on the dev proxy (#43)
#   scripts/dev-lane.sh join      report whether the dev proxy's puppet is on the
#                                 dev Paper (#43)
#   scripts/dev-lane.sh pull-secret
#                                 create the dev ghcr-pull Secret if it is missing
#
# What this lane is for: validating a branch without taking the live front down.
# The live lane holds one writer and one replica of the puppet custody, so a test
# that mounted it would race the token chain. This lane has its own Paper, its own
# Monoplayer, its own custody volume, and its own account, which
# scripts/dev-custody.sh bootstraps (#44).
#
# What it never does: scale, patch, restart, or delete anything in the live
# namespace. `status` reads the live replica count so that claim is checkable
# rather than asserted. The lane is not registered in Argo CD, so nothing applied
# here can roll out to the live lane. Reading a Secret or a ConfigMap from the live
# namespace to seed its dev twin is the one live read, and it writes nothing.
#
# Environment:
#   MONOPLAYER_DEV_NAMESPACE    the dev namespace        (default monoplayer-dev)
#   MONOPLAYER_CLUSTER_NAMESPACE live namespace          (default monoplayer)
#   MONOPLAYER_LIVE_DEPLOYMENT  live deployment to read  (default monoplayer)
#   MONOPLAYER_DEV_READY_TIMEOUT  wait for Paper         (default 600s)
#   MONOPLAYER_DEV_JOIN_TIMEOUT   wait for the join      (default 60s)
#
# Exit codes: 0 done, 1 the lane did not come up or the join failed, 2 setup refused.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV_NAMESPACE=${MONOPLAYER_DEV_NAMESPACE:-monoplayer-dev}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
LIVE_DEPLOYMENT=${MONOPLAYER_LIVE_DEPLOYMENT:-monoplayer}
READY_TIMEOUT=${MONOPLAYER_DEV_READY_TIMEOUT:-600s}
JOIN_TIMEOUT=${MONOPLAYER_DEV_JOIN_TIMEOUT:-60}
IMAGE_REPO=ghcr.io/bafbi/monoplayer
LIVE_REPORT=${MONOPLAYER_DEV_REPORT:-.reports/dev-lane.json}
JOIN_REPORT=${MONOPLAYER_DEV_JOIN_REPORT:-.reports/dev-join.json}

die() { printf 'dev-lane: %s\n' "$1" >&2; exit "${2:-2}"; }
say() { printf 'dev-lane: %s\n' "$1"; }

command -v kubectl >/dev/null || die 'kubectl is not on PATH'

# The dev namespace is the only one this script may write to. A typo in an
# environment variable would otherwise aim a delete at the live lane.
guard() {
  # `monoplayer` is banned even when the live namespace variable is overridden,
  # so no environment can aim this script at the live lane.
  if [ -z "$DEV_NAMESPACE" ] || [ "$DEV_NAMESPACE" = "$LIVE_NAMESPACE" ] || [ "$DEV_NAMESPACE" = monoplayer ]; then
    die "refusing \"$DEV_NAMESPACE\" as the dev namespace: it is the live namespace ($LIVE_NAMESPACE)" 2
  fi
}

ensure_namespace() {
  if kubectl get namespace "$DEV_NAMESPACE" >/dev/null 2>&1; then
    return 0
  fi
  kubectl create namespace "$DEV_NAMESPACE" --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null
  say "created namespace $DEV_NAMESPACE"
}

# Paper cannot start without the RCON Secret, and a Secret value never belongs in
# a manifest. Create it once, randomly, and leave it alone afterwards.
ensure_rcon_secret() {
  if kubectl -n "$DEV_NAMESPACE" get secret dev-rcon >/dev/null 2>&1; then
    say 'the dev-rcon Secret exists'
    return 0
  fi
  ensure_namespace
  kubectl -n "$DEV_NAMESPACE" create secret generic dev-rcon \
    --from-literal=password="$(openssl rand -hex 16)" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
  say 'created the dev-rcon Secret'
}

# The GHCR package is private (docs/deployment.md, "One-time cluster bootstrap",
# step 3), so the dev proxy cannot pull without this Secret. The live lane already
# holds a working credential for the same package, so copy it rather than ask for a
# second token. Reading the live Secret is a read: nothing here writes to the live
# namespace.
ensure_pull_secret() {
  if kubectl -n "$DEV_NAMESPACE" get secret ghcr-pull >/dev/null 2>&1; then
    say 'the ghcr-pull Secret exists'
    return 0
  fi
  ensure_namespace
  if kubectl -n "$LIVE_NAMESPACE" get secret ghcr-pull -o json 2>/dev/null \
    | DEV_NAMESPACE="$DEV_NAMESPACE" node -e '
let raw = ""
process.stdin.on("data", chunk => { raw += chunk })
process.stdin.on("end", () => {
  const source = JSON.parse(raw)
  if (!source.data || !source.type) {
    process.stderr.write("the live ghcr-pull Secret carries no data\n")
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "ghcr-pull", namespace: process.env.DEV_NAMESPACE },
    type: source.type,
    data: source.data
  }))
})
' \
    | kubectl apply -f - >/dev/null 2>&1; then
    say "copied the ghcr-pull Secret from $LIVE_NAMESPACE"
    return 0
  fi
  die "no ghcr-pull Secret in $DEV_NAMESPACE and none to copy from $LIVE_NAMESPACE; create one with a read:packages token (docs/deployment.md step 3)"
}

# An empty attach whitelist denies every login. `--start` still starts on one: it
# logs `whitelistEmpty` and carries on, because a control lane may come up empty and
# be filled afterwards (src/service/start-live.js). This lane has no panel, so
# `dev:up` is the only command in the tree that writes the key.
#
# `kubectl apply -k` writes the empty document below, so the apply resets this key on
# every run. `up` reads the list before that, and `converge_attach_whitelist` puts
# back what the lane held (#393).
#
# $3 says what an absent ConfigMap means: `ok` is a lane nothing has created yet,
# `fault` a read that was supposed to answer. Every other failure is a fault either
# way: answering "empty" to it is how the entries this lane keeps would be lost.
read_attach_whitelist() {
  local namespace=$1 name=$2 absent=$3 answer reason
  # stderr stays out of the value: kubectl warns on stderr for reads that succeed,
  # and a warning written into the document is a whitelist no login can parse.
  if ! answer=$(kubectl -n "$namespace" get configmap "$name" \
      -o jsonpath='{.data.attach-whitelist\.json}' 2>/dev/null); then
    # The reason is read on its own, and only now, so it is the object's answer and
    # not part of the document.
    reason=$(kubectl -n "$namespace" get configmap "$name" 2>&1 >/dev/null) || true
    case "$reason" in
      *NotFound*) [ "$absent" = fault ] || return 0 ;;
    esac
    printf 'dev-lane: cannot read the attach whitelist from %s/%s: %s\n' \
      "$namespace" "$name" "${reason:-the read returned nothing}" >&2
    return 1
  fi
  printf '%s' "$answer"
}

# The document without the whitespace between its keys, for comparing shapes only.
# A ConfigMap in a manifest is pretty-printed, and `"players": []` is not
# `"players":[]`. Nothing is ever written back compacted, so entries keep their shape.
compact_whitelist() { printf '%s' "$1" | tr -d ' \n'; }

# `"players": []` and no document at all are the two shapes of an empty list.
whitelist_is_empty() {
  case "$(compact_whitelist "$1")" in
    *'"players":[]'*|'') return 0 ;;
  esac
  return 1
}

# An entry the lane can never admit: the dev front verifies every login against Mojang
# (deploy/dev/monoplayer.yaml composes no offline legs), and no Mojang account holds a
# UUID derived from a name. That is Java's nameUUIDFromBytes: `md5("OfflinePlayer:<name>")`
# with the version nibble set to 3 (src/legs/offline-identity.js), and Mojang issues
# version 4, so version is the whole test and the name-derived one is a case of it. The
# loopback rig builds its own controller list from exactly those UUIDs
# (`pickerWhitelist`, src/ladder/loopback.js), which is how the shape reaches a lane
# somebody hand-edited: a rig name in a control document is a controller that admits
# nobody, and a count of entries cannot see it (#677).
#
# What a version-4 UUID is: necessary. A mistyped version-4 UUID is still unusable, and
# answering that needs Mojang, which this command never asks. So a line here says the
# shape can be answered for, not that the account behind it exists.
#
# One program, because reading this document has one home and three callers. `report`
# prints a verdict per entry, which is what `status` shows. `prune` writes the document
# back without the entries that cannot attach, naming each one it dropped on stderr, and
# hands back the document it was given when nothing had to go, so an entry keeps the
# shape it was written with. `names` lists who a document carries, for the message that
# says which list an apply replaced. `up` is the writer, so `up` removes them.
whitelist_judgement() {
  cat <<'NODE'
const { offlineUuid } = await import(process.env.ROOT + '/src/legs/offline-identity.js')
// `node -e` hands the extra words in argv[1..], with no script path in front of them.
const [mode, document] = process.argv.slice(1)

const label = player => (typeof player?.name === 'string' && player.name !== '' ? player.name : '(no name)')
const uuidOf = player => String(player?.uuid ?? '')

// A UUID's version is the thirteenth hex digit, and both spellings the repo's parser
// accepts have to be read the same way: an entry written without dashes is a login the
// custody store already takes (src/custody/util.js, normalizeUuid).
const hex = player => uuidOf(player).toLowerCase().replace(/-/g, '')

// Why no Mojang session can answer for this entry, or null when nothing about its shape
// stops it. The name is read first, so the line can name the string that was hashed; the
// version then answers the entry whose name was edited after it was made.
function refusal (player) {
  const digits = hex(player)
  const name = typeof player?.name === 'string' && player.name !== '' ? player.name : null
  if (!/^[0-9a-f]{32}$/.test(digits)) {
    return 'it is not a uuid, so no login can match it'
  }
  if (name !== null && offlineUuid(name).toLowerCase().replace(/-/g, '') === digits) {
    return 'its uuid is md5("OfflinePlayer:' + name + '"), so no Mojang session answers for it'
  }
  if (digits.charAt(12) !== '4') {
    return 'a version-' + digits.charAt(12) + ' uuid is not one Mojang issues, so no Mojang session answers for it'
  }
  return null
}

// A document this program could not read is said out loud: answering "no entries" to it
// is how a broken control document reads as a lane with nothing to fix.
let players = []
let unreadable = false
try {
  const parsed = JSON.parse(document ?? '')
  if (!Array.isArray(parsed.players)) throw new TypeError('no player array')
  players = parsed.players
} catch {
  unreadable = true
}

// One judgement per entry, computed once, so a mode cannot answer twice from two reads
// of the same document.
const judged = players.map(player => ({ player, why: unreadable ? null : refusal(player) }))

if (mode === 'prune') {
  const dropped = judged.filter(entry => entry.why !== null)
  if (dropped.length === 0) {
    process.stdout.write(document)
  } else {
    for (const { player, why } of dropped) {
      process.stderr.write('dev-lane: dropped ' + label(player) + ' ' + uuidOf(player) +
        ' from the attach whitelist: ' + why + '\n')
    }
    process.stdout.write(JSON.stringify({
      ...JSON.parse(document),
      players: judged.filter(entry => entry.why === null).map(entry => entry.player)
    }))
  }
} else if (mode === 'names') {
  process.stdout.write(players.map(player => player.name ?? player.uuid ?? 'unnamed').join(', '))
} else if (unreadable) {
  process.stdout.write('attach whitelist could not be read as a document, so nothing here says who can attach\n')
} else if (players.length === 0) {
  process.stdout.write('attach whitelist is empty: nobody can attach yet\n')
} else {
  // Every mode the script sends is named above, and the last one is the report: a status
  // command that reaches this branch has to answer something.
  const usable = judged.filter(entry => entry.why === null).length
  const plural = players.length === 1 ? 'entry' : 'entries'
  const summary = usable === players.length
    ? 'attach whitelist names ' + players.length + ' ' + plural + (players.length === 1 ? ', and it can authenticate' : ', and every one of them can authenticate')
    : usable === 0
      ? 'attach whitelist names ' + players.length + ' ' + plural + ', and none of them can authenticate'
      : 'attach whitelist names ' + players.length + ' ' + plural + ', ' + usable + ' of which can authenticate'
  const lines = [summary]
  for (const { player, why } of judged) {
    lines.push(why === null
      ? '  ' + label(player) + ' ' + uuidOf(player) + ' can authenticate'
      : '  ' + label(player) + ' ' + uuidOf(player) + ' cannot authenticate: ' + why + '. Remove the entry')
  }
  process.stdout.write(lines.join('\n') + '\n')
}
NODE
}

# The one call, so the three answers differ only in the word they send.
whitelist_judge() {
  ROOT="$ROOT" node --input-type=module -e "$(whitelist_judgement)" "$@"
}

# The verdicts, in the prefix every other line of the report carries, so the block reads
# as one report and the caller needs no second quoting layer.
whitelist_report() {
  whitelist_judge report "$1" | sed 's/^/dev-lane: /'
}

# The names a whitelist document carries, for a message. A document that cannot be read
# names nobody: this reports, and no decision below reads it.
whitelist_names() {
  whitelist_judge names "$1"
}

# The document this lane may keep, or the one it was handed when nothing had to go.
whitelist_pruned() {
  ROOT="$ROOT" node --input-type=module -e "$(whitelist_judgement)" prune "$1"
}

# A merge patch of the one key, never an apply of a whole ConfigMap. A client-side
# apply deletes every data key the previous one wrote and this one omits, which
# would strip allowed-servers.json and leave the picker offering nothing (#392).
# The patch sets this key and leaves its neighbours alone.
patch_attach_whitelist() {
  kubectl -n "$DEV_NAMESPACE" patch configmap monoplayer-dev-config --type merge \
    -p "$(WHITELIST="$1" node -e 'process.stdout.write(JSON.stringify({ data: { "attach-whitelist.json": process.env.WHITELIST } }))')" >/dev/null
}

# The list the lane ends up with, decided in one order. The document the apply just
# wrote wins while it names anyone: that is the copy Git commits, and an edit there
# is meant to reach the lane, as the picker row's is (#392). Otherwise the entries the
# lane held before the apply are the operator's, and the apply reset them. Otherwise
# the live ConfigMap fills the list, because it names the human who attaches.
converge_attach_whitelist() {
  local kept=$1 applied=$2 live pruned
  # The document the apply wrote is judged before it is the answer. That is the one way a
  # rig name reaches a lane through a manifest rather than through an edit on the lane: the
  # case that stops it being committed is in test/tooling/dev-lane.test.js, and this is
  # what happens while it is there (#677).
  # A judgement that fails writes nothing: an empty answer here would be a lane with no
  # list, and the apply has already reset the key.
  pruned=$(whitelist_pruned "$applied") \
    || die 'cannot judge the applied attach whitelist, so the lane was left as the apply wrote it' 1
  if ! whitelist_is_empty "$pruned"; then
    local dropped
    dropped=$(whitelist_names "$kept")
    # The apply left the entries it carried, so a drop is a write of this one key.
    if [ "$(compact_whitelist "$pruned")" != "$(compact_whitelist "$applied")" ]; then
      patch_attach_whitelist "$pruned"
    fi
    if [ -z "$dropped" ]; then
      say 'the applied attach whitelist names controllers, so the lane keeps it'
      return 0
    fi
    say "the applied attach whitelist names controllers, so the lane keeps it and the list it replaced is gone: $dropped"
    return 0
  fi
  # What the lane held, minus the entries no login can use. A list that was all rig
  # names leaves nothing, and the seed below answers instead of writing an empty list.
  kept=$(whitelist_pruned "$1") \
    || die 'cannot judge the dev attach whitelist, so the list the lane held was left as it is' 1
  if ! whitelist_is_empty "$kept"; then
    patch_attach_whitelist "$kept"
    say 'the apply reset the dev attach whitelist, so the entries it held were written back'
    return 0
  fi
  if ! live=$(read_attach_whitelist "$LIVE_NAMESPACE" monoplayer-config fault); then
    say 'the dev attach whitelist is empty and the live one could not be read: add a controller before a client can attach'
    return 0
  fi
  if whitelist_is_empty "$live"; then
    say 'the dev attach whitelist is empty and the live one names nobody: add a controller before a client can attach'
    return 0
  fi
  # Nothing is written from this one, so a judgement that fails costs the seed and not the
  # lane: the message says so rather than patching a list nobody judged.
  if ! live=$(whitelist_pruned "$live"); then
    say 'the dev attach whitelist is empty and the live one could not be judged: add a controller before a client can attach'
    return 0
  fi
  if whitelist_is_empty "$live"; then
    say "the dev attach whitelist is empty and the live one names no entry this lane can verify: add a controller before a client can attach"
    return 0
  fi
  patch_attach_whitelist "$live"
  say "filled the dev attach whitelist from $LIVE_NAMESPACE"
}

up() {
  guard
  ensure_rcon_secret
  ensure_pull_secret
  local kept applied before
  # Read before the apply. The applied ConfigMap ships the empty document, so after
  # the apply the lane's own list is gone, and this value is the only copy of it. The
  # reader has already said what failed, and a run that cannot read this stops before
  # it writes anything.
  if ! kept=$(read_attach_whitelist "$DEV_NAMESPACE" monoplayer-dev-config ok); then
    exit 1
  fi
  # The lane exists so the live deployment keeps serving. Reading its replica
  # count before and after is what makes that a measurement, not a claim.
  before=$(live_replicas)
  kubectl apply -k "$ROOT/deploy/dev" >/dev/null
  say "applied deploy/dev to $DEV_NAMESPACE"
  # What the apply itself wrote: the document the manifest declares. A read that fails
  # here is a lane whose ConfigMap the apply did not create, and guessing "empty"
  # would seed over a document nobody read.
  if ! applied=$(read_attach_whitelist "$DEV_NAMESPACE" monoplayer-dev-config ok); then
    exit 1
  fi
  converge_attach_whitelist "$kept" "$applied"
  kubectl -n "$DEV_NAMESPACE" rollout status deploy/paper --timeout="$READY_TIMEOUT" >/dev/null \
    || die "Paper did not become ready; kubectl -n $DEV_NAMESPACE logs deploy/paper" 1
  say 'Paper is ready'
  # The proxy waits for the dev account (#44) in its init container. Saying so
  # beats an operator staring at an Init:0/1 pod.
  kubectl -n "$DEV_NAMESPACE" get deploy monoplayer >/dev/null 2>&1 \
    && say 'the proxy is applied; if the dev custody volume is empty, run: mise run dev:custody'
  local after
  after=$(live_replicas)
  mkdir -p "$(dirname "$LIVE_REPORT")"
  printf '{"devNamespace":"%s","live":{"before":"%s","after":"%s"}}\n' \
    "$DEV_NAMESPACE" "${before:-unknown}" "${after:-unknown}" >"$LIVE_REPORT"
  say "live replicas before $DEV_NAMESPACE came up: ${before:-unknown}, after: ${after:-unknown} ($LIVE_REPORT)"
  if [ -n "$before" ] && [ "$before" != "$after" ]; then
    die "the live deployment changed its replica count ($before -> $after) while the dev lane came up" 1
  fi
  status
}

# Stop the lane, keep the account. The dev puppet is not disposable: it took one
# human device-code approval, so its claim outlives the workload, for the same
# reason the live claim is never pruned (deploy/manifests/pvc.yaml). Pods go by
# name or label, so the claim, the Secrets, and the namespace stay.
#
# --purge removes the namespace too, and with it the dev account.
down() {
  guard
  local purge=0
  if [ "${1:-}" = --purge ]; then purge=1; fi
  kubectl -n "$DEV_NAMESPACE" delete deployment,service,configmap \
    -l app.kubernetes.io/part-of=monoplayer --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$DEV_NAMESPACE" delete pod \
    -l app.kubernetes.io/name=monoplayer-dev-custody --ignore-not-found >/dev/null 2>&1 || true
  if [ "$purge" = 1 ]; then
    kubectl delete namespace "$DEV_NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true
    say "deleted $DEV_NAMESPACE, and with it the dev custody volume and the dev account"
  else
    say "stopped $DEV_NAMESPACE; its custody volume and the dev account stay (--purge removes them)"
    # The whitelist is not one of the things that stay, and a stop is where an
    # operator loses an entry without being told.
    say "the dev attach whitelist went with its ConfigMap: the next up applies the lane's document, and fills it from $LIVE_NAMESPACE when that names nobody"
  fi
  status
}

# Reading, never writing: this is how the "the live lane kept serving" claim is
# checked after a dev run.
live_replicas() {
  kubectl -n "$LIVE_NAMESPACE" get deploy "$LIVE_DEPLOYMENT" \
    -o jsonpath='{.status.availableReplicas}' 2>/dev/null || true
}

status() {
  say "dev namespace $DEV_NAMESPACE"
  kubectl -n "$DEV_NAMESPACE" get pods --no-headers 2>/dev/null || say '  nothing running'
  local replicas
  replicas=$(live_replicas)
  say "live $LIVE_NAMESPACE/$LIVE_DEPLOYMENT available replicas: ${replicas:-unknown}"
  local players
  # The namespace is gone after `down`, and this read must not fail the report.
  players=$(read_attach_whitelist "$DEV_NAMESPACE" monoplayer-dev-config ok 2>/dev/null) || players=''
  # A read that yielded nothing is not a report about the whitelist, so it says nothing.
  # Everything else is judged by the one program that reads this document: it also names
  # an empty list, and a document it could not parse (#677).
  if [ -n "$players" ]; then
    whitelist_report "$players"
  fi
}

# Point the lane at a branch image (#43). The image is tagged with the commit, so
# the lane runs exactly the tree under review.
set_image() {
  [ $# -ge 1 ] && [ -n "$1" ] || die 'set-image needs a tag or a commit sha' 2
  guard
  local ref="$IMAGE_REPO:$1"
  kubectl -n "$DEV_NAMESPACE" set image deploy/monoplayer "monoplayer=$ref" >/dev/null
  say "dev monoplayer now runs $ref"
  # No manifest records this pin, so the image retention job cannot see it: it
  # keeps the last 20 sha-* tags and a one-day grace, nothing more (#118). The
  # reminder is part of the command because that is the moment the operator knows
  # which tag the lane is on.
  say "if this pin must outlive the next 20 builds, register it: echo '$1  # dev' >> deploy/pins.txt"
  kubectl -n "$DEV_NAMESPACE" rollout status deploy/monoplayer --timeout="$READY_TIMEOUT" >/dev/null \
    || die "the dev proxy did not become ready on $ref" 1
}

# A join through the standing deployment (#43). The dev proxy's puppet is the dev
# account (#44) and it joins the dev Paper when the proxy starts, so a join is a
# fact about the lane. The dev Paper's own player list is the evidence: the server
# is the thing that has to see the account, and RCON reads it without a client.
#
# This replaced a throwaway pod that borrowed the live account. That pod was safe
# (it could not refresh) but it made the live token part of a dev run, which is
# what the dev account exists to stop.
join() {
  guard
  local proxy=deploy/monoplayer name listed players lower_players lower_name joined=0 waited=0
  kubectl -n "$DEV_NAMESPACE" rollout status "$proxy" --timeout="$READY_TIMEOUT" >/dev/null \
    || die "the dev proxy is not ready in $DEV_NAMESPACE; mise run dev:status" 1
  # The account the proxy is signed in as, read from its own volume.
  name=$(kubectl -n "$DEV_NAMESPACE" exec "$proxy" -c monoplayer -- node -e '
const fs = require("node:fs")
const root = "/data/accounts"
const dirs = fs.readdirSync(root).filter(entry => fs.existsSync(root + "/" + entry + "/profile.json"))
if (dirs.length !== 1) {
  process.stderr.write("expected one account on the dev volume, found " + dirs.length + "\n")
  process.exit(1)
}
process.stdout.write(String(JSON.parse(fs.readFileSync(root + "/" + dirs[0] + "/profile.json", "utf8")).name ?? ""))
') || die 'cannot read the dev account profile from the dev volume' 2
  [ -n "$name" ] || die 'the dev account profile names nobody' 2
  while : ; do
    listed=$(kubectl -n "$DEV_NAMESPACE" exec deploy/paper -c paper -- rcon-cli list 2>/dev/null || true)
    players=$(printf '%s' "${listed#*:}" | tr -d ' ')
    lower_players=$(printf '%s' "$players" | tr '[:upper:]' '[:lower:]')
    lower_name=$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')
    case ",$lower_players," in
      *",$lower_name,"*) joined=1; break ;;
    esac
    [ "$waited" -lt "$JOIN_TIMEOUT" ] || break
    sleep 2
    waited=$((waited + 2))
  done
  mkdir -p "$(dirname "$JOIN_REPORT")"
  JOINED="$joined" ACCOUNT="$name" PLAYERS="$players" NAMESPACE="$DEV_NAMESPACE" \
  EVIDENCE="$listed" REPORT="$JOIN_REPORT" node -e '
const fs = require("node:fs")
fs.writeFileSync(process.env.REPORT, JSON.stringify({
  namespace: process.env.NAMESPACE,
  account: process.env.ACCOUNT,
  players: process.env.PLAYERS === "" ? [] : process.env.PLAYERS.split(","),
  evidence: process.env.EVIDENCE,
  joined: process.env.JOINED === "1"
}, null, 2) + "\n")
'
  [ "$joined" = 1 ] || die "$name is not on the dev Paper; the proxy is up but the backend login did not land ($JOIN_REPORT)" 1
  say "$name is on the dev Paper ($JOIN_REPORT)"
}

case "${1:-}" in
  up) up ;;
  down) shift; down "$@" ;;
  status) status ;;
  set-image) shift; set_image "$@" ;;
  join) join ;;
  pull-secret) guard; ensure_pull_secret ;;
  image)
    [ $# -ge 2 ] && [ -n "$2" ] || die 'image needs a tag or a commit sha' 2
    printf '%s:%s\n' "$IMAGE_REPO" "$2"
    exit 0 ;;
  -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "usage: $0 up|down|status|image <tag>|set-image <tag>|join|pull-secret" 2 ;;
esac
