// Gate A spike: minimal two-leg proxy (minecraft-protocol, protocol 775 / 26.1).
//
// Throwaway code, not product code:
//   - a bounded ordered frame cache stands in for the product state cache
//   - chat is blocked, not re-signed
//   - the configuration phase is left to the library's auto-config
//
// Legs:
//   - backend leg: mc client ("Puppet") that owns the server-side session
//   - front leg:   mc server that attaching clients join; they are presented
//                  the forged puppet profile in Login Success.
import { EventEmitter } from 'node:events'
import mc from 'minecraft-protocol'

const VERSION = '26.1'

export const PUPPET_PROFILE = Object.freeze({
  username: 'Puppet',
  uuid: '00000000-0000-0000-0000-000000000001'
})

// Serverbound play frames that never reach the backend leg.
const DROP_SERVERBOUND = new Set([
  'teleport_confirm', // proxy owns teleport IDs per leg; it confirms the backend's own
  'keep_alive', // the front leg answers its own keep-alives
  'chat_message', // chat is blocked for this spike
  'chat_command',
  'chat_command_signed',
  'chat_session_update',
  'chat_ack',
  'configuration_acknowledged',
  'chunk_batch_received', // the client acks proxy-synthesized batches; the puppet leg acks the backend's
  'cookie_response', // replayed cookies are the proxy's, not the fresh client's
  'resource_pack_receive', // MVP targets no required resource pack
  'pong' // a replayed ping must not be answered with the fresh client's pong
])

const CHAT_SERVERBOUND = new Set([
  'chat_message', 'chat_command', 'chat_command_signed', 'chat_session_update', 'chat_ack'
])

// Clientbound play frames that are neither cached nor relayed.
const DROP_CLIENTBOUND = new Set([
  'keep_alive', // per-leg keep-alive ownership; replayed keep-alives carry stale IDs
  'player_chat', // chat history has per-connection global indexes/signature caches
  'profileless_chat',
  'hide_message',
  'system_chat' // spike blocks chat in both directions; read-only chat is a later slice
])

export function createProxy ({ backendHost = '127.0.0.1', backendPort, maxWindowFrames = 512, maxPrefixFrames = 256, logStream = process.stdout }) {
  const metrics = {
    backendLogins: 0,
    attachTotal: 0,
    detachTotal: 0,
    frontRejected: 0,
    backendDisconnects: 0,
    cacheOverflow: 0,
    framesCached: 0,
    framesReplayed: 0,
    serverboundForwarded: 0,
    chatBlocked: 0
  }

  const bus = new EventEmitter()
  const logLines = []
  const log = (event, fields = {}) => {
    const line = JSON.stringify({ t: new Date().toISOString(), event, ...fields })
    logLines.push(line)
    if (logLines.length > 4096) logLines.shift()
    if (logStream) logStream.write(line + '\n')
  }

  // Bounded ordered cache: pinned join prefix (through the first chunk batch)
  // plus a sliding window of the latest state-bearing frames.
  const cache = { prefix: [], window: [], joinComplete: false }

  let attached = null
  let frontPort = null
  let frontTeleportSeq = 0
  // The puppet's authoritative pose. Backend teleports update it; the
  // attaching client's movement also updates it, so a reattach lands where the
  // client actually left the puppet, not where the backend last teleported it.
  let currentPose = { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 }

  const backend = mc.createClient({
    host: backendHost,
    port: backendPort,
    username: PUPPET_PROFILE.username,
    auth: 'offline',
    version: VERSION
  })

  backend.on('error', err => log('backendError', { error: err.message }))
  backend.on('end', reason => {
    metrics.backendDisconnects++
    log('backendEnd', { reason })
    if (attached) {
      const doomed = attached
      attached = null
      metrics.detachTotal++
      try { doomed.end('backend_disconnected') } catch {}
      log('frontClosedAfterBackendEnd', { reason })
    }
  })
  backend.on('login', packet => {
    metrics.backendLogins++
    log('backendLogin', { entityId: packet.entityId })
  })

  backend.on('raw', (buffer, meta) => {
    if (meta.state !== 'play') return
    if (meta.name === 'position') return // synthesized per attach, not replayed raw
    if (DROP_CLIENTBOUND.has(meta.name)) return
    cacheFrame(meta.name, buffer)
    if (attached) attached.writeRaw(buffer)
  })

  // Keep the puppet leg healthy while nobody is attached: confirm the backend's
  // teleports and ack its chunk batches on the puppet's own connection.
  backend.on('position', packet => {
    currentPose = {
      x: packet.x,
      y: packet.y,
      z: packet.z,
      yaw: packet.yaw,
      pitch: packet.pitch
    }
    backend.write('teleport_confirm', { teleportId: packet.teleportId })
    log('backendTeleport', { teleportId: packet.teleportId, x: packet.x, y: packet.y, z: packet.z })
    if (attached) writePosition(attached)
  })
  backend.on('chunk_batch_finished', () => {
    backend.write('chunk_batch_received', { chunksPerTick: 32 })
  })

  const server = mc.createServer({
    host: '127.0.0.1',
    port: 0,
    'online-mode': false,
    version: VERSION,
    beforeLogin (client) {
      // Forge the puppet profile: the attaching client renders the puppet.
      client.username = PUPPET_PROFILE.username
      client.uuid = PUPPET_PROFILE.uuid
    }
  })

  server.on('error', err => log('frontServerError', { error: err.message }))
  server.on('listening', () => {
    frontPort = server.socketServer.address().port
    log('frontListening', { port: frontPort })
    bus.emit('listening', frontPort)
  })

  server.on('login', client => {
    // Track the attaching client's pose. This is the pose a later attach must
    // land on; backend teleports alone do not know where the player walked.
    client.on('packet', (data, meta) => {
      if (meta.state !== 'play' || client !== attached) return
      if (meta.name === 'position' || meta.name === 'position_look') {
        currentPose = { ...currentPose, x: data.x, y: data.y, z: data.z }
      }
      if (meta.name === 'look' || meta.name === 'position_look') {
        currentPose = { ...currentPose, yaw: data.yaw, pitch: data.pitch }
      }
    })
    client.on('raw', (buffer, meta) => {
      if (meta.state !== 'play' || client !== attached) return
      if (DROP_SERVERBOUND.has(meta.name)) {
        if (CHAT_SERVERBOUND.has(meta.name)) {
          metrics.chatBlocked++
          log('chatBlocked', { name: meta.name, from: client.username })
        }
        return
      }
      backend.writeRaw(buffer)
      metrics.serverboundForwarded++
    })
    client.on('end', reason => {
      if (client !== attached) return
      attached = null
      metrics.detachTotal++
      log('detach', { reason, pose: currentPose })
      bus.emit('detach', { reason })
    })
    client.on('error', err => {
      log('frontClientError', { error: err.message })
      if (client === attached) {
        attached = null
        metrics.detachTotal++
      }
    })
  })

  server.on('playerJoin', client => {
    if (attached) {
      metrics.frontRejected++
      log('frontRejected', { reason: 'already_attached', current: attached.username })
      client.end('already_attached')
      return
    }
    attached = client
    metrics.attachTotal++
    const snapshot = [...cache.prefix, ...cache.window]
    log('attach', { cacheFrames: snapshot.length, pose: currentPose })
    let sentPosition = false
    for (const frame of snapshot) {
      if (frame.name === 'position') continue // always synthesize the current pose
      if (frame.name === 'chunk_batch_start' && !sentPosition) {
        writePosition(client)
        sentPosition = true
      }
      client.writeRaw(frame.buffer)
      metrics.framesReplayed++
    }
    if (!sentPosition) writePosition(client)
    log('attachReplayDone', { replayed: metrics.framesReplayed, pose: currentPose })
    bus.emit('attach', { client, replayed: metrics.framesReplayed })
  })

  function writePosition (client) {
    if (!currentPose) return
    client.write('position', {
      teleportId: ++frontTeleportSeq,
      x: currentPose.x,
      y: currentPose.y,
      z: currentPose.z,
      dx: 0,
      dy: 0,
      dz: 0,
      yaw: currentPose.yaw ?? 0,
      pitch: currentPose.pitch ?? 0,
      flags: 0
    })
    metrics.positionsSynthesized = (metrics.positionsSynthesized || 0) + 1
    log('synthesizedPosition', { teleportId: frontTeleportSeq, pose: currentPose })
  }

  function cacheFrame (name, buffer) {
    if (!cache.joinComplete) {
      cache.prefix.push({ name, buffer })
      if (cache.prefix.length > maxPrefixFrames) {
        cache.prefix.shift()
        metrics.cacheOverflow++
      }
      if (name === 'chunk_batch_finished') {
        cache.joinComplete = true
        log('cacheWarm', { prefixFrames: cache.prefix.length })
        bus.emit('warm', { prefixFrames: cache.prefix.length })
      }
    } else {
      cache.window.push({ name, buffer })
      if (cache.window.length > maxWindowFrames) cache.window.shift()
    }
    metrics.framesCached++
  }

  function close () {
    try { backend.end() } catch {}
    for (const client of Object.values(server.clients)) {
      try { client.socket?.destroy() } catch {}
    }
    try { server.socketServer.close() } catch {}
  }

  return {
    version: VERSION,
    backend,
    server,
    bus,
    metrics,
    get frontPort () { return frontPort },
    get attachedClient () { return attached },
    get cacheSize () { return cache.prefix.length + cache.window.length },
    cacheNames: () => [...cache.prefix, ...cache.window].map(f => f.name),
    logLines: () => [...logLines],
    close
  }
}
