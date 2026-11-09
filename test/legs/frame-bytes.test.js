// The backend leg hands the core the frame bytes the wire carried (#82).
//
// minecraft-protocol's reader for the `topBitSetTerminatedArray` protocol type
// clears the high bit of every slot byte it decodes, in place
// (datatypes/compiler-minecraft.js: `buffer[cursor] = buffer[cursor] & 127`).
// That bit is the array's terminator flag, so decoding a multi-entry
// `entity_equipment` frame rewrites the bytes the relay forwards next: the
// client reads one entry, finds the rest trailing, and disconnects.
//
// Socket-free: the parser is driven as the Transform the library pipes the
// splitter into, one frame per write.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import mc from 'minecraft-protocol'

import { createBackendFrameForwarder, keepWireBytes } from '../../src/legs/live-backend.js'
import { createWireChecker, WIRE_CODES } from '../../src/core/wire-check.js'

const VERSION = '26.1'
// entity_equipment for entity 501 with two entries: slot 0 flagged as
// non-terminal, slot 1 terminating. 0x80 on slot 0 is the flag in question.
const TWO_ENTRIES = '66f50380000100'
// The same frame for entity 502 with three entries.
const THREE_ENTRIES = '66f603800080000200'

function deserializer () {
  return mc.createDeserializer({ state: 'play', isServer: false, version: VERSION, noErrorLogging: true })
}

// A client-shaped stub: the two members the guard touches. The library builds a
// fresh deserializer on every state change through setSerializer.
function clientStub () {
  return {
    deserializer: deserializer(),
    setSerializer () { this.deserializer = deserializer() }
  }
}

function parseFrame (parser, wire) {
  return new Promise((resolve, reject) => {
    parser.once('data', resolve)
    parser.once('error', reject)
    parser.write(Buffer.from(wire, 'hex'))
  })
}

test('the library strips an equipment frame\'s terminator flags from the bytes it decodes', () => {
  // The cause, pinned. This test fails the day the dependency stops clearing
  // the flag, which is the day keepWireBytes can be removed.
  const buffer = Buffer.from(TWO_ENTRIES, 'hex')
  const parsed = deserializer().parsePacketBuffer(buffer)
  assert.equal(parsed.metadata.size, buffer.length, 'the wire frame decodes whole')
  assert.equal(buffer.toString('hex'), '66f50300000100', 'the decoded frame lost its flags')

  const second = deserializer().parsePacketBuffer(buffer)
  assert.equal(second.metadata.size, 5, 'a relayed copy now decodes as one entry')
  assert.equal(buffer.length - second.metadata.size, 2, 'and the rest rides along')
})

test('keepWireBytes hands the core the frame bytes the wire carried', async () => {
  const client = keepWireBytes(clientStub())
  const wire = Buffer.from(TWO_ENTRIES, 'hex')
  const parsed = await parseFrame(client.deserializer, wire)

  assert.equal(parsed.buffer.toString('hex'), TWO_ENTRIES)
  assert.equal(parsed.fullBuffer.toString('hex'), TWO_ENTRIES)
  assert.equal(parsed.data.params.equipments.length, 2, 'the decode still sees both entries')

  // The bytes the caller wrote are untouched.
  assert.equal(wire.toString('hex'), TWO_ENTRIES, 'the leg\'s own chunk was rewritten')

  // And the frame the core would relay decodes whole.
  const again = deserializer().parsePacketBuffer(Buffer.from(parsed.buffer))
  assert.equal(again.metadata.size, parsed.buffer.length, 'the relayed frame has trailing bytes')
})

test('keepWireBytes guards the deserializer the library builds on a state change', async () => {
  const client = keepWireBytes(clientStub())
  client.setSerializer()
  const parsed = await parseFrame(client.deserializer, Buffer.from(THREE_ENTRIES, 'hex'))
  assert.equal(parsed.buffer.toString('hex'), THREE_ENTRIES)
})

// The live lane, 2026-11-09 22:55:49.952. Ten `entity_equipment` frames reached
// the front with these bytes (journal session-2026-11-09T22-43-30-629Z), and the
// human's client disconnected on the same replay with "found 11627 bytes extra
// whilst reading packet set_equipment".
const LIVE_RECORDED = '665800000100020003000400050006000700'
// The bytes the backend sent for the same frame. The two differ only in the
// terminator flags the decoder cleared.
const LIVE_WIRE = '665880008100820083008400850086000700'

test('the leg does not write the frame the live lane recorded', async () => {
  const wire = createWireChecker({ version: VERSION })

  // What the journal holds: one entry, 14 bytes trailing.
  const recorded = wire.check({
    state: 'play',
    name: 'entity_equipment',
    buffer: Buffer.from(LIVE_RECORDED, 'hex')
  })
  assert.equal(recorded.code, WIRE_CODES.LEFTOVER_BYTES, 'the journal frame must fail the check')
  assert.equal(recorded.leftover, 14)

  // The same frame through the guarded leg: the backend's own bytes, accepted.
  const client = keepWireBytes(clientStub())
  const parsed = await parseFrame(client.deserializer, Buffer.from(LIVE_WIRE, 'hex'))
  assert.equal(parsed.buffer.toString('hex'), LIVE_WIRE, 'the leg relayed rewritten bytes')
  const delivered = wire.check({ state: 'play', name: 'entity_equipment', buffer: parsed.buffer })
  assert.equal(delivered.ok, true, delivered.code)
  assert.equal(delivered.leftover, 0)
})

test('a bundle of two equipment frames reaches the core intact', async () => {
  const client = keepWireBytes(clientStub())
  const delivered = []
  const forwarder = createBackendFrameForwarder({ deliver: frame => delivered.push(frame) })
  const wire = createWireChecker({ version: VERSION })

  // The splitter pushes one frame per write, in wire order; the library emits
  // the decoded packet, then the parsed frame, for each.
  for (const hex of [TWO_ENTRIES, THREE_ENTRIES]) {
    const parsed = await parseFrame(client.deserializer, Buffer.from(hex, 'hex'))
    forwarder.onPacket(parsed.data.params, { name: 'entity_equipment', state: 'play' })
    forwarder.onRaw(parsed.buffer, { name: 'entity_equipment', state: 'play' })
  }

  assert.deepEqual(delivered.map(frame => frame.buffer.toString('hex')), [TWO_ENTRIES, THREE_ENTRIES])
  assert.deepEqual(delivered.map(frame => frame.data.equipments.length), [2, 3])
  for (const frame of delivered) {
    const result = wire.check({ state: 'play', name: frame.name, buffer: frame.buffer })
    assert.equal(result.ok, true, `${result.code} on ${frame.buffer.toString('hex')}`)
    assert.equal(result.leftover, 0)
  }
})
