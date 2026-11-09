#!/usr/bin/env bash
# Build the pinned ProtocolLib jar the observer plugin links against.
#
# ProtocolLib speaks Minecraft 26.1 through 26.3 only on master: the newest
# published release (5.3.0, latest 5.4.0-SNAPSHOT) declares
# MAXIMUM_MINECRAFT_VERSION = "1.21.1". So the observer pins a commit and builds
# it, and the lane never depends on a branch or an unpublished snapshot.
#
# Output: .cache/protocollib/ProtocolLib-<sha7>.jar (gitignored).
set -euo pipefail

PIN=9cb125fb1f81f39ad0b9dbbd22ebab8d2c26f221   # "Update to Minecraft 26.3 (#3681)"
REPO=https://github.com/dmulloy2/ProtocolLib
CACHE=.cache/protocollib
SRC=$CACHE/src
JAR=$CACHE/ProtocolLib-${PIN:0:7}.jar

say() { printf 'protocollib: %s\n' "$1"; }
die() { printf 'protocollib: %s\n' "$1" >&2; exit 1; }

# The observer needs 26.1; MinecraftVersion must know it. This is the check that
# fails loudly if the pin ever moves to a commit without 26.x support.
verify_supports () {
  local jar home
  jar=$(readlink -f "$1") # the extraction runs inside a temp dir
  home=$(mktemp -d)
  if ! ( cd "$home" && "${JAR_TOOL:-jar}" xf "$jar" com/comphenix/protocol/utility/MinecraftVersion.class ) 2>/dev/null; then
    rm -rf "$home"
    return 1
  fi
  if grep -aq '26\.1' "$home/com/comphenix/protocol/utility/MinecraftVersion.class"; then
    rm -rf "$home"
    return 0
  fi
  rm -rf "$home"
  return 1
}

if [ -f "$JAR" ]; then
  say "up to date: $JAR"
  exit 0
fi

command -v git >/dev/null || die 'git is not on PATH'
[ -n "${JAVA_HOME:-}" ] || JAVA_HOME=$(mise where java 2>/dev/null || true)
[ -n "${JAVA_HOME:-}" ] || die 'set JAVA_HOME (or run through mise)'
GRADLE=${GRADLE:-$(command -v gradle || true)}
[ -n "$GRADLE" ] || die 'gradle is not on PATH'
JAR_TOOL=${JAR_TOOL:-$JAVA_HOME/bin/jar}
[ -x "$JAR_TOOL" ] || die "no jar tool at $JAR_TOOL"

mkdir -p "$CACHE"
if [ ! -d "$SRC/.git" ]; then
  say "cloning $REPO"
  git clone -q "$REPO" "$SRC"
fi
git -C "$SRC" fetch -q origin "$PIN" 2>/dev/null || true
git -C "$SRC" checkout -q "$PIN" || die "cannot check out $PIN"
head=$(git -C "$SRC" rev-parse HEAD)
[ "$head" = "$PIN" ] || die "checkout is $head, not $PIN"

say "building $PIN"
JAVA_HOME="$JAVA_HOME" "$GRADLE" -p "$SRC" --no-daemon -q \
  -Porg.gradle.java.installations.paths="$JAVA_HOME" build -x test

# The plain artifact, not the Spigot one: the Spigot jar relocates packages, so
# the observer cannot link against it and the version check cannot find the class.
built=$(find "$SRC/build/libs" -maxdepth 1 -name 'ProtocolLib-[0-9]*.jar' ! -name '*-sources.jar' | head -1)
[ -n "$built" ] || die 'the build produced no jar'
cp "$built" "$JAR"
verify_supports "$JAR" || die "the pinned build does not support 26.1: $JAR"
say "built $JAR"
