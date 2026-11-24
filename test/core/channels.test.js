// #269: the channel. One attaching player's delivery of one body: whether it is
// the driver or a spectator, what it has been sent, and its own client settings.
// The claim (src/core/claims.js) decides who may drive a body; this registry
// decides what each connection on that body has been handed. Nothing here reads a
// clock, touches a socket, or writes a frame: the caller passes the moment and the
// frame it delivered.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { CHANNEL_ROLES, createChannels } from '../../src/core/channels.js'

const BODY = 'gate-paper:25565'

test('#269 a body serves a driver and a spectator, each with its own delivery state', () => {
  const channels = createChannels()
  const driver = channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Pilot', at: 1000 })
  const spectator = channels.open({ id: 'c2', body: BODY, role: CHANNEL_ROLES.SPECTATOR, name: 'Watcher', at: 2000 })

  assert.equal(driver.ok, true)
  assert.equal(spectator.ok, true)
  assert.equal(driver.channel.role, 'driver')
  assert.equal(spectator.channel.role, 'spectator')

  // What each has been sent is its own. The driver has been following the body
  // since it landed; the spectator arrived after.
  channels.noteDelivery({ id: 'c1', state: 'play', name: 'map_chunk' })
  channels.noteDelivery({ id: 'c1', state: 'play', name: 'entity_velocity' })
  channels.noteDelivery({ id: 'c2', state: 'play', name: 'map_chunk' })
  channels.markReplay('c2')

  const after = channels.on(BODY)
  assert.equal(after.length, 2)
  assert.equal(after[0].role, 'driver', 'the driver comes first, so a caller can read the body\'s owner')
  assert.deepEqual(after[0].delivered, {
    frames: 2,
    play: 2,
    configuration: 0,
    last: { state: 'play', name: 'entity_velocity' },
    replays: 0
  })
  assert.deepEqual(after[1].delivered, {
    frames: 1,
    play: 1,
    configuration: 0,
    last: { state: 'play', name: 'map_chunk' },
    replays: 1
  })
  assert.equal(channels.driverOf(BODY).id, 'c1')
  assert.equal(channels.size, 2)
})

test('#269 two clients on one body never share one record', () => {
  const channels = createChannels()
  channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Pilot' })
  channels.open({ id: 'c2', body: BODY, role: CHANNEL_ROLES.SPECTATOR, name: 'Watcher' })

  // Each client's own client information, recorded where it arrives.
  channels.settings('c1', { locale: 'en_gb', viewDistance: 8 })
  channels.settings('c2', { locale: 'fr_fr', viewDistance: 32 })

  const [driver, spectator] = channels.on(BODY)
  assert.deepEqual(driver.settings, { locale: 'en_gb', viewDistance: 8 })
  assert.deepEqual(spectator.settings, { locale: 'fr_fr', viewDistance: 32 })

  // A record a caller reads is a copy: writing to it cannot reach the registry.
  driver.settings.locale = 'de_de'
  assert.equal(channels.of('c1').settings.locale, 'en_gb')
})

test('#269 one body carries one driver: a second driver is refused with the one that holds it', () => {
  const channels = createChannels()
  channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Pilot' })

  const rival = channels.open({ id: 'c2', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Rival' })

  assert.equal(rival.ok, false)
  assert.equal(rival.reason, 'driver_held')
  assert.equal(rival.channel.id, 'c1', 'the refusal names the channel that holds the body')
  assert.equal(rival.channel.name, 'Pilot')
  assert.equal(channels.size, 1, 'a refused channel is not opened')
  assert.equal(channels.of('c2'), null)
})

test('#269 the leg names the body it serves by the one driver channel it holds', () => {
  const channels = createChannels()
  assert.equal(channels.driverChannel(), null)
  channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.SPECTATOR })
  assert.equal(channels.driverChannel(), null, 'a spectator does not name a body the leg drives')
  channels.open({ id: 'c2', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Pilot' })
  assert.equal(channels.driverChannel().id, 'c2')
  assert.equal(channels.driverChannel().body, BODY)
  channels.close('c2')
  assert.equal(channels.driverChannel(), null, 'the body outlives its driver, and so does its spectator')
})

test('#269 a spectator on another body is not this body\'s spectator', () => {
  const channels = createChannels()
  channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.DRIVER })
  channels.open({ id: 'c2', body: 'other:25565', role: CHANNEL_ROLES.SPECTATOR })

  assert.deepEqual(channels.on(BODY).map(channel => channel.id), ['c1'])
  assert.deepEqual(channels.on('other:25565').map(channel => channel.id), ['c2'])
  assert.equal(channels.driverOf('other:25565'), null)
})

test('#269 a channel ends with its connection, and the body keeps whatever is left', () => {
  const channels = createChannels()
  channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.DRIVER, name: 'Pilot' })
  channels.open({ id: 'c2', body: BODY, role: CHANNEL_ROLES.SPECTATOR, name: 'Watcher' })

  const released = channels.close('c1')
  assert.equal(released.id, 'c1')
  assert.equal(released.role, 'driver')
  assert.equal(channels.driverOf(BODY), null, 'the body has no driver, and its spectator still watches')
  assert.deepEqual(channels.on(BODY).map(channel => channel.id), ['c2'])
  assert.equal(channels.close('c1'), null, 'closing a channel twice releases nothing')
  assert.equal(channels.close('unknown'), null)

  channels.close('c2')
  assert.deepEqual(channels.on(BODY), [], 'the last channel of a body leaves nothing behind')
  assert.equal(channels.size, 0)
})

test('#269 a channel is opened with a connection id and a role', () => {
  const channels = createChannels()
  assert.throws(() => channels.open({ body: BODY, role: CHANNEL_ROLES.DRIVER }), TypeError)
  assert.throws(() => channels.open({ id: '', body: BODY, role: CHANNEL_ROLES.DRIVER }), TypeError)
  assert.throws(() => channels.open({ id: 'c1', body: BODY, role: 'owner' }), TypeError)
  assert.equal(channels.open({ id: 'c1', role: CHANNEL_ROLES.SPECTATOR }).ok, true,
    'a channel the lane admits without a claim has no body, which is the lane\'s own')
  assert.equal(channels.of('c1').body, null)

  const again = channels.open({ id: 'c1', body: BODY, role: CHANNEL_ROLES.SPECTATOR })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'in_use', 'one connection, one channel')
})
