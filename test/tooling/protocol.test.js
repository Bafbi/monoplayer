// tools/protocol.mjs answers one protocol question per command, against both
// the installed 26.1 data and the vendored 26.2 tree.
//
// The vendored protocol.json is the independent source of truth for the 26.2
// side: every list this test expects is derived from that file, never from the
// tool's own output. The 26.1 side pins the installed package instead: its frame
// count and two names, so a data bump that changes 26.1 fails here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { diffProtocols } from '../../tools/protocol.mjs'

const TOOL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'protocol.mjs')
const vendor = JSON.parse(fs.readFileSync(
  new URL('../../vendor/minecraft-data-26.2/data/pc/26.2/protocol.json', import.meta.url),
  'utf8'
))

const run = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' })

function vendorPackets (state, dir) {
  const mappings = vendor[state][dir].types.packet[1][0].type[1].mappings
  return Object.entries(mappings)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((left, right) => left.id - right.id)
}

const hex = id => '0x' + id.toString(16).padStart(2, '0')

// ---------------------------------------------------------------------------
// packets
// ---------------------------------------------------------------------------

test('packets lists every 26.2 play frame as hex id and name, in id order', () => {
  const result = run('packets', '26.2', 'play', 'toClient')
  assert.equal(result.status, 0, result.stderr)

  const expected = vendorPackets('play', 'toClient').map(packet => `${hex(packet.id)} ${packet.name}`)
  assert.deepEqual(result.stdout.trim().split('\n'), expected)
})

test('packets answers for the installed 26.1 data too', () => {
  const result = run('packets', '26.1', 'play', 'toClient')
  assert.equal(result.status, 0, result.stderr)

  const lines = result.stdout.trim().split('\n')
  assert.equal(lines.length, 141, '26.1 play toClient has 141 frames')
  assert.ok(lines.includes('0x2d map_chunk'))
  assert.ok(lines.includes('0x2c keep_alive'))
})

// ---------------------------------------------------------------------------
// usage errors
// ---------------------------------------------------------------------------

test('an unknown version, state, direction, or frame exits 2 and names the valid values', () => {
  const version = run('packets', '99.9', 'play', 'toClient')
  assert.equal(version.status, 2)
  assert.match(version.stderr, /unknown protocol version: 99\.9/)

  const state = run('packets', '26.2', 'plays', 'toClient')
  assert.equal(state.status, 2)
  assert.match(state.stderr, /unknown state: plays/)
  assert.match(state.stderr, /handshaking, status, login, configuration, play/)

  const dir = run('packets', '26.2', 'play', 'client')
  assert.equal(dir.status, 2)
  assert.match(dir.stderr, /unknown direction: client/)
  assert.match(dir.stderr, /toClient, toServer/)

  const frame = run('frame', '26.2', 'play', 'toClient', 'not_a_frame')
  assert.equal(frame.status, 2)
  assert.match(frame.stderr, /unknown frame: not_a_frame/)
})

test('a bare or malformed invocation exits 2 with the usage on stderr', () => {
  for (const args of [[], ['packets'], ['packets', '26.2'], ['nope'], ['frame', '26.2', 'play', 'toClient']]) {
    const result = run(...args)
    assert.equal(result.status, 2, args.join(' '))
    assert.match(result.stderr, /usage: node tools\/protocol\.mjs/, args.join(' '))
  }
})

// ---------------------------------------------------------------------------
// frame
// ---------------------------------------------------------------------------

test('frame prints the id, the param type, and the top-level fields', () => {
  const result = run('frame', '26.2', 'play', 'toClient', 'map_chunk')
  assert.equal(result.status, 0, result.stderr)

  const lines = result.stdout.trim().split('\n')
  assert.equal(lines[0], '26.2 play toClient map_chunk = 0x2d (packet_map_chunk)')
  assert.ok(lines.includes('  x: i32'), 'x is an i32')
  assert.ok(lines.includes('  z: i32'), 'z is an i32')
  assert.ok(lines.includes('  chunkData: ByteArray'), 'chunkData is a ByteArray')
  // 12 top-level fields plus the header; the vendor container is the count.
  const fields = vendor.play.toClient.types.packet_map_chunk[1].filter(field => field && field.name)
  assert.equal(lines.length, fields.length + 1)
})

test('frame says void for a packet with no fields', () => {
  const result = run('frame', '26.2', 'play', 'toClient', 'bundle_delimiter')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '26.2 play toClient bundle_delimiter = 0x00 (void)\n')
})

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

test('diff names the 26.2 serverbound rename', () => {
  const result = run('diff', '26.1', '26.2', 'play', 'toServer')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^26\.1 -> 26\.2 play toServer: 1 added, 1 removed, 4 changed$/m)
  assert.match(result.stdout, /^  \+ 0x3e spectator_action$/m)
  assert.match(result.stdout, /^  - 0x3e spectate_entity$/m)
})

test('diff follows a named type into the version that changed it', () => {
  const result = run('diff', '26.1', '26.2', 'play', 'toClient')
  assert.equal(result.status, 0, result.stderr)
  // Both versions name the type packet_open_book; only the type behind the name
  // changed, so comparing param names alone would report no difference.
  assert.match(result.stdout, /^  ~ open_book 0x3a -> 0x3a$/m)
  assert.match(result.stdout, /^      ~ hand: .*"main_hand".* -> varint$/m)
})

test('diff names the branch a nested change sits in', () => {
  const result = run('diff', '26.1', '26.2', 'play', 'toClient')
  assert.equal(result.status, 0, result.stderr)
  // 26.2's teams frame changed inside its {anon:true} switch, which no named
  // top-level field can report. The path names the branch that moved.
  assert.match(result.stdout, /^      at type\.fields\.add$/m)
})

test('diff of a version against itself reports no differences', () => {
  const result = run('diff', '26.2', '26.2', 'play', 'toClient')
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '26.2 -> 26.2 play toClient: no differences\n')
})

// ---------------------------------------------------------------------------
// diff, on protocol shapes the real data does not contain
// ---------------------------------------------------------------------------

function packetTypes (mappings, params, named = {}) {
  return {
    packet: ['container', [
      { name: 'name', type: ['mapper', { type: 'varint', mappings }] },
      { name: 'params', type: ['switch', { compareTo: 'name', fields: params }] }
    ]],
    ...named
  }
}

const protocolOf = types => ({ play: { toClient: { types } } })

test('diff reports an added frame, a removed frame, and a moved id', () => {
  const before = protocolOf(packetTypes(
    { 0x00: 'kept', 0x01: 'gone' },
    { kept: 'void', gone: 'void' }
  ))
  const after = protocolOf(packetTypes(
    { 0x02: 'kept', 0x03: 'fresh' },
    { kept: 'void', fresh: 'void' }
  ))

  const diff = diffProtocols(before, after, 'play', 'toClient')
  assert.deepEqual(diff.added, [['fresh', 3]])
  assert.deepEqual(diff.removed, [['gone', 1]])
  assert.deepEqual(diff.changed.map(change => [change.name, change.oldId, change.id]), [['kept', 0, 2]])
  assert.equal(diff.changed[0].fields, null, 'an id move is not a field change')
})

test('diff lists an added field and a changed field', () => {
  const before = protocolOf(packetTypes(
    { 0x00: 'frame' },
    { frame: 'packet_frame' },
    { packet_frame: ['container', [{ name: 'x', type: 'i32' }, { name: 'gone', type: 'u8' }]] }
  ))
  const after = protocolOf(packetTypes(
    { 0x00: 'frame' },
    { frame: 'packet_frame' },
    { packet_frame: ['container', [{ name: 'x', type: 'i64' }, { name: 'added', type: 'bool' }]] }
  ))

  const [change] = diffProtocols(before, after, 'play', 'toClient').changed
  assert.deepEqual(change.fields.lines, [
    '- gone: u8',
    '+ added: bool',
    '~ x: i32 -> i64'
  ])
})

test('diff names a field whose named type was redefined', () => {
  // Both versions declare `list: named_list`; only the definition moved, so a
  // comparison of the declared types alone would report nothing.
  const named = value => ({
    packet_frame: ['container', [{ name: 'list', type: 'named_list' }]],
    named_list: ['container', [{ name: 'kind', type: ['mapper', { type: 'varint', mappings: { 0: value } }] }]]
  })
  const before = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, named('old')))
  const after = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, named('new')))

  const [change] = diffProtocols(before, after, 'play', 'toClient').changed
  assert.deepEqual(change.fields, { lines: ['~ list: named_list (definition changed)'], paths: [] })
})

test('diff says a change is nested when it sits in an unnamed container entry', () => {
  // 26.2's teams frame changed inside its {anon:true} switch, which no named
  // top-level field can report.
  const teams = prefix => ({
    packet_frame: ['container', [
      { name: 'team', type: 'string' },
      { anon: true, type: ['switch', { compareTo: 'team', fields: { add: prefix } }] }
    ]]
  })
  const before = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, teams('old')))
  const after = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, teams('new')))

  const [change] = diffProtocols(before, after, 'play', 'toClient').changed
  assert.deepEqual(change.fields, { lines: [], paths: ['type.fields.add'] })
})

test('diff follows a named type inside an unnamed entry', () => {
  // The anon entry names its type; only the definition behind the name moved.
  // Comparing the entry's declared type strings would report nothing.
  const anon = value => ({
    packet_frame: ['container', [{ anon: true, type: 'inner' }]],
    inner: ['container', [{ name: 'x', type: value }]]
  })
  const before = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, anon('i32')))
  const after = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, anon('i64')))

  const [change] = diffProtocols(before, after, 'play', 'toClient').changed
  assert.deepEqual(change.fields, { lines: [], paths: ['type.type'] })
})

test('diff reports a field-order change instead of calling it nested', () => {
  const fields = order => ({ packet_frame: ['container', order.map(name => ({ name, type: 'i32' }))] })
  const before = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, fields(['a', 'b'])))
  const after = protocolOf(packetTypes({ 0x00: 'frame' }, { frame: 'packet_frame' }, fields(['b', 'a'])))

  const [change] = diffProtocols(before, after, 'play', 'toClient').changed
  assert.deepEqual(change.fields.lines, [])
  assert.ok(change.fields.paths.length > 0, 'the difference is named by a path')
})
