// #755: the three glossary entries that define the attach check are pinned to the
// modules that run its two steps.
//
// #721 is the failure this guard exists for, and it is worth stating what it actually
// looked like, because the rule that catches it is not the obvious one. The glossary
// defined the attach check as two steps, named them in the wrong order, and defined a
// session step no lane of the service ran. `mise run check` stayed green through it.
// What the entries said, at 412e7cd^, was prose: "The two steps an attaching player
// passes before they drive a body: the whitelist review, then session verification",
// and no backticked name anywhere in the three bodies. A guard keyed on the names an
// entry carries cannot see an entry that carries none, so the load-bearing case here is
// that a covered entry names the module that runs its step. The sweeps over names are
// the tripwire beside it.
//
// Four facts have a home, and this guard reads all four:
//
//   the whitelist review   reviewLoginStart, on the object createFrontIdentity returns
//                          (src/core/identity.js), reached through the call-in
//                          setLoginStartHandler, a row of FRONT_LEG_CALL_INS
//   the leg's own review   checkVerified, on the object createAttachCheck returns
//                          (src/custody/attach.js)
//   the session step       the installed minecraft-protocol's login path, which answers
//                          hasJoined before it calls beforeLogin, the seam
//                          src/legs/live-front.js registers, and the two counters the leg
//                          keeps for a refusal it never sees
//   each entry's shape     GLOSSARY.md's own: a heading, one line, an _Avoid_ list
//
// What is compared is names, one order, and the grammars the glossary writes for itself:
//
//   X in Y                   Y holds X, and Y is the module the probe asks for X
//   the step, which <path>   the module the composite hands each step to is the one that
//                            runs it, read as the first path named after the step
//   first, then              the step the entry says runs first, read beside the word it
//                            marks the order with
//
// The last two are not a name, and this header says so rather than claiming the prose is
// untouched. They read the entry's own marker words, the way this glossary's other guards
// read "fallback" and "card", and a sentence rewritten in words this guard does not know
// is a finding whose message names the words it reads. The one denial is the Session
// verification entry's last sentence: src/core/identity.js keeps no copy of the step, and
// that file's text is where the claim is answered.
//
// Three cases are total over GLOSSARY.md, not over these three entries: a module path the
// file backticks anywhere is a path that exists, and a X in Y pair is a name Y holds. That
// is the answer this ticket asked for about the fourth entry. A name sweep cannot go
// vacuous, but it also cannot carry #721, because #721's entries named nothing and every
// version of this file back to c81ee82 held only paths that exist. What catches a fourth
// entry is a row: an entry that defines a step of a handshake and names no module is the
// shape #721 shipped, and the table below is where that entry is recorded.
//
// The other entries' names each have their own guard, and this one does not repeat them:
// a config path, a MONOPLAYER_* switch and a .json file are glossary-control-document's
// (test/tooling/glossary-control-document.test.js), a switch a page names is
// env-var-pages', and the UUID decision has its own. This file carries its own copy of the
// entry reader the way every guard here does (test/tooling/dev-lane-proof.test.js: a guard
// that shares a helper with the guard it was modelled on fails when that one is edited).
// #806 moves that reader out of the three older guards, and this is the fourth copy it
// would move.
//
// Nothing here opens a socket, reaches a cluster, or joins a server. A front leg is built
// and never listened on, which reads the interface a caller holds and nothing else (#690).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createFrontIdentity } from '../../src/core/identity.js'
import { createAttachCheck } from '../../src/custody/attach.js'
import { createOfflineFrontLeg } from '../../src/legs/live-front.js'
import { FRONT_LEG_CALL_INS } from '../../src/service/wire-leg-to-core.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const GLOSSARY = read('GLOSSARY.md')

// The two steps, named the way the Attach check entry names them.
const STEPS = ['session verification', 'whitelist review']

// The module that runs each step. The composite entry hands each step to one, and this is
// the hand it is held to: a step beside the wrong file sends a reader to code that does
// not run it, and both paths exist, so only the pairing can catch it.
const STEP_HOME = {
  'whitelist review': 'src/core/identity.js',
  'session verification': 'src/legs/live-front.js'
}

// The three entries, and the names each one may not carry without the code behind it.
// One row per entry the ticket names: the composite that defines the check, and the two
// entries that define its steps. A name here is a claim about this tree, so a rename, a
// move, or a deletion is a finding rather than a sentence that reads well.
const COVERED = {
  'Attach check': [
    'src/core/identity.js',
    'src/legs/live-front.js'
  ],
  'Whitelist review': [
    'reviewLoginStart',
    'src/core/identity.js',
    'setLoginStartHandler',
    'checkVerified',
    'src/custody/attach.js'
  ],
  'Session verification': [
    'minecraft-protocol',
    'hasJoined',
    'beforeLogin',
    'src/legs/live-front.js',
    'sessionVerificationRefused',
    'libraryLoginRefused',
    'src/core/identity.js'
  ]
}

// Every backticked name in a line. A name wears backticks in this glossary, which is its
// style for a key, a switch, a file, a path, or a symbol.
const names = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1])

// An entry: one heading, one line of definition, one _Avoid_ list. It ends at the _Avoid_
// line, so another entry's prose cannot satisfy a claim about this one.
function entry (glossary, term) {
  const lines = glossary.split('\n')
  const heading = lines.findIndex(line => line.startsWith('**' + term + '**:'))
  if (heading === -1) return null
  return { line: heading + 1, body: lines[heading + 1] ?? '', avoid: lines[heading + 2] ?? '' }
}

// A path into this tree. The prefix is what makes it a path, so the sweeps below read it
// wherever it appears.
const MODULE = /^(?:src|test|tools|scripts|deploy)\/[A-Za-z0-9._/-]+$/
const MODULE_ANY = /(?:src|test|tools|scripts|deploy)\/[A-Za-z0-9._/-]+/g

// The glossary's own way of saying where a name lives: X in Y. The symbol is a bare
// identifier, so a config path or a switch beside a file is not this claim.
const PAIR = /`([A-Za-z_][A-Za-z0-9_]*)` in `((?:src|test|tools|scripts|deploy)\/[A-Za-z0-9._/-]+)`/g

// Every name a covered entry wears that this tree holds, the module it lives in, and the
// probe that answers for it. from is the module a pair has to name, because the grammar
// says where the name lives and a probe that answers from another file would vouch for the
// wrong one. A name in no row is a name this guard makes no claim about: a config path, a
// switch, a frame name, or a file name has its own guard, and naming it twice would be the
// second home AGENTS.md warns about.
const HELD = {
  reviewLoginStart: {
    from: 'src/core/identity.js',
    holds: facts => typeof facts.identity.reviewLoginStart === 'function'
  },
  setLoginStartHandler: {
    from: 'src/service/wire-leg-to-core.js',
    holds: facts => facts.callIns.includes('setLoginStartHandler') &&
      typeof facts.leg.setLoginStartHandler === 'function'
  },
  checkVerified: {
    from: 'src/custody/attach.js',
    holds: facts => typeof facts.check.checkVerified === 'function'
  },
  sessionVerificationRefused: {
    from: 'src/legs/live-front.js',
    holds: facts => facts.metrics.includes('sessionVerificationRefused')
  },
  libraryLoginRefused: {
    from: 'src/legs/live-front.js',
    holds: facts => facts.metrics.includes('libraryLoginRefused')
  },
  'minecraft-protocol': {
    from: 'package.json',
    holds: facts => facts.dependencies.includes('minecraft-protocol')
  },
  hasJoined: {
    from: 'minecraft-protocol',
    holds: facts => facts.login.includes('hasJoined')
  },
  beforeLogin: {
    from: 'minecraft-protocol',
    holds: facts => facts.login.includes('beforeLogin') && facts.front.includes('beforeLogin:')
  }
}

// The one uuid an offline front leg needs, and never a real one: an interface does not
// depend on whose uuid it is (test/tooling/product-core-map.test.js).
const OFFLINE_UUID = '00000000-0000-0000-0000-000000000000'

// The installed library's own login path. Resolved from the package the lockfile pins
// rather than typed as a path under node_modules/.pnpm: that directory name carries the
// tarball's hash, so a typed path would rot on the next fork bump.
function loginSource () {
  const from = createRequire(path.join(ROOT, 'package.json'))
  const shipped = path.dirname(from.resolve('minecraft-protocol/package.json'))
  const login = path.join(shipped, 'src', 'server', 'login.js')
  assert.ok(fs.existsSync(login), 'the installed minecraft-protocol ships ' + login + ', and that file is ' +
    'where the attach check\'s order is read. A fork that moves it is a fork whose login path this guard ' +
    'cannot see, so the order would be a claim about nothing.')
  return fs.readFileSync(login, 'utf8')
}

// The tree's answer to every name in the table above. Read once, and only when a case asks
// for it, so a header that no longer parses fails the case that reads it.
let FACTS = null

function facts () {
  if (FACTS !== null) return FACTS
  const leg = createOfflineFrontLeg({
    offlineWhitelist: [OFFLINE_UUID],
    getSnapshotConfig: () => ({}),
    wireCheck: () => {}
  })
  FACTS = {
    identity: createFrontIdentity({ attachWhitelist: [] }),
    check: createAttachCheck({}),
    leg,
    callIns: FRONT_LEG_CALL_INS.map(row => row.name),
    metrics: Object.keys(leg.metrics),
    login: loginSource(),
    front: read('src/legs/live-front.js'),
    dependencies: Object.keys(JSON.parse(read('package.json')).dependencies ?? {}),
    coreIdentity: read('src/core/identity.js')
  }
  return FACTS
}

// The order a lane runs the two steps, and the one fact it rests on: the library answers
// hasJoined, and the leg reviews the login only inside the beforeLogin the library calls
// after it. Two offsets into the shipped file, so a fork that inverts them is the finding.
function runOrder (login) {
  const session = login.indexOf('hasJoined')
  const review = login.indexOf('beforeLogin')
  assert.ok(session !== -1 && review !== -1, 'the installed minecraft-protocol\'s login path names both ' +
    'hasJoined and beforeLogin, and this case reads the order from those two names. A login path that names ' +
    'neither is a library this guard cannot compare an entry with.')
  return session < review ? ['session verification', 'whitelist review'] : ['whitelist review', 'session verification']
}

// The words an entry marks its order with: "session verification first", or "the whitelist
// review, then session verification". The step named closest before its own marker is the
// one it says runs first. A sentence that orders the steps in words this list does not hold
// is a finding, and its message names the words that would pass.
const ORDER_MARKER = ['first', 'then']

function statedFirst (body) {
  const lowered = body.toLowerCase()
  for (const marker of ORDER_MARKER) {
    const found = new RegExp('\\b' + marker + '\\b').exec(lowered)
    if (found === null) continue
    const before = lowered.slice(0, found.index)
    const step = STEPS
      .map(name => ({ name, at: before.lastIndexOf(name) }))
      .filter(row => row.at !== -1)
      .sort((was, is) => is.at - was.at)[0]
    if (step !== undefined) return step.name
  }
  return null
}

// The module the composite hands each step to: the first path named after the step. Both
// are what the entry says, and the pairing is the claim #755 asks for, so a step beside the
// other step's file is a finding even though both files exist.
function stepHomes (body) {
  const lowered = body.toLowerCase()
  const found = new Map()
  for (const step of STEPS) {
    const at = lowered.indexOf(step)
    if (at === -1) continue
    MODULE_ANY.lastIndex = 0
    const named = MODULE_ANY.exec(body.slice(at + step.length))
    if (named !== null) found.set(step, named[0])
  }
  return found
}

const message = {
  noEntry: term => 'GLOSSARY.md defines ' + term + '. It has no entry, so the step it names has no home at ' +
    'all, which is the shape #721 shipped and the reason this guard exists.',
  shape: (where, term) => where + ' is not an entry: the ' + term + ' heading, one line, and its _Avoid_ ' +
    'list. GLOSSARY.md holds one shape for every term, and a term that reads differently is one a reader ' +
    'cannot scan.',
  noModule: (where, term) => where + ' defines a step of the attach check and names no module. #721 shipped ' +
    'these three entries with no path in any of them, and they defined a step no lane ran. A step with no ' +
    'file beside it is a claim nothing can fail on. Name the module that runs the step, in backticks, beside ' +
    'the step it runs.',
  missingName: (where, name, term) => where + ' does not name ' + (MODULE.test(name) ? name : '`' + name + '`') +
    ', which is where the ' + term + ' entry\'s own step has its home. An entry that describes the step ' +
    'without the name a reader greps for sends that reader to the module and no further.',
  unheldName: (where, name, from) => where + ' names `' + name + '`, and ' + from + ' no longer provides ' +
    'it. The entry\'s claim is a pointer, so a pointer at a name the code dropped sends a reader to a ' +
    'definition that is gone.',
  wrongModule: (where, name, named, home) => where + ' names `' + name + '` in ' + named + ', and the ' +
    'name lives in ' + home + '. The glossary writes "X in Y" to say where a name lives, so a pair that ' +
    'names another module sends a reader to a file that does not hold it.',
  unheldPath: (where, name) => where + ' names ' + name + ', which is not in this tree. A module path in the ' +
    'glossary is a reader\'s next click, so a rename or a move that leaves the path behind is a claim the ' +
    'code no longer holds.',
  unpaired: (where, symbol, file) => where + ' names `' + symbol + '` in ' + file + ', and that module ' +
    'does not hold the name. The glossary writes "X in Y" to say where a name lives, so a pair the module ' +
    'does not hold is a name a reader finds nowhere. Re-point it, or say where it went.',
  wrongHome: (where, step, named, home) => where + ' hands ' + step + ' to ' + named + ', and ' + step + ' ' +
    'runs in ' + home + '. The composite is where a reader learns which file to open for a step, and a step ' +
    'beside the other step\'s file sends them to code that does not run it.',
  lostHome: where => where + ' names no module after the step it defines, so nothing there says which file ' +
    'runs the step. Name the module the step runs in, just after the step.',
  noSteps: (where, missing) => where + ' does not name ' + missing.join(' or ') + ', so the Attach check ' +
    'entry no longer states the two steps it is the entry for. The two step entries are this one\'s halves, ' +
    'and a composite that names one of them describes half a check.',
  noOrder: (where, runs) => where + ' states no order: it never says which of its two steps runs first, ' +
    'beside the word this guard reads ("first", or "then"). A lane runs ' + runs + ' first, because the ' +
    'installed minecraft-protocol answers hasJoined and reaches beforeLogin from inside that answer, so a ' +
    'session it refuses never reaches the whitelist review (#722). The entry is where a reader learns that ' +
    'order. Say it once, beside the step.',
  wrongOrder: (where, stated, runs) => where + ' names ' + stated + ' first, and a lane runs ' + runs + ' ' +
    'first. The order is the library\'s: the installed minecraft-protocol answers hasJoined and reaches ' +
    'beforeLogin from inside that answer, so a session it refuses never reaches the whitelist review (#722). ' +
    '#721 shipped this entry with the two steps the other way round, which is the sentence this case exists ' +
    'to fail on. Name the step the lane runs first, first.',
  coreCopy: where => where + ' says src/core/identity.js keeps no copy of the session step, and that file ' +
    'now names `verifySession`. #721 deleted the copy no lane called. A copy that comes back, in that ' +
    'file or in a comment in it, makes the entry wrong, and this guard is where it shows. Delete the copy, ' +
    'or delete the sentence and say where the step runs.'
}

// The three entries' claims, one message per fact that does not hold. The tree is reached
// through the facts it is handed, so every case below can pass a fixture instead of a
// checkout.
function drift (glossary, tree) {
  const problems = []
  const order = runOrder(tree.login)
  for (const [term, required] of Object.entries(COVERED)) {
    const found = entry(glossary, term)
    if (found === null) {
      problems.push(message.noEntry(term))
      continue
    }
    const where = 'GLOSSARY.md:' + found.line
    if (!found.avoid.startsWith('_Avoid_:')) problems.push(message.shape(where, term))
    const named = names(found.body)

    // Completeness first, and alone: an entry with no module path at all is #721 shape,
    // and it is one finding rather than one per name it also failed to carry.
    const hasModule = named.some(name => MODULE.test(name))
    if (!hasModule) {
      problems.push(message.noModule(where, term))
    } else {
      for (const name of required) {
        if (!named.includes(name)) problems.push(message.missingName(where, name, term))
      }
    }

    // The code behind each name the entry does carry. A name no row of HELD knows is one
    // another guard owns, and this one says nothing about it.
    for (const name of named) {
      const held = HELD[name]
      if (held === undefined) continue
      if (!held.holds(tree)) problems.push(message.unheldName(where, name, held.from))
    }

    // A pair in a covered entry names the module the probe asks, not any module.
    for (const [, symbol, file] of found.body.matchAll(PAIR)) {
      const held = HELD[symbol]
      if (held === undefined || held.from === file) continue
      problems.push(message.wrongModule(where, symbol, file, held.from))
    }

    // The composite hands each step to a module, and states the order its halves run in.
    if (term === 'Attach check') {
      // An entry with no path anywhere is the finding above, and one message per step would
      // say the same thing twice.
      const homes = hasModule ? stepHomes(found.body) : new Map()
      for (const step of STEPS) {
        const named = homes.get(step)
        if (named !== undefined && named !== STEP_HOME[step]) {
          problems.push(message.wrongHome(where, step, named, STEP_HOME[step]))
        } else if (named === undefined && hasModule) {
          problems.push(message.lostHome(where))
        }
      }
      const absent = STEPS.filter(step => !found.body.toLowerCase().includes(step))
      const first = statedFirst(found.body)
      if (absent.length > 0) {
        problems.push(message.noSteps(where, absent))
      } else if (first === null) {
        problems.push(message.noOrder(where, order[0]))
      } else if (first !== order[0]) {
        problems.push(message.wrongOrder(where, first, order[0]))
      }
    }

    // The one denial this guard reads, held against the file it names.
    if (term === 'Session verification' && /\bverifySession\b/.test(tree.coreIdentity)) {
      problems.push(message.coreCopy(where))
    }
  }
  return problems
}

// Every path and every pair the whole glossary writes, one message per name the tree does
// not hold. The tree is injected for the same reason: a case about a file the checkout does
// not hold is a case, not a copy of the checkout.
function pointers (glossary, tree) {
  const problems = []
  glossary.split('\n').forEach((line, index) => {
    const where = 'GLOSSARY.md:' + (index + 1)
    for (const name of names(line)) {
      if (!MODULE.test(name)) continue
      if (!tree.exists(name)) problems.push(message.unheldPath(where, name))
    }
    for (const [, symbol, file] of line.matchAll(PAIR)) {
      // A path that is not there is already one finding, and the pair adds nothing to it.
      if (!tree.exists(file)) continue
      if (!tree.holds(file, symbol)) problems.push(message.unpaired(where, symbol, file))
    }
  })
  return problems
}

// A word, not a substring: `check` inside `checkVerified` is not the name.
const word = name => new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')

// This checkout, as pointers asks for it. A directory is read for every name under it,
// because a pair may point at one, and a font or an archive holds no name and is skipped.
const tree = {
  exists: name => fs.existsSync(path.join(ROOT, name)),
  holds (file, symbol) {
    const full = path.join(ROOT, file)
    if (!fs.existsSync(full)) return false
    if (fs.statSync(full).isFile()) return word(symbol).test(fs.readFileSync(full, 'utf8'))
    for (const item of fs.readdirSync(full, { recursive: true, withFileTypes: true })) {
      if (!item.isFile()) continue
      const bytes = fs.readFileSync(path.join(item.parentPath, item.name))
      if (bytes.includes(0)) continue
      if (word(symbol).test(bytes.toString('utf8'))) return true
    }
    return false
  }
}

// One entry per covered term, in the shape the glossary holds, carrying every name the
// table requires. A fixture copied from the tree would make each case below about whatever
// the tree drifted to, so this one is written here.
const BASE = '**Attach check**:\n' +
  'The two steps an attaching player passes before they drive a body, and the module that runs each: the ' +
  'whitelist review, which `src/core/identity.js` decides, and session verification, which ' +
  '`src/legs/live-front.js` takes from its library. An online lane runs session verification first and ' +
  'the whitelist review second.\n' +
  '_Avoid_: attach gate, auth gate, login gate\n' +
  '\n' +
  '**Whitelist review**:\n' +
  'The attach check\'s whitelist step: the claimed UUID must be on the attach whitelist. ' +
  '`reviewLoginStart` in `src/core/identity.js` is the decision, reached through ' +
  '`setLoginStartHandler`. `checkVerified` in `src/custody/attach.js` is the leg\'s own review.\n' +
  '_Avoid_: gate one, precheck\n' +
  '\n' +
  '**Session verification**:\n' +
  'The attach check\'s session step: the sessionserver confirms the session. In a live lane ' +
  '`minecraft-protocol`\'s login handler answers `hasJoined` before the leg\'s `beforeLogin`, and ' +
  '`src/legs/live-front.js` counts that refusal as `sessionVerificationRefused` and records it as ' +
  '`libraryLoginRefused`. `src/core/identity.js` keeps no copy of the step.\n' +
  '_Avoid_: hasJoined check, auth check\n'

// The facts a fixture tree answers with, in the shape facts() answers in: every name the
// three entries carry, and nothing else. Each case below changes one of them.
const FIXTURE = {
  identity: { reviewLoginStart () {} },
  check: { checkVerified () {} },
  leg: { setLoginStartHandler () {} },
  callIns: ['setLoginStartHandler'],
  metrics: ['sessionVerificationRefused', 'libraryLoginRefused'],
  login: 'yggdrasilServer.hasJoined(name, serverId, ...)\n  options.beforeLogin?.(client)\n',
  front: 'const server = mc.createServer({\n  beforeLogin: client => { handleBeforeLogin(client) }\n})\n',
  dependencies: ['minecraft-protocol'],
  coreIdentity: 'export function createFrontIdentity () {}\n'
}

// The glossary a pointer case starts from: one pair the fixture tree holds, and one path.
const POINTERS = 'The decision is `reviewLoginStart` in `src/core/identity.js`, and the leg is ' +
  '`src/legs/live-front.js`.\n'

// A fixture tree, in the shape tree answers in, so no case below touches the checkout.
// files is the whole tree a case offers: a path missing from it is a path that is not
// there, and a name missing from the text beside its path is a pair the module dropped.
const fixture = files => ({
  exists: name => name in files,
  holds: (file, symbol) => word(symbol).test(files[file] ?? '')
})

const POINTER_FILES = {
  'src/core/identity.js': 'export function createFrontIdentity () {\n  function reviewLoginStart () {}\n}\n',
  'src/legs/live-front.js': 'export function createOfflineFrontLeg () {}\n'
}

test('the guard found the three entries, the names they carry, and the code behind each', () => {
  // A comparison over empty sets passes every case below, so both halves of the surface are
  // named here: the three entries, and the code each name in the table resolves to.
  const found = facts()
  for (const term of Object.keys(COVERED)) {
    const headings = entry(GLOSSARY, term)
    assert.notEqual(headings, null, message.noEntry(term))
    assert.ok(headings.avoid.startsWith('_Avoid_:'), message.shape('GLOSSARY.md:' + headings.line, term))
  }
  // A name in the table with no probe behind it is a name that passes on its spelling, which
  // is #721 shape inside this guard. Every row is a path the sweep checks or a symbol a
  // probe answers for.
  for (const [term, required] of Object.entries(COVERED)) {
    for (const name of required) {
      assert.ok(MODULE.test(name) || HELD[name] !== undefined,
        term + ' requires ' + name + ', and no probe answers for it. A path is checked by the sweep, and ' +
        'every other name needs a row of HELD, or the entry would pass on its spelling alone.')
    }
  }
  for (const [name, held] of Object.entries(HELD)) {
    assert.ok(held.holds(found), 'this tree provides ' + name + ', which is one of the names the entries ' +
      'are compared on, and ' + held.from + ' is where it comes from')
  }
  assert.deepEqual(runOrder(found.login), STEPS, 'the installed library answers the session step first, ' +
    'which is the order every case below reads the entries against')
  assert.ok(found.metrics.length > 1, 'the offline front leg answers with its metrics, which is where the ' +
    'leg\'s own counters are read')
  // The sweeps: a case over no names is a case that passes.
  const modules = names(GLOSSARY).filter(name => MODULE.test(name))
  assert.ok(modules.length >= 3, 'the glossary backticks a module path, and this many are what the sweep reads')
  assert.ok([...GLOSSARY.matchAll(PAIR)].length > 0, 'the glossary writes an "X in Y" pair, which is the ' +
    'grammar the pair case reads')
})

test('the three entries say what the code does', () => {
  const found = drift(GLOSSARY, facts())
  assert.deepEqual(found, [],
    'GLOSSARY.md and the attach check disagree:\n  ' + found.join('\n  '))
})

test('every module path, and every name beside one, the glossary writes is one this tree holds', () => {
  const found = pointers(GLOSSARY, tree)
  assert.deepEqual(found, [], 'the glossary points at code that is not there:\n  ' + found.join('\n  '))
})

test('the fixture drifts nothing, and an entry that names no module is the drift #721 shipped', () => {
  assert.deepEqual(drift(BASE, FIXTURE), [], 'the fixture the cases below change drifts nothing itself')
  assert.deepEqual(pointers(POINTERS, fixture(POINTER_FILES)), [],
    'the pointer fixture the cases below change drifts nothing itself')

  // #721 text, in this fixture shape: the composite names the core and the leg as "the core"
  // and "the leg", and carries no path at all.
  const prose = BASE
    .replace('`src/core/identity.js` decides', 'the core decides')
    .replace('`src/legs/live-front.js` takes', 'the leg takes')
  assert.notEqual(prose, BASE, 'the fixture dropped both module paths')
  assert.deepEqual(drift(prose, FIXTURE), [message.noModule('GLOSSARY.md:1', 'Attach check')],
    'an entry that defines a step and names no module is a claim nothing can fail on, which is #721')
})

test('an entry that names one home and not the other is a finding', () => {
  const half = BASE.replace(' and session verification, which `src/legs/live-front.js` takes from its library', '')
  assert.notEqual(half, BASE, 'the fixture dropped the leg path and kept the session step named')
  assert.deepEqual(drift(half, FIXTURE), [
    message.missingName('GLOSSARY.md:1', 'src/legs/live-front.js', 'Attach check'),
    message.lostHome('GLOSSARY.md:1')
  ],
    'the composite is the entry for both halves, and a reader who follows it must reach both')
})

test('the step beside the wrong module is the finding', () => {
  // Both paths exist and both are named, so only the pairing can catch a composite that
  // hands each step to the other step's file.
  const swapped = BASE
    .replace('the whitelist review, which `src/core/identity.js` decides',
      'the whitelist review, which `src/legs/live-front.js` decides')
    .replace('and session verification, which `src/legs/live-front.js` takes',
      'and session verification, which `src/core/identity.js` takes')
  assert.notEqual(swapped, BASE, 'the fixture swapped the two modules')
  assert.deepEqual(drift(swapped, FIXTURE), [
    message.wrongHome('GLOSSARY.md:1', 'session verification', 'src/core/identity.js', 'src/legs/live-front.js'),
    message.wrongHome('GLOSSARY.md:1', 'whitelist review', 'src/legs/live-front.js', 'src/core/identity.js')
  ], 'a step beside the other step\'s file sends a reader to code that does not run it')
})

test('a name the code dropped is the finding, with its line', () => {
  // createAttachCheck still returns its check, and no longer returns checkVerified: the
  // rename this guard exists for, one member at a time.
  assert.deepEqual(drift(BASE, { ...FIXTURE, check: {} }),
    [message.unheldName('GLOSSARY.md:5', 'checkVerified', 'src/custody/attach.js')],
    'a name the code dropped leaves the entry pointing at a definition that is gone')
  // The same for the call-in, which is a row of the table and a member of the leg.
  assert.deepEqual(drift(BASE, { ...FIXTURE, callIns: [], leg: {} }),
    [message.unheldName('GLOSSARY.md:5', 'setLoginStartHandler', 'src/service/wire-leg-to-core.js')],
    'the call-in the entry names is both a declared row and a member the leg answers')
})

test('a pair that names another module is the finding', () => {
  // The name exists, and it does not live where the pair says. checkVerified is a member of
  // attach.js, and the leg only calls it.
  const moved = BASE.replace('`checkVerified` in `src/custody/attach.js`',
    '`checkVerified` in `src/legs/live-front.js`')
  assert.notEqual(moved, BASE, 'the fixture pointed the pair at another module')
  assert.deepEqual(drift(moved, FIXTURE), [
    message.missingName('GLOSSARY.md:5', 'src/custody/attach.js', 'Whitelist review'),
    message.wrongModule('GLOSSARY.md:5', 'checkVerified', 'src/legs/live-front.js', 'src/custody/attach.js')
  ], 'a pair that names a module the name does not live in sends the reader to the wrong file')
})

test('the order the entry states is the order the library runs', () => {
  // The library inverted: beforeLogin reached without hasJoined having answered first. The
  // entry still says the session step runs first, so one of the two moved, and the entry is
  // the one this guard reads.
  const inverted = { ...FIXTURE, login: 'options.beforeLogin?.(client)\n  yggdrasilServer.hasJoined(...)\n' }
  assert.deepEqual(drift(BASE, inverted),
    [message.wrongOrder('GLOSSARY.md:1', 'session verification', 'whitelist review')],
    'an installation whose login path reaches beforeLogin first is an entry whose order is backwards')

  // #721 sentence, in this fixture shape: "the whitelist review, then session verification".
  // It states an order, and a lane runs the other one.
  const before = BASE.replace('runs session verification first and the whitelist review second',
    'runs the whitelist review, then session verification')
  assert.notEqual(before, BASE, 'the fixture named the two steps in the wrong order')
  assert.deepEqual(drift(before, FIXTURE),
    [message.wrongOrder('GLOSSARY.md:1', 'whitelist review', 'session verification')],
    'the entry #721 shipped named the whitelist review first, and a lane runs the session step first')

  // An entry that defines both steps and never orders them states half of what #721 was
  // about, so a pass here would be a guard with nothing to compare.
  const unordered = BASE.replace(' An online lane runs session verification first and the whitelist review second.', '')
  assert.notEqual(unordered, BASE, 'the fixture dropped the sentence that orders the two steps')
  assert.deepEqual(drift(unordered, FIXTURE),
    [message.noOrder('GLOSSARY.md:1', 'session verification')],
    'an entry with no order leaves a reader to guess which step a login meets first')
})

test('a composite that names one step is half a check', () => {
  const one = BASE
    .replace('and session verification, which ', 'and the session step, which ')
    .replace('runs session verification first and the whitelist review second', 'runs the whitelist review second')
  assert.notEqual(one, BASE, 'the fixture dropped every mention of the session step from the composite')
  assert.deepEqual(drift(one, FIXTURE), [
    message.lostHome('GLOSSARY.md:1'),
    message.noSteps('GLOSSARY.md:1', ['session verification'])
  ],
    'the composite is the entry for both steps, and one named alone describes half a check')
})

test('the core that grows the step back is the finding', () => {
  // #721 deleted identity.verifySession, which no lane called. A file that names it again
  // makes the entry's last sentence false, and that sentence is the claim this case holds.
  assert.deepEqual(drift(BASE, { ...FIXTURE, coreIdentity: 'export function verifySession () {}\n' }),
    [message.coreCopy('GLOSSARY.md:9')],
    'the entry says the core keeps no copy of the session step, and that file names one')
})

test('a path that moved, and a pair the module dropped, are the two pointer findings', () => {
  const moved = { ...POINTER_FILES }
  delete moved['src/legs/live-front.js']
  assert.deepEqual(pointers(POINTERS, fixture(moved)),
    [message.unheldPath('GLOSSARY.md:1', 'src/legs/live-front.js')],
    'a module path the tree does not hold sends a reader to a file that is not there')

  const renamed = { ...POINTER_FILES, 'src/core/identity.js': 'export function createFrontIdentity () {}\n' }
  assert.deepEqual(pointers(POINTERS, fixture(renamed)),
    [message.unpaired('GLOSSARY.md:1', 'reviewLoginStart', 'src/core/identity.js')],
    'the glossary says where a name lives, and a module that no longer holds it sends the reader nowhere')
})
