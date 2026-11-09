// The proxy notice path (#15): a refused transfer reaches the attached client
// as a synthetic advancement toast, and the advancement is removed in the same
// call, so the client's advancement state is unchanged afterwards. The notice
// also works when nothing is attached, and falls back to local system chat when
// the toast write fails.
//
// The fakes record what the core writes to the front leg; the packet shape is
// proved in test/core/notice.test.js.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createMonoplayer, DEFAULT_CONFIG } from '../../src/service/monoplayer.js'
import { createFakeBackendLeg, createFakeFrontLeg } from '../../src/legs/fake-legs.js'
import { noticeId } from '../../src/core/notice.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44'
const BUFFER = name => Buffer.from(`backend:${name}`)

function fakeClock () {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout (fn, ms) { const t = { fn, fires: now + ms }; timers.push(t); return t },
    clearTimeout (t) { timers = timers.filter(x => x !== t) },
    tick (ms) {
      now += ms
      const due = timers.filter(t => t.fires <= now)
      timers = timers.filter(t => t.fires > now)
      for (const t of due) t.fn()
    },
    get pending () { return timers.length }
  }
}

function makeCore (config = {}) {
  const clock = fakeClock()
  const backendLeg = createFakeBackendLeg()
  const frontLeg = createFakeFrontLeg()
  const core = createMonoplayer({
    config: {
      ...DEFAULT_CONFIG,
      puppet: { username: 'GlowSquidye', uuid: null },
      attachWhitelist: [PLAYER],
      ...config,
      transfer: { ...DEFAULT_CONFIG.transfer, ...(config.transfer ?? {}) }
    },
    backendLeg,
    frontLeg,
    clock
  })
  core.start()
  return { clock, backendLeg, frontLeg, core }
}

function warmBackend ({ backendLeg, core }) {
  backendLeg.deliver({ state: 'configuration', name: 'registry_data', data: {} })
  for (const frame of [
    { name: 'login', data: { entityId: 42 } },
    { name: 'game_state_change', data: { reason: 13, gameMode: 0 } },
    { name: 'position', data: { teleportId: 9, x: 0.5, y: 1.62, z: 0.5, yaw: 0, pitch: 0 } },
    { name: 'map_chunk', data: { x: 0, z: 0 } },
    { name: 'chunk_batch_finished', data: {} }
  ]) backendLeg.deliver({ state: 'play', ...frame })
  assert.equal(core.cache.warm, true)
}

function attach ({ frontLeg, core }) {
  frontLeg.loginStart({ name: 'Bafbi', uuid: PLAYER })
  const result = core.attachPlayer({ name: 'Bafbi', uuid: PLAYER })
  assert.equal(result.attached, true)
  return result
}

// A refusal: no target at all, so the session and the client stay put.
function refuseTransfer ({ backendLeg }) {
  backendLeg.deliver({ state: 'play', name: 'transfer', buffer: BUFFER('transfer'), data: { host: '', port: 0 } })
}

function noticeFramesWritten (frontLeg) {
  return frontLeg.frames().filter(frame => frame.name === 'advancements')
}

test('a refused transfer reaches the client as a toast and then removes it', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  refuseTransfer(rig)

  const written = noticeFramesWritten(rig.frontLeg)
  assert.equal(written.length, 2, 'the add and the removal')
  const [add, remove] = written
  assert.equal(add.kind, 'synth')
  assert.equal(remove.kind, 'synth')
  assert.equal(add.packet.advancementMapping.length, 1)
  const id = add.packet.advancementMapping[0].key
  assert.equal(id, noticeId(1))
  assert.equal(add.packet.advancementMapping[0].value.displayData.flags.show_toast, 1)
  assert.deepEqual(remove.packet.identifiers, [id], 'the removal names the id it added')
  assert.equal(remove.packet.reset, false)
  assert.deepEqual(remove.packet.advancementMapping, [])
  assert.equal(rig.core.metrics.noticesSent, 1)
  // The replaced path: the toast is the notice, so no chat line rides along.
  assert.equal(rig.frontLeg.frames().at(-1).name, 'advancements')
  assert.equal(rig.frontLeg.namesOf().includes('system_chat'), false)
})

test('the notice path runs with no client attached and throws nothing', () => {
  const rig = makeCore()
  warmBackend(rig)
  assert.equal(rig.core.attached, false)

  const result = rig.core.notice('A proxy action failed.')

  assert.deepEqual(result, { sent: true, kind: 'toast', id: noticeId(1) })
  assert.equal(rig.core.metrics.noticesSent, 1)
  const written = noticeFramesWritten(rig.frontLeg)
  assert.equal(written.length, 2)
  assert.equal(written[1].packet.identifiers[0], written[0].packet.advancementMapping[0].key)
})

test('a toast write that fails falls back to local system chat', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const write = rig.frontLeg.write.bind(rig.frontLeg)
  rig.frontLeg.write = (name, packet, meta) => {
    if (name === 'advancements') throw new Error('serializer refused the frame')
    return write(name, packet, meta)
  }

  refuseTransfer(rig)

  const last = rig.frontLeg.frames().at(-1)
  assert.equal(last.name, 'system_chat')
  assert.match(last.packet.content.value.text.value, /could not follow/i)
  assert.equal(rig.core.metrics.noticeFallbacks, 1)
  const logged = rig.core.logs().join('\n')
  assert.match(logged, /proxyNoticeFailed/)
})

test('the toast carries the advancement screen flag the backend last sent', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  rig.backendLeg.deliver({
    state: 'play',
    name: 'advancements',
    buffer: BUFFER('advancements'),
    data: { reset: true, advancementMapping: [], identifiers: [], progressMapping: [], showAdvancements: false }
  })
  refuseTransfer(rig)

  const written = noticeFramesWritten(rig.frontLeg).slice(-2)
  assert.equal(written.length, 2)
  assert.equal(written[0].packet.showAdvancements, false)
  assert.equal(written[1].packet.showAdvancements, false, 'the removal restores the same flag')
})

test('the toast opens the advancement screen by default when the backend sent no frame', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  refuseTransfer(rig)

  const written = noticeFramesWritten(rig.frontLeg)
  assert.equal(written.length, 2)
  for (const frame of written) assert.equal(frame.packet.showAdvancements, true)
})

test('a refusal sends one notice per attach', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  refuseTransfer(rig)
  refuseTransfer(rig)

  assert.equal(rig.core.metrics.transfersRefused, 2)
  assert.equal(noticeFramesWritten(rig.frontLeg).length, 2, 'the second refusal is silent')
  assert.equal(rig.core.metrics.noticesSent, 1)

  // A fresh attach is a fresh notice.
  rig.core.detachPlayer({ reason: 'test_detach' })
  attach(rig)
  refuseTransfer(rig)
  assert.equal(noticeFramesWritten(rig.frontLeg).length, 4)
})

test('a notice with no text is refused instead of throwing', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  assert.deepEqual(rig.core.notice(''), { sent: false, kind: null, id: null })
  assert.equal(noticeFramesWritten(rig.frontLeg).length, 0)
  assert.match(rig.core.logs().join('\n'), /proxyNoticeRejected/)
})

test('the notice leaves the session cache alone', () => {
  const rig = makeCore()
  warmBackend(rig)
  attach(rig)

  const before = rig.core.cache.snapshot().latest.map(frame => frame.name)
  refuseTransfer(rig)
  const after = rig.core.cache.snapshot().latest.map(frame => frame.name)

  assert.deepEqual(after, before, 'a synthetic frame is never cached')
  assert.equal(after.includes('advancements'), false)
})
