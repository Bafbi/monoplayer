// tools/nath.sh drives the driver display host from the workspace. Every call
// reaches the host through exactly two transports: ssh and, for the driver ops,
// scp. These tests replace both with shims, so nothing here opens a socket,
// reaches a compositor, or needs the host. The shims record the argv and stdin of
// every call — that is what the wrapper composes — and answer with the canned
// reply the host would have given.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'nath.sh')
const SIGNATURE = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef_1700000000_1000000000'
const SCREENSHOT_PATH = '/home/bafbi/.local/share/PrismLauncher/instances/gate-b-player-fabric/minecraft/screenshots/driver-1.png'

// One canned client window for the keeper process, on the given workspace.
const clientOn = (workspace, pid) => JSON.stringify([{ class: 'Minecraft 26.1.2', address: '0xdef', pid, mapped: true, workspace: { id: Number(workspace), name: String(workspace) } }])

const RECORD_SSH = `#!/usr/bin/env bash
{
  printf 'ARGV'
  for arg in "$@"; do printf '\t%s' "$arg"; done
  printf '\nSTDIN\n'
  cat
  printf '\nENDUSTIN\n'
} >> "$NATH_TEST_LOG"
case " $* " in
  *" -W "*) [ -f "$NATH_TEST_REPLY" ] && cat "$NATH_TEST_REPLY" ;;
  *) [ -f "$NATH_TEST_SCRIPT_REPLY" ] && cat "$NATH_TEST_SCRIPT_REPLY" ;;
esac
exit "$(cat "$NATH_TEST_EXIT" 2>/dev/null || echo 0)"
`

const EXEC_SSH = `#!/usr/bin/env bash
# A driver forward carries a payload on stdin and its answer back on stdout; the
# script path resolves the quoted command line the way the remote shell would.
if [ "$1" = "-W" ]; then
  {
    printf 'ARGV'
    for arg in "$@"; do printf '\\t%s' "$arg"; done
    printf '\\nSTDIN\\n'
    cat
    printf '\\nENDUSTIN\\n'
  } >> "$NATH_TEST_LOG"
  [ -f "$NATH_TEST_REPLY" ] && cat "$NATH_TEST_REPLY"
  exit "$(cat "$NATH_TEST_EXIT" 2>/dev/null || echo 0)"
fi
script=$(cat)
{
  printf 'ARGV'
  for arg in "$@"; do printf '\t%s' "$arg"; done
  printf '\nSTDIN\n%s\nENDUSTIN\n' "$script"
} >> "$NATH_TEST_LOG"
# The wrapper sends one quoted command line, exactly as ssh would. Re-split it
# the way the remote shell would, so an unquoted word would run for real here.
eval "set -- $1"
shift 3
exec bash -c "$script" bash "$@"
`

const RECORD_SCP = `#!/usr/bin/env bash
{
  printf 'ARGV'
  for arg in "$@"; do printf '\t%s' "$arg"; done
  printf '\nSTDIN\n\nENDUSTIN\n'
} >> "$NATH_TEST_LOG"
for last in "$@"; do :; done
target=$last
case "$NATH_TEST_SCP_MODE" in
  png|'') printf '\\x89PNG\\r\\n\\x1a\\n0000' > "$target" ;;
  text) printf 'not a png' > "$target" ;;
  fail) exit 1 ;;
esac
`

function writeScript (dir, name, body) {
  const file = path.join(dir, name)
  writeFileSync(file, body)
  chmodSync(file, 0o755)
  return file
}

// The fake jq answers the exact programs the wrapper runs. It never sees a
// program it does not know, so a new query in the wrapper fails loudly here.
const JQ = `#!/usr/bin/env node
const fs = require('node:fs')
const [, , flag, program] = process.argv
if (flag !== '-r') {
  console.error('fake jq: expected -r, got ' + flag)
  process.exit(1)
}
const input = fs.readFileSync(0, 'utf8')
const data = input.trim() === '' ? null : JSON.parse(input)
const out = (value) => process.stdout.write(value + '\\n')
if (program === 'length') out(process.env.FAKE_INSTANCE_COUNT)
else if (program === '.[0].instance') out(process.env.FAKE_SIGNATURE)
else if (program === '.[0].wl_socket') out(process.env.FAKE_WL_SOCKET)
else if (program === '.id') out(data.id)
else if (program === '.address') out(data.address)
else if (program === '(.class // "")') out(data.class ?? '')
else if (program.startsWith('.[] | select(.mapped')) {
  // The window list the launch reads: address, pid, workspace, mapped only.
  for (const client of data) {
    if (client.mapped === false) continue
    out(client.address + ' ' + client.pid + ' ' + client.workspace.name)
  }
} else {
  console.error('fake jq: unsupported program: ' + program)
  process.exit(1)
}
`
// Answers every hyprctl call the wrapper makes. The active workspace sequence is
// read one line per call, so a launch can be silent or not; the clients and the
// active window come from canned JSON.
const HYPRCTL = `#!/usr/bin/env bash
case "$1" in
  instances) exit "$FAKE_HYPRCTL_EXIT" ;;
  eval)
    printf '%s\\n' "$*" >> "$FAKE_HYPRCTL_EVAL_LOG"
    case "$FAKE_HYPRCTL_EVAL_MODE" in
      fail) echo "error: bad lua" >&2; exit 7 ;;
      fail-move)
        case "$*" in
          *window.move*) echo "error: move refused" >&2; exit 7 ;;
        esac
        ;;
    esac
    echo ok
    ;;
  activeworkspace)
    n=$(cat "$FAKE_AW_COUNT" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FAKE_AW_COUNT"
    printf '{"id":%s}\\n' "$(sed -n "$n"p "$FAKE_AW_SEQUENCE")"
    ;;
  activewindow) cat "$FAKE_ACTIVEWINDOW" ;;
  clients)
    n=$(cat "$FAKE_CLIENTS_COUNT" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$FAKE_CLIENTS_COUNT"
    file=$(sed -n "$n"p "$FAKE_CLIENTS_SEQUENCE")
    [ -n "$file" ] || file=$(tail -1 "$FAKE_CLIENTS_SEQUENCE")
    cat "$file"
    ;;
  *) echo "fake hyprctl: unsupported command: $*" >&2; exit 1 ;;
esac
`
// Answers the listening sockets the driver check asks about, in the shape ss
// prints with -p: the wrapper reads the pid out of users:(("java",pid=N,fd=K)).
const SS = `#!/usr/bin/env bash
[ -f "$FAKE_SS_REPLY" ] && cat "$FAKE_SS_REPLY"
exit 0
`

// One temp dir per test: the shims, the call log, and the canned replies.
function harness ({ sshBody = RECORD_SSH, host = {}, fake = true } = {}) {
  let stop = () => {}
  let pid = null
  const dir = mkdtempSync(path.join(tmpdir(), 'nath-'))
  const bin = path.join(dir, 'bin')
  mkdirSync(bin)
  const log = path.join(dir, 'calls.log')
  writeFileSync(log, '')
  const reply = path.join(dir, 'reply')
  const scriptReply = path.join(dir, 'script-reply')
  const exitFile = path.join(dir, 'exit')
  const env = {
    ...process.env,
    NATH_TEST_LOG: log,
    NATH_TEST_REPLY: reply,
    NATH_TEST_SCRIPT_REPLY: scriptReply,
    NATH_TEST_EXIT: exitFile,
    NATH_SSH: writeScript(bin, 'ssh', sshBody),
    NATH_SCP: writeScript(bin, 'scp', RECORD_SCP),
  }
  if (fake) {
    writeScript(bin, 'jq', JQ)
    writeScript(bin, 'hyprctl', HYPRCTL)
    writeScript(bin, 'ss', SS)
    const activeWindow = path.join(dir, 'activewindow.json')
    const workspaceSequence = path.join(dir, 'workspaces.txt')
    const clientsSequence = path.join(dir, 'clients-sequence.txt')
    // A real process whose command line carries the instance library path, so
    // the wrapper's pid check has something to match. t.after stops it; unref
    // keeps the test process from waiting on it.
    const keeper = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', 'nath-test', 'instances/gate-b-player-fabric/natives'], { stdio: 'ignore' })
    keeper.unref()
    stop = () => keeper.kill()
    pid = keeper.pid
    // One canned client list per hyprctl clients call, the last one repeating:
    // a launch reads the list while it waits, then reads it again to check the
    // placement it just asked for.
    const listed = typeof host.clients === 'function' ? host.clients(keeper.pid) : host.clients
    const lists = listed === undefined
      ? [JSON.stringify([{ class: 'Monoplayer Gate B', address: '0xabc', pid: keeper.pid, mapped: true, workspace: { id: 9, name: '9' } }])]
      : [listed].flat()
    const clientFiles = lists.map((json, index) => {
      const file = path.join(dir, `clients-${index + 1}.json`)
      writeFileSync(file, json)
      return file
    })
    // Who holds the driver port: the keeper by default, so a kill for the
    // instance it carries can use the quit op. A test can say nobody does.
    const ssReply = path.join(dir, 'ss.txt')
    writeFileSync(ssReply, host.driverHolder === 'none' ? '' : 'LISTEN 0 50 [::ffff:127.0.0.1]:25599 *:* users:(("java",pid=' + keeper.pid + ',fd=93))\n')
    writeFileSync(clientsSequence, clientFiles.join('\n') + '\n')
    writeFileSync(activeWindow, host.activeWindow ?? JSON.stringify({ class: 'com.t3tools.T3Code' }))
    // One workspace id per activeworkspace call: before the launch, then after.
    writeFileSync(workspaceSequence, (host.workspaces ?? ['2', '2']).join('\n') + '\n')
    Object.assign(env, {
      FAKE_INSTANCE_COUNT: host.count ?? '1',
      FAKE_SIGNATURE: host.signature ?? SIGNATURE,
      FAKE_WL_SOCKET: host.socket ?? 'wayland-1',
      FAKE_HYPRCTL_EXIT: String(host.hyprctlExit ?? 0),
      FAKE_HYPRCTL_EVAL_MODE: host.evalMode ?? 'ok',
      FAKE_HYPRCTL_EVAL_LOG: path.join(dir, 'eval.log'),
      FAKE_AW_COUNT: path.join(dir, 'aw-count'),
      FAKE_AW_SEQUENCE: workspaceSequence,
      FAKE_CLIENTS_SEQUENCE: clientsSequence,
      FAKE_CLIENTS_COUNT: path.join(dir, 'clients-count'),
      FAKE_ACTIVEWINDOW: activeWindow,
      FAKE_SS_REPLY: ssReply,
    })
    env.PATH = bin + ':' + env.PATH
  }
  return {
    dir,
    env,
    pid,
    stop: () => stop(),
    run: (args, extra = {}) => spawnSync(TOOL, args, { env: { ...env, ...extra }, encoding: 'utf8' }),
    answer: text => writeFileSync(reply, text),
    answerScript: text => writeFileSync(scriptReply, text),
    fail: code => writeFileSync(exitFile, String(code)),
    calls: () => parseCalls(readFileSync(log, 'utf8')),
  }
}

function parseCalls (text) {
  return text
    .split('\nENDUSTIN\n')
    .filter(block => block.trim() !== '')
    .map(block => {
      const [head, ...stdin] = block.split('\nSTDIN\n')
      return { argv: head.split('\t').slice(1), stdin: stdin.join('\nSTDIN\n') }
    })
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

test('bare invocation prints the usage on stderr and exits 2', () => {
  const h = harness()
  const run = h.run([])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /tools\/nath\.sh env/)
  assert.equal(h.calls().length, 0)
})

test('an unknown command exits 2 without calling the host', () => {
  const h = harness()
  const run = h.run(['screenshot'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /unknown command: screenshot/)
  assert.equal(h.calls().length, 0)
})

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

test('env derives the session values from hyprctl instances -j', () => {
  const h = harness({ sshBody: EXEC_SSH })
  const run = h.run(['env'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^NATH_HOST=bafbi@nath\.tail41e568\.ts\.net$/m)
  assert.match(run.stdout, /^WAYLAND_DISPLAY=wayland-1$/m)
  assert.match(run.stdout, new RegExp('^XDG_RUNTIME_DIR=/run/user/' + process.getuid() + '$', 'm'))
  assert.match(run.stdout, new RegExp('^HYPRLAND_INSTANCE_SIGNATURE=' + SIGNATURE + '$', 'm'))
  // The derivation is on the host, once per call: the script the wrapper sends
  // asks hyprctl, and no value was stored on this side.
  assert.match(h.calls()[0].stdin, /hyprctl instances -j/)
})

test('env fails when no Hyprland instance is running', () => {
  const h = harness({ sshBody: EXEC_SSH, host: { count: '0' } })
  const run = h.run(['env'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /no Hyprland instance is running on the host/)
})

test('env fails when hyprctl itself fails', () => {
  const h = harness({ sshBody: EXEC_SSH, host: { hyprctlExit: 1 } })
  const run = h.run(['env'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /hyprctl instances -j failed on the host/)
})

// ---------------------------------------------------------------------------
// launch
// ---------------------------------------------------------------------------

test('launch starts the instance with the compositor exec rules and passes the arguments through', () => {
  const h = harness()
  h.answerScript([
    'INSTANCE=gate-b-player-fabric',
    'WINDOW=0x55d3eff99680',
    'WORKSPACE=9',
    'SILENT=yes',
    'ACTIVE_WORKSPACE=3',
    'FOCUSED=com.t3tools.T3Code',
    '',
  ].join('\n'))
  const run = h.run(['launch', 'gate-b-player-fabric', '-s', 'monoplayer-gate-b-paper.tail41e568.ts.net:25565', '-a', 'Bafbi'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^SILENT=yes$/m)
  assert.match(run.stdout, /^FOCUSED=com\.t3tools\.T3Code$/m)

  const [call] = h.calls()
  // ssh joins its arguments into one remote command line, so the wrapper quotes
  // every word before it leaves this machine.
  assert.equal(call.argv.join(' ').trim(), 'bash -s -- gate-b-player-fabric -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi')
  assert.match(call.stdin, /hyprctl instances -j/)
  assert.match(call.stdin, /hl\.dsp\.exec_cmd/)
  assert.match(call.stdin, /workspace = \\"9 silent\\"/)
  assert.match(call.stdin, /no_initial_focus = true/)
  assert.match(call.stdin, /focus_on_activate = false/)
  assert.match(call.stdin, /launch="prismlauncher -l \$instance"/)
})

test('launch refuses an instance name that is not a bare name', () => {
  const h = harness()
  const run = h.run(['launch', 'gate-b-player-fabric; rm -rf ~'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /invalid instance name/)
  assert.equal(h.calls().length, 0)
})

test('launch needs an instance name', () => {
  const h = harness()
  const run = h.run(['launch'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /launch needs an instance name/)
  assert.equal(h.calls().length, 0)
})

test('launch reports the host refusal and exits 1', () => {
  const h = harness()
  h.fail(1)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
})


// ---------------------------------------------------------------------------
// kill
// ---------------------------------------------------------------------------

test('kill quits through the driver and reports no process left', (t) => {
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  h.answer('{"ok":true,"data":{"quitting":true}}')
  const run = h.run(['kill'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^QUIT=ok$/m)
  assert.match(run.stdout, /^STOPPED=$/m)

  // The port owner is asked first, then the quit goes over the forward, then
  // the anchor sweep finds nothing left.
  const [owner, quit, cleanup] = h.calls()
  assert.equal(owner.argv.join(' ').trim(), 'bash -s -- gate-b-player-fabric 25599')
  assert.ok(owner.stdin.includes('ss -ltnpH "sport = :$port"'), 'the check asks for the driver port')
  assert.deepEqual(quit.argv, ['-W', '127.0.0.1:25599'])
  assert.match(quit.stdin, /"op":"quit"/)
  assert.equal(cleanup.argv.join(' ').trim(), 'bash -s -- gate-b-player-fabric')
})

test('kill never asks the driver for another instance', (t) => {
  // The driver answers for whichever client holds the port, so the quit op has
  // to be gated: this kill is for the unmodded instance while the driver
  // belongs to the Fabric one.
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  const run = h.run(['kill', 'gate-b-player'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^QUIT=no$/m)

  const calls = h.calls()
  assert.equal(calls.some(call => call.argv.includes('-W')), false, 'no driver request is sent')
  assert.equal(calls[0].argv.join(' ').trim(), 'bash -s -- gate-b-player 25599')
  assert.equal(calls[1].argv.join(' ').trim(), 'bash -s -- gate-b-player')
})

test('kill does not ask the driver when no client holds the port', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { driverHolder: 'none' } })
  t.after(h.stop)
  h.answer('{"ok":true,"data":{"quitting":true}}')
  const run = h.run(['kill'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^QUIT=no$/m)
  assert.equal(h.calls().some(call => call.argv.includes('-W')), false, 'no driver request is sent')
})

test('kill falls back to the JVM anchor when the driver is not this instance', () => {
  const h = harness()
  h.answerScript('4242\n')
  const run = h.run(['kill', 'other-instance'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^QUIT=no$/m)
  assert.match(run.stdout, /^STOPPED=4242$/m)

  const [, cleanup] = h.calls()
  // The instance travels as an argument, never inside the script text, so the
  // pgrep pattern cannot match the shell that runs it.
  assert.equal(cleanup.argv.join(' ').trim(), 'bash -s -- other-instance')
  assert.match(cleanup.stdin, /pattern=\$\{instance\/\/\.\/\\\\\.\}/)
  assert.match(cleanup.stdin, /-Djava\.library\.path=\$HOME\/\.local\/share\/PrismLauncher\/instances\/\$pattern\/natives/)
})

test('kill says so when there is nothing to stop', () => {
  const h = harness()
  const run = h.run(['kill'])
  assert.equal(run.status, 0)
  assert.match(run.stdout, /^STOPPED=$/m)
  assert.match(run.stderr, /nothing to stop on gate-b-player-fabric/)
})

test('kill refuses an instance name that is not a bare name', () => {
  const h = harness()
  const run = h.run(['kill', 'bad/name'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /invalid instance name/)
  assert.equal(h.calls().length, 0)
})

// ---------------------------------------------------------------------------
// shot
// ---------------------------------------------------------------------------

test('shot asks the driver, copies the PNG back, and checks it is a PNG', () => {
  const h = harness()
  h.answer(JSON.stringify({ ok: true, data: { path: SCREENSHOT_PATH } }))
  const target = path.join(h.dir, 'shots', 'client.png')
  const run = h.run(['shot', target])
  assert.equal(run.status, 0, run.stderr)
  assert.equal(existsSync(target + '.part'), false, 'the .part file is gone after the move')
  assert.match(run.stdout, new RegExp('^PATH=' + target + '$', 'm'))
  assert.match(run.stdout, new RegExp('^REMOTE_PATH=' + SCREENSHOT_PATH + '$', 'm'))
  assert.match(run.stdout, /^BYTES=12$/m)

  const [request, copy] = h.calls()
  assert.deepEqual(request.argv, ['-W', '127.0.0.1:25599'])
  assert.match(request.stdin, /"op":"screenshot"/)
  assert.deepEqual(copy.argv, ['bafbi@nath.tail41e568.ts.net:' + SCREENSHOT_PATH, target + '.part'])
  assert.equal(readFileSync(target, 'latin1'), '\x89PNG\r\n\x1a\n0000')
})

test('shot surfaces the driver refusal and copies nothing', () => {
  const h = harness()
  h.answer('{"ok":false,"error":"not in a world"}')
  const run = h.run(['shot', path.join(h.dir, 'client.png')])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /not in a world/)
  assert.equal(h.calls().length, 1)
})

test('shot fails honestly when the driver is not listening', () => {
  const h = harness()
  const run = h.run(['shot', path.join(h.dir, 'client.png')])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /the driver is not answering on 127\.0\.0\.1:25599/)
})

test('shot rejects a copy that is not a PNG', () => {
  const h = harness()
  h.answer(JSON.stringify({ ok: true, data: { path: SCREENSHOT_PATH } }))
  const run = h.run(['shot', path.join(h.dir, 'client.png')], { NATH_TEST_SCP_MODE: 'text' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /not a PNG/)
})

test('shot needs a destination path', () => {
  const h = harness()
  const run = h.run(['shot'])
  assert.equal(run.status, 2)
  assert.match(run.stderr, /shot needs a destination path/)
  assert.equal(h.calls().length, 0)
})

// ---------------------------------------------------------------------------
// The issue's done-when conditions
// ---------------------------------------------------------------------------

test('the wrapper carries no stored signature', () => {
  const source = readFileSync(TOOL, 'utf8')
  assert.doesNotMatch(source, /[0-9a-f]{40}_[0-9]+_[0-9]+/)
  assert.doesNotMatch(source, /HYPRLAND_INSTANCE_SIGNATURE=I/)
  assert.match(source, /hyprctl instances -j/)
})

// ---------------------------------------------------------------------------
// launch, with the remote script actually executed against a fake compositor
// ---------------------------------------------------------------------------

test('launch builds the Lua, waits for the window, and reports a silent launch', (t) => {
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric', '-a', 'Bafbi'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^INSTANCE=gate-b-player-fabric$/m)
  assert.match(run.stdout, /^WINDOW=0xabc$/m)
  assert.match(run.stdout, /^WORKSPACE=9$/m)
  assert.match(run.stdout, /^SILENT=yes$/m)
  assert.match(run.stdout, /^ACTIVE_WORKSPACE=2$/m)
  assert.match(run.stdout, /^FOCUSED=com\.t3tools\.T3Code$/m)

  const lua = readFileSync(path.join(h.dir, 'eval.log'), 'utf8')
  assert.match(lua, /hl\.dsp\.exec_cmd\("prismlauncher -l gate-b-player-fabric -a Bafbi"/)
  assert.match(lua, /workspace = "9 silent"/)
  assert.match(lua, /no_initial_focus = true/)
  assert.match(lua, /focus_on_activate = false/)
})

test('launch fails when the launch moved the active workspace', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { workspaces: ['2', '9'] } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stdout, /^SILENT=no$/m)
  assert.match(run.stderr, /the launch switched the active workspace: 2 -> 9/)
  assert.match(run.stderr, /stop it with: tools\/nath\.sh kill gate-b-player-fabric/)
})

test('launch reports a client that took focus, and says where it is', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { activeWindow: JSON.stringify({ class: 'Minecraft 26.1.2', address: '0xabc' }) } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stdout, /^SILENT=no$/m)
  assert.match(run.stderr, /the client took focus; its window is on workspace 9/)
})

test('launch fails when the compositor refuses the Lua', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { evalMode: 'fail' } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /the compositor refused the launch: error: bad lua/)
})

test('launch fails when the client opens no window in the budget', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { clients: '[]' } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'], { NATH_LAUNCH_TIMEOUT: '1' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /opened no window carrying instances\/gate-b-player-fabric\/natives/)
})

test('launch moves a window that opened on another workspace and reports the launch silent', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { clients: (pid) => [clientOn(2, pid), clientOn(9, pid)] } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^WINDOW=0xdef$/m)
  assert.match(run.stdout, /^OPENED_WORKSPACE=2$/m)
  assert.match(run.stdout, /^WORKSPACE=9$/m)
  assert.match(run.stdout, /^SILENT=yes$/m)

  // The launch chunk, then the move: a silent move of the exact window, so no
  // other client can be picked up and the active workspace stays put.
  const chunks = readFileSync(path.join(h.dir, 'eval.log'), 'utf8').trim().split('\n')
  assert.equal(chunks.length, 2)
  assert.match(chunks[1], /hl\.dsp\.window\.move/)
  assert.match(chunks[1], /window = "address:0xdef"/)
  assert.match(chunks[1], /workspace = 9/)
  assert.match(chunks[1], /follow = false/)
})

test('launch leaves a window that already opened on workspace 9 where it is', (t) => {
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /^OPENED_WORKSPACE=9$/m)
  assert.match(run.stdout, /^SILENT=yes$/m)
  assert.doesNotMatch(readFileSync(path.join(h.dir, 'eval.log'), 'utf8'), /window\.move/)
})

test('launch names the workspace when the compositor refuses the move', (t) => {
  const h = harness({ sshBody: EXEC_SSH, host: { evalMode: 'fail-move', clients: (pid) => clientOn(2, pid) } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /refused to move 0xdef from workspace 2: error: move refused/)
})

test('launch fails when the window stays off workspace 9 after the move', (t) => {
  // eval answers ok even when the dispatcher found no window, so the placement
  // is read back rather than trusted.
  const h = harness({ sshBody: EXEC_SSH, host: { clients: (pid) => [clientOn(2, pid), clientOn(2, pid)] } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /0xdef is on workspace 2, not 9, after the move/)
})

test('launch says so when it cannot read the placement after the move', (t) => {
  // The second list is empty: the client quit between the wait and the check.
  const h = harness({ sshBody: EXEC_SSH, host: { clients: (pid) => [clientOn(2, pid), '[]'] } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /cannot read the workspace of 0xdef after the move/)
})

test('launch ignores a window whose process is not the instance', (t) => {
  // Another instance's client on workspace 9 must not stand in for this one.
  const h = harness({ sshBody: EXEC_SSH, host: { clients: () => JSON.stringify([{ class: 'Minecraft 26.1.2', address: '0xfff', pid: process.pid, mapped: true, workspace: { id: 9, name: '9' } }]) } })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric'], { NATH_LAUNCH_TIMEOUT: '1' })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /opened no window carrying instances\/gate-b-player-fabric\/natives/)
})
test('an unreachable host says so instead of leaking ssh exit 255', () => {
  const h = harness()
  h.fail(255)
  const run = h.run(['launch', 'gate-b-player-fabric'])
  assert.equal(run.status, 1)
  assert.match(run.stderr, /cannot reach bafbi@nath\.tail41e568\.ts\.net/)
})

test('launch argument quoting survives the transport', (t) => {
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric', '-a', 'x;echo INJECTED'])
  assert.equal(run.status, 0, run.stderr)
  assert.doesNotMatch(run.stdout, /INJECTED/)
  assert.match(run.stdout, /^INSTANCE=gate-b-player-fabric$/m)
  // The argument reached the launch line quoted, not as shell text.
  const lua = readFileSync(path.join(h.dir, 'eval.log'), 'utf8')
  // printf %q turned the argument into x\;echo\ INJECTED, and the Lua string
  // doubled each backslash, so the host shell sees one literal argument.
  assert.ok(lua.includes('x\\\\;echo\\\\ INJECTED'), lua)
})

test('a command substitution in an argument stays text', (t) => {
  const h = harness({ sshBody: EXEC_SSH })
  t.after(h.stop)
  const run = h.run(['launch', 'gate-b-player-fabric', '-a', '$(id)'])
  assert.equal(run.status, 0, run.stderr)
  const lua = readFileSync(path.join(h.dir, 'eval.log'), 'utf8')
  // printf %q escaped the argument, and the Lua string doubled each backslash,
  // so the host shell receives one literal argument instead of a substitution.
  assert.ok(lua.includes('\\\\$\\\\(id\\\\)'), lua)
  assert.doesNotMatch(run.stdout, /uid=/)
})
