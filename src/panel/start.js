// The panel's in-cluster entrypoint.
//
//   node src/panel/start.js [--registry <file>] [--port <n>]
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
import fs from 'node:fs'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

import { parseRegistry } from './registry.js'
import { createPanelHandler } from './server.js'

// The port the Service targets. Not 25565: this is the one HTTP surface in the
// repo, and a Minecraft client must never be the thing that connects to it.
export const DEFAULT_PORT = 8080
// Where the kubelet projects the ConfigMap key. One key, one file.
export const DEFAULT_REGISTRY = '/etc/panel/registry/puppets.json'
// The identity the next tickets' write path will authenticate with. Read here so
// the start line says whether this pod can act at all, and never logged.
export const SERVICE_ACCOUNT_TOKEN = '/var/run/secrets/kubernetes.io/serviceaccount/token'
// How long a stop waits for an open response before it closes the socket anyway.
// A browser holding a keep-alive connection must not hold a rolling update open.
export const STOP_GRACE_MS = 5_000

const USAGE = 'usage: node src/panel/start.js [--registry <file>] [--port <n>]'

export function parseArgs (argv) {
  const options = { registry: DEFAULT_REGISTRY, port: DEFAULT_PORT }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg !== '--registry' && arg !== '--port') {
      throw new Error('unknown argument ' + JSON.stringify(arg) + '\n' + USAGE)
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(arg + ' needs a value\n' + USAGE)
    }
    index += 1
    if (arg === '--registry') {
      options.registry = value
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
// a log line, an error, or a returned value: the only question today is whether
// the next ticket's write path would be able to authenticate.
function hasServiceAccountToken (file) {
  try {
    return fs.readFileSync(file, 'utf8').trim() !== ''
  } catch {
    return false
  }
}

export async function startPanel ({ argv = [], io = process, tokenFile = SERVICE_ACCOUNT_TOKEN } = {}) {
  const options = parseArgs(argv)
  const stdout = io.stdout ?? process.stdout
  const log = (event, fields = {}) => {
    try {
      stdout.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
    } catch { /* a closed stdout must not take the panel down */ }
  }

  const read = () => {
    let text
    try {
      text = fs.readFileSync(options.registry, 'utf8')
    } catch (error) {
      throw new Error('registry: cannot read ' + options.registry + ': ' + error.message)
    }
    return parseRegistry(text)
  }
  // Fail fast, before the socket exists.
  const document = read()

  const server = http.createServer(createPanelHandler({ registry: read, log }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '0.0.0.0', () => {
      server.off('error', reject)
      resolve()
    })
  })
  const { port } = server.address()

  log('panelStart', {
    registry: options.registry,
    puppets: document.puppets.length,
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

  return { port, close }
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
