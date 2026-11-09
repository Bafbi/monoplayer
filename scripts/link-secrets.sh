#!/usr/bin/env bash
# Give this worktree the working copy's .secrets, by symlink and never by copy.
#
#   scripts/link-secrets.sh
#
# Tokens live in one place: the main working copy's .secrets. A copy is wrong for
# more than tidiness. The custody token refreshes on use, so two copies of one
# refresh token invalidate each other, and the per-account lock that keeps one
# writer is only shared when the directory is. A symlink gives both
# (docs/adr/one-account-one-writer-one-replica.md, docs/custody.md).
#
# Safe to run on every worktree create: it is idempotent, it never prints file
# contents, and it exits 0 when there is nothing to link.
#
# Environment:
#   MONOPLAYER_SECRETS_SOURCE  secrets directory to link to. Default: .secrets
#                              beside the main worktree from `git worktree list`.
#
# Exit codes: 0 linked, already linked, or no source to link. 1 a real .secrets
# is in the way, the caller is outside a git work tree, or the link failed.
set -euo pipefail

die() {
  printf 'secrets: %s\n' "$1" >&2
  exit "${2:-1}"
}

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || die 'not inside a git work tree'
target="$repo_root/.secrets"

source_dir="${MONOPLAYER_SECRETS_SOURCE:-}"
if [ -z "$source_dir" ]; then
  main_worktree=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
  [ -n "$main_worktree" ] || die 'git worktree list named no main worktree'
  source_dir="$main_worktree/.secrets"
fi

# A real directory or file is somebody's secrets, possibly the only copy.
# Replace it manually, or not at all.
if [ -e "$target" ] && [ ! -L "$target" ]; then
  die "$target exists and is not a symlink; refusing to replace it"
fi

if [ ! -d "$source_dir" ]; then
  printf 'secrets: no secrets at %s; live rungs will not run here\n' "$source_dir"
  exit 0
fi

want=$(cd "$source_dir" && pwd -P)
if [ -L "$target" ]; then
  have=$(cd "$target" 2>/dev/null && pwd -P || true)
  if [ "$have" = "$want" ]; then
    printf 'secrets: already linked to %s\n' "$want"
    exit 0
  fi
fi

ln -sfn "$want" "$target" || die "cannot link $target to $want"

accounts=$(find "$want/accounts" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
whitelist=missing
[ -f "$want/attach-whitelist.json" ] && whitelist=present
printf 'secrets: linked %s -> %s (%s account(s), attach whitelist %s)\n' \
  "$target" "$want" "$accounts" "$whitelist"
