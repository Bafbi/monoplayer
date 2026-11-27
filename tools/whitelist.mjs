#!/usr/bin/env node
// The attach-whitelist judgement, in the one place the gate parses it (#741).
//
//   node tools/whitelist.mjs report '<document>'
//   node tools/whitelist.mjs prune  '<document>'
//   node tools/whitelist.mjs names  '<document>'
//
// One program, because reading this document has one home and three callers
// (`scripts/dev-lane.sh`). `report` prints a UUID decision per entry, and that is what
// `status` shows. `prune` writes the document back without the entries no login can
// use, and names each drop on stderr. `names` lists who a document carries, for the
// message that says which list an apply replaced.
//
// This was a heredoc inside that script, and bash reads a heredoc body as data, so no
// stage of the gate saw the program. The two stages that would have caught it are the
// ones `[tasks.lint]` in mise.toml runs, a parse and a resolve. Teaching that task to
// extract heredoc bodies was the other route: it needs a tool of its own and a tag
// convention no stage owns, and it buys the parse without the resolve.
//
// The document arrives as argv and the answer leaves on stdout, because every caller
// reads one. A document that cannot be read is an answer and not a failure: the exit
// status is what `die` reads, so raising one would turn a report into a failed `up`.
import { pathToFileURL } from 'node:url'

import { uuidRefusalReason } from '../src/custody/util.js'

// An entry the lane can never admit: the dev front verifies every login against Mojang
// (deploy/dev/monoplayer.yaml composes no offline legs), and no Mojang account holds a
// UUID derived from a name. uuidRefusalReason answers why (#677, #703), and its
// docstring says what the answer settles and what it cannot. The loopback rig builds its
// own controller list from exactly those UUIDs (pickerWhitelist, src/ladder/loopback.js),
// which is how the shape reaches a lane somebody hand-edited: a rig name in a control
// document is a controller that admits nobody, and a count of entries cannot see it
// (#677).
//
// The name goes with the uuid because it is what makes the answer name the hashed string
// rather than the version.
const label = player => (typeof player?.name === 'string' && player.name !== '' ? player.name : '(no name)')
const uuidOf = player => String(player?.uuid ?? '')

// Why no Mojang session can answer for this entry, or null when nothing about its shape
// stops it. This file judges nothing itself: uuidRefusalReason is the rule, in the module
// that accepts both spellings a document may carry (#703).
const refusal = player => uuidRefusalReason(uuidOf(player), player?.name)

// One answer for one document: what goes to stdout and what goes to stderr. Both are
// strings, so a mode reads as one report and a test can hold the pair without a socket.
export function whitelistAnswer (mode, document) {
  const text = document ?? ''
  // A document this program could not read is said out loud: answering "no entries" to
  // it is how a broken control document reads as a lane with nothing to fix.
  let players = []
  let unreadable = false
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed.players)) throw new TypeError('no player array')
    players = parsed.players
  } catch {
    unreadable = true
  }

  // One judgement per entry, computed once, so a mode cannot answer twice from two reads
  // of the same document.
  const judged = players.map(player => ({ player, why: unreadable ? null : refusal(player) }))

  if (mode === 'prune') {
    const dropped = judged.filter(entry => entry.why !== null)
    if (dropped.length === 0) return { out: text, err: '' }
    const err = dropped
      .map(({ player, why }) => 'dev-lane: dropped ' + label(player) + ' ' + uuidOf(player) +
        ' from the attach whitelist: ' + why + '\n')
      .join('')
    return {
      out: JSON.stringify({
        ...JSON.parse(text),
        players: judged.filter(entry => entry.why === null).map(entry => entry.player)
      }),
      err
    }
  }
  if (mode === 'names') {
    return { out: players.map(player => player.name ?? player.uuid ?? 'unnamed').join(', '), err: '' }
  }
  if (unreadable) {
    return { out: 'attach whitelist could not be read as a document, so nothing here says who can attach\n', err: '' }
  }
  if (players.length === 0) {
    return { out: 'attach whitelist is empty: nobody can attach yet\n', err: '' }
  }
  // Every mode the script sends is named above, and the last one is the report: a status
  // command that reaches this branch has to answer something.
  const usable = judged.filter(entry => entry.why === null).length
  const plural = players.length === 1 ? 'entry' : 'entries'
  const summary = usable === players.length
    ? 'attach whitelist names ' + players.length + ' ' + plural + (players.length === 1 ? ', and it can authenticate' : ', and every one of them can authenticate')
    : usable === 0
      ? 'attach whitelist names ' + players.length + ' ' + plural + ', and none of them can authenticate'
      : 'attach whitelist names ' + players.length + ' ' + plural + ', ' + usable + ' of which can authenticate'
  const lines = [summary]
  for (const { player, why } of judged) {
    lines.push(why === null
      ? '  ' + label(player) + ' ' + uuidOf(player) + ' can authenticate'
      : '  ' + label(player) + ' ' + uuidOf(player) + ' cannot authenticate: ' + why + '. Remove the entry')
  }
  return { out: lines.join('\n') + '\n', err: '' }
}

// The mode, then the document: the script passes both as words, and the document is one
// word there, so a document holding newlines survives the shell.
export function main (argv) {
  const { out, err } = whitelistAnswer(argv[0], argv[1])
  process.stdout.write(out)
  process.stderr.write(err)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2))
}
