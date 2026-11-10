// The front leg's error policy (#87).
//
// minecraft-protocol's server-side `client.end(reason)` in play writes
// `kick_disconnect`, whose `reason` is an anonymous NBT string
// (`node tools/protocol.mjs frame 26.1 play toClient kick_disconnect`). The
// library's default client error handler calls `client.end(err)` with the Error
// object itself, so the reason field holds an Error, the serializer fails, that
// failure becomes the end reason, and the socket is destroyed 30 s later
// (`closeTimeout`) with the TypeError — the live log's second line.
//
// The leg passes its own `errorHandler` to `mc.createServer`, which puts one
// line of text in that field instead. Socket-free: the frames are built and
// decoded here, nothing listens.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mc from 'minecraft-protocol'
import nbt from 'prismarine-nbt'

import { createFrontErrorHandler, frontErrorKickReason } from '../../src/legs/live-front.js'

const VERSION = '26.1'
const KICK_ID = 0x20 // play toClient kick_disconnect

// The packet minecraft-protocol writes when it ends a play client, built the way
// src/server.js builds it: the reason is a compound carrying one text string.
function kickPacket (reason) {
  const serializer = mc.createSerializer({ state: 'play', isServer: true, version: VERSION, noErrorLogging: true })
  return serializer.createPacketBuffer({
    name: 'kick_disconnect',
    params: { reason: nbt.comp({ text: nbt.string(reason) }) }
  })
}

test('a kick whose reason is an Error fails to serialize, which is the live log line', () => {
  assert.throws(
    () => kickPacket(new Error('read ECONNRESET')),
    error => {
      assert.match(error.message, /The "string" argument must be of type string/)
      assert.match(error.message, /Received an instance of Error/)
      return true
    }
  )
})

test("the leg's kick reason is a string, and that packet is a kick", () => {
  const reason = frontErrorKickReason(new Error('read ECONNRESET'))
  assert.equal(reason, 'front_error: read ECONNRESET')
  const buffer = kickPacket(reason)
  assert.ok(Buffer.isBuffer(buffer) && buffer.length > 0)
  assert.equal(buffer[0], KICK_ID, 'the frame is a play-state kick')
})

test('the handler ends the client with that string and records why', () => {
  const ended = []
  const logs = []
  const handler = createFrontErrorHandler({ log: (event, fields) => logs.push({ event, fields }) })
  const client = { username: 'Bafbi', state: 'play', end: reason => ended.push(reason) }

  handler(client, new Error('read ECONNRESET'))

  assert.deepEqual(ended, ['front_error: read ECONNRESET'])
  assert.equal(typeof ended[0], 'string', 'the reason field never holds an Error')
  assert.equal(logs.length, 1)
  assert.equal(logs[0].event, 'frontError')
  assert.equal(logs[0].fields.reason, ended[0])
  assert.equal(logs[0].fields.state, 'play')
  assert.equal(logs[0].fields.username, 'Bafbi')
})

test('a client that is already gone makes the handler throw nothing', () => {
  const handler = createFrontErrorHandler({ log: () => {} })
  const gone = { end: () => { throw new Error('closed') } }
  assert.doesNotThrow(() => handler(gone, new Error('late')))
  assert.doesNotThrow(() => handler(null, new Error('no client')))
})

test('the kick reason is one bounded line of text, whatever it was given', () => {
  assert.equal(frontErrorKickReason(new Error('read ECONNRESET')), 'front_error: read ECONNRESET')
  assert.equal(frontErrorKickReason('plain'), 'front_error: plain')
  assert.equal(frontErrorKickReason({ message: 'obj' }), 'front_error: obj')
  assert.equal(frontErrorKickReason(null), 'front_error: null')
  assert.equal(frontErrorKickReason(undefined), 'front_error: undefined')
  assert.ok(frontErrorKickReason(new Error('x'.repeat(500))).length <= 200, 'bounded')
  for (const value of [new Error('e'), null, undefined, { message: 'm' }, 'text']) {
    const reason = frontErrorKickReason(value)
    assert.equal(typeof reason, 'string')
    assert.ok(Buffer.isBuffer(kickPacket(reason)), 'every reason serializes')
  }
})
