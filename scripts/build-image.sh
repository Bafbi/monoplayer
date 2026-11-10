#!/bin/sh
# Build the Monoplayer image and push it to the cluster Zot registry. PUSH=0
# builds it and publishes nothing: a Dockerfile or deploy/ change needs the
# build, not the push.
#
#   scripts/build-image.sh
#   PUSH=0 scripts/build-image.sh
#   REGISTRY=zot.deepmine-core.svc:5000 scripts/build-image.sh
#
# Prints `<image> <tag> <digest>`. Pin the deployment to that digest.
#
# The tag is `sha-<7>` and `org.opencontainers.image.created` comes from the
# commit time, so one commit yields one tag and one digest (same policy as
# deploy/images/build.sh in the deepmine repo).
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
REGISTRY=${REGISTRY:-zot.deepmine-core.svc:5000}
SHA=$(git -C "$ROOT" rev-parse --short=7 HEAD)
CREATED=$(git -C "$ROOT" log -1 --format=%cI)
IMAGE="$REGISTRY/deepmine/monoplayer"
TAG="sha-$SHA"
# Anything but 0 or 1 is a typo, and a typo must not publish.
PUSH=${PUSH:-1}
case "$PUSH" in
	0) PUSH_ATTR=false ;;
	1) PUSH_ATTR=true ;;
	*)
		echo "PUSH must be 0 or 1, not '$PUSH'" >&2
		exit 1
		;;
esac
# Bind the forwarder to the loopback alias. This dev environment probes
# 127.0.0.1 and a probe's connection reset tears down kubectl's forwarder
# mid-build; 127.0.0.2 is the same loopback interface and stays up.
LOCAL_ADDR=${BUILDKIT_LOCAL_ADDR:-127.0.0.2}
BUILDKIT_ADDR=${BUILDKIT_ADDR:-tcp://$LOCAL_ADDR:1234}
METADATA=/tmp/monoplayer-image.json

PF_PID=
cleanup() {
	if [ -n "$PF_PID" ]; then
		kill "$PF_PID" 2>/dev/null || true
		wait "$PF_PID" 2>/dev/null || true
	fi
}
trap cleanup EXIT

kubectl -n deepmine-build port-forward --address "$LOCAL_ADDR" svc/buildkitd 1234:1234 >/dev/null 2>&1 &
PF_PID=$!

# Wait until buildkitd answers. `debug workers` is the readiness probe: it
# succeeds only when the forwarded port reaches a live daemon.
tries=0
while :; do
	if ! kill -0 "$PF_PID" 2>/dev/null; then
		echo "port-forward to buildkitd exited before the build started" >&2
		exit 1
	fi
	if buildctl --addr "$BUILDKIT_ADDR" debug workers >/dev/null 2>&1; then
		break
	fi
	tries=$((tries + 1))
	if [ "$tries" -ge 60 ]; then
		echo "buildkitd did not answer on $LOCAL_ADDR:1234" >&2
		exit 1
	fi
	sleep 1
done

# A stale metadata file would yield the previous digest on a failed push.
rm -f "$METADATA"

buildctl --addr "$BUILDKIT_ADDR" build \
	--frontend dockerfile.v0 \
	--local "context=$ROOT" \
	--local "dockerfile=$ROOT" \
	--opt filename=Dockerfile \
	--opt "label:org.opencontainers.image.revision=$SHA" \
	--opt "label:org.opencontainers.image.created=$CREATED" \
	--output "type=image,name=$IMAGE:$TAG,push=$PUSH_ATTR,registry.insecure=true" \
	--metadata-file "$METADATA"

# buildctl writes formatted JSON, so key and value are never on one line.
# Strip the formatting before matching, or every successful build looks failed.
digest=$(tr -d ' \t\n' < "$METADATA" |
	sed -n 's/.*"containerimage.digest":"\([^"]*\)".*/\1/p')
if [ -z "$digest" ]; then
	echo "no digest for $IMAGE:$TAG; the build wrote none" >&2
	exit 1
fi

printf '%s %s %s\n' "$IMAGE" "$TAG" "$digest"
