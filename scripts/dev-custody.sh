#!/usr/bin/env bash
# The dev puppet account (#44): bootstrap it onto the dev custody volume, read
# its custody health, and prove a dev run left the live account untouched.
#
#   scripts/dev-custody.sh up          create the handle pod on the dev volume
#   scripts/dev-custody.sh down        delete the handle pod
#   scripts/dev-custody.sh bootstrap   one device-code approval, then headless
#   scripts/dev-custody.sh accounts    list the accounts on the dev volume
#   scripts/dev-custody.sh status [--refresh]
#   scripts/dev-custody.sh live-digest print the live account's file digests
#   scripts/dev-custody.sh prove-live -- <command ...>
#                                      digest the live account, run the command,
#                                      digest again, and fail if it changed
#
# Why a pod: the dev account's token chain lives on `monoplayer-dev-custody`, and
# one account has one writer (docs/custody.md, "Sessions, copies, and refresh").
# A copy on a laptop would be a second copy of a rolling token, so the bootstrap
# runs where the volume is, the way scripts/online-cluster.sh runs the live rung
# where the live token is.
#
# Why the branch's code is copied onto the volume: `finalizeStaging` renames the
# staging directory into `/data/accounts`, so staging has to share a filesystem
# with the account tree. Copying `src` to `/data/.bootstrap` puts the CLI's repo
# root on the same volume, so the rename stays a rename.
#
# What it never does: write to the live namespace. `live-digest` and
# `prove-live` read the live account's files through the live pod's own mount,
# because a second mount of that claim is the thing this lane exists to avoid.
# They never scale, patch, or restart it either.
#
# Environment:
#   MONOPLAYER_DEV_NAMESPACE      the dev namespace        (default monoplayer-dev)
#   MONOPLAYER_CLUSTER_NAMESPACE  live namespace           (default monoplayer)
#   MONOPLAYER_LIVE_DEPLOYMENT    live deployment to read  (default monoplayer)
#   MONOPLAYER_DEV_ACCOUNT        the alias to bootstrap   (default devpuppet)
#   MONOPLAYER_DEV_IMAGE          the image to run         (default ghcr.io/bafbi/monoplayer:main)
#   MONOPLAYER_DEV_HANDLE_POD     the handle pod's name    (default dev-custody)
#   MONOPLAYER_DEV_READY_TIMEOUT  wait for the handle pod  (default 300s)
#   MONOPLAYER_CUSTODY_REPORT     the bootstrap report     (default .reports/dev-custody.json)
#   MONOPLAYER_LIVE_DIGEST_REPORT the proof report         (default .reports/live-custody-digest.json)
#
# Exit codes: 0 done, 1 the bootstrap or the proof failed, 2 setup refused.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEV_NAMESPACE=${MONOPLAYER_DEV_NAMESPACE:-monoplayer-dev}
LIVE_NAMESPACE=${MONOPLAYER_CLUSTER_NAMESPACE:-monoplayer}
LIVE_DEPLOYMENT=${MONOPLAYER_LIVE_DEPLOYMENT:-monoplayer}
ACCOUNT=${MONOPLAYER_DEV_ACCOUNT:-devpuppet}
IMAGE=${MONOPLAYER_DEV_IMAGE:-ghcr.io/bafbi/monoplayer:main}
HANDLE_POD=${MONOPLAYER_DEV_HANDLE_POD:-dev-custody}
READY_TIMEOUT=${MONOPLAYER_DEV_READY_TIMEOUT:-300s}
REPORT=${MONOPLAYER_CUSTODY_REPORT:-.reports/dev-custody.json}
DIGEST_REPORT=${MONOPLAYER_LIVE_DIGEST_REPORT:-.reports/live-custody-digest.json}
# The account tree, and where the branch's code sits on the same volume.
ACCOUNTS_DIR=/data/accounts
BOOTSTRAP_DIR=/data/.bootstrap
CLI=$BOOTSTRAP_DIR/src/custody/cli.js

die() { printf 'dev-custody: %s\n' "$1" >&2; exit "${2:-2}"; }
say() { printf 'dev-custody: %s\n' "$1"; }

command -v kubectl >/dev/null || die 'kubectl is not on PATH'

# The dev namespace is the only one this script may create objects in. `monoplayer`
# is banned even when the live namespace variable is overridden, so no environment
# can aim this script at the live lane.
guard() {
  if [ -z "$DEV_NAMESPACE" ] || [ "$DEV_NAMESPACE" = "$LIVE_NAMESPACE" ] || [ "$DEV_NAMESPACE" = monoplayer ]; then
    die "refusing \"$DEV_NAMESPACE\" as the dev namespace: it is the live namespace ($LIVE_NAMESPACE)" 2
  fi
}

# The namespace and the dev ghcr-pull Secret belong to the lane, so the lane
# script owns creating them and this one asks for them: two copies of a Secret
# bootstrap is two chances to invent a different credential.
ensure_pull_secret() {
  MONOPLAYER_DEV_NAMESPACE="$DEV_NAMESPACE" \
  MONOPLAYER_CLUSTER_NAMESPACE="$LIVE_NAMESPACE" \
    "$ROOT/scripts/dev-lane.sh" pull-secret
}

# The dev proxy's pod, if one exists. It holds the dev claim, so the handle pod
# cannot: ReadWriteOnce on a two-node cluster, and one account has one writer.
proxy_pod() {
  kubectl -n "$DEV_NAMESPACE" get pods -l app.kubernetes.io/name=monoplayer \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true
}

require_handle_pod() {
  local phase
  phase=$(kubectl -n "$DEV_NAMESPACE" get pod "$HANDLE_POD" -o jsonpath='{.status.phase}' 2>/dev/null || true)
  if [ "$phase" != Running ]; then
    die "the handle pod $HANDLE_POD is not running in $DEV_NAMESPACE; run: mise run dev:custody:up" 2
  fi
  printf '%s\n' "$HANDLE_POD"
}

up() {
  guard
  # The volume conflict comes first: nothing below it runs if the claim is taken.
  local proxy
  proxy=$(proxy_pod)
  if [ -n "$proxy" ]; then
    die "the dev proxy ($proxy) holds the dev custody volume, and one account has one writer. Remove it, bootstrap, then bring the lane back: kubectl -n $DEV_NAMESPACE delete deploy/monoplayer" 2
  fi
  ensure_pull_secret
  kubectl apply -f "$ROOT/deploy/dev/custody.yaml" >/dev/null
  kubectl apply -n "$DEV_NAMESPACE" -f - >/dev/null <<YAML
apiVersion: v1
kind: Pod
metadata:
  name: $HANDLE_POD
  namespace: $DEV_NAMESPACE
  labels:
    app.kubernetes.io/name: monoplayer-dev-custody
    app.kubernetes.io/part-of: monoplayer
spec:
  restartPolicy: Never
  automountServiceAccountToken: false
  securityContext:
    runAsNonRoot: true
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
    seccompProfile:
      type: RuntimeDefault
  imagePullSecrets:
    - name: ghcr-pull
  containers:
    - name: custody
      image: $IMAGE
      imagePullPolicy: IfNotPresent
      command: ["sh", "-c", "sleep 86400"]
      env:
        - name: HOME
          value: /tmp
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      resources:
        requests:
          cpu: 50m
          memory: 128Mi
        limits:
          memory: 512Mi
      volumeMounts:
        - name: custody
          mountPath: /data
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: custody
      persistentVolumeClaim:
        claimName: monoplayer-dev-custody
    - name: tmp
      emptyDir: {}
YAML
  kubectl -n "$DEV_NAMESPACE" wait --for=condition=Ready "pod/$HANDLE_POD" --timeout="$READY_TIMEOUT" >/dev/null \
    || die "the handle pod never became ready; kubectl -n $DEV_NAMESPACE describe pod $HANDLE_POD" 1
  # The branch's code, next to the image's own dependencies.
  kubectl -n "$DEV_NAMESPACE" exec "$HANDLE_POD" -- sh -c "rm -rf $BOOTSTRAP_DIR && mkdir -p $BOOTSTRAP_DIR" >/dev/null
  kubectl cp "$ROOT/src" "$DEV_NAMESPACE/$HANDLE_POD:$BOOTSTRAP_DIR/src" >/dev/null
  kubectl cp "$ROOT/package.json" "$DEV_NAMESPACE/$HANDLE_POD:$BOOTSTRAP_DIR/package.json" >/dev/null
  kubectl -n "$DEV_NAMESPACE" exec "$HANDLE_POD" -- sh -c "ln -sfn /app/node_modules $BOOTSTRAP_DIR/node_modules" >/dev/null
  say "the handle pod $HANDLE_POD runs $IMAGE with the branch's code"
}

down() {
  guard
  kubectl -n "$DEV_NAMESPACE" delete pod "$HANDLE_POD" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  say "deleted the handle pod in $DEV_NAMESPACE"
}

# One device-code approval, streamed to the terminal. A device code never goes to
# a file (docs/custody.md, "The exact user device-code action"): the CLI writes it
# to stderr, and `kubectl exec` without a TTY is what keeps it a stream.
bootstrap() {
  guard
  local pod
  pod=$(require_handle_pod) || exit 2
  say "signing in as $ACCOUNT: approve the code below in a browser, signed in as that account"
  local status=0
  kubectl -n "$DEV_NAMESPACE" exec -i "$pod" -- \
    node "$CLI" device-code --alias "$ACCOUNT" --accounts-dir "$ACCOUNTS_DIR" || status=$?
  if [ "$status" -ne 0 ]; then
    say "the device-code login did not finish (exit $status)"
    kubectl -n "$DEV_NAMESPACE" exec "$pod" -- node "$CLI" accounts --accounts-dir "$ACCOUNTS_DIR" || true
    exit 1
  fi
  summarize_accounts "$pod"
}

# One account, with the alias the deployment selects. The report is the machine
# readable half: uuid, name, and alias are not secrets (src/service/start-live.js
# logs the same fields).
summarize_accounts() {
  local pod="$1"
  mkdir -p "$(dirname "$REPORT")"
  # shellcheck disable=SC2016
  kubectl -n "$DEV_NAMESPACE" exec "$pod" -- \
    node "$CLI" accounts --accounts-dir "$ACCOUNTS_DIR" --json \
    | DEV_NAMESPACE="$DEV_NAMESPACE" ACCOUNT="$ACCOUNT" ACCOUNTS_DIR="$ACCOUNTS_DIR" node -e '
let raw = ""
process.stdin.on("data", chunk => { raw += chunk })
process.stdin.on("end", () => {
  const listing = JSON.parse(raw)
  const accounts = (listing.accounts ?? []).map(account => ({
    uuid: account.uuid,
    name: account.name ?? null,
    alias: account.alias ?? null
  }))
  const doc = { namespace: process.env.DEV_NAMESPACE, accountsDir: process.env.ACCOUNTS_DIR, accounts }
  process.stdout.write(JSON.stringify(doc, null, 2) + "\n")
  if (accounts.length !== 1) {
    process.stderr.write("expected exactly one account on the dev volume, found " + accounts.length + "\n")
    process.exit(1)
  }
  if (accounts[0].alias !== process.env.ACCOUNT) {
    process.stderr.write("expected the alias " + process.env.ACCOUNT + ", found " + accounts[0].alias + "\n")
    process.exit(1)
  }
})
' | tee "$REPORT"
  say "the dev account is bootstrapped ($REPORT)"
}

accounts() {
  guard
  local pod
  pod=$(require_handle_pod) || exit 2
  kubectl -n "$DEV_NAMESPACE" exec "$pod" -- node "$CLI" accounts --accounts-dir "$ACCOUNTS_DIR" "$@"
}

status() {
  guard
  local pod
  pod=$(require_handle_pod) || exit 2
  kubectl -n "$DEV_NAMESPACE" exec "$pod" -- \
    node "$CLI" status --account "$ACCOUNT" --accounts-dir "$ACCOUNTS_DIR" "$@"
}

# What the live deployment runs, read rather than assumed: name, pod selector,
# puppet uuid, accounts dir. One `kubectl get`, so a shim sees one read.
live_info() {
  # shellcheck disable=SC2016
  kubectl -n "$LIVE_NAMESPACE" get deploy "$LIVE_DEPLOYMENT" -o json | node -e '
const deployment = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
const container = deployment.spec?.template?.spec?.containers?.[0] ?? {}
const env = Object.fromEntries((container.env ?? []).map(entry => [entry.name, entry.value]))
const selector = Object.entries(deployment.spec?.selector?.matchLabels ?? {})
  .map(([key, value]) => key + "=" + value)
  .join(",")
process.stdout.write([
  deployment.metadata.name,
  selector,
  env.MONOPLAYER_PUPPET_UUID ?? "",
  env.MONOPLAYER_PUPPET_ACCOUNTS_DIR ?? "/data/accounts"
].join("|"))
'
}

# The live account's files, digested inside the live pod. Reading the account
# directory through the pod that already holds it is the only way to look at it
# without mounting the claim somewhere else.
live_digest() {
  local deployment selector uuid accounts_dir
  IFS='|' read -r deployment selector uuid accounts_dir <<<"$(live_info)"
  [ -n "$uuid" ] || die "$LIVE_NAMESPACE/$LIVE_DEPLOYMENT defines no MONOPLAYER_PUPPET_UUID" 2
  [ -n "$selector" ] || die "cannot read the pod selector of $LIVE_NAMESPACE/$LIVE_DEPLOYMENT" 2
  kubectl -n "$LIVE_NAMESPACE" exec deploy/"$deployment" -c monoplayer -- node -e '
const fs = require("node:fs")
const crypto = require("node:crypto")
const path = require("node:path")
const dir = process.argv[1]
const files = fs.readdirSync(dir)
  .filter(name => name === "profile.json" || name.endsWith("-cache.json"))
  .sort()
if (files.length === 0) {
  process.stderr.write("no account files in " + dir + "\n")
  process.exit(1)
}
for (const name of files) {
  const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex")
  process.stdout.write(sha + "  " + name + "\n")
}
process.stdout.write("dir=" + dir + "\n")
' "$accounts_dir/$uuid"
}

# Prove a command left the live account's token files byte-identical (#44's
# fourth criterion). A refresh that the live proxy performs on its own schedule
# would also move the digests, so the report records the pod and the command: a
# difference is diagnosable, not just red.
prove_live() {
  guard
  [ $# -ge 1 ] || die 'prove-live needs a command: scripts/dev-custody.sh prove-live -- <command ...>' 2
  if [ "$1" = -- ]; then shift; fi
  [ $# -ge 1 ] || die 'prove-live needs a command after --' 2
  local before after status=0 pod
  IFS='|' read -r _ selector _ _ <<<"$(live_info)"
  [ -n "$selector" ] || die "cannot read the pod selector of $LIVE_NAMESPACE/$LIVE_DEPLOYMENT" 2
  pod=$(kubectl -n "$LIVE_NAMESPACE" get pods -l "$selector" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  before=$(live_digest) || die 'cannot digest the live account; is the live deployment running?' 2
  say "digested the live custody of $LIVE_NAMESPACE/$LIVE_DEPLOYMENT ($pod); running: $*"
  set +e
  "$@"
  status=$?
  set -e
  after=$(live_digest) || die 'cannot digest the live account after the run' 2
  write_digest_report "$before" "$after" "$status" "$pod" "$*"
  if [ "$before" = "$after" ]; then
    say 'the live account token files are byte-identical'
  else
    say 'the live account token files changed during the run'
    diff <(printf '%s\n' "$before") <(printf '%s\n' "$after") >&2 || true
    die 'the run touched the live custody; that is #44 fourth criterion failing' 1
  fi
  exit "$status"
}

write_digest_report() {
  local before="$1" after="$2" status="$3" pod="$4" command="$5"
  mkdir -p "$(dirname "$DIGEST_REPORT")"
  # shellcheck disable=SC2016
  BEFORE="$before" AFTER="$after" STATUS="$status" POD="$pod" COMMAND="$command" \
  LIVE_NAMESPACE="$LIVE_NAMESPACE" LIVE_DEPLOYMENT="$LIVE_DEPLOYMENT" REPORT="$DIGEST_REPORT" node -e '
const fs = require("node:fs")
const lines = value => value.split("\n").filter(Boolean)
fs.writeFileSync(process.env.REPORT, JSON.stringify({
  namespace: process.env.LIVE_NAMESPACE,
  deployment: process.env.LIVE_DEPLOYMENT,
  pod: process.env.POD,
  command: process.env.COMMAND,
  exitStatus: Number(process.env.STATUS),
  identical: process.env.BEFORE === process.env.AFTER,
  before: lines(process.env.BEFORE),
  after: lines(process.env.AFTER)
}, null, 2) + "\n")
'
}

case "${1:-}" in
  up) up ;;
  down) down ;;
  bootstrap) bootstrap ;;
  accounts) shift; accounts "$@" ;;
  status) shift; status "$@" ;;
  live-digest) guard; live_digest ;;
  prove-live) shift; prove_live "$@" ;;
  -h|--help) sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) die "usage: $0 up|down|bootstrap|accounts|status|live-digest|prove-live -- <command>" 2 ;;
esac
