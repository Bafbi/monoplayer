// The panel's in-cluster entrypoint.
//
//   node src/panel/start.js [--registry <file>] [--port <n>] [--host <address>]
//   node src/panel/start.js --fixture <file> [--port <n>] [--host <address>]
//
// It is a second entrypoint on the same image as the proxy: the Dockerfile CMD
// runs src/service/monoplayer.js, and the panel Deployment overrides the command.
// One image, two programs, so a panel cannot run a different version of the code
// that reads the registry than the one that was built for it.
//
// The registry is read once here and on every request. Once, because a document
// the panel cannot parse must fail the pod instead of the first visitor: a green
// rollout that serves "registry: puppets[0].backend must be host:port" is a
// deploy that passed and a panel that does not work. On every request, because the
// kubelet rewrites a mounted ConfigMap in place, so an operator's edit reaches the
// page within a minute and needs no restart.
//
// `--registry` takes either a mounted `puppets.json` (a pod) or the ConfigMap
// itself (a checkout): src/panel/registry.js reads both shapes through one
// function. Locally:
//
//   node src/panel/start.js --registry deploy/panel/registry.yaml --port 8080
//
// Flags, not environment variables: src/service/start-live.js is the one module
// that reads MONOPLAYER_* out of the environment, and the panel does not widen
// that. A panel Deployments sets its flags in the manifest, where a reader of the
// diff sees them.
//
// `--fixture` serves a recorded document instead of the cluster (#248), so a branch
// can be rendered and screenshotted before it is merged. It REFUSES to start when
// the in-cluster ServiceAccount token is mounted: a fixture is a development tool,
// and a pod that served one would be a panel showing a recording while the lane it
// is supposed to describe runs on. That is the one failure this mode must make
// impossible, so the check is on the start path and it runs before the socket
// exists.
import fs from 'node:fs'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { redact } from '../observability/redact.js'
import { parseFixture } from './fixture.js'
import { createKubeClient } from './kube.js'
import { parseRegistry } from './registry.js'
import { createPanelHandler } from './server.js'

// The port the Service targets. Not 25565: this is the one HTTP surface in the
// repo, and a Minecraft client must never be the thing that connects to it.
export const DEFAULT_PORT = 8080
// Where the kubelet projects the ConfigMap key. One key, one file.
export const DEFAULT_REGISTRY = '/etc/panel/registry/puppets.json'
// Where the kubelet projects the identity the panel authenticates with: the start
// line says whether this pod can act at all (#233), and the value never reaches a
// log, an error, or a return. src/panel/kube.js reads it per request, because the
// kubelet rotates it.
export const SERVICE_ACCOUNT_TOKEN_FILE = '/var/run/secrets/kubernetes.io/serviceaccount/token'
// How long a stop waits for an open response before it closes the socket anyway.
// A browser holding a keep-alive connection must not hold a rolling update open.
export const STOP_GRACE_MS = 5_000

const USAGE = 'usage: node src/panel/start.js [--registry <file>] [--port <n>] [--host <address>]\n' +
  '       node src/panel/start.js --fixture <file> [--port <n>] [--host <address>]'

// The pod binds every interface, because a Service targets the pod IP and not its
// loopback. A run on a workstation binds loopback instead, which is what
// `mise run panel:run` asks for: the panel's one documented ingress is the tailnet
// Service, and a laptop must not publish it on a LAN as a side effect of trying it.
export const DEFAULT_HOST = '0.0.0.0'

export function parseArgs (argv) {
  const options = { registry: DEFAULT_REGISTRY, fixture: null, port: DEFAULT_PORT, host: DEFAULT_HOST }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--registry' && arg !== '--fixture' && arg !== '--port' && arg !== '--host') {
      throw new Error('unknown argument ' + JSON.stringify(arg) + '\n' + USAGE)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(arg + ' needs a value\n' + USAGE)
    }
    index += 1
    // One source of facts, named once. Two would leave the panel reading a
    // recording for the page and a cluster for a write, which is the shape of a
    // page that cannot be trusted.
    if (arg === '--fixture') {
      if (options.fixture !== null) throw new Error('--fixture is given twice\n' + USAGE)
      if (options.registry !== DEFAULT_REGISTRY) {
        throw new Error('--fixture and --registry name two sources, and the panel reads one\n' + USAGE)
      }
      options.fixture = value
      continue
    }
    if (arg === '--registry') {
      if (options.fixture !== null) {
        throw new Error('--fixture and --registry name two sources, and the panel reads one\n' + USAGE)
      }
      options.registry = value
      continue
    }
    if (arg === '--host') {
      // An address, not a name to resolve: the two values in use are the wildcard
      // the pod needs and the loopback a workstation uses.
      if (value.trim() === '' || /\s/.test(value)) {
        throw new Error('--host must be an address, not ' + JSON.stringify(value) + '\n' + USAGE)
      }
      options.host = value
      continue
    }
    // 0 is allowed: it asks the kernel for a free port, which is what a test
    // does. A deployed panel names 8080 in its manifest.
    const port = Number(value)
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error('--port must be an integer between 0 and 65535, not ' + JSON.stringify(value) + '\n' + USAGE)
    }
    options.port = port
  }
  return options
}

// Whether this pod has an identity mounted. The token itself is never read into
// a log line, an error, or a returned value: the question is whether the write path
// can authenticate, and a start line that says false is a panel whose first move
// will answer 503.
function hasServiceAccountToken (file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() !== ''
  } catch {
    return false
  }
}

// The registry file, re-read on every request: the kubelet rewrites a mounted
// ConfigMap in place, so a read at start would show the old document until the pod
// restarted.
function registryReader (file) {
  return () => {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error('registry: cannot read ' + file + ': ' + error.message)
    }
    return parseRegistry(text)
  }
}

// The recorded document, re-read on every request too, and for a second reason:
// rewriting the file is how the stream is shown to update. The panel never writes
// it, and the page says nothing about where the facts came from, because a fixture
// is a development aid and not a state the product has.
function fixtureReader (file) {
  const load = () => {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error('fixture: cannot read ' + file + ': ' + error.message)
    }
    return parseFixture(text)
  }
  return {
    registry: () => load().registry,
    facts: name => {
      const found = load().facts.get(name)
      return found ?? null
    }
  }
}

export async function startPanel ({
  argv = [],
  io = process,
  tokenFile = SERVICE_ACCOUNT_TOKEN_FILE,
  // #231: the read path to the API server. Injected for the same reason the
  // registry is: a test hands in a function that answers for a Deployment, a pod
  // list, and a log, and the routes cannot tell it from the cluster.
  kubernetes = createKubeClient()
} = {}) {
  const options = parseArgs(argv)
  const stdout = io.stdout ?? process.stdout
  // The same redaction every other line in this repo passes through
  // (src/observability/redact.js): a second log writer is not a reason for a
  // second rule, and the next field someone adds here is the one that matters.
  const log = (event, fields = {}) => {
    try {
      stdout.write(redact(JSON.stringify({ t: new Date().toISOString(), event, ...fields })) + '\n')
    } catch { /* a closed stdout must not take the panel down */ }
  }

  const fixture = options.fixture === null ? null : fixtureReader(options.fixture)
  // The fence, and it is first: a pod must never serve a recording. The token is
  // the one thing a fixture host does not have and a pod always does.
  if (fixture !== null && hasServiceAccountToken(tokenFile)) {
    throw new Error('--fixture refuses to start: ' + tokenFile + ' holds a ServiceAccount token, ' +
      'so this process is in a pod. A fixture is a development document, and a panel that served one ' +
      'beside a running lane would be showing a recording instead of the lane')
  }

  // Fixture mode reads the recording on every request, exactly as the registry is
  // read, so an edit to the file reaches an open page on its next tick.
  const read = fixture === null ? registryReader(options.registry) : fixture.registry
  const recorded = fixture === null ? null : fixture.facts
  // A fixture has no cluster: the write routes answer 503 "no cluster client"
  // rather than pretending to have written something.
  const client = fixture === null ? kubernetes : null

  // Fail fast, before the socket exists.
  const document = read()

  const server = http.createServer(createPanelHandler({ registry: read, kubernetes: client, recorded, log }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { address: host, port } = server.address()

  log('panelStart', {
    // Which document the facts come from, named once. A fixture says so in the
    // first line, so a log with a fake heartbeat in it is not mistaken for a lane.
    ...(fixture === null ? { registry: options.registry } : { fixture: options.fixture }),
    puppets: document.puppets.length,
    host,
    port,
    serviceAccountToken: hasServiceAccountToken(tokenFile)
  })

  let closing = null
  const close = () => {
    if (closing !== null) return closing
    closing = new Promise(resolve => {
      const timer = setTimeout(() => {
        server.closeAllConnections?.()
        resolve()
      }, STOP_GRACE_MS)
      timer.unref?.()
      server.close(() => {
        clearTimeout(timer)
        resolve()
      })
      server.closeIdleConnections?.()
    }).then(() => { log('panelStop', { port }) })
    return closing
  }

  return { host, port, close }
}

export async function main ({ argv = process.argv.slice(2), io = process } = {}) {
  const stderr = io.stderr ?? process.stderr
  let panel
  try {
    panel = await startPanel({ argv, io })
  } catch (error) {
    stderr.write('monoplayer panel: ' + String(error?.message ?? error) + '\n')
    return 2
  }

  // A stop is graceful and bounded: the page in flight finishes, and a socket
  // that will not close is closed at STOP_GRACE_MS. The process exits because the
  // server it was serving on is gone, not because it calls process.exit here.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      panel.close().then(() => { process.exitCode = 0 }, () => { process.exitCode = 1 })
    })
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code })
}
