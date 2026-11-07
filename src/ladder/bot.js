// Protocol bot for the ladder's loopback rung: a real 26.1 client that joins
// the product front leg with offline auth and records what it receives.
//
// The bot is deliberately thin. It is not a vanilla oracle: minecraft-protocol
// accepts frames a vanilla client would reject (trailing bytes, wrong name for
// the state). The wire checker in the front leg covers that class; only a real
// official client proves vanilla acceptance (see docs/testing-ladder.md).
//
// Recording: the `packet` event is the only place the full frame is visible.
// It fires as (data, meta, buffer, fullBuffer), where `buffer` is the consumed
// slice and `fullBuffer` carries any trailing bytes. `raw` sees only the
// truncated buffer, so leftover accounting happens here.
import mc from 'minecraft-protocol'

const VERSION = '26.1'

export function createBot ({
  host = '127.0.0.1',
  port,
  username,
  version = VERSION,
  auth = 'offline',
  profilesFolder = null,
  logStream = null
} = {}) {
  if (!port) throw new TypeError('port is required')
  if (typeof username !== 'string' || username.length === 0) {
    throw new TypeError('username must be a non-empty string')
  }

  const received = {
    names: [], // every clientbound frame: { state, name }
    byState: {}, // state -> [name]
    leftovers: [], // frames whose fullBuffer exceeded the parsed frame
    success: null, // login success packet, if one arrived
    login: null, // play login packet
    positions: [],
    mapChunks: [],
    blockChanges: [],
    ended: null,
    errors: []
  }

  const log = (event, fields = {}) => {
    // Metadata only. Never frame bytes, profile tokens, or account material.
    if (logStream) logStream.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
  }

  const options = { host, port, username, version, auth, keepAlive: true }
  if (profilesFolder) options.profilesFolder = profilesFolder

  const client = mc.createClient(options)

  let resolveEnded = null
  const ended = new Promise(resolve => { resolveEnded = resolve })

  client.on('packet', (data, meta, buffer, fullBuffer) => {
    const state = meta?.state ?? null
    const name = meta?.name ?? null
    const total = Buffer.isBuffer(fullBuffer) ? fullBuffer.length : (buffer?.length ?? 0)
    const consumed = Buffer.isBuffer(buffer) ? buffer.length : total
    const leftover = total - consumed

    received.names.push({ state, name })
    if (!received.byState[state]) received.byState[state] = []
    received.byState[state].push(name)
    if (leftover !== 0) received.leftovers.push({ state, name, total, leftover })
  })

  client.on('success', packet => {
    received.success = packet
    log('botSuccess', { username: packet?.username ?? null })
  })
  client.on('login', packet => {
    received.login = packet
    log('botLogin', { entityId: packet?.entityId ?? null })
  })
  client.on('position', packet => received.positions.push(packet))
  client.on('map_chunk', packet => received.mapChunks.push(packet))
  client.on('block_change', packet => received.blockChanges.push(packet))

  client.on('error', error => {
    received.errors.push(String(error?.message ?? error).slice(0, 200))
    log('botError', { error: String(error?.message ?? error).slice(0, 200) })
  })
  client.on('end', reason => {
    received.ended = reason
    log('botEnd', { reason: String(reason).slice(0, 160) })
    resolveEnded(reason)
  })

  function waitFor (pred, label, ms = 10_000) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + ms
      const tick = () => {
        let ok = false
        try { ok = pred() } catch { /* predicate reads the recorder; treat as not-ready */ }
        if (ok) return resolve()
        if (Date.now() >= deadline) {
          return reject(new Error(`bot ${username}: timed out after ${ms} ms waiting for ${label}`))
        }
        setTimeout(tick, 10)
      }
      tick()
    })
  }

  // The play join is ready when the login packet, a position, and a chunk have
  // all arrived. Configuration state is already behind us by then.
  function ready () {
    return waitFor(
      () => received.login !== null && received.positions.length > 0 && received.mapChunks.length > 0,
      'play login + position + map_chunk'
    )
  }

  let digSeq = 1
  let placeSeq = 1
  let closePromise = null

  function close () {
    if (closePromise) return closePromise
    closePromise = new Promise(resolve => {
      if (received.ended !== null) return resolve()
      client.once('end', () => resolve())
      try {
        client.end()
      } catch {
        resolve()
      }
    })
    return closePromise
  }

  return {
    kind: 'offline-bot',
    client,
    received,
    ended,
    ready,
    waitFor,
    playNames: () => received.names.filter(frame => frame.state === 'play').map(frame => frame.name),

    sendPosition ({ x, y, z }, onGround = true) {
      client.write('position', { x, y, z, flags: { onGround } })
    },
    sendDig (location, status = 0, face = 1) {
      client.write('block_dig', { status, location, face, sequence: digSeq++ })
    },
    sendPlace (location, direction = 1, cursor = { x: 0.5, y: 1, z: 0.5 }) {
      client.write('block_place', {
        hand: 'main_hand',
        location,
        direction,
        cursorX: cursor.x,
        cursorY: cursor.y,
        cursorZ: cursor.z,
        insideBlock: false,
        worldBorderHit: false,
        sequence: placeSeq++
      })
    },
    sendTeleportConfirm (teleportId) {
      client.write('teleport_confirm', { teleportId })
    },
    sendChunkBatchReceived (chunksPerTick) {
      client.write('chunk_batch_received', { chunksPerTick })
    },
    sendKeepAlive (keepAliveId) {
      client.write('keep_alive', { keepAliveId: BigInt(keepAliveId) })
    },
    close
  }
}
