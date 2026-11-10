// Dialog codec: the read and write halves of the `show_dialog` /
// `custom_click_action` pair, and the per-dialog rule that says whether the
// puppet may answer one at all (#105).
//
// Two callers sit in two directories: the backend leg answers configuration
// gates with it (#20, #21, #73), and the protocol bot builds the same click to
// prove a real client reaches the same gate (src/ladder/bot.js). What the
// answer is and how it is framed is nobody's socket, so it lives here.
//
// The split with the leg is about the write, not the rule. This module holds
// `decideDialogAutoAnswer` and the bytes. The leg asks it once per dialog,
// holds the per-connection attempt cap and its counter, decides whether an
// attached player has the gate instead, and does the write. `answerBackendDialog`
// in src/legs/live-backend.js is that side of it.
//
// Why src/core/ and not a new src/protocol/: the tree is named after a
// domain, and a domain name comes from GLOSSARY.md. A `src/protocol/` would
// hold this one file, and it would contest wire work that core already holds
// under domain names: client-settings.js encodes the VarInt used below,
// notice.js and skin.js build frames, wire-check.js parses them. The ADR
// rejected a layer name ("a layer says where code sits, not what it does") and a
// vendor name ("a name that dies with a dependency"); `protocol` is that same
// defect under a third label.
import nbt from 'prismarine-nbt'

// The one VarInt encoder in core. client-settings.js needs it for the brand
// length prefix and this module needs it for the identifier and payload
// lengths, so both call one function and the two encoders cannot drift.
import { encodeVarInt } from './client-settings.js'

// Text component reader for a dialog label. The library decodes the dialog NBT
// into { type, value } wrappers; a label is a compound whose `text` and `extra`
// fields carry the visible string.
function dialogText (node) {
  const value = node?.value ?? node
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(dialogText).join('')
  if (value && typeof value === 'object') {
    const text = typeof value.text?.value === 'string'
      ? value.text.value
      : (typeof value.text === 'string' ? value.text : '')
    const extra = value.extra?.value ?? value.extra
    return `${text}${Array.isArray(extra) ? extra.map(dialogText).join('') : ''}`
  }
  return ''
}

// Choose one action from a `show_dialog` packet. `dialogAction` is `first`,
// `last`, or a case-insensitive label substring, the value of
// `MONOPLAYER_DIALOG_ACTION`. Default is the last action, which is the current
// season on the Excalia selection dialog. Which dialogs this runs for is
// `decideDialogAutoAnswer`'s decision, not this function's.
export function chooseDialogAction (data, dialogAction = 'last') {
  const dialog = data?.dialog?.value ?? data?.dialog ?? data
  const entries = dialog?.actions?.value?.value
  if (!Array.isArray(entries) || entries.length === 0) return null

  const actions = entries.map((entry, index) => {
    const action = entry?.action?.value ?? entry?.action ?? {}
    return {
      index,
      id: action.id?.value ?? action.id ?? null,
      additions: action.additions ?? null,
      type: action.type?.value ?? action.type ?? null,
      label: dialogText(entry?.label)
    }
  }).filter(action => typeof action.id === 'string')

  if (actions.length === 0) return null

  let index = actions.length - 1
  const wanted = String(dialogAction ?? '').toLowerCase()
  if (wanted === 'first') {
    index = 0
  } else if (wanted !== '' && wanted !== 'last') {
    const found = actions.findIndex(action => action.label.toLowerCase().includes(wanted))
    if (found >= 0) index = found
  }

  return {
    ...actions[index],
    total: actions.length,
    dialogType: dialog?.type?.value ?? dialog?.type ?? null
  }
}

// #16/#20: who answers a control dialog.
//
// A play dialog is the human's, always: the attached client answers it, or it
// waits in the core's pending holder until one attaches. The puppet never
// clicks one, attached or not, so `MONOPLAYER_DIALOG_ACTION` covers the
// configuration phase only (#20). What a headless puppet does with a
// configuration gate is #21's decision; this function keeps the fallback that
// ticket needs.
//
// One decision, consulted per dialog, so a client that attaches mid-session
// changes the answer without rebuilding the leg.
export function decideDialogAutoAnswer ({ dialogAction, humanAttached, state }) {
  // The phase is checked first, so a play dialog always reports the same reason
  // whether or not a policy is configured. An allow-list, so a state nobody
  // named fails closed and waits for a human instead of clicking.
  if (state !== 'configuration') {
    return { auto: false, reason: state === 'play' ? 'play_dialog_waits' : 'unsupported_state' }
  }
  if (!dialogAction) return { auto: false, reason: 'no_policy' }
  if (humanAttached) return { auto: false, reason: 'human_attached' }
  return { auto: true, reason: null }
}

// The vanilla `ServerboundCustomClickActionPacket` codec is
//   Identifier id, lengthPrefixed(optional anonymous NBT) payload
// (see the 26.1.2 client: UNTRUSTED_TAG_CODEC = optionalTagCodec.apply(
// lengthPrefixed(65536))). minecraft-data's packet shape omits the length
// prefix, so the library's `write` produces a frame the server rejects. Build
// the body from the dialog's action and send it with writeRaw.
export function buildCustomClickAction ({ state, id, additions }) {
  const packetId = state === 'play' ? 0x44 : state === 'configuration' ? 0x08 : null
  if (packetId === null) return null
  if (typeof id !== 'string' || id.length === 0) return null

  const identifier = Buffer.from(id, 'utf8')
  const tag = additions && additions.value
    ? Buffer.concat([Buffer.from([1]), nbt.writeUncompressed({ type: 'compound', name: '', value: additions.value })])
    : Buffer.from([0])

  return Buffer.concat([
    Buffer.from([packetId]),
    encodeVarInt(identifier.length),
    identifier,
    encodeVarInt(tag.length),
    tag
  ])
}
