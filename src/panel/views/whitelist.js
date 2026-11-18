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

// One entry: who, which uuid, and when it was added. The uuid is printed because the
// remove request names it, and because two accounts can share a name over time.
//
// The answer to a removal is not printed in the row: a tick would take it away with the
// row it belongs to. It goes to the block's answer area, outside the list.
function renderEntry (puppet, entry) {
  const uuid = String(entry.uuid)
  const added = present(entry.addedAt) ? entry.addedAt : 'no added-at recorded'
  const who = present(entry.name) ? entry.name : 'no name recorded'
  return [
    '      <li class="entry">',
    '        <span class="who"><span class="player">' + escape(who) + '</span> <code>' + escape(uuid) + '</code></span>',
    '        <span class="when">added ' + escape(added) + '</span>',
    // data-uuid is the key the page holds its armed confirmation under, so a tick that
    // replaces this button paints the confirmation back onto it. data-who is the name
    // that confirmation reads back, so the second press asks about a person.
    '        <form class="remove" method="post" data-write="remove" data-uuid="' + escape(uuid) + '" data-who="' + escape(who) + '" action="/api/puppets/' +
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
  lines.push('    <ul class="entries">\n')
  for (const entry of players) lines.push(renderEntry(puppet, entry) + '\n')
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
    '    <section class="attach-block">',
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
