// RCON adapter for the Paper backend. Commands run through
//
//   kubectl -n <namespace> exec deploy/<deployment> -- rcon-cli "<command>"
//
// so no server credentials ever appear in code, on this command line, or in
// reports; rcon-cli reads its config inside the pod. The namespace is the run's gate
// lane (#282): the caller's, GATEB_RCON_NAMESPACE, or the lane this worktree derives,
// and src/driver/lane.js is the only place that answers it. The deployment is
// configurable for testing and re-use. The adapter returns records
// `{ ok, output, command, durationMs, label, kind }` and never throws.
//
// Op classification lives with the caller: helpers below tag setup vs
// assertion vs probe, and the scenario executor records the tag.
import { execFile } from 'node:child_process'
import { resolveGateLane } from './lane.js'

export function blockIfCommand (x, y, z, block) {
  return `execute if block ${x} ${y} ${z} ${block}`
}

export function blockUnlessCommand (x, y, z, block) {
  return `execute unless block ${x} ${y} ${z} ${block}`
}

export function createRcon ({
  // No literal lane here. A default that typed one administered the lane that
  // shipped while the run measured its own, and nothing said so (#282).
  namespace = process.env.GATEB_RCON_NAMESPACE || resolveGateLane(),
  deployment = process.env.GATEB_RCON_DEPLOYMENT || 'paper',
  timeoutMs = Number(process.env.GATEB_RCON_TIMEOUT_MS || 20000),
  exec = defaultExec,
} = {}) {
  async function run (command, { label = '', kind = 'probe', timeoutMs: timeout = timeoutMs } = {}) {
    const args = ['-n', namespace, 'exec', `deploy/${deployment}`, '--', 'rcon-cli', command]
    const startedAt = Date.now()
    try {
      const { stdout, stderr } = await exec(args, timeout)
      return {
        ok: true,
        output: String(stdout).trim(),
        stderr: String(stderr).trim(),
        command, label, kind,
        durationMs: Date.now() - startedAt,
      }
    } catch (error) {
      const detail = error && error.message ? error.message : String(error)
      return {
        ok: false,
        output: error && error.stdout ? String(error.stdout).trim() : '',
        stderr: error && error.stderr ? String(error.stderr).trim() : detail,
        command, label, kind,
        durationMs: Date.now() - startedAt,
      }
    }
  }

  // ---- setup (mutating world-state prep) ----
  const setblock = (x, y, z, block) => run(`setblock ${x} ${y} ${z} ${block}`, { kind: 'setup', label: 'setblock' })
  const fill = (x1, y1, z1, x2, y2, z2, block) =>
    run(`fill ${x1} ${y1} ${z1} ${x2} ${y2} ${z2} ${block}`, { kind: 'setup', label: 'fill' })
  const tp = (name, x, y, z) => run(`tp ${name} ${x} ${y} ${z}`, { kind: 'setup', label: 'tp' })
  const give = (name, item, count = 1) => run(`give ${name} ${item} ${count}`, { kind: 'setup', label: 'give' })

  // ---- assertions (positive tests; see checks.parseBlockTest) ----
  const assertBlockIs = (x, y, z, block) => run(blockIfCommand(x, y, z, block), { kind: 'assertion', label: 'block-is' })
  const assertBlockIsNot = (x, y, z, block) => run(blockUnlessCommand(x, y, z, block), { kind: 'assertion', label: 'block-is-not' })

  // ---- probes (read-only reads) ----
  const list = () => run('list', { kind: 'probe', label: 'list' })
  const getEntityPos = name => run(`data get entity ${name} Pos`, { kind: 'probe', label: 'pos' })
  const getEntityRotation = name => run(`data get entity ${name} Rotation`, { kind: 'probe', label: 'rotation' })
  const getEntityDimension = name => run(`data get entity ${name} Dimension`, { kind: 'probe', label: 'dimension' })

  return {
    namespace, deployment, timeoutMs,
    run, setblock, fill, tp, give,
    assertBlockIs, assertBlockIsNot,
    list, getEntityPos, getEntityRotation, getEntityDimension,
  }
}

// Default child_process wrapper: (args, timeoutMs) -> Promise<{stdout, stderr}>.
function defaultExec (args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile('kubectl', args, { timeout: timeoutMs + 5000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
      } else {
        resolve({ stdout, stderr })
      }
    })
  })
}
