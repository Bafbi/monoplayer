// #742: every sentence the library ends a login with, not the one #722 saw.
//
// `minecraft-protocol` refuses a login for reasons of its own, and it ends the
// connection itself, before it calls `options.beforeLogin`. #722 recorded one of
// those sentences: the sessionserver's. Every other one ended the connection with no
// line and no counter, so the first evidence of a player's join failing at the door was
// the player's own screenshot.
//
// Two facts are proved here, and neither is enough alone. The leg's table is exactly
// the set of sentences the installed library refuses a login with, read out of its own
// handlers rather than copied from a ticket, so a fork bump that adds or renames one
// fails this file instead of quietly emptying the lane's record. And the seam is driven
// with each sentence, so a record removed from it fails this file.
//
// Four of the classes are driven by the library itself, with no seam faked: a handshake
// from another protocol version, an encryption answer the server cannot read, the
// library's own kick for a socket that never speaks, and the sessionserver's refusal
// (test/legs/session-verification-refused.test.js). What cannot be reached that way is
// reached by calling `client.end` with the library's own sentence, which is the one
// input this seam has: the profile-key sentences need a login-start field that no
// protocol version this repo serves has, and the page names them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import mc from 'minecraft-protocol'

import { DENY_REASONS } from '../../src/custody/attach.js'
import { createLiveFrontLeg, libraryRefusalWord, LIBRARY_LOGIN_REFUSALS } from '../../src/legs/live-front.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VERSION = '26.1'
const RECORD = 'libraryLoginRefused'

// The library's own files, as installed.
function librarySources () {
  const packagePath = createRequire(import.meta.url).resolve('minecraft-protocol/package.json')
  const source = name => fs.readFileSync(path.join(path.dirname(packagePath), 'src', 'server', name), 'utf8')
  return { login: source('login.js'), handshake: source('handshake.js') }
}

// What the library's two handlers end a connection with. `client.end('...')` is one
// handler ending a connection itself, `raise` is login.js's one wrapper for it (it
// passes its argument to `client.end` as the reason, with a translate payload beside it
// that the connection's end event never carries), and a literal followed by `+` is a
// sentence the library builds around the values it compared.
function libraryRefusals () {
  const { login, handshake } = librarySources()
  const whole = new Set()
  const composed = new Set()
  // Both handlers, so a whole sentence added to the handshake is as visible as one added
  // to the login. `raise` is login.js's own wrapper and lives only there.
  for (const file of [login, handshake]) {
    for (const match of file.matchAll(/client\.end\('([^']+)'/g)) whole.add(match[1])
    for (const match of file.matchAll(/client\.end\('([^']*)'\s*\+/g)) {
      composed.add(match[1])
      whole.delete(match[1])
    }
  }
  for (const match of login.matchAll(/raise\('([^']+)'/g)) whole.add(match[1])
  return { whole: [...whole].sort(), composed: [...composed].sort(), login, handshake }
}

test('#742 the table is every sentence the installed library refuses a login with', () => {
  const { whole, composed, login, handshake } = libraryRefusals()

  // Every whole sentence sits before the hook this leg reviews a login in. A sentence
  // written after it is a login this leg already saw, and it is not what this table is
  // for. The handshake's two are written on `set_protocol`, which arrives before any
  // login start, so no review can have run for them either.
  const beforeLogin = login.indexOf('options.beforeLogin')
  assert.notEqual(beforeLogin, -1, 'the login handler still calls beforeLogin, which is the line these sentences sit before')
  for (const site of login.matchAll(/client\.end\('([^']+)'|raise\('([^']+)'/g)) {
    assert.ok(site.index < beforeLogin,
      JSON.stringify(site[1] ?? site[2]) + ' is written after options.beforeLogin, so this leg reviewed that login')
  }
  assert.match(handshake, /client\.once\('set_protocol'/, 'the handshake sentences are still written on the handshake')

  // Every end either handler writes is a literal, or a literal with the numbers it
  // compared appended. A reason composed another way is a sentence no table can be read
  // against, and it is the one hole a source scan cannot see past.
  const built = []
  for (const [name, file] of [['login.js', login], ['handshake.js', handshake]]) {
    for (const site of file.matchAll(/(client\.end|raise)\(/g)) {
      // `raise` is login.js's own wrapper, and its body forwards to client.end.
      if (/=>\s*$/.test(file.slice(Math.max(0, site.index - 40), site.index))) continue
      if (file[site.index + site[0].length] === "'") continue
      built.push(name + ': ' + file.slice(site.index, site.index + 24).split('\n')[0])
    }
  }
  // The library's own default error handler ends a connection with the Error object and
  // not with a sentence. It never runs on this lane, because the leg passes its own
  // handler, and the second assertion is what keeps that exemption honest: the site is
  // the only one that is not a literal, and the wiring that skips it is still there.
  assert.deepEqual(built, ['login.js: client.end(err)'],
    'a refusal the library builds from something other than a literal is one no table can be read against: ' +
    'read it, and add the sentence it builds to the table if the library refuses a login with it')
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'legs', 'live-front.js'), 'utf8'),
    /errorHandler: createFrontErrorHandler\(\{ log \}\)/,
    'the leg still replaces the library\'s default error handler, which is why that end is not a sentence')

  // Classified by what the library's source shows, not by a second list in this file: an
  // entry is composed when the source builds it, and a table entry in neither set is the
  // deepEqual's business below.
  const tableWhole = [...LIBRARY_LOGIN_REFUSALS.keys()].filter(sentence => !composed.includes(sentence)).sort()
  const tableComposed = [...LIBRARY_LOGIN_REFUSALS.keys()].filter(sentence => composed.includes(sentence)).sort()

  assert.deepEqual(tableWhole, whole,
    'the leg records ' + tableWhole.length + ' of the library\'s ' + whole.length +
    ' whole sentences: every one is a player\'s join failing at the door with nothing written for it')
  assert.deepEqual(tableComposed, composed,
    'and the sentences the library builds around a protocol number are matched by the prefix it builds them from')
  for (const [sentence] of LIBRARY_LOGIN_REFUSALS) {
    assert.ok(sentence.length > 0, 'an empty sentence would match every end reason there is')
  }
})

test('#742 each sentence has its own word, and docs/telemetry.md names every one', () => {
  const words = [...LIBRARY_LOGIN_REFUSALS.values()]
  assert.equal(new Set(words).size, words.length, 'two sentences sharing a word read as one refusal')
  for (const word of words) {
    assert.match(word, /^[a-z][a-z0-9_]*$/, JSON.stringify(word) + ' is a reason word, not a sentence')
  }

  // #722's word, kept: `monoplayer.session.refused` charts this one sentence under it,
  // and a rename would split one number into two that an operator cannot add up.
  assert.equal(LIBRARY_LOGIN_REFUSALS.get('Failed to verify username!'), DENY_REASONS.HASJOINED_FAILED,
    'the sessionserver sentence keeps the attach check\'s own word for a failed hasJoined')

  // A row of the section's own table, not any mention on the page: `hasjoined_failed` is
  // already in the metrics table above, so a page-wide read would pass with its row gone.
  const page = fs.readFileSync(path.join(ROOT, 'docs', 'telemetry.md'), 'utf8')
  const section = page.slice(page.indexOf('### The library\'s login refusals'))
  const listed = [...section.slice(0, section.indexOf('\n### ', 4)).matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map(match => match[1])

  const missing = words.filter(word => !listed.includes(word))
  assert.deepEqual(missing, [],
    'docs/telemetry.md\'s reason-word table has no row for: ' + missing.join(', ') + '.')
  // Both directions, as the picker's refusal row is read: a word this table retired keeps
  // its row otherwise, and the page then names a refusal the lane cannot count.
  const stale = listed.filter(word => !words.includes(word))
  assert.deepEqual(stale, [],
    'docs/telemetry.md\'s reason-word table names words the leg does not count: ' + stale.join(', ') + '.')
})

// What the library hands the seam: each whole sentence, and each composed one built the
// way the library builds it.
function refusalCases () {
  const { composed } = libraryRefusals()
  const cases = []
  for (const [sentence, word] of LIBRARY_LOGIN_REFUSALS) {
    cases.push({ text: composed.includes(sentence) ? sentence + '776' : sentence, word })
  }
  return cases
}

// One lane, its lines, and the clients the library built for each connection. The
// table's subject is the reason the library gives, and the client is where that reason
// arrives, so the test holds the client rather than a socket.
async function withLane (run, { kickTimeout = null, preAuth = {} } = {}) {
  const original = mc.createServer
  const waiting = []
  mc.createServer = (options, ...rest) => {
    // The library's own bound for a socket that never speaks, shortened for the test.
    if (kickTimeout !== null) options.kickTimeout = kickTimeout
    const server = original(options, ...rest)
    server.on('connection', client => {
      for (const resolve of waiting.splice(0)) resolve(client)
    })
    return server
  }
  const lines = []
  const leg = createLiveFrontLeg({
    host: '127.0.0.1',
    port: 0,
    version: VERSION,
    attachWhitelistFile: path.join(os.tmpdir(), 'monoplayer-742-nobody.json'),
    getSnapshotConfig: () => [],
    wireMode: 'off',
    preAuth,
    log: (event, fields) => lines.push({ event, fields })
  })
  try {
    const { port } = await leg.listen()
    return await run({
      leg,
      lines,
      port,
      nextClient: () => new Promise(resolve => waiting.push(resolve))
    })
  } finally {
    mc.createServer = original
    await leg.close()
  }
}

function recordsOf (lines, event) {
  return lines.filter(line => line.event === event).map(line => line.fields)
}

async function settleUntil (read, label, timeoutMs = 10_000) {
  const started = Date.now()
  while (!read()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for ' + label)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

test('#742 the seam records each sentence, with the library\'s own words and its own count', async () => {
  await withLane(async ({ leg, lines, port, nextClient }) => {
    let refused = 0
    for (const { text, word } of refusalCases()) {
      refused += 1
      const socket = net.connect(port, '127.0.0.1')
      try {
        const client = await nextClient()
        // The library's end, called on the connection the leg wired.
        client.end(text)
        await settleUntil(() => recordsOf(lines, RECORD).length === refused, 'the line for ' + JSON.stringify(text))

        const record = recordsOf(lines, RECORD)[refused - 1]
        assert.deepEqual(Object.keys(record).sort(), ['reason', 'refused', 'text', 'username', 'uuid'],
          'the line carries the words the client was told and no field that could hold a secret')
        assert.equal(record.reason, word, 'the word this refusal is counted under')
        assert.equal(record.text, text, 'and the sentence the library itself wrote')
        assert.equal(record.username, null, 'this connection never logged in, so it names no account')
        assert.equal(record.refused, refused, 'the line states its own running count, as the window\'s two lines do')
      } finally {
        socket.destroy()
      }
    }

    assert.equal(leg.metrics.libraryLoginRefused, LIBRARY_LOGIN_REFUSALS.size, 'one count, and the total is the table')
    for (const { text, word } of refusalCases()) {
      assert.equal(leg.metrics.libraryLoginRefusedByReason[word], 1,
        'the map splits the total, one entry for ' + JSON.stringify(text))
    }
    // #722's counter is still the sessionserver's own, because `monoplayer.session.refused`
    // samples it and charts it under one word. It is the subset, not a second total.
    assert.equal(leg.metrics.sessionVerificationRefused, 1,
      'the sessionserver sentence is still counted under #722\'s counter, and nothing else is')
    assert.equal(leg.metrics.denied, 0, 'no review ran for any of these, so no denial counts them')
    assert.deepEqual(recordsOf(lines, 'attachDenied'), [])
  })
})

test('#742 the first refusal the library gives is the one recorded', async () => {
  // The library keeps the last reason it was handed, and its kick for a peer that never
  // finished closing is a sentence the table carries. Reading the reason at the event
  // would record the kick and lose the refusal, which is the defect this ticket closes
  // read backwards.
  await withLane(async ({ leg, lines, port, nextClient }) => {
    const socket = net.connect(port, '127.0.0.1')
    try {
      const client = await nextClient()
      client.end('Failed to verify username!')
      client.end('LoginTimeout')
      await settleUntil(() => recordsOf(lines, RECORD).length === 1, 'the refusal\'s own line')
      await new Promise(resolve => setTimeout(resolve, 50))

      const records = recordsOf(lines, RECORD)
      assert.equal(records.length, 1, 'one connection, one refusal, one line')
      assert.equal(records[0].reason, DENY_REASONS.HASJOINED_FAILED,
        'the refusal the library made first is the one on the record, not the kick that followed it')
      assert.equal(leg.metrics.libraryLoginRefusedByReason.login_timeout, undefined,
        'and the kick counts nothing of its own')
    } finally {
      socket.destroy()
    }
  })
})

test('#742 a close that is not one of the library\'s refusals writes nothing', async () => {
  await withLane(async ({ leg, lines, port, nextClient }) => {
    // `socketClosed` is the library's own word for a peer that went away, `ServerShutdown`
    // is its server closing, and a front error's sentence is this leg's. None of them is
    // the library refusing a login, and a record for one would count a client that was
    // never turned away.
    for (const reason of ['socketClosed', 'ServerShutdown', 'front_error: boom', undefined]) {
      const socket = net.connect(port, '127.0.0.1')
      try {
        const client = await nextClient()
        client.end(reason)
        await new Promise(resolve => setTimeout(resolve, 20))
      } finally {
        socket.destroy()
      }
    }
    assert.deepEqual(recordsOf(lines, RECORD), [], 'a close that refused nothing is not a refusal')
    assert.equal(leg.metrics.libraryLoginRefused, 0)
    assert.deepEqual(leg.metrics.libraryLoginRefusedByReason, {})
  })
})

test('#742 the lookup answers the library\'s own sentence and nothing else', () => {
  assert.equal(libraryRefusalWord('multiplayer.disconnect.invalid_public_key'), 'invalid_public_key',
    'a whole sentence is spelled as the library spells it, not as the longer one it prefixes')
  assert.equal(libraryRefusalWord('multiplayer.disconnect.invalid_public_key_signature'),
    'invalid_public_key_signature', 'the longer sentence keeps its own word')
  assert.equal(libraryRefusalWord('Wrong protocol version, expected: 775 and you are using: 776'),
    'protocol_version_mismatch', 'a composed sentence is matched by its prefix')
  for (const text of ['socketClosed', 'ServerShutdown', '', null, undefined]) {
    assert.equal(libraryRefusalWord(text), undefined, JSON.stringify(text) + ' is not one of the library\'s refusals')
  }
})

// The sessionserver's refusal is the third class a real client reaches, and
// test/legs/session-verification-refused.test.js drives it. These two are the other two
// the library can be made to refuse, and neither seam is faked: the library decides, and
// the record is the leg's.

test('#742 a client on another protocol version is refused by the library, and recorded', async () => {
  await withLane(async ({ leg, lines, port }) => {
    // The lane pins 26.1; this client shakes hands as 26.2, which is the one sentence the
    // library builds around the numbers it compared.
    const bot = mc.createClient({
      host: '127.0.0.1', port, username: 'Newer', version: '26.2', auth: 'offline', keepAlive: false
    })
    bot.on('error', () => {})
    try {
      await settleUntil(() => recordsOf(lines, RECORD).length === 1, 'the handshake refusal')
      const [record] = recordsOf(lines, RECORD)
      assert.equal(record.reason, 'protocol_version_mismatch', 'the handshake refused it, and the word says so')
      assert.match(record.text, /^Wrong protocol version, expected: \d+ and you are using: \d+$/,
        'and the line carries the whole sentence, numbers and all')
      assert.equal(record.username, null, 'no login start arrived, so the connection has no name')
      assert.equal(leg.metrics.libraryLoginRefused, 1)
    } finally {
      bot.socket?.destroy()
    }
  })
})

test('#742 an encryption answer the library cannot read is refused by the library, and recorded', async () => {
  const protocolRequire = createRequire(createRequire(import.meta.url).resolve('minecraft-protocol'))
  const NodeRSA = protocolRequire('node-rsa')
  const originalDecrypt = NodeRSA.prototype.decrypt
  // The server's key decrypts the answer the client encrypted with its public half. A
  // key that refuses every ciphertext is an answer the library cannot read, which is the
  // branch that ends the connection with its own sentence. Restored below, because the
  // prototype is the process's.
  NodeRSA.prototype.decrypt = function () { throw new Error('not a ciphertext') }
  try {
    await withLane(async ({ leg, lines, port }) => {
      const bot = mc.createClient({
        host: '127.0.0.1', port, username: 'Unreadable', version: VERSION, auth: 'offline', keepAlive: false
      })
      bot.on('error', () => {})
      try {
        await settleUntil(() => recordsOf(lines, RECORD).length === 1, 'the encryption refusal')
        const [record] = recordsOf(lines, RECORD)
        assert.equal(record.reason, 'did_not_encrypt_verify_token_properly')
        assert.equal(record.text, 'DidNotEncryptVerifyTokenProperly', 'the library\'s own sentence, as it wrote it')
        assert.equal(record.username, 'Unreadable', 'the login start arrived, so the connection has a name')
        assert.equal(leg.metrics.libraryLoginRefused, 1)
      } finally {
        bot.socket?.destroy()
      }
    })
  } finally {
    NodeRSA.prototype.decrypt = originalDecrypt
  }
})

// #742: one close, one record. The library's kick and this leg's pre-auth deadline are
// both 30 s on a deployed lane and the library's is armed first, so a silent socket met
// both. Each case shortens one of the two and leaves the other at its deployed length, so
// the test drives the timer that fires rather than the one that does not.

test('#742 a socket the library kicks is one refusal, and not an expired window', async () => {
  await withLane(async ({ leg, lines, port }) => {
    const socket = net.connect(port, '127.0.0.1')
    try {
      await settleUntil(() => recordsOf(lines, RECORD).length === 1, 'the library\'s kick')
      // The deadline is due in the same millisecond. Let it fire before reading.
      await new Promise(resolve => setTimeout(resolve, 50))
      const [record] = recordsOf(lines, RECORD)
      assert.equal(record.reason, 'login_timeout', 'the library ended it, and its own sentence says why')
      assert.equal(leg.preAuthStats().expired, 0,
        'and the deadline that was due with it counts nothing: one close is one number')
    } finally {
      socket.destroy()
    }
  }, { kickTimeout: 60 })
})

test('#742 a socket this leg\'s deadline ends is one expiry, and no refusal', async () => {
  await withLane(async ({ leg, lines, port }) => {
    const socket = net.connect(port, '127.0.0.1')
    try {
      await settleUntil(() => leg.preAuthStats().expired === 1, 'the deadline')
      await new Promise(resolve => setTimeout(resolve, 50))
      assert.deepEqual(recordsOf(lines, RECORD), [],
        'the leg ended it, so no sentence of the library\'s is on a record')
      assert.equal(leg.metrics.libraryLoginRefused, 0)
    } finally {
      socket.destroy()
    }
  }, { preAuth: { deadlineMs: 60 } })
})
