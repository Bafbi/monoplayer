#!/usr/bin/env bash
# Drive the driver display host from the workspace.
#
#   tools/nath.sh env                        session environment, as KEY=value
#   tools/nath.sh launch <instance> [args...] start a Prism client on workspace 9, silent
#   tools/nath.sh kill [instance]            stop the driver client
#   tools/nath.sh shot <path>                capture the client render to <path>
#
# env, launch, and the kill fallback read the session on the host, deriving the
# Hyprland signature from "hyprctl instances -j" and storing nothing. No caller
# supplies DISPLAY, XDG_RUNTIME_DIR, WAYLAND_DISPLAY, or
# HYPRLAND_INSTANCE_SIGNATURE: launch inherits them from the compositor, and
# shot and the driver quit need no session at all.
#
# Environment:
#   NATH_HOST            SSH target       (default bafbi@nath.tail41e568.ts.net)
#   NATH_INSTANCE        default instance (default gate-b-player-fabric)
#   NATH_DRIVER_PORT     driver port      (default 25599)
#   NATH_SSH             SSH command      (default ssh -o BatchMode=yes -o ConnectTimeout=10 HOST)
#   NATH_SCP             SCP command      (default scp -q)
#   NATH_LAUNCH_TIMEOUT  window budget    (default 90 seconds)
#   GATEB_DRIVER_TOKEN   driver token, when the mod runs with one
#
# Exit codes: 0 the command did what it says, 1 the host or the driver refused,
# 2 bad usage. kill exits 0 when no client is running, because that is the state
# it promises; launch exits 1 when it cannot keep the window off your workspace.
set -euo pipefail

host=${NATH_HOST:-bafbi@nath.tail41e568.ts.net}
default_instance=${NATH_INSTANCE:-gate-b-player-fabric}
driver_port=${NATH_DRIVER_PORT:-25599}

read -r -a ssh_cmd <<<"${NATH_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=10 ${host}}"
read -r -a scp_cmd <<<"${NATH_SCP:-scp -q}"

die() { printf 'nath: %s\n' "$1" >&2; exit "${2:-1}"; }
usage() { sed -n '2,26p' "$0" | sed 's/^# \{0,1\}//'; }

# Values that reach a remote shell are whitelisted, never escaped.
require_instance() {
  local instance=$1
  case $instance in
    ''|*[!A-Za-z0-9._-]*) die "invalid instance name: ${instance:-<empty>}" 2 ;;
  esac
}

# Run a script on the host with the session environment derived there. The
# script arrives on stdin, so no argument of the ssh call carries a pattern that
# a later pgrep could match. ssh joins its arguments into one remote command
# line, so each word is quoted here; an unquoted argument would run as shell
# text on the host.
remote() {
  local body=$1 command rc=0
  shift
  command=$(printf '%q ' bash -s -- "$@")
  "${ssh_cmd[@]}" "$command" <<<"${SESSION_PRELUDE}${body}" || {
    rc=$?
    if [ "$rc" -eq 255 ]; then
      die "cannot reach $host"
    fi
    return "$rc"
  }
}

# The one place that knows how to find the compositor. hyprctl needs no
# environment of its own, and its JSON carries the Wayland socket.
IFS= read -r -d '' SESSION_PRELUDE <<'REMOTE' || true
set -euo pipefail
if ! instance_json=$(hyprctl instances -j 2>/dev/null); then
  echo "nath: hyprctl instances -j failed on the host" >&2
  exit 1
fi
if [ "$(jq -r 'length' <<<"$instance_json")" -lt 1 ]; then
  echo "nath: no Hyprland instance is running on the host" >&2
  exit 1
fi
HYPRLAND_INSTANCE_SIGNATURE=$(jq -r '.[0].instance' <<<"$instance_json")
WAYLAND_DISPLAY=$(jq -r '.[0].wl_socket' <<<"$instance_json")
XDG_RUNTIME_DIR=/run/user/$(id -u)
export HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY XDG_RUNTIME_DIR

REMOTE
cmd_env() {
  remote '
display=
for socket in /tmp/.X11-unix/X*; do
  [ -S "$socket" ] && { display=":${socket##*/X}"; break; }
done
if [ -n "$display" ]; then
  printf "DISPLAY=%s\n" "$display"
else
  echo "nath: no XWayland socket under /tmp/.X11-unix; DISPLAY is unset" >&2
fi
printf "WAYLAND_DISPLAY=%s\n" "$WAYLAND_DISPLAY"
printf "XDG_RUNTIME_DIR=%s\n" "$XDG_RUNTIME_DIR"
printf "HYPRLAND_INSTANCE_SIGNATURE=%s\n" "$HYPRLAND_INSTANCE_SIGNATURE"
'
}
cmd_launch() {
  local instance=${1:-}
  [ -n "$instance" ] || die "launch needs an instance name" 2
  require_instance "$instance"
  shift
  remote '
instance=$1
shift
# A second client on the same instance fights the first for the driver port.
# pgrep matches a regex and the whitelist allows dots, so the dots are literal.
pattern=${instance//./\\.}
anchor="-Djava.library.path=$HOME/.local/share/PrismLauncher/instances/$pattern/natives"
if pgrep -f -- "$anchor" >/dev/null; then
  echo "nath: $instance is already running; stop it with: tools/nath.sh kill $instance" >&2
  exit 1
fi

# %q keeps the caller extra prismlauncher arguments intact; the Lua string then
# only has to escape backslashes and double quotes.
launch="prismlauncher -l $instance"
for arg in "$@"; do
  launch="$launch $(printf "%q" "$arg")"
done
escaped=${launch//\\/\\\\}
escaped=${escaped//\"/\\\"}
lua="hl.dispatch(hl.dsp.exec_cmd(\"$escaped\", { workspace = \"9 silent\", no_initial_focus = true, focus_on_activate = false }))"

active_before=$(hyprctl activeworkspace -j | jq -r ".id") || { echo "nath: hyprctl activeworkspace failed" >&2; exit 1; }
# exec_cmd runs the client as a compositor child, so it inherits DISPLAY,
# WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and the signature. The rules put its window
# on workspace 9 without switching to it, but only when the compositor spawns
# the process that opens the window. Prism hands a second launch to a
# PrismLauncher that is already running, and that process carries no rule, so
# the move below is the placement that always lands.
if ! eval_reply=$(hyprctl eval "$lua" 2>&1); then
  echo "nath: the compositor refused the launch: $eval_reply" >&2
  exit 1
fi

# Every mapped window, on every workspace. The instance owns a window when the
# window process carries the instance library path, so another instance cannot
# stand in and no class name has to match.
clients() { hyprctl clients -j | jq -r ".[] | select(.mapped != false) | \"\(.address) \(.pid) \(.workspace.name // (.workspace.id | tostring))\""; }
workspace_of() {
  local address=$1 address_now pid_now workspace_now
  while read -r address_now pid_now workspace_now; do
    if [ "$address_now" = "$address" ]; then printf "%s\n" "$workspace_now"; return 0; fi
  done <<<"$(clients || true)"
  return 1
}

window= opened_on=
deadline=$((SECONDS + ${NATH_LAUNCH_TIMEOUT:-90}))
while [ $SECONDS -lt $deadline ]; do
  candidates=$(clients) || { echo "nath: hyprctl clients failed" >&2; exit 1; }
  while read -r address pid workspace; do
    [ -n "$address" ] || continue
    if tr "\0" " " < "/proc/$pid/cmdline" 2>/dev/null | grep -qF -- "instances/$instance/natives"; then
      window=$address
      opened_on=$workspace
      break
    fi
  done <<<"$candidates"
  if [ -n "$window" ]; then break; fi
  sleep 1
done
if [ -z "$window" ]; then
  echo "nath: $instance opened no window carrying instances/$instance/natives within the launch budget" >&2
  exit 1
fi

# Move it without following, so the caller keeps the workspace it is on. eval
# answers ok even when the dispatcher found no window, so read the placement
# back instead of trusting the reply.
if [ "$opened_on" != "9" ]; then
  lua="hl.dispatch(hl.dsp.window.move({ window = \"address:$window\", workspace = 9, follow = false }))"
  if ! move_reply=$(hyprctl eval "$lua" 2>&1); then
    echo "nath: the compositor refused to move $window from workspace $opened_on: $move_reply" >&2
    exit 1
  fi
  if ! moved_on=$(workspace_of "$window"); then
    echo "nath: cannot read the workspace of $window after the move; it left the compositor, or hyprctl failed" >&2
    exit 1
  fi
  if [ "$moved_on" != "9" ]; then
    echo "nath: $window is on workspace $moved_on, not 9, after the move" >&2
    exit 1
  fi
fi

active_after=$(hyprctl activeworkspace -j | jq -r ".id") || { echo "nath: hyprctl activeworkspace failed" >&2; exit 1; }
focused=$(hyprctl activewindow -j | jq -r "(.class // \"\")") || { echo "nath: hyprctl activewindow failed" >&2; exit 1; }
focused_window=$(hyprctl activewindow -j | jq -r ".address") || focused_window=
printf "INSTANCE=%s\n" "$instance"
printf "WINDOW=%s\n" "$window"
printf "OPENED_WORKSPACE=%s\n" "$opened_on"
printf "WORKSPACE=9\n"
if [ "$active_after" = "$active_before" ] && [ "$focused_window" != "$window" ]; then
  printf "SILENT=yes\n"
else
  printf "SILENT=no\n"
  echo "nath: the launch was not silent: active workspace $active_before -> $active_after" >&2
  echo "nath: the client is running; stop it with: tools/nath.sh kill $instance" >&2
  exit 1
fi
printf "ACTIVE_WORKSPACE=%s\n" "$active_after"
printf "FOCUSED=%s\n" "$focused"
' "$instance" "$@"
}
# One request to the driver over an SSH stdio forward: the reply stays local,
# so the token never travels through a remote shell.
driver_reply() {
  local payload=$1 reply
  reply=$(printf '%s\n' "$payload" | timeout 30 "${ssh_cmd[@]}" -W "127.0.0.1:${driver_port}" 2>/dev/null) || true
  [ -n "$reply" ] || die "the driver is not answering on 127.0.0.1:${driver_port} on ${host}: no client, or the mod is not installed"
  printf '%s' "$reply"
}

driver_payload() {
  local payload="{\"op\":\"$1\"" token
  if [ -n "${GATEB_DRIVER_TOKEN:-}" ]; then
    token=${GATEB_DRIVER_TOKEN//\\/\\\\}
    token=${token//\"/\\\"}
    payload="$payload,\"token\":\"$token\""
  fi
  printf '%s}' "$payload"
}

cmd_kill() {
  local instance=${1:-${default_instance}} quit=no stopped=
  require_instance "$instance"

  # Ask nicely first: the quit op closes the world and the driver socket.
  if reply=$(printf '%s\n' "$(driver_payload quit)" | timeout 30 "${ssh_cmd[@]}" -W "127.0.0.1:${driver_port}" 2>/dev/null) && [ -n "$reply" ]; then
    case $reply in
      *'"ok":true'*) quit=yes ;;
    esac
  fi

  # The quit op needs a live mod. A wedged client still has to die, so fall back
  # to the JVM library path. The script arrives on stdin, so this pattern never
  # matches the remote shell that runs it.
  stopped=$(remote '
instance=$1
pattern=${instance//./\\.}
anchor="-Djava.library.path=$HOME/.local/share/PrismLauncher/instances/$pattern/natives"
pids=$(pgrep -f -- "$anchor" || true)
if [ -z "$pids" ]; then
  exit 0
fi
kill $pids 2>/dev/null || true
for _ in $(seq 1 20); do
  pgrep -f -- "$anchor" >/dev/null || { printf "%s\n" "$pids"; exit 0; }
  sleep 1
done
kill -9 $pids 2>/dev/null || true
printf "%s\n" "$pids"
' "$instance")

  if [ "$quit" = yes ]; then printf 'QUIT=ok\n'; else printf 'QUIT=no\n'; fi
  if [ -n "$stopped" ]; then
    printf 'STOPPED=%s\n' "$(tr '\n' ' ' <<<"$stopped" | sed 's/ $//')"
  else
    printf 'STOPPED=\n'
    if [ "$quit" = no ]; then
      echo "nath: nothing to stop on $instance" >&2
    fi
  fi
}
cmd_shot() {
  local target=${1:-} reply path magic
  [ -n "$target" ] || die "shot needs a destination path" 2

  reply=$(driver_reply "$(driver_payload screenshot)")
  case $reply in
    *'"ok":true'*) ;;
    *) die "the driver refused the screenshot: $(sed -n 's/.*"error":"\([^"]*\)".*/\1/p' <<<"$reply")" ;;
  esac
  path=$(sed -n 's/.*"path":"\([^"]*\)".*/\1/p' <<<"$reply")
  [ -n "$path" ] || die "the driver answered without a screenshot path: $reply"

  mkdir -p "$(dirname "$target")"
  # Copy beside the target and move only after the PNG check, so a failed
  # capture never leaves a file that looks like evidence.
  if ! "${scp_cmd[@]}" "${host}:${path}" "$target.part"; then
    rm -f "$target.part"
    die "scp failed for ${host}:${path}"
  fi
  magic=$(od -An -tx1 -N8 "$target.part" | tr -d ' \n')
  if [ "$magic" != 89504e470d0a1a0a ]; then
    rm -f "$target.part"
    die "not a PNG: ${host}:${path}"
  fi
  mv "$target.part" "$target"

  printf 'PATH=%s\n' "$target"
  printf 'REMOTE_PATH=%s\n' "$path"
  printf 'BYTES=%s\n' "$(wc -c <"$target" | tr -d ' ')"
}

case ${1:-} in
  env) shift; [ $# -eq 0 ] || die "env takes no arguments" 2; printf 'NATH_HOST=%s\n' "$host"; cmd_env ;;
  launch) shift; cmd_launch "$@" ;;
  kill) shift; cmd_kill "$@" ;;
  shot) shift; cmd_shot "$@" ;;
  -h|--help|help) usage ;;
  '') usage >&2; exit 2 ;;
  *) die "unknown command: $1 (try --help)" 2 ;;
esac
