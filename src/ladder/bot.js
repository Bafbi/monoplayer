// Protocol bot for the ladder's loopback and online rungs: a real 26.1 client
// that joins the product front leg and records what it receives.
//
// Offline is the default (rung 2). The online rung passes auth 'microsoft'
// with a token-custody cache factory, so the same recorder proves the real
// hasJoined path (rung 3).
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

import { buildCustomClickAction } from '../core/dialog-codec.js'

const VERSION = '26.1'

// Build the createClient options. Pure, so tests can prove the auth material
// is only present when set. `profilesFolder` must be the token-custody cache
// factory (a function); a plain cache path would let the library mint its own
// token store, which the G1 custody rules forbid.
export function buildClientOptions ({
  host = '127.0.0.1',
  port,
  username,
  version = VERSION,
  auth = 'offline',
  profilesFolder = null,
  authTitle = null,
  deviceType = null,
  flow = null,
  keepAlive = true,
  // The bot's own Client Information, sent in the configuration phase. Used to
  // prove what the server sees when a human's fields differ from a default.
  clientSettings = null
} = {}) {
  if (!port) throw new TypeError('port is required')
  if (typeof username !== 'string' || username.length === 0) {
    throw new TypeError('username must be a non-empty string')
  }
  if (typeof auth !== 'string' || auth.length === 0) {
    throw new TypeError('auth must be a non-empty string')
  }

  const options = { host, port, username, version, auth, keepAlive }
  if (profilesFolder !== null && profilesFolder !== undefined) {
    if (typeof profilesFolder !== 'function') {
      throw new TypeError('profilesFolder must be a token-custody cache factory, never a path')
    }
    options.profilesFolder = profilesFolder
  }
  if (clientSettings !== null && clientSettings !== undefined) {
    if (typeof clientSettings !== 'object') throw new TypeError('clientSettings must be an object')
    options.clientSettings = clientSettings
  }
  if (authTitle !== null && authTitle !== undefined) options.authTitle = authTitle
  if (deviceType !== null && deviceType !== undefined) options.deviceType = deviceType
  // prismarine-auth needs an explicit flow whenever authTitle is overridden;
  // its defaults only apply when authTitle is undefined. 'live' is the Java flow.
  if (auth === 'microsoft') options.flow = flow ?? 'live'
  return options
}

export function createBot ({
  host = '127.0.0.1',
  port,
  username,
  version = VERSION,
  auth = 'offline',
  profilesFolder = null,
  authTitle = null,
  deviceType = null,
  flow = null,
  clientSettings = null,
  // #73: a real client shows the code of conduct and waits for a click, while
  // the protocol library accepts it on its own. A rung that needs a human who
  // did not answer turns that off.
  answerCodeOfConduct = true,
  logStream = null
} = {}) {
  const received = {
    names: [], // every clientbound frame: { state, name }
    byState: {}, // state -> [name]
    leftovers: [], // frames whose fullBuffer exceeded the parsed frame
    success: null, // login success packet, if one arrived
    login: null, // play login packet
    positions: [],
    mapChunks: [],
    blockChanges: [],
    windowItems: [], // decoded clientbound window_items frames
    setSlots: [], // decoded clientbound set_slot frames
    equipment: [], // decoded clientbound entity_equipment frames (#82)
    heldItemSlots: [], // decoded clientbound held_item_slot frames
    health: [], // decoded clientbound update_health frames
    systemChat: [], // decoded clientbound system_chat frames
    dialogs: [], // decoded clientbound show_dialog frames (#16)
    gatesHeld: 0, // code-of-conduct accepts this bot refused to send (#73)
    advancements: [], // decoded clientbound advancements frames (a proxy notice toast, #15)
    kick: null, // decoded clientbound kick_disconnect, if one arrived
    ended: null,
    errors: []
  }

  const log = (event, fields = {}) => {
    // Metadata only. Never frame bytes, profile tokens, or account material.
    if (logStream) logStream.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
  }

  const options = buildClientOptions({
    host,
    port,
    username,
    version,
    auth,
    profilesFolder,
    authTitle,
    deviceType,
    flow,
    clientSettings
  })

  const client = mc.createClient(options)
  if (answerCodeOfConduct !== true) {
    const answer = client.write.bind(client)
    client.write = (name, params, ...rest) => {
      if (name !== 'accept_code_of_conduct') return answer(name, params, ...rest)
      received.gatesHeld++
      log('botGateHeld', { username })
      return false
    }
  }

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
  client.on('window_items', packet => received.windowItems.push(packet))
  client.on('set_slot', packet => received.setSlots.push(packet))
  // #82: a relay that rewrites the frame's terminator flags arrives here as one
  // entry plus a leftover, so the decoded entry count is the direct signal.
  client.on('entity_equipment', packet => received.equipment.push(packet))
  client.on('held_item_slot', packet => received.heldItemSlots.push(packet))
  client.on('update_health', packet => received.health.push(packet))
  client.on('system_chat', packet => received.systemChat.push(packet))
  client.on('show_dialog', packet => received.dialogs.push(packet))
  client.on('advancements', packet => received.advancements.push(packet))
  client.on('kick_disconnect', packet => { received.kick = packet })

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
        try {
          ok = pred()
        } catch (error) {
          return reject(error)
        }
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
  // all arrived. Configuration state is already behind us by then. The online
  // rung allows a longer window: the Microsoft token refresh runs before the
  // socket ever connects.
  function ready (ms = 10_000) {
    return waitFor(
      () => {
        if (received.errors.length > 0) throw new Error(`bot ${username}: ${received.errors[0]}`)
        if (received.ended !== null) throw new Error(`bot ${username}: ended before play (${String(received.ended).slice(0, 120)})`)
        return received.login !== null && received.positions.length > 0 && received.mapChunks.length > 0
      },
      'play login + position + map_chunk',
      ms
    )
  }

  let digSeq = 1
  let placeSeq = 1
  let closePromise = null

  function close () {
    if (closePromise) return closePromise
    closePromise = new Promise(resolve => {
      if (received.ended !== null) return resolve()
      const timer = setTimeout(() => {
        try { client.socket?.destroy() } catch { /* already gone */ }
        resolve()
      }, 2000)
      timer.unref?.()
      client.once('end', () => { clearTimeout(timer); resolve() })
      try {
        client.end()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
    return closePromise
  }

  return {
    kind: auth === 'microsoft' ? 'online-bot' : 'offline-bot',
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
    // The bot's own chat text, sent the way a client sends it: the library
    // signs it when the connection has profile keys and always fills the
    // checksum and offset from this connection's own window. An offline bot has
    // no keys, so the frame goes out unsigned. The proxy must speak the text as
    // the puppet rather than forward the frame (#19).
    sendChat (text) {
      client._signedChat(text)
    },
    sendCommand (command) {
      client._signedChat(command.startsWith('/') ? command : `/${command}`)
    },
    sendMessageAck (count = 0) {
      client.write('message_acknowledgement', { count })
    },
    // #16: answer a dialog the way a client does. The library's own writer for
    // this packet omits the payload's length prefix, so the body comes from the
    // dialog codec both this bot and the puppet leg use, and is written raw.
    answerDialog (id, additions = null) {
      const body = buildCustomClickAction({ state: 'play', id, additions })
      if (body === null) throw new Error(`cannot build a dialog answer for ${JSON.stringify(id)}`)
      client.writeRaw(body)
    },
    close
  }
}
