// The one place a driver run names its gate lane (#282).
//
// A lane is not a constant. One worktree gets one lane, derived from its short commit
// and a short hash of its path (#279), and scripts/gate-lane.sh owns that name: it
// derives the lane, honours MONOPLAYER_GATE_NAMESPACE when an operator names one, and
// refuses a name that is not a gate lane. This module is the driver's only reader of
// it, so the RCON target and the address a client joins cannot name different lanes.
//
// They did once: backends.js exported a literal lane and rcon.js and run.js defaulted
// to the same string, so a renamed lane's scenario administered the lane that
// shipped while the run believed it was measuring its own (#282).
//
// Nothing runs at import: the resolver asks the script once, when a default needs it,
// and a refusal is the script's own sentence.
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const GATE_LANE_SCRIPT = path.join(ROOT, 'scripts', 'gate-lane.sh')

// The tailnet this repo's cluster is on. It is one constant here rather than a
// hostname per caller: the lane names the host, the tailnet names the domain.
export const TAILNET = 'tail41e568.ts.net'

// A lane this driver could not name. The message is scripts/gate-lane.sh's own
// sentence, because that script knows what a reader has to do next.
export class LaneError extends Error {
  constructor (message) {
    super(message)
    this.name = 'LaneError'
  }
}

// Ask the one owner. Its refusal is written to stderr, so it is not swallowed by the
// capture: a command substitution would keep it out of the run's own output too.
function askGateLane (env) {
  const result = spawnSync('bash', [GATE_LANE_SCRIPT, 'name'], {
    encoding: 'utf8',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error) {
    throw new LaneError(`cannot run ${GATE_LANE_SCRIPT}: ${result.error.message}`)
  }
  if (result.status !== 0) {
    const said = String(result.stderr || '').trim() || String(result.stdout || '').trim()
    throw new LaneError(said || `${GATE_LANE_SCRIPT} name exited ${result.status} without saying why`)
  }
  const namespace = String(result.stdout || '').trim()
  if (namespace === '') {
    throw new LaneError('scripts/gate-lane.sh name printed no lane, and a run that cannot name its lane administers nobody\'s')
  }
  return namespace
}

// The lane, one line: this worktree's, or the one an operator named. The process's
// own environment is answered once, because the lane is a fact about the checkout and
// not about the call.
let cached = null
export function resolveGateLane ({ env = process.env, exec = askGateLane } = {}) {
  if (exec === askGateLane && env === process.env && cached !== null) return cached
  const namespace = exec(env)
  if (exec === askGateLane && env === process.env) cached = namespace
  return namespace
}

// The tailnet name the lane publishes for one workload: the tree renders
// monoplayer-gate-<instance>-<workload> on the Service that carries it.
export function tailnetHost (namespace, workload) {
  return `${namespace}-${workload}.${TAILNET}`
}

// What a client on the display host joins for the lane's Paper.
export function paperAddress (namespace, port = 25565) {
  return `${tailnetHost(namespace, 'paper')}:${port}`
}

// The lane a tailnet address belongs to, or null when the address is an address and
// not a lane: a tunnel, a port-forward, an IP. The tree renders
// monoplayer-gate-<instance>-paper on the Service that publishes each lane's Paper.
const LANE_HOST = new RegExp('^(monoplayer-gate-.+)-paper\\.' + TAILNET.replace(/\./g, '\\.') + '$')

export function laneOfAddress (address) {
  const match = LANE_HOST.exec(String(address).split(':')[0])
  return match === null ? null : match[1]
}

// The two targets one driver run fills from the lane: the address a client joins and
// the namespace RCON administers. Or the sentence that stops the run.
//
// --server and --rcon-namespace are the caller's overrides, not second lanes: a run
// handed both goes where it was told, which is what #301 kept for --backend-host. A
// run handed one of them, where the other would be this lane's, names two lanes when
// they disagree, so it refuses instead of picking one. A tunnel or a port-forward is
// an address and not a lane, so it never disagrees.
export function laneTargets (lane, { server = '', rconNamespace = '' } = {}) {
  if (rconNamespace !== '' && server === '' && rconNamespace !== lane) {
    return {
      refused: `GATEB_RCON_NAMESPACE names "${rconNamespace}" and this worktree's lane is "${lane}". One run names one lane: pass --server too if the client should join the other one`,
    }
  }
  const serverLane = laneOfAddress(server)
  if (rconNamespace === '' && serverLane !== null && serverLane !== lane) {
    return {
      refused: `--server names "${serverLane}" and this worktree's lane is "${lane}". One run names one lane: pass --rcon-namespace too if RCON should administer the other one`,
    }
  }
  return { server: server || paperAddress(lane), rconNamespace: rconNamespace || lane }
}
