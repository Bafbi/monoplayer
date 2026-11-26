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
import { CHANNEL_ROLES } from './channels.js'
import { claimRefusalText } from './claims.js'

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

// One button per row. `rows` are { name, state, driver, spectators }, the picker's
// own vocabulary: a body is claimed, unclaimed, or down, a claimed body names who
// is driving it, and a watched body names how many are watching it (#259).
//
// The order is the order a player asks the questions: what is it, is anyone
// driving it, am I alone if I watch. A body nobody watches names no count, because
// ", 0 watching" is a sentence about a player who is not there.
export function pickerLabel (row) {
  const name = String(row?.name ?? 'server')
  const state = String(row?.state ?? 'down')
  const driver = row?.driver ? String(row.driver) : null
  const spectators = spectatorCount(row?.spectators)
  const driving = driver === null ? '' : ' (' + driver + ')'
  const watching = spectators === 0 ? '' : ', ' + spectators + ' watching'
  return name + ' - ' + state + driving + watching
}

// How many watch a body, as the lane counted them. One rule for the three places a
// count arrives from, so a label, a normalised row and a composed row cannot
// disagree about what a count is. A number that is not a count is nobody.
function spectatorCount (value) {
  return Number.isInteger(value) && value > 0 ? value : 0
}

// #265: the name a row is offered under is the canonical address its claim
// dials. A claim labels a body with pickSlug(row.name). The per-body state cache is
// keyed by pickSlug(host + ':' + port) of the dial (src/core/body-caches.js,
// src/service/monoplayer.js). A name that spells one address another way would
// give one server two body ids, and one body's state two caches. So a row is
// normalised here, where every row a lane offers is read.
function canonicalPickName (name) {
  const target = pickTarget(name)
  // A name that names no address is offered as it was written. The claim refuses
  // it in words, and rewriting it would be a guess at which server was meant.
  if (target === null) return String(name ?? '')
  // A bracketed IPv6 address is written the way a URL writes one, and the socket
  // layer takes the address without its brackets. The name keeps the brackets, so
  // it parses back to the address it dials.
  const host = target.host.indexOf(':') === -1 ? target.host : '[' + target.host + ']'
  return host + ':' + target.port
}

export function pickerRows (rows = []) {
  return rows.map(row => {
    // One name per row. The slug and the id are read from the name this row is
    // offered under, never from the one its lane handed over. A claim records the
    // slug, so a row whose slug came from another spelling is the split above.
    const name = canonicalPickName(row?.name ?? 'server')
    return {
      name,
      state: String(row?.state ?? 'down'),
      driver: row?.driver ? String(row.driver) : null,
      // #259: a row the lane knows nothing about watches nobody.
      spectators: spectatorCount(row?.spectators),
      slug: pickSlug(name),
      id: pickIdFor(name)
    }
  })
}

// #259: a row with what the lane knows about the body it names, composed where
// the rows are handed out. The state answers the question a player asks first: can I
// get in. So a body that is not up is `down` whatever a claim still says about it,
// because a claim outlives a dial that failed (#295) and a row that reads `claimed`
// about a body nobody can enter sends the player into a refusal. A driver is a fact
// about an up body, so a claim on a down one names nobody.
export function pickerRowForBody (row, { up = false, driver = null, spectators = 0 } = {}) {
  const named = up && typeof driver === 'string' && driver.length > 0 ? driver : null
  return {
    ...row,
    state: up ? (named === null ? 'unclaimed' : 'claimed') : 'down',
    driver: named,
    spectators: spectatorCount(spectators)
  }
}

// #265: the rows a picker lane offers, from the read of the allowed-server list.
// `read` is src/service/control.js's own answer: the servers, and the file that
// answered. A picker lane therefore offers the live file's list, the seed's when
// the live file cannot answer, and nothing when neither is configured. The row is
// the picker's vocabulary. Its name is the `host:port` a claim dials, because a
// claim lands the client on the address its row names. A row that names anything
// else can be offered and never entered.
export function pickerOfferedRows (read = null) {
  const list = typeof read === 'function' ? read() : null
  const servers = Array.isArray(list?.servers) ? list.servers : []
  return {
    source: typeof list?.source === 'string' ? list.source : 'none',
    // #315: why there is no list when there is none, so the offer's log line can name
    // what to edit. The picker passes the reason through and never invents one: a
    // reader that reports no reason leaves it null.
    reason: typeof list?.reason === 'string' ? list.reason : null,
    rows: servers.map(server => ({
      name: String(server?.host ?? '') + ':' + String(server?.port ?? ''),
      // The list names servers, not bodies: what a body is doing is the lane's
      // answer at the offer (src/legs/live-front.js, `pickerOffer`).
      state: 'down',
      driver: null,
      spectators: 0
    }))
  }
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

// A verb this lane reads and cannot carry. `disconnect` is not one of them: since
// #261 it ends the body the frame names, and the client stays in the picker, so
// nothing here refuses it. `claim` is not one either: #267 records a claim where
// the client answers (src/core/claims.js), and its refusal has its own sentence
// there. `spectate` is the lane's since #269, and it has its own refusal below.
// What reaches here is a verb no lane offers yet.
export function verbRefusalText ({ verb = null, server = null } = {}) {
  const named = server === null ? 'that server' : server
  const asked = verb === null ? 'that' : verb
  return 'Monoplayer: ' + named + ' was asked for ' + asked + ', and this lane cannot carry a ' + asked + ' yet.'
}

// #259: the sentence a client gets when it asks to watch a body it cannot watch.
// Each reason asks the player for something different, so each gets its own
// sentence. Nothing is standing on that server yet, so claim it. This lane serves
// another body. The body is still coming up, so wait. The body is down, and a claim
// is what brings it back. A spectator is never told the body has no driver, because
// a body with no driver is watchable (#259).
export function spectateRefusalText ({ server = null, reason = null } = {}) {
  const named = server === null ? 'that server' : server
  switch (reason) {
    case 'no_body':
      return 'Monoplayer: nobody is on ' + named + ' yet, so there is nothing to watch. Claim it to drive it.'
    case 'body_not_served':
      return 'Monoplayer: this lane is not serving ' + named + '.'
    case 'body_not_warm':
      return 'Monoplayer: ' + named + ' is still connecting. Try watching it again in a moment.'
    case 'body_down':
      return 'Monoplayer: ' + named + ' is down, so there is nothing to watch. Claim it to bring it back.'
    case 'picker_off':
      return 'Monoplayer: ' + named + ' cannot be watched on this lane.'
    default:
      return 'Monoplayer: ' + named + ' cannot be watched right now.'
  }
}

// #261: the sentence a client gets when it asks to disconnect a body somebody
// holds. A disconnect is the one verb that acts on the body rather than on the
// client, so its refusal names the driver: the client can ask them, or wait for
// the claim to end with their connection. A claim with no name in it is named as
// another player rather than left blank, because a sentence with a hole in it
// reads as a bug in the lane.
export function disconnectRefusalText ({ server = null, driver = null } = {}) {
  const named = server === null ? 'that server' : server
  const who = typeof driver === 'string' && driver.length > 0 ? driver : 'another player'
  return 'Monoplayer: ' + named + ' is claimed by ' + who +
    ', so it cannot be disconnected. A body can only be disconnected while nobody claims it.'
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

// #315: what the client is told when the lane has no server to offer it. The client
// clicked nothing, so the sentence is about the lane. "That server could not be
// offered" named a choice nobody made, and a choice it cannot make again.
//
// One sentence for every empty state, because the fix is never the client's. An
// operator reads which of the five states it was on the offer's log line
// (src/service/control.js), and a player can do nothing with that.
export function pickEmptyText () {
  return 'Monoplayer: this lane is not offering any server to join.'
}

// What the client is told when a dialog could not be written. A pick that names an
// offered server opens that server's dialog (#266), and a claim on it dials that
// body (#258), so neither of those is what this sentence is for. It is for a lane
// that cannot show the list at all, and the servers exist: none of them reached the
// client. A named server keeps its own sentence, because then one row is the one
// that failed.
export function pickRefusalText ({ server = null } = {}) {
  if (server === null) return 'Monoplayer: this lane could not show its server list.'
  return 'Monoplayer: ' + server + ' could not be offered on this lane.'
}

// ---- #595: the picker's decisions, as a value ----

// The front leg holds the socket, the dialog bytes and the writes. What it should
// not hold is the answer to three questions, each of which was reachable only
// through a real connection: what a row reads as, what a click means, and which
// sentence a refusal gets.
//
//   offer: each row, composed from the body this lane is serving, the claims it
//          holds and the channels it opened.
//   click: a pick, a verb, a refusal, or a frame that is not this dialog's.
//   refuse: the sentence a refusal gets, from the verb that was answered and the
//          reason the board decided.
//
// The ports are the two boards the answer reads, `claims` and `channels`, and they
// are held for the caller's lifetime, the way `createTransfer` holds a session and a
// cache (src/core/transfer.js). The facts that change per call are arguments: the
// rows an offer was read from, and the body the session is serving. Nothing here
// writes, logs, counts, opens a channel or reads a clock; every landing is still the
// leg's own, and this module only decides.
//
// A lane that serves no picker passes neither port, and the board answers every row
// as a body nobody holds and nobody watches.
export function createPickerBoard ({ claims = null, channels = null } = {}) {
  // A port is the board itself, never a copy of it: a copy is what drifts from the
  // claim the leg records and the channel it opened.
  if (claims !== null && typeof claims?.claimOn !== 'function') {
    throw new TypeError('createPickerBoard requires a claims board that answers claimOn(body)')
  }
  if (channels !== null && typeof channels?.on !== 'function') {
    throw new TypeError('createPickerBoard requires a channels board that answers on(body)')
  }

  // #316: a row is what this lane can offer, not what it has dialled. A body whose
  // claim is held but which is not up reads `down`, and names nobody, because a
  // claim outlives a dial that failed (#295) and a row that reads `claimed` about a
  // body nobody can enter sends the player into a refusal. A claim on an up body is
  // the one fact that makes a row `claimed`, and a watcher is a spectator channel,
  // never a driver's.
  function offer ({ rows = [], served = null } = {}) {
    return pickerRows(rows ?? []).map(row => {
      const claim = claims === null ? null : claims.claimOn(row.slug)
      const watching = channels === null ? [] : (channels.on(row.slug) ?? [])
      const spectators = watching.filter(channel => channel.role === CHANNEL_ROLES.SPECTATOR).length
      const up = served !== null && served.body === row.slug && served.up === true
      return pickerRowForBody(row, { up, driver: claim === null ? null : claim.name, spectators })
    })
  }

  // #266: one click on a dialog this lane authored, at either level. The level is
  // the id's namespace, not a connection's memory, so the frame alone says which
  // dialog it answers and nothing has to be kept in step between two clients.
  //
  // The pick is read before the verb: the two levels are told apart by the
  // namespace, and a level-one answer read as a verb is an unknown verb.
  //
  // The order the leg's socket function used to hold is here, as the answer: a body
  // nobody holds is the act, and a claimed body refuses a disconnect before the act
  // is reached (#261). A row the offer does not name is refused at whichever level
  // the click came from, and the answer says which, so the leg answers a stale pick
  // with the pick's words and a stale verb with the verb's.
  function click ({ buffer = null, rows = [] } = {}) {
    const offered = pickerRows(rows ?? [])
    const pick = readPickAction(buffer)
    if (pick !== null) {
      const row = offered.find(candidate => candidate.slug === pick.slug) ?? null
      if (row === null) return refusal({ id: pick.id, slug: pick.slug, reason: 'unknown_server', level: 'pick' })
      return { kind: 'pick', level: 'pick', id: pick.id, slug: pick.slug, row }
    }
    const action = readServerAction(buffer)
    if (action.ok === true) {
      const row = offered.find(candidate => candidate.slug === action.slug) ?? null
      if (row === null) {
        return refusal({ id: action.id, verb: action.verb, slug: action.slug, reason: 'unknown_server', level: 'verb' })
      }
      // #261: a disconnect acts on a body, so a claim is what stands in the way. The
      // claim is answered with the answer rather than turned into a refusal here,
      // because the leg records the verb before it answers it, and a refused
      // disconnect is still a verb the lane was asked for. `held` is the claim that
      // will refuse it, and null for every other click.
      const held = action.verb === 'disconnect' && claims !== null ? claims.claimOn(row.slug) : null
      return { kind: 'verb', level: 'verb', id: action.id, verb: action.verb, slug: action.slug, row, held }
    }
    if (action.reason === 'not_a_click') {
      // Not a click this dialog can read at all: another packet's bytes, or a frame
      // from another state. The dialog stays on screen, so the client can still
      // choose (#257).
      return { kind: 'ignore', level: null, reason: 'not_a_pick', id: null }
    }
    // Ours to read and it did not read, so the client is told what was wrong.
    return refusal({ id: action.id, verb: action.verb, slug: action.slug, reason: action.reason })
  }

  // #542: the sentence a refusal gets, chosen in one place. The verb that was
  // answered knows its family: a claim names who holds the body, a disconnect names
  // its driver, a Spectate names what to do about the body. A verb no lane carries
  // is refused in words that name it. A click that never named a verb is refused by
  // its own reason: the part of the id that did not read, or the lane's inability to
  // show a list at all (#315).
  //
  // The three reasons a Spectate is refused with after the body's answer allowed it
  // (#435) reach the Spectate family here, and #542 is the ticket that gives each
  // one its own sentence. This dispatch is where that lands.
  function refuse ({ verb = null, reason = null, server = null, driver = null, holder = null, claimed = null, id = null } = {}) {
    // A click this lane could not read is refused in words about the id, whatever
    // verb a fragment of it looked like.
    if (reason === 'unknown_id' || reason === 'malformed' || reason === 'unknown_verb') {
      return serverActionProblemText({ reason, id, verb })
    }
    // A server this lane does not offer is refused in the same sentence at either
    // level, whatever verb the frame named: the dialog on screen is older than the
    // list, and no claim or disconnect on it happened.
    if (reason === 'unknown_server') return pickUnknownText({ id })
    // A verb this lane does not carry is refused in words that name it, and that is
    // the only sentence this branch gives: a click that did not read never reaches it,
    // because its reason is answered above.
    if (verb !== null && !PICK_VERBS.includes(verb)) return verbRefusalText({ verb, server })
    switch (verb) {
      case 'claim':
        return claimRefusalText({ reason, server, holder, claimed })
      case 'spectate':
        return spectateRefusalText({ server, reason })
      // One refusal, one sentence: a disconnect is refused by a claim and by nothing
      // else, so this family does not switch on the reason.
      case 'disconnect':
        return disconnectRefusalText({ server, driver })
    }
    switch (reason) {
      // #315: the client clicked nothing, so a lane with nothing to offer speaks
      // about itself. `empty_offer` is this module's own word for that sentence and
      // is not a counted reason: nothing failed, so the leg logs it and counts no
      // refusal.
      case 'empty_offer':
        return pickEmptyText()
      case 'picker_unavailable':
        return pickRefusalText({ server })
      default:
        return serverActionProblemText({ reason, id, verb })
    }
  }

  // Every refusal the board names, in one shape: the reason, the level it came
  // from, and the facts its sentence needs.
  function refusal ({ id = null, verb = null, slug = null, row = null, reason = null, level = null }) {
    return { kind: 'refuse', level, id, verb, slug, row, reason }
  }

  return { offer, click, refuse }
}
