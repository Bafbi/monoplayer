// #417: the numbers #415 could not reach are the front leg's, because the leg is
// where the frame is written and where the picker connection lives.
//
// Four of them, and each is measured at the only place that knows it: the bytes at
// the buffer handed to the socket, the picker's duration on the connection's own
// context, a refusal's reason at the site that refuses, and the dialog's size from
// the one encode that also writes it.
//
// The seams below are exported for exactly this: the leg itself is reached only
// through a listening server, and a number that only a listening server can be
// asked about is a number no test reads.
//
// #710: the scan below reads src/legs/live-front.js, so it proves a branch is mentioned and
// never that it runs. The three picker ends it guards are driven at a real front leg, with
// the record and the count read off one run of each, in test/legs/picker-ends.test.js. What
// this file keeps is the half a run cannot make: a site deleted, a sentence composed without
// its count, and the two words a record and its map are keyed by agreeing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import mc from 'minecraft-protocol'

import { bumpReason, elapsedSince, encodeFrame, MAX_REFUSAL_REASONS } from '../../src/legs/live-front.js'
import { bumpBounded, OVERFLOW_KEY } from '../../src/core/bounded-counter.js'
import { pickerDialogParams, pickerRows } from '../../src/core/picker.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SOURCE = fs.readFileSync(path.join(ROOT, 'src', 'legs', 'live-front.js'), 'utf8')
const VERSION = '26.1'

// A row is named for the host:port its claim dials (GLOSSARY.md, *Allowed server*),
// and pickerRows derives the slug and the id from that name.
const ROWS = pickerRows([
  { name: 'paper:25565' },
  { name: 'sky:25565' }
])

function serializer (state = 'configuration') {
  return mc.createSerializer({ state, isServer: true, version: VERSION })
}

test("#417 the picker dialog's encoded size is the frame the codec builds", () => {
  const params = pickerDialogParams({ rows: ROWS })
  const { ok, buffer } = encodeFrame({ serializer: serializer(), name: 'show_dialog', params })

  assert.equal(ok, true)
  assert.ok(Buffer.isBuffer(buffer), 'the encode answers the bytes, not a length to trust separately')
  assert.deepEqual(buffer, serializer().createPacketBuffer({ name: 'show_dialog', params }),
    'and they are the frame the library itself encodes from the same params')
  assert.ok(buffer.length > 0, 'a dialog with two rows is more than a header')

  const wider = pickerDialogParams({ rows: [...ROWS, ...pickerRows([{ name: 'nether:25565' }])] })
  assert.ok(encodeFrame({ serializer: serializer(), name: 'show_dialog', params: wider }).buffer.length > buffer.length,
    'a third row costs bytes, so the number follows what the dialog carries')
})

test('#417 a frame the codec cannot build is absent, never a size of zero', () => {
  const params = pickerDialogParams({ rows: ROWS })

  assert.deepEqual(encodeFrame({ serializer: null, name: 'show_dialog', params }),
    { ok: false, buffer: null, error: 'no serializer for this connection' },
    'a connection with no serializer builds nothing, and says why')
  assert.equal(encodeFrame({ serializer: {}, name: 'show_dialog', params }).ok, false,
    'and neither does one whose serializer cannot encode a packet')

  const refused = encodeFrame({
    serializer: { createPacketBuffer () { throw new Error('no such frame in this state') } },
    name: 'show_dialog',
    params
  })
  assert.equal(refused.ok, false, 'a codec that refuses the frame answers nothing rather than failing the join')
  assert.equal(refused.error, 'no such frame in this state',
    'and the reason comes back with it, because an operator cannot guess at a codec refusal')
})

// The dialog is the one frame a picker connection is shown, so its size is the
// number a reader is looking for when they ask how large the picker is. It is
// written and measured from one encode: a second one could disagree with it.
//
// #600: the encode is one function both of this leg's dialogs call, so the picker's
// dialog and a server's cannot drift into two codecs or two encodes.
test('#417 the picker dialog is written and measured from one encode', () => {
  const encode = SOURCE.slice(SOURCE.indexOf('function encodeDialogFrame'), SOURCE.indexOf('function sendPickerDialog'))
  assert.ok(encode.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal((encode.match(/encodeFrame\(/g) ?? []).length, 1, 'the dialog is encoded once, for both dialogs')
  assert.match(encode, /try \{\s*return encodeFrame\(/, 'the params build is inside a guard too')

  const dialog = SOURCE.slice(SOURCE.indexOf('function sendPickerDialog'), SOURCE.indexOf('function handlePickerClick'))
  assert.ok(dialog.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.equal((dialog.match(/encodeDialogFrame\(/g) ?? []).length, 1, 'the picker dialog asks for that encode once')
  // #602: the write is the funnel's, and it is handed the one encode's own buffer, so
  // the bytes measured are still the bytes that went to the socket.
  assert.match(dialog, /writeRawTo\(client, encoded\.buffer,/, 'the bytes written are the bytes measured')
  assert.match(dialog, /log\('pickerDialog', \{/, 'the pickerDialog record is still written')
  assert.match(dialog, /bytes: encoded\.buffer\.length/, 'and it carries the size it wrote')
})

// #417: a refusal's reason, as a bounded map. The reasons are a closed set the leg
// already writes, and the cap is what keeps a lane from growing a map no reader
// asked for if one ever is not.
//
// #555: what the leg owns here is the cap it passes and the seam a reader counts
// through. The count-up, the overflow bucket and what an empty key becomes are
// src/core/bounded-counter.js's rule, and that rule is asserted once, in
// test/core/bounded-counter.test.js. Restating it here would leave one of the two
// stale the day the rule changes, and would read as coverage that proves the leg.
test('#417 the leg passes its own cap to the shared rule, and its map stops at that cap', () => {
  // As many distinct words as a reason can be, far past the cap, so a map that grew
  // one key per word would show it.
  const reasons = Array.from({ length: MAX_REFUSAL_REASONS * 50 }, (_, index) => 'reason-' + index)
  const leg = {}
  const shared = {}
  for (const reason of reasons) {
    bumpReason(leg, reason)
    bumpBounded(shared, reason, MAX_REFUSAL_REASONS)
  }

  assert.deepEqual(leg, shared,
    'the leg hands the shared rule its own cap, so the rule the map follows is the one in src/core/bounded-counter.js')
  assert.ok(Object.keys(leg).length <= MAX_REFUSAL_REASONS + 1,
    'and the map the leg hands a reader stops at that cap, with the one bucket the rule adds past it')
  assert.ok(leg[OVERFLOW_KEY] > 0,
    'and the cap is a bound that bites: a thousand words cannot fit under it, so the leg\'s number is headroom and not a second vocabulary')
})

// #417: the duration is one connection's. Both moments are the leg's: it sees the
// login, and it sees the pick on the same socket. A number keyed by player name
// cannot say which of two connections from one account picked.
test("#417 a connection's login-to-pick age is its own, and absent when it never logged in", () => {
  assert.equal(elapsedSince(1000, 4000), 3000, 'the pick came 3 s after the login')
  assert.equal(elapsedSince(null, 4000), null, 'a connection the leg never stamped has no age')
  assert.equal(elapsedSince(undefined, 4000), null)
  assert.equal(elapsedSince(Number.NaN, 4000), null)
  assert.equal(elapsedSince(4000, 1000), 0, 'a clock that stepped backwards is 0, never a negative age')
  assert.equal(elapsedSince(1000, 1000), 0, 'and a pick in the same millisecond is 0, which is real')
})

// Every `refuseAndCount({...})` call in the leg, read by brace matching so a record
// object nested in one site is not mistaken for the end of it.
function refusalSites (source) {
  const sites = []
  for (let at = source.indexOf('refuseAndCount({'); at !== -1; at = source.indexOf('refuseAndCount({', at + 1)) {
    const from = source.indexOf('{', at)
    let depth = 0
    let end = -1
    for (let i = from; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    assert.notEqual(end, -1, 'the refusal site at byte ' + at + ' closes')
    sites.push(source.slice(from + 1, end))
  }
  return sites
}

// The helper's own body: what it writes is the rule, so the guard reads it rather than
// trusting a comment. One brace scan, below, reads every body this file asks about (#708).
function helperBody (source) {
  return functionBody(source, 'refuseAndCount')
}

// The word one counted refusal passes, read out of its own object literal, so the site
// list below names reasons and not line numbers.
function refusedReason (body) {
  const named = body.match(/reason:\s*([^,]+)/)
  if (named !== null) return named[1].trim()
  // A site that passes the closure's own argument writes it shorthand.
  return /\breason\s*,/.test(body) ? 'reason' : 'MISSING'
}
// The guard the four rest on: one helper composes a refusal and counts it, so no call
// site can tell a client why it was refused and leave the map short of it. #435 found
// the Spectate landing doing that; #616 found the Disconnect verb doing it, so the
// guard is the shape both defects share rather than the two instances.
test('#417 every refusal the leg counts is counted once, through one helper', () => {
  assert.equal((SOURCE.match(/metrics\.pickerRefusals\+\+/g) ?? []).length, 1,
    'only the helper counts a refusal')
  assert.equal((SOURCE.match(/metrics\.pickerRefusalsByReason/g) ?? []).length, 1,
    'and only the helper writes the map by reason')

  const start = SOURCE.indexOf('function bumpPickerRefusal')
  assert.ok(start > 0, 'the helper exists')
  const helper = SOURCE.slice(start, start + 500)
  assert.match(helper, /bumpReason\(/, 'the helper is what bumps the map')

  // Ten refusal sites, each named by the word its own record carries: the two
  // dialogs the leg could not write, the lane with no rows to offer (#670), the three a
  // click's own answer refuses (a frame that did not read, and a server the offer does
  // not carry at either level), the claim the core answers, the Spectate landing's own
  // refusals, the Disconnect verb (#616) refused because a claim holds the body, and the
  // claim landing that lost its phase-end write (#708). The Spectate landing's phase-end
  // refusal and the claim landing's are one write failing on two paths, so they pass one
  // word: `finish_failed` names the write that did not happen. Each arm's
  // `configurationEnded` line keeps its own word (`spectate_refused`, `claim_failed`).
  // The key each one passes is asserted too, because a site swapped to the wrong word
  // still counts and still lies about why.
  //
  // #595 moved the choice of reason into src/core/picker.js (click): the three a
  // click's answer refuses pass the reason the board decided instead of one read from
  // the frame, because the level a click came from is now one of the board's answers
  // rather than a branch in the leg.
  const sites = refusalSites(SOURCE)
    .map(refusedReason)
    .sort()
  assert.deepEqual(sites, [
    "'disconnect_claimed'",
    "'empty_offer'",
    "'finish_failed'",
    "'picker_unavailable'",
    "'picker_unavailable'",
    'answer.reason',
    'answer.reason',
    'answer.reason',
    'outcome.reason',
    'reason'
  ].sort(), 'every refusal site counts, and each passes the reason its own record carries')

  // Two sentences are composed without a count, and each is here with its reason: the
  // verb guard answers a verb no lane carries, which is unreachable today; and the leg's
  // own spectate() seam answers no_client for a name no connection holds, and that
  // sentence reaches no client, because the lookup that would have received it found no
  // connection. #670 settled the third: a lane with no rows to offer used to speak here,
  // and it counts through the helper now, because a client the picker ends is a client
  // the map answers for whether the lane turned a request down or had nothing to give.
  assert.equal((SOURCE.match(/pickerBoard\.refuse\(/g) ?? []).length, 3,
    'the counted refusal the helper composes, and the two sentences that count nothing')
  assert.match(SOURCE, /pickerBoard\.refuse\(\{ verb: answer\.verb, server: server\.name \}\)/,
    'the unbuilt-verb guard speaks and counts nothing')
  assert.match(SOURCE, /pickerBoard\.refuse\(\{ verb: 'spectate', reason: 'no_client', server: server \?\? body \}\)/,
    'the seam with no connection speaks to nobody, so it counts nothing')

  // #616: the Disconnect verb's own number (#261) is bumped in the same helper, not at
  // the branch, so a refusal that is counted once is counted twice in the two places a
  // reader asks about and never at one of them alone. #435 and #616 each found a branch
  // that moved one and not the other.
  assert.equal((SOURCE.match(/metrics\.pickerDisconnectsRefused\+\+/g) ?? []).length, 1,
    'one place counts the disconnect\'s own number')
  assert.match(helper, /metrics\.pickerDisconnectsRefused\+\+/, 'and that place is the helper that counts every refusal')
  assert.equal((SOURCE.slice(SOURCE.indexOf('function bumpPickerRefusal') + 500).match(/metrics\.pickerDisconnectsRefused/g) ?? []).length, 0,
    'no other function moves it')

  // #435: the Spectate landing's four refusals are one site, the closure they all
  // return through, so a branch added there cannot refuse without counting. The guard
  // is the closure's own shape: it composes the sentence through the counted helper,
  // and it writes the record whose reason the map is keyed by, so the count and the
  // line cannot part ways.
  const landing = SOURCE.slice(SOURCE.indexOf('function landSpectator'), SOURCE.indexOf('function sendBodyConfiguration'))
  assert.ok(landing.length > 0, 'the seam this guard reads is still the leg\'s own')
  assert.match(landing, /const refused = reason => \{/, 'the refusals return through one closure')
  // The parts, not one exact call: a field added to the request is a normal change and
  // must not red this guard.
  assert.match(landing, /refuseAndCount\(\{/, 'and the counted helper composes their sentence')
  assert.match(landing, /verb: 'spectate',/, 'for the Spectate verb')
  assert.match(landing, /record: \w+ => record\(client, 'spectateRefused', \{/,
    'which hands it to the record they are read by, and that record stamps the channel')
  assert.equal((landing.match(/watching: false/g) ?? []).length, 2,
    'the two shape literals are the answer the leg builds when it has no core, and the closure, and no branch builds a third')

  // #435: the landing is counted after the write that ends the client's phase. Before
  // it, a phase the leg could not end read as a landing and a refusal at once, and
  // finish_failed now counts as the refusal it is. No test can make that write
  // throw without reaching into the library's socket, so the order is the fact pinned.
  const landingCount = landing.indexOf('metrics.spectateLandings++')
  const landingWrite = landing.indexOf("client.write('finish_configuration'")
  assert.ok(landingWrite > 0, 'the write that ends the phase is still in this function')
  assert.ok(landingCount > landingWrite,
    'the landing is counted after the phase-end write, so a write that threw is not a landing')
})

// #670: the count and the record that explains it are one call, in both directions.
// #417 and #616 each found a sentence composed and not counted. These are the mirror:
// a dialog the leg could not write was counted (#616), and its own line carried only
// the error, so the reason an operator greps for lived on `configurationEnded` and on
// no refusal record at all. The fix is not a field on two lines: the helper writes the
// record, so a site cannot count without telling a reader why.
test('#670 every counted refusal writes its own record, and the record carries the reason and the sentence', () => {
  const sites = refusalSites(SOURCE)
  assert.ok(sites.length >= 10, 'the leg counts ten refusals, and the guard reads each site: ' + sites.length)
  // The scanner looks for the call as it is written today. A site spelled around it, with
  // a space before the argument or an alias, would pass every assertion below unseen.
  assert.equal((SOURCE.match(/refuseAndCount\s*\(/g) ?? []).length, sites.length + 1,
    'every call to the helper is one the scan reads, beside the one that defines it')

  // The record is a closure the helper calls, so the event name stays a literal at the
  // site (#416), and the pair the helper hands over, the reason and the sentence, can only
  // arrive at the site that writes them. A site may take that pair by name instead of
  // spreading it, which is the same rule.
  const unnamed = sites.filter(site => {
    const named = site.match(/(^|[^.\w])record:\s*(\w+|\(\s*\{[^}]*\}\s*\))\s*=>/)
    if (named === null) return true
    if (named[2].startsWith('(')) return false
    return !site.includes('...' + named[2])
  })
  assert.deepEqual(unnamed, [],
    'every counted refusal names the record it writes and spreads the pair the helper hands it: ' +
      unnamed.length + ' do not')

  const helper = helperBody(SOURCE)
  assert.match(helper, /\(\{\s*reason,\s*text\s*\}\)/,
    'the helper hands that record the reason the map was keyed by and the sentence the client was told')
  assert.equal((helper.match(/\blog\(/g) ?? []).length, 0,
    'and the helper names no event itself, so a comment cannot stand in for the line a reader greps')

  // The two dialogs the leg could not write are counted refusals (#616), so each names
  // its own line: a reader who greps the record gets the reason and the sentence the
  // client was given, and needs no second record to learn them.
  for (const event of ['pickerDialogFailed', 'pickerServerDialogFailed']) {
    assert.ok(sites.some(site => site.includes("log('" + event + "'")),
      event + ' is a counted refusal, and its own record carries the reason')
  }

  // #670: the empty offer is the second asymmetry. It counts now, so the word the map is
  // keyed by is the record's `reason`, and the offer's own cause rides beside it: that
  // code, not the sentence's word, is what an operator repairs a file from (#372).
  const empty = sites.filter(site => site.includes("'empty_offer'"))
  assert.equal(empty.length, 1, 'the lane with no rows counts once, through the helper')
  assert.match(empty[0], /reason: 'empty_offer'/, 'and it counts under the word the board composes its sentence from')
  assert.match(empty[0], /offerReason: offer\.reason/, 'while the offer own cause, which names the file to repair, rides beside it')
})

// #708: every `endConfiguration(client, '<reason>', <sentence>)` call in the leg, as its
// argument list rather than as a line. The sentence is the last argument, and it is a call
// or a property access as often as a name, so the arguments are split at the commas that sit
// outside braces, brackets and strings.
function splitArguments (source) {
  const args = []
  let depth = 0
  let quote = null
  let from = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (quote !== null) {
      if (char === '\\') i += 1
      else if (char === quote) quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue }
    if (char === '(' || char === '{' || char === '[') depth += 1
    else if (char === ')' || char === '}' || char === ']') depth -= 1
    else if (char === ',' && depth === 0) { args.push(source.slice(from, i).trim()); from = i + 1 }
  }
  args.push(source.slice(from).trim())
  return args
}

function endConfigurationSites (source) {
  const sites = []
  for (let at = source.indexOf('endConfiguration(');
    at !== -1;
    at = source.indexOf('endConfiguration(', at + 1)) {
    // The definition, not a call, and the one spelling that is not a call at all.
    if (/function\s+$/.test(source.slice(0, at))) continue
    const open = source.indexOf('(', at)
    let depth = 0
    let end = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '(') depth += 1
      else if (source[i] === ')') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    assert.notEqual(end, -1, 'the end site at byte ' + at + ' closes')
    sites.push({ at, args: splitArguments(source.slice(open + 1, end)) })
  }
  return sites
}

// The function the call sits in. The leg's own functions are declared at two spaces inside
// createFrontLeg, so the nearest of those above the call is its own.
function enclosingFunction (source, at) {
  const declared = [...source.slice(0, at).matchAll(/\n {2}function (\w+) \(/g)]
  assert.notEqual(declared.length, 0, 'the end site at byte ' + at + ' is inside a function')
  return declared[declared.length - 1][1]
}

// A function's body and where it starts in the source, so an assertion can be made about
// the text in front of a call rather than about the function as a whole.
function functionSpan (source, name) {
  const at = source.indexOf('\n  function ' + name + ' (')
  assert.notEqual(at, -1, 'the leg has the function ' + name)
  // The body's brace, not the one a destructured parameter opens.
  const open = source.indexOf(') {', at) + 2
  assert.ok(open > 2, name + ' has a body')
  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return { from: open + 1, body: source.slice(open + 1, i) }
    }
  }
  assert.fail(name + ' closes')
}

function functionBody (source, name) {
  return functionSpan(source, name).body
}

// #708: the ends the argument scan above cannot judge on its own are listed here, with
// what the guard knows about them and how it knows it.
//
// A picker client is ended in three shapes. Eight of them pass a local the counted
// helper returned in the same function; two pass the `.text` a function handed back
// (`recordClaim`'s refusal, which is the claim's, and `landSpectator`'s, which is the
// Spectate landing's); and one composes its own sentence and counts nothing, which is the
// verb guard no client reaches (#670). Anything else is a sentence written at the call
// site, which is #708: `endConfiguration(client, 'claim_failed', claimFailureText({ ... }))`
// told the client why it was leaving and left both the count and the record short.
//
// What this proves and what it does not: it reads the sentence argument, so a sentence
// composed at the end is red. A local named `text` is accepted when the function that
// ends the client also calls the helper; a function holding one counted arm and one arm
// that binds its own `text` would pass, because this is a source scan and not a
// dataflow proof. The count and the record of a counted arm are held by the two guards
// above, off the same scan, so the three read the one helper between them.
test('#708 every sentence an ended picker client is given comes from a counted refusal', () => {
  const sites = endConfigurationSites(SOURCE)
  // The ends, in the order they appear in `live-front.js`, each named by the reason its
  // own line records. A new arm reds this list until it is named here.
  assert.deepEqual(sites.map(site => site.args[1]), [
    "'picker_empty'",
    "'picker_unavailable'",
    "'picker_refused'",
    "'picker_unavailable'",
    "'verb_refused'",
    "'disconnect_refused'",
    "'claim_refused'",
    "'spectate_refused'",
    "'verb_' + answer.verb + '_unbuilt'",
    "'claim_failed'",
    "'pick_refused'"
  ], 'the leg ends a picker client from eleven places, in this order, with these reasons')

  // The two names a sentence arrives under when the function that composes it is not the
  // one that ends the client, and the function each one is handed by.
  const HANDED_BACK = { claimed: 'recordClaim', landing: 'landSpectator' }

  for (const site of sites) {
    const [client, reason, sentence] = site.args
    assert.equal(client, 'client', 'every end is one connection\'s own')
    // The one end whose sentence counts nothing, named with its reason so a second such
    // arm cannot arrive unremarked: no client reaches it, because the board answers
    // `unknown_verb` for a verb it does not carry before this branch can run (#670).
    if (reason === "'verb_' + answer.verb + '_unbuilt'") {
      assert.equal(sentence, 'pickerBoard.refuse({ verb: answer.verb, server: server.name })',
        'the unbuilt-verb guard is the one end that composes its sentence and counts nothing')
      continue
    }
    const local = sentence.match(/^(\w+)$/)
    if (local !== null) {
      const owner = enclosingFunction(SOURCE, site.at)
      const span = functionSpan(SOURCE, owner)
      // The binding in scope at the call, which is the last one written before it, and
      // its initialiser. A function holding a counted arm and an arm that binds its own
      // sentence cannot pass on the strength of the counted arm next door, and a rename
      // of the counted local costs nothing here.
      const bindings = [...span.body.slice(0, site.at - span.from)
        .matchAll(new RegExp('\\b(?:const|let|var) ' + local[1] + ' =', 'g'))]
      assert.notEqual(bindings.length, 0,
        reason + ' names a local ' + owner + ' binds (' + sentence + '), and the guard reads the binding')
      const bindingAt = bindings[bindings.length - 1].index
      assert.match(span.body.slice(bindingAt, bindingAt + 400), /refuseAndCount\(\{/,
        reason + ' hands over the counted helper\'s own sentence, in ' + owner)
      continue
    }
    const handed = sentence.match(/^(\w+)\.text$/)
    assert.notEqual(handed, null,
      reason + ' hands over a sentence composed at the call site (' + sentence + '). A picker end ' +
        'whose sentence is composed here is a refusal nothing counted (#708)')
    const producer = HANDED_BACK[handed[1]]
    assert.equal(typeof producer, 'string',
      handed[1] + ' is a value this guard knows the origin of, or a new one it must be told about')
    assert.match(functionBody(SOURCE, producer), /refuseAndCount\(\{/,
      handed[1] + ' is handed back by ' + producer + ', which composes it through the counted helper')
  }

  // #435's ordering rule, which this landing was the second to break: the landing is
  // counted after the frame that ends the client's phase, so a phase the leg could not
  // end is a refusal and never also a landing. The Spectate landing's order is pinned
  // above; this is the claim landing's, which #708 moved.
  const claimLanding = functionBody(SOURCE, 'landClaimedClient')
  const claimWrite = claimLanding.indexOf("client.write('finish_configuration'")
  const claimCount = claimLanding.indexOf('metrics.claimLanded++')
  assert.ok(claimWrite > 0, 'the claim landing writes the frame that ends the phase')
  assert.ok(claimCount > claimWrite,
    'the claim landing is counted after that write, so a claim whose phase-end write threw is a refusal and not a landing')
})

