// B1 target: the front-leg identity gate (pure decisions), and the one decision it
// offers. The attach check's session-verification step is the front leg's (#721).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFrontIdentity, DENY_REASONS, ALLOW_REASONS } from '../../src/core/identity.js'

const PLAYER = '0d8ea4d6-0b44-472b-b0d3-bb3db38c2a44' // "Bafbi" shape; placeholder
const PUPPET = '1e135e26-fed1-4a2c-8989-5a3bb7f9d3a4' // "GlowSquidye" shape
const STRANGER = '3f7f2c60-5fd1-4b3c-94b7-000000000042' // on no list, for the review to refuse

const identity = createFrontIdentity({
  attachWhitelist: [PLAYER],
  puppetProfile: { username: 'GlowSquidye', uuid: PUPPET }
})

test('whitelisted Login Start is allowed', () => {
  const decision = identity.reviewLoginStart({ uuid: PLAYER, name: 'Bafbi' })
  assert.equal(decision.allowed, true)
  assert.equal(decision.reason, ALLOW_REASONS.WHITELISTED)
  assert.equal(decision.phase, 'login_start')
})

test('non-whitelisted Login Start is denied at phase login_start (deny before Login Success)', () => {
  const stranger = '3f7f2c60-5fd1-4b3c-94b7-000000000042'
  const decision = identity.reviewLoginStart({ uuid: stranger, name: 'Stranger' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, DENY_REASONS.NOT_WHITELISTED)
  assert.equal(decision.phase, 'login_start')
})

test('malformed/absent UUID cannot sneak past the whitelist review, denied with a distinct reason + surfaced identity', () => {
  const noUuid = identity.reviewLoginStart({ name: 'NoUuid' })
  assert.equal(noUuid.allowed, false)
  assert.equal(noUuid.reason, DENY_REASONS.MALFORMED_UUID)
  assert.equal(noUuid.phase, 'login_start')
  assert.equal(noUuid.name, 'NoUuid')

  const bad = identity.reviewLoginStart({ uuid: 'not-a-uuid', name: 'X' })
  assert.equal(bad.allowed, false)
  assert.equal(bad.reason, DENY_REASONS.MALFORMED_UUID, 'shape failure is not conflated with not_whitelisted')
  assert.equal(bad.uuid, 'not-a-uuid')
  assert.equal(bad.name, 'X')
})

test('whitelist is case-insensitive on UUID', () => {
  assert.equal(identity.reviewLoginStart({ uuid: PLAYER.toUpperCase(), name: 'Bafbi' }).allowed, true)
})

test('whoAmI exposes configuration without secrets', () => {
  const me = identity.whoAmI()
  assert.deepEqual(me.puppet, { username: 'GlowSquidye', uuid: PUPPET })
  assert.equal(me.whitelist.length, 1)
})

// The reasons the module's one reachable decision returns, over every input it can be
// asked: a listed UUID, an unlisted one, a login with no UUID, and a malformed one.
function reasonsReturned () {
  return new Set([
    { uuid: PLAYER, name: 'Bafbi' },
    { uuid: STRANGER, name: 'Stranger' },
    {},
    { uuid: 'not-a-uuid', name: 'X' }
  ].map(input => identity.reviewLoginStart(input).reason))
}

// #721: one gate the module can be asked, and no reason a caller cannot reach.
//
// The attach check's second step is the front leg's, not this module's:
// minecraft-protocol's login handler answers the sessionserver's hasJoined before
// `options.beforeLogin`, and src/custody/attach.js `checkVerified` holds that answer to
// the whitelist there. A verifier this module was built without could only ever answer
// `allowed`, so a step that cannot refuse is not a gate, and a reason no input reaches
// is a word a reader looks for and cannot find.
test('#721 the module offers the whitelist review and no second gate that nothing calls', () => {
  const surface = Object.keys(createFrontIdentity({ attachWhitelist: [PLAYER], puppetProfile: {} })).sort()
  assert.deepEqual(surface, ['includes', 'reviewLoginStart', 'whoAmI'],
    'createFrontIdentity offers the Login Start review and the identity it was built from. A fourth ' +
    'entry point is a gate, and the only session verifier this repo injects is the front leg\'s own ' +
    '(src/legs/live-front.js, via src/custody/attach.js).')
})

test('#721 every reason the module publishes is one the whitelist review returns', () => {
  const returned = reasonsReturned()
  const unreachable = [...Object.values(ALLOW_REASONS), ...Object.values(DENY_REASONS)]
    .filter(reason => !returned.has(reason))
  assert.deepEqual(unreachable, [],
    'the module publishes a reason the whitelist review never returns. Every reason is one a caller ' +
    'can act on, so one nothing reaches is a word a reader looks for and cannot find (#721).')
})

test('#721 whoAmI reports what the module was built with, and no field about a step nobody runs', () => {
  assert.deepEqual(Object.keys(identity.whoAmI()).sort(), ['puppet', 'whitelist'],
    'whoAmI reports the whitelist and the puppet it was built with. A field answering "is a verifier ' +
    'injected" says false in every lane (#721).')
})

// #229: the attach whitelist can be a provider so a file edited between two
// logins takes effect on the next one. The array stays the default and stays
// frozen, so no existing lane changes behaviour by accident.
test('#229 a provider whitelist is read at each login, so a UUID added between two logins is allowed', () => {
  let players = [PLAYER]
  const live = createFrontIdentity({ attachWhitelist: () => players })
  assert.equal(live.reviewLoginStart({ uuid: STRANGER, name: 'Stranger' }).allowed, false)
  assert.equal(live.reviewLoginStart({ uuid: STRANGER, name: 'Stranger' }).reason, DENY_REASONS.NOT_WHITELISTED)

  players = [PLAYER, STRANGER]
  const allowed = live.reviewLoginStart({ uuid: STRANGER, name: 'Stranger' })
  assert.equal(allowed.allowed, true, 'the same gate allows it on the next login, with no rebuild')
  assert.equal(allowed.reason, ALLOW_REASONS.WHITELISTED)
})

test('#229 a provider whitelist is case-insensitive and reports what it holds now', () => {
  let players = [PLAYER]
  const live = createFrontIdentity({ attachWhitelist: () => players })
  players = [PLAYER, STRANGER.toUpperCase()]
  assert.equal(live.reviewLoginStart({ uuid: STRANGER.toUpperCase(), name: 'Stranger' }).allowed, true)
  assert.deepEqual(live.whoAmI().whitelist, [PLAYER, STRANGER].map(uuid => uuid.toLowerCase()))
})

test('#229 a provider that throws denies, it never allows', () => {
  const broken = createFrontIdentity({
    attachWhitelist: () => { throw new Error('control file is a directory') }
  })
  const decision = broken.reviewLoginStart({ uuid: PLAYER, name: 'Bafbi' })
  assert.equal(decision.allowed, false)
  assert.equal(decision.reason, DENY_REASONS.NOT_WHITELISTED)
})

test('#229 an array whitelist is still a snapshot, so a caller mutating its own array changes nothing', () => {
  const players = [PLAYER]
  const fixed = createFrontIdentity({ attachWhitelist: players })
  players.push(STRANGER)
  assert.equal(fixed.reviewLoginStart({ uuid: STRANGER, name: 'Stranger' }).allowed, false)
})
