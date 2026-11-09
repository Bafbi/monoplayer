// Proxy notices as a synthetic advancement toast (#15).
//
// A notice is local proxy speech. The client has no chat-free way for the
// proxy to speak, so the notice rides the advancement frame: one synthetic
// advancement whose display asks for a toast, sent complete so the client
// shows it, and removed in the same call.
//
// The ghost rule: the client's advancement map must hold nothing of ours
// afterwards. Two facts make that true. The removal names the id in
// `identifiers` and never sets `reset`, because `reset: true` would wipe
// every advancement the server sent. And the toast is queued when the client
// processes the add, holding its own copy of the advancement, so the removal
// that follows does not cancel it. Both frames go out back to back; see the
// council record on #15 and docs/transparency.md.
//
// Ids live in the `monoplayer` namespace so a removal cannot name a server or
// datapack advancement. The client parses the id as a resource location, so
// the characters stay lowercase and in `[a-z0-9/._-]`.
//
// `showAdvancements` is server state, not ours: the caller passes the value
// from the backend's last advancement frame, so the notice keeps whatever the
// server decided. When the backend never sent that frame the caller passes the
// client's own default instead of hiding the screen. The frames are never
// cached or replayed; the caller writes them straight to the front leg.
//
// Field shapes come from the vendored 26.2 protocol data and the installed
// 26.1 data; both carry the same layout (`node tools/protocol.mjs frame 26.2
// play toClient advancements`).

export const NOTICE_FRAME = 'advancements'
export const NOTICE_NAMESPACE = 'monoplayer:notice'
export const NOTICE_TITLE = 'Monoplayer'
export const NOTICE_CRITERION = 'notice'
// The icon is an item id in the registry the client received from its server,
// and the configuration frames are not decoded here, so only the shape is
// known: id 1, which is `minecraft:stone` in the vanilla registry ordering
// (`node -e "const md=require('minecraft-data'); console.log(md('26.2').itemsByName.stone.id)"`
// prints 1 for 26.1 and 26.2). A datapack server that renumbers its items
// changes the icon, never the toast.
export const NOTICE_ICON_ID = 1
// frameType 0 is `task`: a goal or a challenge plays the challenge sound, and
// a proxy notice has no reason to beep at the player.
const TASK_FRAME = 0

// The wire form of a plain text component: a nameless NBT compound carrying
// one `text` string, which is what the frame's `anonymousNbt` fields hold.
function textComponent (text) {
  return { type: 'compound', value: { text: { type: 'string', value: text } } }
}

export function noticeId (seq) {
  return `${NOTICE_NAMESPACE}/${seq}`
}

// The two frames of one notice: the add that raises the toast, then the
// removal that leaves the advancement map as it was. `id` must be unique per
// notice so a removal can never name an earlier one.
export function noticeFrames ({ text, id, showAdvancements = true } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new TypeError('notice text is required')
  }
  if (typeof id !== 'string' || !id.startsWith(`${NOTICE_NAMESPACE}/`)) {
    throw new TypeError(`notice id must be in the ${NOTICE_NAMESPACE} namespace: ${id}`)
  }
  // Only an explicit false hides the screen: an unknown caller value must not
  // take the server's advancement screen away.
  const show = showAdvancements !== false
  return [
    {
      name: NOTICE_FRAME,
      packet: {
        reset: false,
        advancementMapping: [{
          key: id,
          value: {
            parentId: undefined,
            displayData: {
              title: textComponent(NOTICE_TITLE),
              description: textComponent(text),
              icon: {
                itemId: NOTICE_ICON_ID,
                itemCount: 1,
                addedComponentCount: 0,
                removedComponentCount: 0,
                components: [],
                removeComponents: []
              },
              frameType: TASK_FRAME,
              // hidden: the advancement screen keeps it out of the tree.
              // show_toast: the toast the notice exists for. No background
              // texture, so the frame carries none.
              flags: { unused: 0, hidden: 1, show_toast: 1, has_background_texture: 0 },
              xCord: 0,
              yCord: 0
            },
            requirements: [],
            // The field name is the protocol data's, typo included.
            sendsTelemtryData: false
          }
        }],
        identifiers: [],
        // A completed criterion at epoch 0. Presence is what marks it done;
        // without it the client adds the advancement and shows no toast.
        progressMapping: [{ key: id, value: [{ criterionIdentifier: NOTICE_CRITERION, criterionProgress: 0n }] }],
        showAdvancements: show
      }
    },
    {
      name: NOTICE_FRAME,
      packet: {
        reset: false,
        advancementMapping: [],
        identifiers: [id],
        progressMapping: [],
        showAdvancements: show
      }
    }
  ]
}

// The fallback: local system chat, the notice path this replaces. The text is
// the same, so a reader sees one message whether it arrived as a toast or as a
// chat line.
export function systemChatFrame (text) {
  return {
    name: 'system_chat',
    packet: { content: textComponent(text), isActionBar: false }
  }
}
