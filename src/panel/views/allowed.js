// The servers the picker offers: the entries the lane reads, and the two writes that
// change them (#309 renders what #262 writes).
//
// The block is the attach whitelist's twin on purpose (src/panel/views/whitelist.js):
// same list, same one answer area, same form outside the list, same out-of-band swap
// on every tick. An operator reading one block has read both.
//
// The one difference is the name of a row. An attach whitelist entry is named by its
// uuid, so its removal path says uuid. A server is named by its `host:port` address,
// which is what the route's DELETE path takes, what a picker row is called, and what
// the add form asks for: one field, because a phone operator pastes one thing, and the
// page splits it into the two fields the route takes (src/panel/public/panel.js).
//
// The other difference is that this key has a fallback. A missing or unreadable
// allowed-servers.json is not an empty picker: the lane offers the copy Git commits.
// So the list says which file answered when it is not the live key, because the
// operator about to edit it has to know that the first write is built on that copy
// (src/panel/routes/allowed.js).
import { addressName } from '../../core/picker.js'
import { escape, present } from './html.js'

// One server: the address, and when it was added. The address is the row's name and
// the removal's path, and the confirmation reads it back, so nobody removes a server
// by pressing a button that names another one.
function renderServer (puppet, server) {
  // #890: the one rule spells it (#815, #906). An IPv6 host keeps its brackets, or the row reads
  // `2001:db8::1:25565` and the removal path it posts to cannot be split back into a host and a
  // port. An IPv4 row reads as it always did, which is why this went unseen for three passes.
  const address = addressName(server.host, server.port)
  const added = present(server.addedAt) ? server.addedAt : 'no added-at recorded'
  return [
    '      <li class="entry">',
    '        <span class="who"><span class="server">' + escape(address) + '</span></span>',
    '        <span class="when">added ' + escape(added) + '</span>',
    // data-key is the key the page holds its armed confirmation under, and data-name
    // is what that confirmation reads back, so a tick that replaces the button paints
    // the confirmation onto it again (src/panel/public/panel.js).
    '        <form class="remove" method="post" data-write="remove-server" data-key="' + escape(address) +
      '" data-name="' + escape(address) + '" action="/api/puppets/' +
      escape(encodeURIComponent(puppet.name)) + '/allowed-servers/' + escape(encodeURIComponent(address)) + '">',
    '          <button type="submit" data-armed="false">remove</button>',
    '        </form>',
    '      </li>'
  ].join('\n')
}

// The list: a failure, an unread list, an empty one, or the servers. Every branch
// says which it is, because "the picker offers nothing" and "the panel could not read
// the list" look the same when both are an empty list.
//
// The list carries no read time. A tick replaces it whenever the entries change, so a
// clock printed here would be the time of the last change and would go stale in
// silence. The instant it was read and the ConfigMap's version are in the card's own
// footer, which is rewritten every tick (src/panel/views/live.js).
export function renderAllowedEntries ({ puppet, list }) {
  if (list === null || list === undefined) {
    return '    <p class="note">the panel did not read the allowed servers for this page</p>\n'
  }
  if (present(list.failure)) {
    return '    <p class="refused">the allowed servers could not be read: ' + escape(list.failure) + '</p>\n'
  }
  const servers = Array.isArray(list.document?.servers) ? list.document.servers : []
  const lines = []
  // Which file answered, when it is not the live key. The lane is offering the copy
  // Git commits, and the panel's first write is built on that copy, so an operator
  // who does not know it would not know what their next add writes.
  if (list.source === 'seed') {
    lines.push('    <p class="note">the control ConfigMap holds no <code>allowed-servers.json</code> key, ' +
      'so this is the copy in <code>' + escape(puppet.seedConfigMap) + '</code> that Git commits, and the next ' +
      'write is built on it</p>\n')
  }
  if (servers.length === 0) {
    lines.push(list.source === 'none'
      ? '    <p class="note">no allowed servers: neither the control ConfigMap nor <code>' + escape(puppet.seedConfigMap) +
        '</code> holds an <code>allowed-servers.json</code> key, so the picker offers nothing</p>\n'
      : '    <p class="note">no allowed servers: the picker offers a joining player nothing</p>\n')
    return lines.join('')
  }
  lines.push('    <ul class="entries">\n')
  for (const server of servers) lines.push(renderServer(puppet, server) + '\n')
  lines.push('    </ul>\n')
  return lines.join('')
}

// The add form. One field, because the route names a server by its address and the
// list, the removal path and a picker row all use that one name. What the operator
// types is split on the last colon into the route's host and port
// (src/panel/public/panel.js), and a value that does not split is sent as a host the
// route refuses, in its own words.
export function renderAddForm (puppet) {
  return [
    '    <form class="write" method="post" data-write="add-server" action="/api/puppets/' +
      escape(encodeURIComponent(puppet.name)) + '/allowed-servers">',
    '      <label>host:port <input name="server" required autocomplete="off" spellcheck="false" placeholder="paper.example.net:25565"></label>',
    '      <button type="submit">add an allowed server</button>',
    '      <p class="note">Sent as <code>application/json</code>, which is what the route requires and what a',
    '      cross-origin form post cannot send. A host is a name or an IP address, with no scheme and no port',
    '      of its own. An IPv6 address is printed in brackets here, and typed either way:',
    '      <code>[2001:db8::1]:25565</code> and <code>2001:db8::1:25565</code> are one server. The port is a',
    '      number from 1 to 65535. The lane reads this file at each offer, so a server added here is offered at',
    '      a joining player\'s next attempt. Removing a server asks twice.</p>',
    '    </form>',
    ''
  ].join('\n')
}

// The whole block: the list, one answer area, then the form that adds to it. The
// answer area is outside the list for the same reason as the whitelist's: the list is
// replaced whenever it changes, and a refusal printed inside a row would go with it.
export function renderAllowedBlock ({ puppet, list }) {
  return [
    '    <section class="allowed-block control-block">',
    '    <h3>Allowed servers</h3>',
    '    <p class="note">From <code>' + escape(puppet.controlConfigMap) + '</code> key',
    '    <code>allowed-servers.json</code> in <code>' + escape(puppet.namespace) +
      '</code>. A picker lane offers these to a joining player at each offer; a lane whose',
    '    <code>MONOPLAYER_PICKER</code> is off offers nothing. The list redraws whenever it changes, and the',
    '    card says when it was last read.</p>',
    '    <div class="allowed" id="' + escape(listId(puppet.name)) + '">',
    renderAllowedEntries({ puppet, list }),
    '    </div>',
    '    <output class="result block-result" role="status" aria-live="polite"></output>',
    renderAddForm(puppet),
    '    </section>'
  ].join('\n')
}

export const listId = name => 'allowed-' + name

// The list as the stream carries it: the same block, marked as an out-of-band swap so
// htmx replaces the list beside the live region instead of inside it (the whitelist's
// reasoning, src/panel/views/whitelist.js).
export function renderAllowedSwap ({ puppet, list }) {
  return '  <div class="allowed" id="' + escape(listId(puppet.name)) + '" hx-swap-oob="true">\n' +
    renderAllowedEntries({ puppet, list }) +
    '  </div>\n'
}
