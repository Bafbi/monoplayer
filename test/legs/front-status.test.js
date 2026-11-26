// #200: the status ping answers deliberately, not from the library's defaults.
//
// One of the two places in the unit rung that speaks the game protocol over a
// socket, and the socket is a loopback port 0 on this machine: the answer is a wire
// fact, so the test reads it the way the internet would, with a real handshake and
// no `.secrets` read. The other is test/legs/spectate-refusal.test.js (#435), which
// logs a client in because a Spectate refusal after the landing is not reachable
// without one. The panel and tooling tests listen on loopback too, and none of them
// speaks this protocol. The offline front leg and the live one share one body, so the answer
// asserted here is the answer both constructors send.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import mc from 'minecraft-protocol'
import minecraftData from 'minecraft-data'

import { createOfflineFrontLeg } from '../../src/legs/live-front.js'

const VERSION = '26.1'
const ATTACH_UUID = '06081639-2178-368a-abb3-3f762836f9a4'

// The protocol number a client reads out of the answer, from the data the leg
// itself answers with: a rename of the version under test is not a failure.
const PROTOCOL = minecraftData(VERSION).version.version

async function withFront (run) {
  const leg = createOfflineFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    offlineWhitelist: [ATTACH_UUID],
    getSnapshotConfig: () => [],
    wireMode: 'off'
  })
  try {
    const { port } = await leg.listen()
    return await run({ port })
  } finally {
    await leg.close()
  }
}

// A pre-1.7 status ping: the 0xFE 0x01 the library answers from
// server.motd, server.playerCount and server.maxPlayers. The library never
// closes this connection, so read the one frame and destroy the socket.
async function legacyPing (port) {
  return await new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const chunks = []
    socket.setTimeout(5000, () => reject(new Error('legacy ping timed out')))
    socket.on('error', reject)
    socket.on('data', chunk => {
      chunks.push(chunk)
      const buffer = Buffer.concat(chunks)
      if (buffer.length < 3) return
      socket.destroy()
      const length = buffer.readUInt16BE(1)
      const payload = buffer.subarray(3, 3 + length * 2).swap16().toString('utf16le')
      resolve({ marker: buffer[0], payload })
    })
    socket.write(Buffer.from([0xfe, 0x01]))
  })
}

test('the status ping answers with no description text', async () => {
  await withFront(async ({ port }) => {
    const answer = await mc.ping({ host: '127.0.0.1', port, version: VERSION })
    assert.deepEqual(answer.description, { text: '' })
  })
})

test('the status ping names no build and keeps the protocol number', async () => {
  await withFront(async ({ port }) => {
    const answer = await mc.ping({ host: '127.0.0.1', port, version: VERSION })
    assert.deepEqual(answer.version, { name: '', protocol: PROTOCOL })
  })
})

test('the status ping reports no players and no sample', async () => {
  await withFront(async ({ port }) => {
    const answer = await mc.ping({ host: '127.0.0.1', port, version: VERSION })
    assert.deepEqual(answer.players, { max: 0, online: 0 })
    assert.equal('sample' in answer.players, false, 'a sample is the player list by another name')
  })
})

test('the status ping sends the three fields a client reads and nothing else', async () => {
  await withFront(async ({ port }) => {
    const answer = await mc.ping({ host: '127.0.0.1', port, version: VERSION })
    const fields = Object.keys(answer).filter(name => name !== 'latency').sort()
    assert.deepEqual(fields, ['description', 'players', 'version'])
  })
})

// The legacy wire is a positional six-field string the library builds from
// server.mcversion, server.motd, server.playerCount and server.maxPlayers. The
// leg sets the motd and the maximum; the count is already zero, the version
// field follows the leg's `version` option, and the format has no hook for it.
test('a legacy status ping carries no motd and no player counts', async () => {
  await withFront(async ({ port }) => {
    const { marker, payload } = await legacyPing(port)
    assert.equal(marker, 0xff, 'the legacy answer is the 0xff frame')
    // \xa7 1 \0 protocol \0 version \0 motd \0 online \0 max
    assert.deepEqual(payload.slice(1).split('\u0000'), ['1', String(PROTOCOL), VERSION, '', '0', '0'])
  })
})
