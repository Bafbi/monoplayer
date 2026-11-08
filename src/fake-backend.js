// Scripted fake backend (26.1) serving a one-chunk flat world.
//
// Shared by the frozen Gate A spike and the product offline loopback rung
// (`src/ladder/loopback.js`). Changes here affect both; run `mise run spike`
// and `mise run loopback` after editing.
//
// On playerJoin it sends a minimal but valid join sequence:
//   login (entityId 42) -> game_state_change 13 -> position 0.5/1.62/0.5 ->
//   chunk_batch_start -> map_chunk (0,0) -> chunk_batch_finished
// It records serverbound position, block_dig, block_place and chat packets,
// and exposes sendBlockChange, sendPosition, sendWindowItems and sendSetSlot
// for scenario mutations.
import mc from 'minecraft-protocol'
import prismarineChunk from 'prismarine-chunk'
import minecraftData from 'minecraft-data'
import nbt from 'prismarine-nbt'

const VERSION = '26.1'

// Vanilla player-inventory window (window id 0): 5 crafting/armor slots, 27
// main slots, 9 hotbar slots, 4 armor slots, and the offhand. The join frame
// fills every slot so a later full frame can prove it replaced the base.
const INVENTORY_SLOTS = 46
const JOIN_SENTINEL_SLOT = 9

// 26.1 Slot shape from minecraft-data: an empty slot carries itemCount 0 only.
// A present item also needs the component counts and arrays the codec reads.
export function emptySlot () {
  return { itemCount: 0 }
}

export function itemStack (itemId, itemCount = 1) {
  return {
    itemId,
    itemCount,
    addedComponentCount: 0,
    removedComponentCount: 0,
    components: [],
    removeComponents: []
  }
}

export async function createFakeBackend ({ port = 0, logStream = process.stdout } = {}) {
  const mcData = minecraftData(VERSION)
  const Chunk = prismarineChunk(VERSION)
  const grassState = mcData.blocksByName.grass_block.defaultState
  const stoneState = mcData.blocksByName.stone.defaultState

  const received = {
    logins: 0,
    positions: [], // serverbound position packets
    digs: [],
    places: [],
    chats: [],
    chatCommands: [],
    chatAcks: [],
    chatSessionUpdates: [],
    teleportConfirms: [],
    keepAlives: [],
    chunkBatchAcks: [],
    cookieResponses: [],
    resourcePackResponses: [],
    pongs: []
  }

  const log = (event, fields = {}) => {
    if (logStream) logStream.write(JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n')
  }

  const server = mc.createServer({
    host: '127.0.0.1',
    port,
    'online-mode': false,
    version: VERSION
  })

  let teleportSeq = 0
  const join = { position: { x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 }, blockChange: null }

  function makeFlatChunk () {
    const chunk = new Chunk({ minY: -64, worldHeight: 384 })
    // grass at y=0 for the whole 16x16 column
    for (let x = 0; x < 16; x++) {
      for (let z = 0; z < 16; z++) {
        chunk.setBlockStateId({ x, y: 0, z }, grassState)
      }
    }
    // full sky light for every block, like a flat world
    for (let y = chunk.minY; y < chunk.minY + chunk.worldHeight; y++) {
      for (let x = 0; x < 16; x++) {
        for (let z = 0; z < 16; z++) {
          chunk.setSkyLight({ x, y, z }, 15)
        }
      }
    }
    return chunk
  }

  server.on('playerJoin', client => {
    received.logins++
    log('playerJoin', { address: client.socket.remoteAddress })

    const chunk = makeFlatChunk()
    const light = chunk.dumpLight()

    client.write('login', { ...mcData.loginPacket, entityId: 42 })
    client.write('game_state_change', { reason: 'level_chunks_load_start', gameMode: 0 })
    client.write('position', { teleportId: ++teleportSeq, ...join.position, dx: 0, dy: 0, dz: 0, flags: 0 })
    client.write('chunk_batch_start', {})
    client.write('map_chunk', {
      x: 0,
      z: 0,
      heightmaps: [],
      chunkData: chunk.dump(),
      blockEntities: [],
      skyLightMask: light.skyLightMask,
      blockLightMask: light.blockLightMask,
      emptySkyLightMask: light.emptySkyLightMask,
      emptyBlockLightMask: light.emptyBlockLightMask,
      skyLight: light.skyLight,
      blockLight: light.blockLight
    })
    client.write('chunk_batch_finished', { batchSize: 1 })

    // A real backend sends the player inventory after the join settles. One
    // sentinel slot makes a later full frame detectable: if the cache layered
    // the frames instead of replacing the base, the sentinel would survive.
    const joinItems = Array.from({ length: INVENTORY_SLOTS }, emptySlot)
    joinItems[JOIN_SENTINEL_SLOT] = itemStack(3, 1)
    client.write('window_items', { windowId: 0, stateId: 0, items: joinItems, carriedItem: emptySlot() })

    client.on('position', p => {
      received.positions.push(p)
      log('receivedPosition', { x: p.x, y: p.y, z: p.z })
    })
    client.on('block_dig', p => {
      received.digs.push(p)
      log('receivedDig', { status: p.status, location: p.location })
    })
    client.on('block_place', p => {
      received.places.push(p)
      log('receivedPlace', { location: p.location })
    })
    client.on('chat_message', p => {
      received.chats.push(p)
      log('receivedChat', { message: p.message })
    })
    client.on('chat_command', p => {
      received.chatCommands.push(p)
      log('receivedChatCommand', { command: p.command })
    })
    client.on('chat_ack', p => {
      received.chatAcks.push(p)
      log('receivedChatAck')
    })
    client.on('chat_session_update', p => {
      received.chatSessionUpdates.push(p)
      log('receivedChatSessionUpdate')
    })
    client.on('teleport_confirm', p => {
      received.teleportConfirms.push(p.teleportId)
      log('receivedTeleportConfirm', { teleportId: p.teleportId })
    })
    client.on('keep_alive', p => {
      received.keepAlives.push(p.keepAliveId)
      log('receivedKeepAlive', { keepAliveId: String(p.keepAliveId) })
    })
    client.on('chunk_batch_received', p => {
      received.chunkBatchAcks.push(p.chunksPerTick)
      log('receivedChunkBatchAck', { chunksPerTick: p.chunksPerTick })
    })
    client.on('cookie_response', p => { received.cookieResponses.push(p) })
    client.on('resource_pack_receive', p => { received.resourcePackResponses.push(p) })
    client.on('pong', p => { received.pongs.push(p) })
  })

  server.on('error', err => log('serverError', { error: err.message }))

  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const boundPort = server.socketServer.address().port

  // Send a block_change to every connected client (works attached or detached).
  function sendBlockChange (pos, type = stoneState) {
    join.blockChange = { pos, type }
    for (const client of Object.values(server.clients)) {
      client.write('block_change', { location: pos, type })
    }
    log('sendBlockChange', { pos, type })
  }

  // Send a new synchronize-player-position to every connected client.
  function sendPosition (pos, yaw = 0, pitch = 0) {
    join.position = { x: pos.x, y: pos.y, z: pos.z, yaw, pitch }
    for (const client of Object.values(server.clients)) {
      client.write('position', { teleportId: ++teleportSeq, x: pos.x, y: pos.y, z: pos.z, dx: 0, dy: 0, dz: 0, yaw, pitch, flags: 0 })
    }
    log('sendPosition', { pos, teleportId: teleportSeq })
  }

  // Send a full inventory window frame to every connected client. `items`
  // uses the 26.1 Slot shape (see emptySlot/itemStack).
  function sendWindowItems ({ windowId = 0, stateId = 0, items } = {}) {
    for (const client of Object.values(server.clients)) {
      client.write('window_items', { windowId, stateId, items, carriedItem: emptySlot() })
    }
    log('sendWindowItems', { windowId, stateId, slots: items?.length ?? 0 })
  }

  // Send one slot update to every connected client. `item` uses the same
  // 26.1 Slot shape as sendWindowItems.
  function sendSetSlot ({ windowId = 0, stateId = 0, slot, item } = {}) {
    for (const client of Object.values(server.clients)) {
      client.write('set_slot', { windowId, stateId, slot, item })
    }
    log('sendSetSlot', { windowId, stateId, slot, itemId: item?.itemId ?? null })
  }

  // Clientbound chat while detached: the proxy must not replay it to a later
  // client. It carries per-connection indexes and signature state.
  function sendPlayerChat (message, globalIndex = 1) {
    for (const client of Object.values(server.clients)) {
      client.write('player_chat', {
        globalIndex,
        senderUuid: '00000000-0000-0000-0000-000000000002',
        index: 0,
        signature: undefined,
        plainMessage: message,
        timestamp: BigInt(Date.now()),
        salt: 0n,
        previousMessages: [],
        unsignedChatContent: nbt.comp({ text: nbt.string(message) }),
        filterType: 0,
        type: { chatType: 1 },
        networkName: nbt.comp({ text: nbt.string('Puppet') }),
        networkTargetName: undefined
      })
    }
    log('sendPlayerChat', { message, globalIndex })
  }

  function sendSystemChat (message) {
    for (const client of Object.values(server.clients)) {
      client.write('system_chat', {
        content: nbt.comp({ text: nbt.string(message) }),
        isActionBar: false
      })
    }
    log('sendSystemChat', { message })
  }

  // A server transfer directive: the packet that must never reach the
  // attaching client (see the 2026-11-08 Skyblock incident).
  function sendTransfer (host = 'sky-2.excalia.fr', port = 25565) {
    for (const client of Object.values(server.clients)) {
      client.write('transfer', { host, port })
    }
    log('sendTransfer', { host, port })
  }

  function close () {
    for (const client of Object.values(server.clients)) {
      try { client.socket?.destroy() } catch {}
    }
    try { server.socketServer.close() } catch {}
  }

  return { server, port: boundPort, received, join, sendBlockChange, sendPosition, sendWindowItems, sendSetSlot, sendPlayerChat, sendSystemChat, sendTransfer, close }
}
