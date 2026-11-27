// The client's own world read (#675): what a real client holds in its level, as
// opposed to what it was told about that level.
//
// The skin op reads the client's tab list (conn.getOnlinePlayers() in
// tools/driver/src/main/java/eu/monoplayer/driver/DriverServer.java), so a run can
// prove the client holds a player_info entry for the puppet's UUID and say nothing
// about whether a body stands in that client's world. That was the owner's report
// (#632) one layer up: an entry with nobody standing in it, and the general form of
// #598's lesson, where a protocol bot passed a bug a real client died on.
//
// The entities op reads the level instead. This module turns that payload into the
// rows and the answers a report quotes. The two ops answer two different questions,
// and neither answers for the other:
//
//   skin      the client holds an entry for this UUID, with these textures
//             properties. It is not a body: a client holds an entry for a player it
//             never draws.
//   entities  this client holds a body for this UUID, at this position, and this is
//             the skin it resolved for that body. It is not the entry: read the
//             resolved texture against the property the proxy wrote, and read skin
//             for the entry itself.
//
// Neither says a person saw anything. That is the witness half of #634
// (src/driver/dev-proof.js).
import { FIRST_VIRTUAL_ENTITY_ID } from '../core/virtual-players.js'
import { skinBodyKind } from './skin.js'

// What one entity read cannot say, in the words a report can quote. The two halves
// are named together because a run that quotes one without the other is claiming a
// pair from a single op.
export const ENTITY_LIMITS = Object.freeze([
  'This is one client\'s level: a row is a body that client holds. A player the tab list holds and the client never spawns has no row here, so an empty answer names a missing body rather than a missing entry.',
  'A row\'s skin is the texture the client resolved for that body, not the property the proxy wrote for it. Compare the resolved path with the property (src/driver/skin.js) before claiming the puppet\'s skin is drawn.',
  'A row is where the client drew the entity, not what the server sees: this is a client read, and the server-side assertion is its pair.',
  'A row is a body the client\'s level holds, not a sighting: the read runs no frustum or occlusion test, so an entity behind the player has a row here as well.'
])

const isObject = value => value !== null && typeof value === 'object'

const finite = value => {
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

const trimmed = value => String(Math.round(Number(value) * 100) / 100)

// A position a reader can compare with another, or null when the payload carried none.
function readPos (raw) {
  if (!isObject(raw)) return null
  const x = finite(raw.x)
  const y = finite(raw.y)
  const z = finite(raw.z)
  return x === null || y === null || z === null ? null : { x, y, z }
}

// The proxy mints its own entity ids from FIRST_VIRTUAL_ENTITY_ID upward, one per
// player UUID for the life of the process (src/core/virtual-players.js). A row at or
// above it is a body the proxy invented, which is how a run names the puppet rather
// than guessing from a name.
export function isVirtualEntityId (id) {
  const number = finite(id)
  return number !== null && number >= FIRST_VIRTUAL_ENTITY_ID
}

// One row of the mod's payload, in the shape this side compares and quotes.
export function readEntityRow (raw) {
  const id = finite(raw?.id)
  const skin = isObject(raw?.skin) ? raw.skin : null
  return {
    id,
    type: typeof raw?.type === 'string' ? raw.type : null,
    uuid: typeof raw?.uuid === 'string' ? raw.uuid : null,
    name: typeof raw?.name === 'string' ? raw.name : null,
    pos: readPos(raw?.pos),
    distance: finite(raw?.distance),
    local: raw?.local === true,
    player: raw?.player === true,
    virtual: isVirtualEntityId(id),
    skin,
    skinKind: skinBodyKind(skin?.body ?? null)
  }
}

// The whole payload: the frame the read was taken in, and the rows in the order the
// mod sent them. The radius and the level's own count are read back from the mod
// rather than assumed here, because the mod owns both numbers: it filtered by one
// and capped the other.
export function readEntityReading (payload) {
  if (!isObject(payload)) throw new Error('the driver reported no entities payload')
  if (!Array.isArray(payload.entities)) {
    throw new Error('the driver reported no entities list: nothing to read, and an empty list is a different answer')
  }
  const radius = finite(payload.radius)
  if (radius === null) {
    throw new Error('the driver reported no radius, so these rows are not a reading of one')
  }
  return {
    dimension: payload.dimension ?? null,
    radius,
    center: readPos(payload.center),
    inLevel: finite(payload.inLevel),
    truncated: payload.truncated === true,
    rows: payload.entities.map(readEntityRow)
  }
}

// One row by UUID, or by the client's own entity id when given a number. A UUID
// compares case-insensitively: the payload is the client's, and a report may have
// upper-cased it.
export function findEntity (reading, key) {
  const rows = Array.isArray(reading?.rows) ? reading.rows : []
  if (typeof key === 'number') return rows.find(row => row.id === key) ?? null
  const needle = String(key ?? '').toLowerCase()
  if (needle === '') return null
  return rows.find(row => typeof row.uuid === 'string' && row.uuid.toLowerCase() === needle) ?? null
}

export function formatEntityPos (pos) {
  if (pos === null || pos === undefined) return '(unknown)'
  return '(' + trimmed(pos.x) + ', ' + trimmed(pos.y) + ', ' + trimmed(pos.z) + ')'
}

// The sentence a report quotes, which is the claim the epic needs: this UUID has a
// body in this client's world, of this type, and it is or is not the player the
// client controls.
export function describeEntity (row, { name = true } = {}) {
  const who = row.uuid ?? ('id ' + row.id)
  const named = name && typeof row.name === 'string' && row.name !== '' ? ' (' + row.name + ')' : ''
  return 'entity ' + who + named + ' exists at ' + formatEntityPos(row.pos) +
    ', type ' + (row.type ?? 'unknown') + ', ' + (row.local ? 'me' : 'not me')
}

// The row fields an absent answer carries, so a caller reads one shape either way.
const ABSENT = Object.freeze({
  id: null,
  type: null,
  name: null,
  pos: null,
  distance: null,
  local: false,
  player: false,
  virtual: false,
  skin: null,
  skinKind: null
})

// What a run asserts about one UUID, as data. present: false is the answer that names
// the gap: an entry in the tab list and no body in the world. complete: false is the
// other answer, that the mod capped the rows, so this read cannot say a body is
// absent. An answer that could not be given never reads as one that was.
export function entityPresence (reading, { uuid } = {}) {
  const key = String(uuid ?? '').toLowerCase()
  const row = findEntity(reading, key)
  const rows = Array.isArray(reading?.rows) ? reading.rows.length : 0
  if (row !== null) {
    return { ...row, uuid: key, present: true, complete: true, sentence: describeEntity(row) }
  }
  const truncated = reading?.truncated === true
  const inLevel = finite(reading?.inLevel)
  const radius = finite(reading?.radius)
  const because = truncated
    ? ' among the ' + rows + ' row(s) this answer carries, and the mod capped them' +
      (inLevel === null ? '' : ' out of ' + inLevel) + ': a capped read cannot say a body is absent'
    : ' in the ' + rows + ' row(s) within ' + (radius === null ? 'the radius' : trimmed(radius) + ' blocks') +
      ' of the client' + (inLevel === null ? '' : ', ' + inLevel + ' in its level') +
      ': an entry in the tab list is not a body here'
  return { ...ABSENT, uuid: key, present: false, complete: !truncated, sentence: 'no entity ' + key + because }
}
