// Who may attach: the entries the lane admits, and the two writes that change them
// (#248 renders what #232 writes).
//
// The list is the one part of a card that is read from a ConfigMap rather than from
// the puppet's log, so it is the one part with a version instead of a timestamp. Both
// are printed, and each says which it is: an entry carries the "added at" the document
// recorded, and the list carries the instant the panel read it plus the ConfigMap's
// resourceVersion, which is a version and not a time.
//
// The form is outside the list, and the list is outside the live region. The stream
// replaces the live region's innerHTML every 5 s and carries this list beside it as an
// out-of-band swap, so a tick refreshes the entries without touching a half-typed name
// or a remove button the operator has just armed.
import { escape, present } from './html.js'
import { uuidRefusalReason } from '../../custody/util.js'

// One entry: who, which uuid, when it was added, and whether a login can use it. The
// uuid is printed because the remove request names it, and because two accounts can
// share a name over time.
//
// The UUID decision is #705's, and its rule is `uuidRefusalReason`'s in src/custody/util.js:
// the panel judges here rather than printing a count, because a list of two entries
// where one uuid Java derived from a name reads as healthy otherwise, which is the
// state #677 found in the dev lane's document.
//
// "can authenticate" is that script's word, and it means what the rule can answer:
// nothing about the entry's shape stops a Mojang session answering. A uuid of the
// right shape that nobody owns still fails its login, and no read can tell that.
//
// The answer to a removal is not printed in the row: a tick would take it away with the
// row it belongs to. It goes to the block's answer area, outside the list.
function renderEntry (puppet, entry, refusalReason) {
  const uuid = String(entry.uuid)
  const added = present(entry.addedAt) ? entry.addedAt : 'no added-at recorded'
  const who = present(entry.name) ? entry.name : 'no name recorded'
  return [
    '      <li class="entry">',
    '        <span class="who"><span class="player">' + escape(who) + '</span> <code>' + escape(uuid) + '</code></span>',
    '        <span class="when">added ' + escape(added) + '</span>',
    '        <span class="uuid-decision' + (refusalReason === null ? '' : ' unusable') + '">' +
      (refusalReason === null
        ? 'can authenticate'
        : 'cannot authenticate: ' + escape(refusalReason)) + '</span>',
    // data-key is the key the page holds its armed confirmation under, so a tick that
    // replaces this button paints the confirmation back onto it. data-name is what that
    // confirmation reads back, so the second press asks about a person. The allowed
    // servers' block uses the same two attributes, keyed by host:port (#309).
    '        <form class="remove" method="post" data-write="remove" data-key="' + escape(uuid) + '" data-name="' + escape(who) + '" action="/api/puppets/' +
      escape(encodeURIComponent(puppet.name)) + '/whitelist/' + escape(encodeURIComponent(uuid)) + '">',
    '          <button type="submit" data-armed="false">remove</button>',
    '        </form>',
    '      </li>'
  ].join('\n')
}

// The list itself: a failure, an unread list, an empty one, or the entries. Every
// branch says which it is, because "nobody may attach" and "the panel could not read
// the list" are different facts that look the same when both are an empty list.
//
// The list carries no read time. The tick replaces it whenever the entries change, so
// a clock printed here would be the time of the last change and would go stale in
// silence. The instant it was read, and the ConfigMap's version, are in the card's own
// footer, which is rewritten every tick (src/panel/views/live.js).
export function renderEntries ({ puppet, list }) {
  if (list === null || list === undefined) {
    return '    <p class="note">the panel did not read the attach whitelist for this page</p>\n'
  }
  if (present(list.failure)) {
    return '    <p class="refused">the attach whitelist could not be read: ' + escape(list.failure) + '</p>\n'
  }
  const players = Array.isArray(list.document?.players) ? list.document.players : []
  const lines = []
  if (players.length === 0) {
    lines.push("    <p class=\"note\">no entries: only the puppet's own account may attach</p>\n")
    return lines.join('')
  }
  // One judgement per entry, computed once, so the ratio and the rows cannot be two
  // answers about one list (scripts/dev-lane.sh does the same, #677). Each entry travels
  // with its own answer, so the two lists cannot fall out of step by position.
  const judged = players.map(entry => ({ entry, why: uuidRefusalReason(entry?.uuid, entry?.name) }))
  const usable = judged.filter(({ why }) => why === null).length
  // A list where some entry cannot authenticate is a fault, and it is stated above the
  // rows: a row of eight with one derived uuid is easy to read past. The sentence is
  // `mise run dev:status`'s, so an operator who reads one reads the other without
  // translating. The two are copies, and no test ties them: the script's sentence lives
  // in a shell heredoc. One entry is the one place this says it differently, because
  // "none of them" is wrong for a list of one.
  if (usable < players.length) {
    const single = players.length === 1
    lines.push('    <p class="refused">attach whitelist names ' + players.length +
      (single ? ' entry' : ' entries') +
      (usable === 0
        ? (single ? ', and it cannot authenticate' : ', and none of them can authenticate')
        : ', ' + usable + ' of which can authenticate') +
      '</p>\n')
  }
  lines.push('    <ul class="entries">\n')
  for (const { entry, why } of judged) lines.push(renderEntry(puppet, entry, why) + '\n')
  lines.push('    </ul>\n')
  return lines.join('')
}

// The add form. One field, because the route takes one of two shapes and a form with
// two fields would ask the operator to know which one the panel needs. What the field
// holds is sent as the field it is: a uuid that parses as one goes as a uuid, anything
// else goes as a name, and the route answers a name it cannot resolve by asking for
// the uuid. That answer is rendered as an instruction, not as a failure
// (src/panel/public/panel.js).
export function renderAddForm (puppet) {
  return [
    '    <form class="write" method="post" data-write="add" action="/api/puppets/' +
      escape(encodeURIComponent(puppet.name)) + '/whitelist">',
    '      <label>player name or uuid <input name="player" required autocomplete="off" spellcheck="false" placeholder="Bafbi, or 6eb73524-ff88-4a62-a8d0-c63905e7afba"></label>',
    '      <button type="submit">add to the attach whitelist</button>',
    '      <p class="note">Sent as <code>application/json</code>, which is what the route requires and what a',
    '      cross-origin form post cannot send. The lane re-reads this file at each login, so an entry added',
    '      here admits the player at their next attempt, with no restart. Removing an entry asks twice.</p>',
    '    </form>',
    ''
  ].join('\n')
}

// The whole block: the list, one answer area, then the form that adds to it.
//
// The answer area is outside the list on purpose. The list is replaced whenever it
// changes, and an answer printed inside a row would go with it: an operator reading a
// refusal would watch it vanish mid-sentence. One area per block holds the answer to
// whichever action was last taken, and it stays until the next one.
export function renderWhitelistBlock ({ puppet, list }) {
  return [
    '    <section class="attach-block control-block">',
    '    <h3>Who may attach</h3>',
    '    <p class="note">From <code>' + escape(puppet.controlConfigMap) + '</code> key',
    '    <code>attach-whitelist.json</code> in <code>' + escape(puppet.namespace) +
      '</code>. The list redraws whenever it changes, and the card says when it was last read.</p>',
    '    <div class="attach" id="' + escape(listId(puppet.name)) + '">',
    renderEntries({ puppet, list }),
    '    </div>',
    '    <output class="result block-result" role="status" aria-live="polite"></output>',
    renderAddForm(puppet),
    '    </section>'
  ].join('\n')
}

export const listId = name => 'whitelist-' + name

// The list as the stream carries it: the same block, marked as an out-of-band swap so
// htmx replaces the list beside the live region instead of inside it. The stream's
// fragment is swapped into the live region, and this element inside that fragment is
// moved to the element with this id and removed from the fragment, which is what keeps
// the add form and an armed remove button out of a tick's reach.
export function renderWhitelistSwap ({ puppet, list }) {
  return '  <div class="attach" id="' + escape(listId(puppet.name)) + '" hx-swap-oob="true">\n' +
    renderEntries({ puppet, list }) +
    '  </div>\n'
}
