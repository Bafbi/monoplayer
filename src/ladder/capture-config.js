// Capture a real server's configuration phase as a fixture the front can serve.
//
//   node src/ladder/capture-config.js --host <h> --port <n> --out <file>
//                                    [--version 26.2] [--account glowsquidye]
//                                    [--offline] [--timeout 120] [--lane <ns>]
//                                    [--paper-build <n>] [--image <ref>]
//                                    [--reached-via <how>] [--note <why>]
//
// The front leg serves a configuration phase of its own when no backend is
// connected (the picker, #257). It cannot invent that phase: minecraft-protocol
// writes registry frames only from `options.registryCodec`, and the registry it
// can write is the one vendored in minecraft-data, which is a copy of the
// 1.20.5 login codec. It carries no registry tags, and for 26.2 it is one
// registry short of what a server sends (`minecraft:sulfur_cube_archetype`).
// Serving it fails the client's registry loading, which is recorded at
// src/legs/live-front.js (the comment on `allowLibraryFallback`) and in
// docs/product-core.md.
//
// So the phase is recorded from a server this repository deploys, byte for byte,
// and the fixture is that recording. Every frame is a frame a real client
// received from Paper, so a client that accepts Paper accepts the fixture.
//
// What is dropped, and why: `keep_alive` and `ping` belong to one connection and
// are reissued by each leg that owns a socket (`clientboundPolicy` calls them
// per-leg). Replaying a stale keep-alive would put a dead id in the front
// client's hands.
//
// A capture from the gate lane needs its own server, because the gate Paper is
// online-mode and this repository does not refresh the puppet's token as a side
// effect of a capture:
//
//   kubectl -n monoplayer-gate-b apply -f .scratch/capture-paper.yaml  # gate image, online-mode off
//   kubectl -n monoplayer-gate-b port-forward pod/capture-paper 25599:25565
//   node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --offline \
//     --note 'online-mode is off: the puppet token is expired and a refresh is a human decision' \
//     --out src/legs/configuration-baseline/26.2.json
//   kubectl -n monoplayer-gate-b delete pod capture-paper
//
// When the puppet's token is valid, scripts/online-cluster.sh runs the same
// module in the cluster against the gate Paper with a real account:
//
//   mise run gate:up
//   scripts/online-cluster.sh --rung src/ladder/capture-config.js --keep-pod
//   kubectl -n monoplayer cp <pod>:/work/config-baseline.json <fixture>
//   mise run gate:down
//
// Exit codes: 0 a capture was written, 1 the join failed, 2 setup failed.
import fs from 'node:fs'

import md from 'minecraft-data'

import { flag } from '../service/cli.js'
import { createBot } from './bot.js'
import { resolveBotIdentity } from './observer-baseline.js'

// A connection's own frames. See the header: a replay of either would address a
// conversation this leg never had.
const PER_LEG = new Set(['keep_alive', 'ping'])

const DEFAULT_OUT = 'config-baseline.json'
const DEFAULT_VERSION = process.env.MONOPLAYER_VERSION || '26.2'
// What the recorded server is when the flags are not given: the gate lane's own
// Paper (deploy/driver/paper.yaml), because that is the server a refresh records.
// A capture from anywhere else passes its own values.
const DEFAULT_LANE = process.env.MONOPLAYER_GATE_NAMESPACE || 'monoplayer-gate-b'
const DEFAULT_PAPER_BUILD = '135'
const DEFAULT_IMAGE = 'itzg/minecraft-server:2026.10.1-java25'

function fail (message, code = 2) {
  process.stderr.write('capture-config: ' + message + '\n')
  process.exit(code)
}

async function main (argv) {
  const host = flag(argv, '--host') ?? process.env.MONOPLAYER_BACKEND_HOST ?? '127.0.0.1'
  const port = Number(flag(argv, '--port') ?? process.env.MONOPLAYER_BACKEND_PORT ?? 25565)
  const version = flag(argv, '--version') ?? DEFAULT_VERSION
  const out = flag(argv, '--out') ?? DEFAULT_OUT
  const selector = flag(argv, '--account') ?? process.env.MONOPLAYER_CAPTURE_ACCOUNT ?? 'glowsquidye'
  const offline = argv.includes('--offline')
  const timeout = Number(flag(argv, '--timeout') ?? 120_000)
  // Provenance, so a reader can tell how the fixture was reached and how to reach
  // it again: the lane and the Paper build are what make the recording checkable.
  const lane = flag(argv, '--lane') ?? DEFAULT_LANE
  const paperBuild = flag(argv, '--paper-build') ?? DEFAULT_PAPER_BUILD
  const image = flag(argv, '--image') ?? DEFAULT_IMAGE
  const reachedVia = flag(argv, '--reached-via') ?? ('kubectl -n ' + lane + ' port-forward pod/capture-paper ' + port + ':25565')
  const note = flag(argv, '--note') ?? null
  if (!Number.isInteger(port) || port <= 0) fail('bad port: ' + port)

  const data = md(version)
  if (data === null) fail('no protocol data for ' + version)

  let identity
  try {
    identity = offline
      ? { auth: 'offline', username: 'CaptureBot', account: null }
      : resolveBotIdentity({ selector })
  } catch (error) {
    fail(String(error?.message ?? error))
  }

  process.stdout.write('capture-config: joining ' + host + ':' + port + ' as ' + identity.username + ' (' + version + ', ' + identity.auth + ')\n')

  const frames = []
  const bot = createBot({
    host,
    port,
    version,
    username: identity.username,
    auth: identity.auth,
    profilesFolder: identity.profilesFolder ?? null,
    authTitle: identity.authTitle ?? null,
    deviceType: identity.deviceType ?? null,
    logStream: { write: () => {} }
  })

  // The raw buffer is the frame the leg replays: packet id plus payload,
  // decompressed and unframed, which is what writeRaw takes.
  bot.client.on('raw', (buffer, meta) => {
    if (meta.state !== 'configuration') return
    if (PER_LEG.has(meta.name)) return
    frames.push({ state: meta.state, name: meta.name, bytes: buffer.toString('base64') })
  })

  let closed = false
  const finish = async (code, message) => {
    if (closed) return
    closed = true
    if (message) process.stderr.write('capture-config: ' + message + '\n')
    try { await bot.close() } catch { /* already gone */ }
    process.exit(code)
  }

  const timer = setTimeout(() => {
    finish(1, 'no finish_configuration within ' + timeout + ' ms; ' + frames.length + ' configuration frames recorded')
  }, timeout)

  await bot.waitFor(
    () => frames.some(frame => frame.name === 'finish_configuration'),
    'the configuration phase of the backend',
    timeout
  ).then(() => {
    clearTimeout(timer)
    const document = {
      // What the recording is, so a reader can refresh it and know when it is old.
      version,
      protocolVersion: data.version.version,
      capturedFrom: {
        kind: 'paper',
        version,
        paperBuild,
        image,
        lane,
        host,
        port,
        reachedVia,
        at: new Date().toISOString(),
        note,
        command: 'node src/ladder/capture-config.js --host ' + host + ' --port ' + port +
          (offline ? ' --offline' : '') + ' --out <fixture>'
      },
      // Every clientbound configuration frame, in the order the server sent it.
      frames
    }
    fs.writeFileSync(out, JSON.stringify(document, null, 2) + '\n')
    const bytes = frames.reduce((sum, frame) => sum + Buffer.from(frame.bytes, 'base64').length, 0)
    process.stdout.write('capture-config: wrote ' + out + ': ' + frames.length + ' frames, ' + bytes +
      ' bytes, registries ' + frames.filter(frame => frame.name === 'registry_data').length + '\n')
    finish(0, null)
  }).catch(error => {
    clearTimeout(timer)
    finish(1, String(error?.message ?? error))
  })
}

main(process.argv.slice(2)).catch(error => fail(String(error?.message ?? error), 1))
