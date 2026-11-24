// The picker's dialog and its answer (#257).
//
// The picker is a dialog the front shows a joining client during the
// configuration phase, when no backend is connected. Two halves, and neither is
// a socket: the dialog the front sends, and the click the front reads back.
//
// Where the pick rides. The vanilla answer frame is
//   Identifier id, lengthPrefixed(optional anonymous NBT) payload
// (net.minecraft.network.protocol.common.ServerboundCustomClickActionPacket).
// The dialog's own action type is `minecraft:dynamic/custom`, with fields `id`
// and optional `additions`, read out of ClientboundShowDialogPacket's codec in
// the 26.2 client. minecraft-data's packet shape omits the length prefix, so the
// library's own writer produces a frame a server misreads, and its reader
// misreads a frame a client sends with a payload. The id is the first field and
// survives both, so the pick rides in the id and never in `additions`. That
// decision was taken on the ticket (#257, first comment), and this module is
// where it is enforced: `readPickAction` parses the vanilla layout itself and
// reads nothing else.
//
// The dialog shape is Minecraft's own. `minecraft:multi_action` flattens
// CommonDialogData (title, can_close_with_escape, ...) beside `actions`,
// `exit_action` and `columns`, and each action button flattens CommonButtonData
// (`label`, `width`) beside `action`. The reference in this repository is the
// `minecraft:dialog` registry a real Paper 26.2 sends, which is inside the
// committed baseline (src/legs/configuration-baseline/26.2.json): its
// `exit_action` carries `label` and `width` inline, which is the same flattening.
import { decodeVarInt, encodeVarInt } from './client-settings.js'

export const PICK_NAMESPACE = 'monoplayer:pick'
export const PICK_DIALOG_TYPE = 'minecraft:multi_action'
export const PICK_ACTION_TYPE = 'minecraft:dynamic/custom'
// The configuration-state packet id of `custom_click_action`. The play state
// uses 0x44. The picker only ever runs in configuration.
const CONFIGURATION_CLICK_PACKET_ID = 0x08

// A resource location path segment, so a server label survives as an id: lower
// case, and nothing outside [a-z0-9/._-]. A host and port ("paper:25565") is not
// a legal identifier, so the id is a slug of it and the dialog's label carries
// the readable name.
export function pickSlug (name) {
  const raw = String(name ?? '').toLowerCase()
  const slug = raw.replace(/[^a-z0-9/._-]+/g, '_').replace(/^[._/-]+|[._/-]+$/g, '')
  return slug.length > 0 ? slug : 'server'
}

export function pickIdFor (name) {
  return PICK_NAMESPACE + '/' + pickSlug(name)
}

function textComponent (text) {
  return { type: 'string', value: String(text) }
}

// One button per row. `rows` are { name, state, driver } — the picker's own
// vocabulary: a body is claimed, unclaimed, or down, and a claimed body names
// who is driving it.
export function pickerLabel (row) {
  const name = String(row?.name ?? 'server')
  const state = String(row?.state ?? 'down')
  const driver = row?.driver ? String(row.driver) : null
  return driver === null ? name + ' - ' + state : name + ' - ' + state + ' (' + driver + ')'
}

export function pickerRows (rows = []) {
  return rows.map(row => ({
    name: String(row?.name ?? 'server'),
    state: String(row?.state ?? 'down'),
    driver: row?.driver ? String(row.driver) : null,
    slug: pickSlug(row?.name),
    id: pickIdFor(row?.name)
  }))
}

// The dialog as the NBT the show_dialog frame carries. Pure: the caller writes
// it, so a test can compare the tree without a socket.
export function pickerDialog ({ rows = [], title = 'Choose a server' } = {}) {
  // A list of compounds carries each element as the compound's own key map, not
  // as a { type, value } node: prismarine-nbt's list writer takes the element map
  // and writes each key. A wrapped element is written as an empty compound and
  // the wrapper's keys are left on the wire, which the client reads as a dialog
  // with no buttons.
  const buttons = pickerRows(rows).map(row => ({
    label: textComponent(pickerLabel(row)),
    width: { type: 'int', value: 200 },
    action: {
      type: 'compound',
      value: {
        type: { type: 'string', value: PICK_ACTION_TYPE },
        id: { type: 'string', value: row.id }
      }
    }
  }))
  return {
    type: 'compound',
    name: '',
    value: {
      type: { type: 'string', value: PICK_DIALOG_TYPE },
      title: textComponent(title),
      // A picker that Esc closes would leave the client in a configuration phase
      // with nothing on screen: the dialog is the whole phase here.
      can_close_with_escape: { type: 'byte', value: 0 },
      // One column: the allowed list is short, and a second column is a design
      // decision no ticket has made.
      columns: { type: 'int', value: 1 },
      actions: {
        type: 'list',
        value: { type: 'compound', value: buttons }
      }
    }
  }
}

// The packet params for a configuration-state show_dialog. The configuration
// field is a plain anonymousNbt, so the compound is the params' own value. The
// play state's field is a registry-entry holder with an inline branch named
// `data`, which is a different shape for a different state.
export function pickerDialogParams (options) {
  return { dialog: pickerDialog(options) }
}

// Read the pick out of a serverbound `custom_click_action` frame, in the vanilla
// layout the client actually sends. Returns null for a frame that is not one, so
// a caller cannot mistake an unrelated click for a pick.
export function readPickAction (buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3) return null
  // The one VarInt reader in core (src/core/client-settings.js), so this parse
  // and the encoder that built the frame cannot drift.
  const id = decodeVarInt(buffer, 0)
  if (id === null || id.value !== CONFIGURATION_CLICK_PACKET_ID) return null
  const length = decodeVarInt(buffer, id.bytes)
  if (length === null || length.value === 0) return null
  const start = id.bytes + length.bytes
  const end = start + length.value
  if (end > buffer.length) return null
  let identifier
  try {
    identifier = buffer.toString('utf8', start, end)
  } catch {
    return null
  }
  if (!identifier.startsWith(PICK_NAMESPACE + '/')) return null
  const slug = identifier.slice(PICK_NAMESPACE.length + 1)
  if (slug.length === 0) return null
  return { id: identifier, slug }
}

// The frame the picker's answer rides in, built for the front's own tests and
// for the protocol bot that has to send it. Same bytes a vanilla client sends
// with no payload: the identifier, then a VarInt length of 1 and an END tag.
export function buildPickAnswer ({ name } = {}) {
  const identifier = Buffer.from(pickIdFor(name), 'utf8')
  const payload = Buffer.from([0])
  return Buffer.concat([
    Buffer.from([CONFIGURATION_CLICK_PACKET_ID]),
    encodeVarInt(identifier.length),
    identifier,
    encodeVarInt(payload.length),
    payload
  ])
}

// What the client is told after a pick, until a pick lands somewhere. #267 is
// the ticket that makes a pick connect a body. Until it lands there is nothing to
// enter, and a client left staring at a dialog is worse than one that is told
// why it cannot.
export function pickRefusalText ({ server = null } = {}) {
  const named = server === null ? 'that server' : server
  return 'Monoplayer: ' + named + ' was recorded, but this lane cannot connect a body yet.'
}
