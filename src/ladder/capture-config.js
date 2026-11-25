// Capture a real server's configuration phase as a fixture the front can serve.
//
//   node src/ladder/capture-config.js --host <h> --port <n> --paper-build <n> --out <file>
//                                    [--image <ref>] [--version 26.2]
//                                    [--account glowsquidye] [--offline]
//                                    [--timeout 120] [--lane <lane>]
//                                    [--reached-via <how>] [--note <why>]
//
// What the fixture may claim (#367). `capturedFrom` records provenance the capture
// had. The build and the image are named by the operator and never defaulted, because
// no frame a client receives carries either. Paper answers a status ping with
// `serverModName() + ' ' + serverVersion()`, which is "Paper 26.2" and no build
// (PaperServerListPingEventImpl, paper-server). A container image is packaging the
// server never sends. So a capture with no --paper-build stops before the join, and one
// that names no --image records `image: null`, which says nobody named one. The
// recorded command carries every flag that decided the recording. A reader who repeats
// it reaches the same lane, build and image from another worktree.
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
//   kubectl -n "$(scripts/gate-lane.sh name)" apply -f .scratch/capture-paper.yaml  # gate image, online-mode off
//   kubectl -n "$(scripts/gate-lane.sh name)" port-forward pod/capture-paper 25599:25565
//   node src/ladder/capture-config.js --host 127.0.0.1 --port 25599 --offline \
//     --paper-build 135 --image itzg/minecraft-server:2026.10.1-java25 \
//     --note 'online-mode is off: the puppet token is expired and a refresh is a human decision' \
//     --out src/legs/configuration-baseline/26.2.json
//   kubectl -n "$(scripts/gate-lane.sh name)" delete pod capture-paper
//
// When the puppet's token is valid, scripts/online-cluster.sh runs the same
// module in the cluster against the gate Paper with a real account:
//
//   mise run gate:up
//   scripts/online-cluster.sh --rung src/ladder/capture-config.js --keep-pod
//   kubectl -n monoplayer cp <pod>:/work/config-baseline.json <fixture>
//   mise run gate:down
//
// That rung is handed no flags: scripts/online-cluster.sh runs the module with its own
// argv alone. The capture therefore stops on the build before the join (#367). A capture
// that needs the real account names the build and the image, and runs the module where it
// can reach the gate Paper's tailnet name.
//
// Exit codes: 0 a capture was written, 1 the join failed, 2 setup failed.
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

import md from 'minecraft-data'

import { flag } from '../service/cli.js'
import { resolveGateLane } from '../driver/lane.js'
import { createBot } from './bot.js'
import { resolveBotIdentity } from './observer-baseline.js'

// A connection's own frames. See the header: a replay of either would address a
// conversation this leg never had.
const PER_LEG = new Set(['keep_alive', 'ping'])

const DEFAULT_OUT = 'config-baseline.json'
const DEFAULT_VERSION = '26.2'

// A provenance input the capture cannot record, so it stops before the join with the
// sentence that says what to pass (#367). Exit 2, beside the lane's refusal (#322).
export class CaptureSetupError extends Error {
  constructor (message) {
    super(message)
    this.name = 'CaptureSetupError'
  }
}

function fail (message, code = 2) {
  process.stderr.write('capture-config: ' + message + '\n')
  process.exit(code)
}

// The lane a capture records: the one --lane names, or the one this worktree's
// scripts derive (#322). A capture from somewhere else says --lane, because a
// port-forward cannot name the lane it forwards to.
//
// A lane it cannot name is the exception, not a fallback: gate-lane.sh's own
// sentence travels, so main() can stop before the join.
export function captureLane ({ lane = null, resolve = resolveGateLane } = {}) {
  if (lane) return lane
  return resolve()
}

// The Paper build, named or refused (#367). No frame a client receives carries it: a
// status ping answers "Paper 26.2" (the module header says where that comes from) and the
// configuration phase carries registries and packs. The one place a build is written down
// is the deployment that ran it, `PAPER_BUILD` in deploy/driver/paper.yaml. A capture
// cannot read that from the socket, so a default here would record the gate lane's build
// for every server. The sentence instead asks the operator for the one value only they
// have.
export function captureBuild ({ paperBuild = null } = {}) {
  const build = typeof paperBuild === 'string' ? paperBuild.trim() : ''
  if (build === '') {
    throw new CaptureSetupError(
      'a capture records no Paper build it did not read: pass --paper-build <n>, the build the server you are capturing was deployed from (PAPER_BUILD in deploy/driver/paper.yaml)'
    )
  }
  return build
}

// The container image, or null when nobody named one (#367). A protocol client cannot see
// an image: it is packaging around the server, not something the server sends. So the
// fixture records the one an operator names, and records null when nobody did. The gate
// lane's image in a fixture taken from another image is the claim this replaces.
export function captureImage ({ image = null } = {}) {
  const named = typeof image === 'string' ? image.trim() : ''
  return named === '' ? null : named
}

// The command that repeats a capture (#367): every flag that decided what the fixture
// holds. A reader who repeats it in another worktree reaches the same server, and records
// the same lane, build and image rather than that worktree's. --note, --reached-via,
// --account and --timeout are commentary, how it was reached, identity and patience. A
// replay leaves those to the operator, and --out is the reader's choice of file. Every
// value here is one token, so the line runs as written.
export function captureCommand ({ host, port, version, offline, lane, paperBuild, image }) {
  const parts = [
    'node src/ladder/capture-config.js',
    '--host ' + host,
    '--port ' + port,
    '--version ' + version
  ]
  if (offline) parts.push('--offline')
  parts.push('--lane ' + lane, '--paper-build ' + paperBuild)
  if (image !== null) parts.push('--image ' + image)
  parts.push('--out <fixture>')
  return parts.join(' ')
}

// What a capture resolves from its flags, before it dials (#322, #367). Pure apart from
// the lane resolver, so a case proves what a fixture claims with no socket. It also proves
// what a replay of that fixture's own command claims.
export function captureInputs (argv, { resolve = resolveGateLane, env = process.env } = {}) {
  const host = flag(argv, '--host') ?? env.MONOPLAYER_BACKEND_HOST ?? '127.0.0.1'
  const port = Number(flag(argv, '--port') ?? env.MONOPLAYER_BACKEND_PORT ?? 25565)
  const version = flag(argv, '--version') ?? env.MONOPLAYER_VERSION ?? DEFAULT_VERSION
  const offline = argv.includes('--offline')
  const lane = captureLane({ lane: flag(argv, '--lane') ?? null, resolve })
  const paperBuild = captureBuild({ paperBuild: flag(argv, '--paper-build') ?? null })
  const image = captureImage({ image: flag(argv, '--image') ?? null })
  const reachedVia = flag(argv, '--reached-via') ?? ('kubectl -n ' + lane + ' port-forward pod/capture-paper ' + port + ':25565')
  const note = flag(argv, '--note') ?? null
  return { host, port, version, offline, lane, paperBuild, image, reachedVia, note }
}

// The provenance a reader needs to reach this server again, and to know when the
// recording is old. Pure, so a case proves what lands in `capturedFrom` with no socket
// (#322, #367): the lane a capture was given, the build and image it had, and the command
// that repeats it.
export function captureProvenance ({ version, lane, paperBuild, image, host, port, offline, reachedVia, note, at }) {
  return {
    kind: 'paper',
    version,
    paperBuild,
    image,
    lane,
    host,
    port,
    reachedVia,
    at,
    note,
    command: captureCommand({ host, port, version, offline, lane, paperBuild, image })
  }
}

async function main (argv) {
  const out = flag(argv, '--out') ?? DEFAULT_OUT
  const selector = flag(argv, '--account') ?? process.env.MONOPLAYER_CAPTURE_ACCOUNT ?? 'glowsquidye'
  const timeout = Number(flag(argv, '--timeout') ?? 120_000)
  // Provenance, so a reader can tell how the fixture was reached and how to reach it
  // again. A lane nobody can name, and a build nobody states, are setup failures here. A
  // fixture that guessed either points the next reader at another server (#322, #367).
  let inputs
  try {
    inputs = captureInputs(argv)
  } catch (error) {
    fail(error.message)
  }
  const { host, port, version, offline } = inputs
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
      capturedFrom: captureProvenance({ ...inputs, at: new Date().toISOString() }),
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

// The direct-run guard every rung here uses (#322). Importing this module must not
// start a capture, so a unit case can read the lane default without a server.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => fail(String(error?.message ?? error), 1))
}
