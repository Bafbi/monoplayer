# Run: nath host wrapper (`tools/nath.sh`) — issue #9

Fixed point at start: `4b07849` (origin/main). Branch: `t3/nathost-validation-issue-9`.
VCS: git (no jj repo). Orchestrator: `mise` (`mise run check`).

## Queue

| # | Ticket | Blockers |
|---|---|---|
| T1 | `tools/nath.sh`: `env`, `launch`, `kill`, `shot` + tests over a fake-ssh seam + `lint` covers the script | — |
| T2 | Docs: the validation doc runs through the wrapper; record the host facts learned | T1 |

## Source of truth

GitHub issue #9 (Bafbi/monoplayer): "tools: nath wrapper for the puppet host".

> The puppet host is reached with 254 `ssh bafbi@nath…` calls across 5 sessions. 59 of them paste a
> hardcoded `HYPRLAND_INSTANCE_SIGNATURE` copied from one earlier `hyprctl` output, and every client
> kill rebuilds a `pgrep`/`pkill` line.
>
> Add `tools/nath.sh` with these subcommands: `launch <instance>` starts the client on workspace 9,
> silent. `kill` stops the driver client. `shot <path>` captures the screen and copies it back.
> `env` prints the session environment. Derive the signature on the host with `hyprctl instances -j`.
> Never store it.
>
> Done when: launching, killing, and screenshotting need no inline environment triple. The wrapper
> carries no hardcoded signature.

## Research: how the nath host was driven before (opencode sessions)

Source: `~/.local/share/opencode/opencode.db`, sessions `ses_e4f1fb698` (project exploration, 171 nath
commands), `ses_e49cbde86` (B1 live wiring, 42), `ses_e53016416` (puppet proxy architecture, 34),
`ses_e49db0664` (driver UI, 14), `ses_e4ef9057b` (G0 controller, 8). 269 nath commands total.

Findings that shape the wrapper:

1. **Signature was copy-pasted.** One `hyprctl` output gave
   `efb509937…_1793801726_1661756444`; it was then pasted inline 59 times. It is also derivable from
   `ls /run/user/1000/hypr | head -1`, which is what the first session did.
2. **`hyprctl instances -j` needs no environment.** Verified live: `env -i /usr/bin/hyprctl instances -j`
   returns `[{instance, time, pid, wl_socket}]` on 0.56.2. `wl_socket` gives `WAYLAND_DISPLAY`.
3. **Hyprland 0.56.2 uses a Lua config; the legacy dispatcher syntax is gone.**
   `hyprctl dispatch movetoworkspacesilent "9,address:0x…"` fails with
   `')' expected near '9'` (exit 7). The working form is
   `hyprctl eval 'hl.dispatch(hl.dsp.window.move({workspace="9", follow=false, window="address:0x…"}))'`.
4. **Moving windows can switch the active workspace.** In one session, moving two Prism console
   windows left the active workspace on 9. Anything that moves windows must not assume it preserved focus.
5. **`grim` needs `WAYLAND_DISPLAY`.** With only `HYPRLAND_INSTANCE_SIGNATURE` and
   `XDG_RUNTIME_DIR` set, `grim` fails with `failed to create display`. The signature is not what
   grim needs; the Wayland socket is.
6. **`grim -g` cannot see a window on a hidden workspace.** Verified live: a red `kitty` on workspace 9,
   captured by geometry while workspace 3 was active, produced a picture of workspace 3.
7. **`pgrep -af gate-b-player` self-matches.** It matched the `ssh`/tailscaled/bash wrapper and the
   wrapper's own `bash -c` line. The precise anchor is the java classpath/library path:
   `-Djava.library.path=/home/bafbi/.local/share/PrismLauncher/instances/<instance>/natives`.
8. **Launching from the CLI raises Prism's own windows.** Prism's main window and its per-instance
   `Console window for <instance>` appear and take focus unless rules suppress them; the client needs
   `DISPLAY` (XWayland) or it crashes during init and Prism opens an error console.
9. **`hyprctl eval "hl.dispatch(hl.dsp.exec_cmd(cmd, rules))"` removes the triple entirely.** Verified
   live: the child inherits `DISPLAY=:0`, `WAYLAND_DISPLAY=wayland-1`, `XDG_RUNTIME_DIR=/run/user/1000`,
   `HYPRLAND_INSTANCE_SIGNATURE` from the compositor, and with
   `{workspace="9 silent", no_initial_focus=true, focus_on_activate=false}` a probe window landed on
   workspace 9 with the active workspace still 3 and T3 Code still focused.
10. **Host tooling:** `hyprctl`, `grim`, `jq`, `prismlauncher`, `scp`, `python3`, `wl-copy` exist.
    `kubectl` does not: RCON lives on the laptop side.
11. **jq traps:** `.title` can be `null`; `select(.class|test(…))` then throws
    `Cannot index string with string`. Use `(.class // "")` and `(.title // "")`.
12. **The driver socket is loopback-only** (`127.0.0.1:25599` on nath); the laptop reaches it through
    `ssh -N -L 25599:127.0.0.1:25599`.
13. **Host state at implementation time:** instances `gate-b-player`, `gate-b-player-fabric`,
    `gate-b-player-262` (plus the user's own). A `gate-b-player-262` client was running; the user was
    active on workspace 3 (T3 Code). Nothing here may steal focus or kill the wrong JVM.

## Research delegates (three lenses)

TBD

## Council

TBD

## Reviews

TBD

## Research delegates — adopted and dismissed

Three lenses ran on the queue (smaller, precedent, other). What I adopted:

- **Launch through the compositor, not through a derived triple** (all three, and the live probe):
  hl.dsp.exec_cmd with the workspace 9 silent rules gives the client the session environment for free.
- **Kill must not use a bare pgrep -f**: the pattern travels in the ssh argv. The wrapper sends the
  remote script on stdin, and the pattern is built from $HOME and $instance inside it.
- **The driver request travels over ssh -W**, so no node, python, or /dev/tcp is needed on the host,
  and the token stays on this side.
- **Shell lint**: bash -n in the lint task, because nothing covered shell before.
- **Do not refactor src/gate-b.js**: the runner is the validated G0 path. Recorded as a follow-up.
- **The kill anchor is a regex**: the whitelist allows dots, so they are escaped before pgrep.
  Adopted from the review, not the researchers.

What I dismissed, with reasons:

- **A node module under src/ with injected adapters**: the issue names a bash file, the host logic would
  still be shell text, and the repo has no precedent for host-only tooling under src/.
- **mise tasks per verb**: mise run forwards arguments badly and the wrapper parses its own.
- **grim for shot**: three of three council seats and the live probe say grim cannot see a window parked
  on workspace 9. See the council record.

## Council: how shot captures

Options put to the three seats: (A) grim of the client window, switching workspace and restoring;
(B) the driver screenshot op over the ssh forward, then scp; (C) grim of the active workspace, no
switching; (D) hybrid.

| Seat | Model | Vote | Why |
|---|---|---|---|
| Pragmatist | opencode-go/deepseek-v4.1-flash | B | The driver op and the scp copy already exist and are validated; the transport is shared with kill; A adds a workspace switch on the user's desktop for evidence grim cannot even give. |
| Architect | opencode-go/claude-haiku-5-5 | B | One seam (the driver socket) serves two verbs; a wrapper that returns a desktop grab under the name of a client screenshot is the lie to avoid. Condition: prove the render target works while the window is hidden on workspace 9. |
| Adversary | opencode-go/deepseek-v4.1-flash | B | A can exit 0 on a wrong capture (a valid PNG of workspace 3); D hides which truth you got. B fails closed. |

Verdict 3/3 for B. The architect's condition was met live on 2026-11-08: the client sat on workspace 9
with the user on workspace 2, and the driver returned a 1916x1050 PNG of the world. The issue's words
"captures the screen" are met as "the client's screen"; the doc says so. The unmodded witness lane keeps
its manual grim step.

## Deviations from the ticket

- launch takes optional prismlauncher arguments after the instance (-s, -a). The ticket's
  launch <instance> alone cannot reproduce the recorded launch, which always names a server.
- kill accepts an optional instance name and exits 0 when nothing runs. The argument keeps the fallback
  from reaching another instance.
- launch exits 1 when the active workspace moved, because the ticket's done-when says "silent".

## Proof (observed, 2026-11-08, host nath)

- tools/nath.sh env -> DISPLAY=:0, WAYLAND_DISPLAY=wayland-1, XDG_RUNTIME_DIR=/run/user/1000, and a
  signature the earlier sessions never saw.
- tools/nath.sh launch gate-b-player-fabric with DISPLAY, WAYLAND_DISPLAY, XDG_RUNTIME_DIR, and
  HYPRLAND_INSTANCE_SIGNATURE unset -> WORKSPACE=9, SILENT=yes, ACTIVE_WORKSPACE=2,
  FOCUSED=com.t3tools.T3Code, exit 0.
- tools/nath.sh shot testdata/nath-wrapper-2026-11-08.png, same scrubbed environment -> exit 0, driver
  path .../screenshots/gate-b-1794179840585.png, a 1916x1050 PNG copied back.
- tools/nath.sh kill gate-b-player-fabric -> QUIT=ok, STOPPED=12831, the driver port closed, no
  Monoplayer/Minecraft window left, active workspace still 2.

## Review

One review delegate (opencode-go/claude-haiku-5-5, run through the code-review skill over
4b07849..HEAD). Findings and their disposition:

| Finding | Disposition |
|---|---|
| Launch arguments reach the remote shell unquoted (ssh joins argv, so -a 'x;echo INJECTED' ran) | Fixed: the remote command is built with printf %q before it leaves this machine, plus a test that would have caught it. |
| launch exits 0 when the active workspace moved | Fixed: exit 1 with the message. |
| The launch tests only replay a canned reply | Fixed: the launch path now runs against a fake compositor (window wait, silent comparison, Lua build), and the argument-quoting case runs the transport. |
| An unreachable host leaks ssh exit 255 with no message | Fixed: exit 255 becomes "nath: cannot reach <host>", with a test. |
| hyprctl eval result ignored, so a refused launch waits 90 s | Fixed: exit 1 with the compositor's message. |
| tools/gate-b-driver/README.md still showed the inline triple | Fixed. |
| eval "$(tools/nath.sh env)" does not export | Fixed in the doc: the lines are for reading, prefix them with export. |
| install.sh prints a wrapper command without saying where it runs | Fixed: "launch, from the workspace:". |
| Commit message said "nine host-independent cases" for 19 | Fixed by rewriting the two commits before publishing. |
| src/gate-b.js still builds the triple | Recorded as a follow-up, not this ticket: the runner is the validated G0 path and changing it needs its own live 2/2 re-run. |
| The signature test matches a shape, not the historical value | Dismissed: the historical value lives only in untracked .scratch, so a test that names it would fail in CI. |
| Token not escaped in the JSON payload; shot leaves a non-PNG behind; pgrep pattern dots | Fixed: token escaped, the copy lands in .part and is moved only after the PNG check, instance dots escaped. |
