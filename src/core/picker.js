// The picker's dialog and its answer (#257).
//
// The picker is a dialog the front shows a joining client during the
// configuration phase, when no backend is connected. Two levels (#257, #266) and
// two clicks, and none of it is a socket. The front sends a dialog and reads a
// click back. The first level names a server. The second names a verb on that
// server.
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
// #266: the second level's verbs. One namespace per verb, not one namespace with
// the verb inside it. With the verb in the path (`monoplayer:pick/<slug>/claim`),
// `readPickAction` returns a pick of a server called `<slug>/claim`. The two levels
// are then told apart by splitting a slug. One namespace per verb keeps a level-one
// answer and a level-two answer distinguishable at the first field.
export const PICK_VERBS = ['claim', 'spectate', 'disconnect']
const VERB_NAMESPACE = 'monoplayer:'
const VERB_LABELS = { claim: 'Claim', spectate: 'Spectate', disconnect: 'Disconnect' }
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

// #258: the address a row names. A row's name is the backend it points at
// ("paper:25565"), and a claim lands the client on that body, so the leg needs
// the address out of the label. The slug is lossy (the colon becomes `_` and a
// host keeps its case), so this reads the name and never the id. Null for a name
// that is not an address: a lane whose row cannot be dialled refuses the claim
// in words rather than dialling a host called "paper".
export function pickTarget (name) {
  const raw = String(name ?? '')
  const colon = raw.lastIndexOf(':')
  if (colon <= 0 || colon === raw.length - 1) return null
  // A bracketed IPv6 address is written the way a URL writes one and dialled the
  // way the socket layer takes one.
  const host = raw.startsWith('[') && raw.slice(0, colon).endsWith(']')
    ? raw.slice(1, colon - 1)
    : raw.slice(0, colon)
  const port = Number(raw.slice(colon + 1))
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (host.length === 0) return null
  return { host, port }
}

function textComponent (text) {
  return { type: 'string', value: String(text) }
}

// One button per row. `rows` are { name, state, driver }, the picker's own
// vocabulary: a body is claimed, unclaimed, or down, and a claimed body names who
// is driving it.
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
  const buttons = pickerRows(rows).map(row => actionButton(pickerLabel(row), row.id))
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

// The identifier out of a serverbound `custom_click_action`, in the vanilla layout
// the client actually sends: packet id, then a length-prefixed identifier, then a
// length-prefixed optional tag this module never reads. Null for a frame that is
// not one, so no caller can mistake an unrelated click for an answer.
export function readActionId (buffer) {
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
  try {
    return buffer.toString('utf8', start, end)
  } catch {
    return null
  }
}

// Read the pick out of a serverbound `custom_click_action` frame. Returns null for
// a frame that is not one, so a caller cannot mistake an unrelated click for a pick.
export function readPickAction (buffer) {
  const identifier = readActionId(buffer)
  if (identifier === null || !identifier.startsWith(PICK_NAMESPACE + '/')) return null
  const slug = identifier.slice(PICK_NAMESPACE.length + 1)
  if (slug.length === 0) return null
  return { id: identifier, slug }
}

// #266: the second level. A clicked server opens its own dialog, and each button
// answers with a verb and the server it belongs to. The server is in the id, never
// in a connection's memory. The frame the client sends says which dialog it came
// from and which server it names. A leg that lost its state therefore cannot act on
// the wrong server, and nothing has to be kept in step between two clients.
export function verbIdFor (verb, name) {
  if (!PICK_VERBS.includes(verb)) {
    throw new TypeError('verb must be one of ' + PICK_VERBS.join(', ') + ', got ' + JSON.stringify(verb))
  }
  return VERB_NAMESPACE + verb + '/' + pickSlug(name)
}

// One button of a multi_action dialog: a label, a width, and one custom action on
// the id a click will carry. Both levels write their buttons through this, so the
// nested compound has one author. The element is a bare key map, for the reason
// recorded in `pickerDialog`.
function actionButton (label, id) {
  return {
    label: textComponent(label),
    width: { type: 'int', value: 200 },
    action: {
      type: 'compound',
      value: {
        type: { type: 'string', value: PICK_ACTION_TYPE },
        id: { type: 'string', value: id }
      }
    }
  }
}

// The chosen server's own dialog: claim, spectate, disconnect. Same shape as the
// picker's, and its title is the words the picker's button carried for it.
export function serverDialog ({ server = {} } = {}) {
  const buttons = PICK_VERBS.map(verb => actionButton(VERB_LABELS[verb], verbIdFor(verb, server.name)))
  return {
    type: 'compound',
    name: '',
    value: {
      type: { type: 'string', value: PICK_DIALOG_TYPE },
      title: textComponent(pickerLabel(server)),
      can_close_with_escape: { type: 'byte', value: 0 },
      columns: { type: 'int', value: 1 },
      actions: { type: 'list', value: { type: 'compound', value: buttons } }
    }
  }
}

export function serverDialogParams (options) {
  return { dialog: serverDialog(options) }
}

// Read a click on a server's dialog. Unlike `readPickAction`, a refusal is a
// result, not a null. The ticket requires the client to be told what was wrong, and
// a sentence needs to know whether the verb was unknown, the id was someone else's,
// or a server was missing. `ok: true` is the only case a caller acts on.
export function readServerAction (buffer) {
  const id = readActionId(buffer)
  if (id === null) return { ok: false, reason: 'not_a_click', id: null, verb: null, slug: null }
  if (!id.startsWith(VERB_NAMESPACE)) return { ok: false, reason: 'unknown_id', id, verb: null, slug: null }
  const rest = id.slice(VERB_NAMESPACE.length)
  const slash = rest.indexOf('/')
  if (slash < 0) return { ok: false, reason: 'malformed', id, verb: rest, slug: null }
  const verb = rest.slice(0, slash)
  const slug = rest.slice(slash + 1)
  if (verb.length === 0 || slug.length === 0) {
    return { ok: false, reason: 'malformed', id, verb, slug }
  }
  if (!PICK_VERBS.includes(verb)) return { ok: false, reason: 'unknown_verb', id, verb, slug }
  return { ok: true, reason: null, id, verb, slug }
}

// What is wrong with a refused click, as one sentence a log and a client can both
// carry. It names the id and the part that did not read.
export function serverActionProblemText (action) {
  const id = action?.id === null || action?.id === undefined ? 'the answer' : '"' + action.id + '"'
  switch (action?.reason) {
    case 'unknown_verb':
      return 'Monoplayer: the answer ' + id + ' names the verb "' + action.verb +
        '", which this dialog does not offer. It offers claim, spectate and disconnect.'
    case 'unknown_id':
      return 'Monoplayer: the answer ' + id + ' is not a Monoplayer action.'
    case 'malformed':
      return 'Monoplayer: the answer ' + id + ' names no server.'
    default:
      return 'Monoplayer: the answer is not a dialog click this lane can read.'
  }
}

// A verb this lane reads and cannot carry yet. `disconnect` is the one verb the
// dialog layer can honour, so it is not refused here: the client leaves, and its
// configuration `disconnect` frame says which server it left (#266). `claim` is
// no longer one of them: #267 records a claim where the client answers
// (src/core/claims.js), and its refusal has its own sentence there. `spectate`
// still acts on a body nothing watches from this phase, so this is what it gets.
export function verbRefusalText ({ verb = null, server = null } = {}) {
  const named = server === null ? 'that server' : server
  const asked = verb === null ? 'that' : verb
  return 'Monoplayer: ' + named + ' was asked for ' + asked + ', and this lane cannot carry a ' + asked + ' yet.'
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

// A pick naming a server the lane does not offer. The dialog on screen may be a
// moment older than the list, so the sentence says which id did not match rather
// than repeating the list.
export function pickUnknownText ({ id = null } = {}) {
  const named = id === null ? 'that answer' : '"' + id + '"'
  return 'Monoplayer: ' + named + ' names no server this lane offers.'
}

// #258: the list a client comes back to when the body it claimed did not let it
// in. The title names that body, so a failed landing is a choice the client can
// make again rather than a dialog nobody will read.
export function claimRestoreTitle ({ server = null } = {}) {
  const named = server === null ? 'that server' : server
  return 'Choose a server - ' + named + ' did not answer'
}

// #258: the sentence a client gets when its claim was granted and the body could
// not be entered. The one case the client is ended rather than offered the list
// again is a body that answered every frame and then refused the finish.
export function claimFailureText ({ server = null } = {}) {
  const named = server === null ? 'that server' : server
  return 'Monoplayer: ' + named + ' accepted the connection and could not be entered.'
}

// What the client is told when the picker cannot go on: no servers to offer, or a
// dialog that could not be written. A pick that names an offered server opens that
// server's dialog (#266), and a claim on it dials that body (#258), so neither of
// those is what this sentence is for. It is for a lane that cannot show the list at
// all.
export function pickRefusalText ({ server = null } = {}) {
  const named = server === null ? 'that server' : server
  return 'Monoplayer: ' + named + ' could not be offered on this lane.'
}
