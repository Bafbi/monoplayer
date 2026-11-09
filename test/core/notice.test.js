// The proxy notice frames (#15): the synthetic advancement toast and its
// removal.
//
// The wire contract is proved by encoding each frame with the installed
// protocol library and reading it back with the interpreter, so the assertion
// is on the bytes a 26.x client parses, not on our own object shape. The ghost
// rule is proved by applying both frames to a client-side advancement model
// the way the vanilla client does: reset clears, identifiers remove, the
// mapping adds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import mc from 'minecraft-protocol'

import {
  NOTICE_CRITERION,
  NOTICE_TITLE,
  noticeFrames,
  noticeId,
  systemChatFrame
} from '../../src/core/notice.js'

const VERSIONS = ['26.1', '26.2']

function encode (version, frame) {
  const serializer = mc.createSerializer({ state: 'play', isServer: true, version })
  return serializer.createPacketBuffer({ name: frame.name, params: frame.packet })
}

// Decode with the compiled reader, the same one the legs use. This fork's
// interpreter path is broken (it calls a prismarine-nbt helper that does not
// exist), and the compiled reader reports an i64 as protodef's bigint wrapper,
// so an i64 is compared by value below.
function decode (version, frame) {
  const parser = mc.createDeserializer({ state: 'play', isServer: false, version, noErrorLogging: true })
  const buffer = encode(version, frame)
  const parsed = parser.parsePacketBuffer(buffer)
  assert.equal(parsed.metadata.size, buffer.length, 'the frame consumed every byte it wrote')
  return parsed.data.params
}

// The client's advancement state, as the vanilla client keeps it: a map of id
// to progress or definition, replaced wholesale on reset, pruned by
// identifiers, extended by the mapping.
function createAdvancementState (seed = {}) {
  return { advancements: new Map(Object.entries(seed)), shown: true }
}

function applyAdvancements (state, params) {
  if (params.reset) state.advancements.clear()
  for (const id of params.identifiers ?? []) state.advancements.delete(id)
  for (const entry of params.advancementMapping ?? []) state.advancements.set(entry.key, entry.value)
  for (const entry of params.progressMapping ?? []) {
    const held = state.advancements.get(entry.key)
    if (held !== undefined) state.advancements.set(entry.key, { ...held, progress: entry.value })
  }
  state.shown = params.showAdvancements
  return state
}

function notice (overrides = {}) {
  return noticeFrames({ text: 'The transfer failed. You stay on this server.', id: noticeId(1), ...overrides })
}

test('the toast is one advancement that asks for a visible toast', () => {
  for (const version of VERSIONS) {
    const [add] = notice()
    const params = decode(version, add)

    assert.equal(params.reset, false, 'the advancement set is never wiped')
    assert.equal(params.advancementMapping.length, 1)
    const entry = params.advancementMapping[0]
    assert.equal(entry.key, noticeId(1))
    assert.equal(entry.value.parentId, undefined, 'a notice has no parent to unlock')
    assert.deepEqual(entry.value.requirements, [], 'no criteria gate the toast')
    assert.equal(entry.value.sendsTelemtryData, false)

    const display = entry.value.displayData
    assert.equal(display.flags.show_toast, 1, 'the toast is the point')
    assert.equal(display.flags.has_background_texture, 0)
    assert.equal(display.frameType, 0, 'a task frame, so the client stays silent')
    assert.equal(display.title.value.text.value, NOTICE_TITLE)
    assert.equal(display.description.value.text.value, 'The transfer failed. You stay on this server.')
    assert.equal(display.icon.itemCount, 1)

    assert.equal(params.progressMapping.length, 1)
    assert.equal(params.progressMapping[0].key, noticeId(1))
    assert.equal(params.progressMapping[0].value.length, 1)
    const criterion = params.progressMapping[0].value[0]
    assert.equal(criterion.criterionIdentifier, NOTICE_CRITERION)
    assert.equal(String(criterion.criterionProgress), '0', 'a completed criterion is what queues the toast')
    assert.deepEqual(params.identifiers, [])
  }
})

test('the removal names the id it added and changes nothing else', () => {
  for (const version of VERSIONS) {
    const [add, remove] = notice()
    const added = decode(version, add)
    const removed = decode(version, remove)

    assert.equal(removed.reset, false, 'reset would wipe the server advancements too')
    assert.deepEqual(removed.identifiers, [added.advancementMapping[0].key])
    assert.deepEqual(removed.advancementMapping, [])
    assert.deepEqual(removed.progressMapping, [])
    assert.equal(removed.showAdvancements, added.showAdvancements)
  }
})

test('the server advancement set survives the notice', () => {
  const server = {
    'minecraft:story/root': { displayData: 'story' },
    'minecraft:adventure/kill_a_mob': { displayData: 'adventure' }
  }
  const before = createAdvancementState(server)
  const state = applyAdvancements(before, { reset: false, advancementMapping: [], identifiers: [], progressMapping: [], showAdvancements: true })
  assert.deepEqual([...state.advancements.keys()].sort(), Object.keys(server).sort())

  const frames = notice()
  applyAdvancements(state, frames[0].packet)
  assert.equal(state.advancements.has(noticeId(1)), true, 'the notice advanced, so the client can toast it')

  applyAdvancements(state, frames[1].packet)
  assert.deepEqual([...state.advancements.keys()].sort(), Object.keys(server).sort(), 'no ghost advancement is left')
  assert.equal(state.advancements.get('minecraft:story/root').displayData, 'story')
  assert.equal(state.shown, true)
})

test('two notices leave two removals and no state behind', () => {
  const state = createAdvancementState()
  for (const seq of [1, 2]) {
    for (const frame of noticeFrames({ text: 'notice', id: noticeId(seq) })) applyAdvancements(state, frame.packet)
  }
  assert.deepEqual([...state.advancements.keys()], [], 'each notice removed its own id')
})

test('the toast carries the advancement screen flag it is given', () => {
  for (const [given, expected] of [[false, false], [true, true], [undefined, true]]) {
    for (const frame of noticeFrames({ text: 'notice', id: noticeId(1), showAdvancements: given })) {
      assert.equal(frame.packet.showAdvancements, expected)
    }
  }
})

test('only an explicit false hides the advancement screen', () => {
  // An unknown caller value must not take the server's screen away, so it
  // counts as shown.
  for (const given of ['yes', 1, null]) {
    assert.equal(noticeFrames({ text: 'n', id: noticeId(1), showAdvancements: given })[0].packet.showAdvancements, true)
  }
})

test('a notice id stays inside the monoplayer namespace', () => {
  assert.match(noticeId(1), /^monoplayer:notice\/1$/)
  assert.notEqual(noticeId(1), noticeId(2))
  assert.throws(() => noticeFrames({ text: 'n', id: 'minecraft:story/root' }), /namespace/)
  assert.throws(() => noticeFrames({ text: '', id: noticeId(1) }), /text/)
})

test('the fallback is local system chat with the same text', () => {
  const frame = systemChatFrame('The transfer failed. You stay on this server.')
  assert.equal(frame.name, 'system_chat')
  assert.equal(frame.packet.isActionBar, false)
  assert.equal(frame.packet.content.value.text.value, 'The transfer failed. You stay on this server.')
  assert.equal(decode('26.2', frame).content.value.text.value, 'The transfer failed. You stay on this server.')
})
