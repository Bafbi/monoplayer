// Gate A spike: scripted fake backend (26.1) serving a one-chunk flat world.
//
// On playerJoin it sends a minimal but valid join sequence:
//   login (entityId 42) -> game_state_change 13 -> position 0.5/1.62/0.5 ->
//   chunk_batch_start -> map_chunk (0,0) -> chunk_batch_finished
// It records serverbound position, block_dig, block_place and chat packets,
// and exposes sendBlockChange / sendPosition for scenario mutations.
import mc from 'minecraft-protocol'
import prismarineChunk from 'prismarine-chunk'
import minecraftData from 'minecraft-data'
import nbt from 'prismarine-nbt'

const VERSION = '26.1'

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

  function close () {
    for (const client of Object.values(server.clients)) {
      try { client.socket?.destroy() } catch {}
    }
    try { server.socketServer.close() } catch {}
  }

  return { server, port: boundPort, received, join, sendBlockChange, sendPosition, sendPlayerChat, sendSystemChat, close }
}
