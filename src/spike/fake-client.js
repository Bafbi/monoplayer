// Protocol spike: scripted attaching client (26.1) that records what it receives.
//
// It waits for the synthesized play join (login, position, map_chunk), records
// clientbound play packet names and selected parsed data, and can send
// position / block_dig / block_place / chat packets with valid 26.1 fields.
import mc from 'minecraft-protocol'

const VERSION = '26.1'

export function createFakeClient ({ host = '127.0.0.1', port, username = 'Attacher', timeout = 10000, logStream = process.stdout } = {}) {
  const received = {
    names: [], // clientbound play packet names, in order
    positions: [], // parsed synchronize player position packets
    blockChanges: [],
    mapChunks: [],
    gameStateChanges: [],
    login: null, // parsed play login
    profile: null, // Login Success profile
    errors: [],
    ended: null
  }

  const log = (event, fields = {}) => {
    if (logStream) logStream.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
  }

  const client = mc.createClient({ host, port, username, auth: 'offline', version: VERSION })

  client.on('error', err => {
    received.errors.push(err.message)
    log('clientError', { error: err.message })
  })
  client.on('end', reason => {
    received.ended = reason
    log('clientEnd', { reason })
  })
  client.on('success', packet => {
    received.profile = { username: packet.username, uuid: packet.uuid }
  })
  client.on('raw', (buffer, meta) => {
    if (meta.state === 'play') received.names.push(meta.name)
  })
  client.on('login', p => { received.login = p })
  client.on('position', p => { received.positions.push(p) })
  client.on('block_change', p => { received.blockChanges.push(p) })
  client.on('map_chunk', p => { received.mapChunks.push(p) })
  client.on('game_state_change', p => { received.gameStateChanges.push(p) })

  const waitFor = (pred, label, ms = timeout) => new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = () => {
      let ok = false
      try { ok = pred() } catch {}
      if (ok) return resolve()
      if (Date.now() - started > ms) return reject(new Error(`fake client: timeout waiting for ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })

  const ready = () => waitFor(
    () => received.login && received.positions.length > 0 && received.names.includes('map_chunk'),
    'play login + position + map_chunk'
  )

  let digSeq = 1
  let placeSeq = 1

  return {
    client,
    received,
    ready,
    waitFor,
    sendPosition (pos, onGround = true) {
      client.write('position', { x: pos.x, y: pos.y, z: pos.z, flags: { onGround } })
    },
    sendDig (location, status = 0, face = 1) {
      client.write('block_dig', { status, location, face, sequence: digSeq++ })
    },
    sendPlace (location, direction = 1) {
      client.write('block_place', {
        hand: 'main_hand',
        location,
        direction,
        cursorX: 0.5,
        cursorY: 1,
        cursorZ: 0.5,
        insideBlock: false,
        worldBorderHit: false,
        sequence: placeSeq++
      })
    },
    sendChat (message) {
      client.write('chat_message', {
        message,
        timestamp: BigInt(Date.now()),
        salt: 0n,
        signature: undefined,
        offset: 0,
        acknowledged: Buffer.alloc(3),
        checksum: 0
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
    close () {
      return new Promise(resolve => {
        if (received.ended) return resolve()
        client.once('end', resolve)
        client.end()
      })
    }
  }
}
