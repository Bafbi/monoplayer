// The puppet's skin on the human's own player (#99).
//
// The front leg authenticates the human's client as the human, so the body that
// client draws is the human's own. The world inside it is the puppet's, and the
// backend's own `player_info` lists the puppet, never the human, so nothing in
// the relay gives the human's UUID a skin. A client resolves every player's skin
// from that player's `player_info` entry and falls back to a vanilla default
// (steve, alex, or one of the 26.x defaults) when it holds no entry, so the
// human's own body renders a default skin today.
//
// A server-side skin change is one `player_info` `add_player` entry for the
// player's own UUID carrying the skin's `textures` property. This module builds
// exactly that frame from a property the backend already sent: the proxy holds no
// skin of its own and invents none, so a property that no relayed frame carried
// is a property the proxy does not have.
//
// Two client facts shape the frame (`ClientPacketListener.handlePlayerInfoUpdate`,
// 26.2):
//
//   add_player only   an entry is created only by ADD_PLAYER, and an existing
//                     entry wins (`putIfAbsent`). The map holding those entries
//                     belongs to one `ClientPacketListener`. A fresh connection
//                     creates one, and so does a reconfiguration: the client
//                     builds a new listener in
//                     `ClientConfigurationPacketListenerImpl.handleConfigurationFinished`.
//                     Both start with no entry, so a frame written for one play
//                     state does not reach the next (#134).
//   no update_listed  the tab list is the client's own `listedPlayers` set,
//                     which only UPDATE_LISTED fills. Without that action the
//                     entry carries a skin and adds no tab list line beside the
//                     puppet's, which is what the ticket asks for.
//
// Signature: the client requires a signed property only for players other than
// the one it controls (`PlayerInfo.createSkinLookup` passes `requireSecure =
// !isLocalPlayer(profileId)`), so the human's own UUID accepts the puppet's
// signature unchanged, and it accepts an unsigned copy of the same property as
// well. Measured on a real 26.2 client; see testdata/skin-verdict.md.
//
// Field shapes come from the vendored 26.2 protocol data:
// `node tools/protocol.mjs frame 26.2 play toClient player_info`.

export const SKIN_FRAME = 'player_info'
export const TEXTURES_PROPERTY = 'textures'

// `player_info`'s action field is a bitflag byte and bit 0 is add_player. A
// packet object carries the flags, not the raw byte: the protocol data's
// bitflags writer reads the named flags and writes their mask.
export const ADD_PLAYER_ONLY = Object.freeze({ _value: 1, add_player: true })

// The textures property in a list of profile properties, as it states itself.
// The first one that carries a value wins.
export function pickTextures (properties) {
  if (!Array.isArray(properties)) return null
  for (const property of properties) {
    if (property?.name !== TEXTURES_PROPERTY) continue
    if (typeof property.value !== 'string' || property.value === '') continue
    return typeof property.signature === 'string' && property.signature !== ''
      ? { value: property.value, signature: property.signature }
      : { value: property.value }
  }
  return null
}

// The entries a `player_info` frame lists, whichever shape the caller holds.
function entriesOf (packet) {
  return Array.isArray(packet?.data) ? packet.data : []
}

// The UUID as a comparison key. A UUID reaches the pick from two places, the
// resolved account and the decoded packet, and case and hyphens are not a
// difference between them. A validator it is not: a malformed string compares
// equal only to itself.
function uuidKey (value) {
  return typeof value === 'string' ? value.replace(/-/g, '').toLowerCase() : null
}

// The textures property a relayed `player_info` frame states for one UUID.
//
// The entry is chosen by UUID, never by position. A busy backend sends the whole
// tab list through this frame, so the first entry with a property is usually
// another player's (#134). Picking by position put a stranger's skin on the
// human's body, and it made the known-property comparison change on every frame
// that carried one. The measurement is in testdata/skin-verdict.md.
//
// No UUID is no answer. A caller that cannot name the player's UUID takes no
// property, rather than whichever one arrived first.
export function texturesPropertyOf (packet, { uuid = null } = {}) {
  const wanted = uuidKey(uuid)
  if (wanted === null || wanted === '') return null
  for (const entry of entriesOf(packet)) {
    if (uuidKey(entry?.uuid) !== wanted) continue
    const picked = pickTextures(entry?.player?.properties)
    if (picked !== null) return picked
  }
  return null
}

// Whether any entry in the frame states a textures property, whoever's it is.
// A config that names no puppet UUID takes no skin, and this is how the core
// tells a frame that carried one from a frame that carried none.
export function carriesTextures (packet) {
  for (const entry of entriesOf(packet)) {
    if (pickTextures(entry?.player?.properties) !== null) return true
  }
  return false
}

// One `player_info` frame that gives `uuid` the skin of `property`. The name is
// the client's own name for the human: the profile in the frame is the only place
// the client learns which account the entry belongs to, and the human's client
// already holds that name.
export function skinPlayerInfoPacket ({ uuid, name, property } = {}) {
  if (typeof uuid !== 'string' || uuid === '') throw new TypeError('skinPlayerInfoPacket needs a uuid')
  if (typeof name !== 'string' || name === '') throw new TypeError('skinPlayerInfoPacket needs a name')
  if (!property || typeof property.value !== 'string' || property.value === '') {
    throw new TypeError('skinPlayerInfoPacket needs a textures property with a value')
  }
  const textures = { name: TEXTURES_PROPERTY, value: property.value }
  if (typeof property.signature === 'string' && property.signature !== '') textures.signature = property.signature
  return {
    action: { ...ADD_PLAYER_ONLY },
    data: [{ uuid, player: { name, properties: [textures] } }]
  }
}

// The same property with its signature removed. Nothing in the product sends
// this: it exists so the measured run can ask the client whether an unsigned
// property would work too, which decides whether a future change could drop the
// signature requirement.
export function withoutSignature (property) {
  if (!property || typeof property.value !== 'string') throw new TypeError('withoutSignature needs a textures property')
  return { value: property.value }
}
