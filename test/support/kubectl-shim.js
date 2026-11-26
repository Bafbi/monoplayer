// The strict kubectl a tooling test puts on PATH (#152). A test that drives one of
// the scripts under scripts/ replaces kubectl with a fake, so a case can run an
// argv and read what the script asked for without a cluster. A fake that answers an
// argv it does not model reports a pass for a call the cluster would refuse, and
// that is the defect this module exists to make impossible.
//
// Three properties, all owned here rather than repeated in each test file:
//
// - a call no rule models fails, prints the argv it saw, and exits 111. It also
//   appends that argv to the log's `.unmodelled` sibling, so a case whose script
//   swallowed the status still fails on the record.
// - a rule must say what it answers. `ns` puts `-n <ns>` in front of the rule's
//   words, so a script that drops `-n "$NAMESPACE"` matches nothing: the rule is
//   the namespace and the words, never the words alone. A cluster-scoped call says
//   `cluster: '<reason>'` instead, so the reason is read by whoever adds the next
//   arm. `ns` takes one namespace or a list: a case that names a lane as an argument
//   makes that lane a namespace the shim is asked about, and each is matched as
//   itself rather than as "any namespace".
//
// Matching is on argv words, not on the joined string. A token holding a space is
// one word here, so `-p '{"a": 1}'` cannot match a rule that names `-p` and a
// different body. `ANY` is one word nobody named, `REST` is the tail of an argv a
// rule does not read, and `endingWith` is one word with a fixed suffix: the three
// holes a rule may declare, and every one of them is visible where it is used.
//
// - every rule a test file declares is reached by one of its cases (`deadRules`), so an
//   arm no case reaches is a failure rather than a comment nobody reads.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on
// its own. `test/tooling/kubectl-shim.test.js` is where this module's own cases
// live, and it is the file that keeps the two properties above true.
import fs from 'node:fs'

// One argv word the rule does not read: a payload such as `--timeout=90s`, a
// jsonpath, or the script `node -e` is handed. The count and the order stay exact,
// so the words a rule varies are the words it names with this.
export const ANY = Symbol('any one word')

// Zero or more words at the end of an argv: the payload an `exec` hands a program, or
// the flags a `cp` does not read. Only the last word of a rule, and never the whole
// rule: the call up to here is the call the arm names, and the tail is what the arm
// does not read.
export const REST = Symbol('the rest of the words')

// One word that ends with exactly this text. The case it exists for is a path a pod name
// prefixes: `<pod>:/work/online-report.json` is one argv word, and the pod name is
// generated per run. The suffix is a whole path, so the word still says which call it
// is; a word that merely contains a substring is not something this module offers.
export const endingWith = text => ({ endsWith: String(text) })

const shellWord = value => "'" + String(value).replace(/'/g, "'\\''") + "'"

// One rule's dispatch. The guard compares words and their count, so the order and
// the number of the words are both exact.
function emitRule (rule, index) {
  // A rule may answer whatever namespace the call carries, for a script whose subject is
  // namespaces other than its own — the reaper reads the lanes a case names. That is a
  // choice with a reason, so `why` is required: the flag is still part of the call, and
  // a call that loses `-n` matches nothing.
  if (rule.ns === ANY && typeof rule.why !== 'string') {
    throw new Error('kubectl shim: rule ' + index + ' answers any namespace without a why: ' + JSON.stringify(rule.match))
  }
  // `-n` is not always first: `kubectl apply -n X -f -` puts it after the verb. `at`
  // says where the flag goes, and it is still the rule's own words, so a call that
  // loses the flag matches nothing.
  const at = rule.at ?? 0
  const words = rule.ns === undefined
    ? [...rule.match]
    : [...rule.match.slice(0, at), '-n', rule.ns === ANY ? ANY : rule.ns, ...rule.match.slice(at)]
  const rest = words[words.length - 1] === REST
  if (rest && words.length < 3) {
    throw new Error('kubectl shim: rule ' + index + ' ends in REST after fewer than three words: ' + JSON.stringify(words))
  }
  if (rest) words.pop()
  for (const word of words) {
    if (word === REST) throw new Error('kubectl shim: REST must be the last word of rule ' + index)
  }
  // The count is exact: a rule answers an argv of the words it names, no more and no
  // fewer. A hole is written ANY, so the words a call may vary are the words the arm
  // says it tolerates.
  const terms = [rest ? '[ "$n" -ge ' + words.length + ' ]' : '[ "$n" -eq ' + words.length + ' ]']
  words.forEach((word, slot) => {
    // Braced: `$10` is `${1}0`, so an unbraced positional makes every rule past
    // the ninth word test the wrong argv.
    if (word === ANY) return
    const position = '${' + (slot + 1) + '}'
    if (word !== null && typeof word === 'object' && typeof word.endsWith === 'string') {
      // The suffix goes in bare: quotes inside a parameter expansion's pattern stop it
      // matching. That means a glob character in one would match more than a suffix, so a
      // suffix holding one is refused at build.
      if (/[*?[\]]/.test(word.endsWith)) {
        throw new Error('kubectl shim: endingWith takes a literal suffix, not a pattern: ' + word.endsWith)
      }
      terms.push('[ "' + position + '" != "${' + (slot + 1) + '%' + word.endsWith + '}" ]')
      return
    }
    terms.push('[ "' + position + '" = ' + shellWord(word) + ' ]')
  })
  // A rule that carries no namespace has to say why, so an arm cannot leave it out
  // by forgetting it.
  if (rule.ns === undefined && typeof rule.cluster !== 'string') {
    throw new Error('kubectl shim: rule ' + index + ' names no ns and no cluster reason: ' + JSON.stringify(words))
  }
  if (typeof rule.cluster === 'string' && rule.cluster.trim() === '') {
    throw new Error('kubectl shim: rule ' + index + ' has an empty cluster reason')
  }
  // A body that does not exit falls through to the rule after it, so the arm stops
  // meaning what it says. Refused at build instead of answered at run.
  const lines = String(rule.body).trimEnd().split('\n')
  if (!/\bexit\s+\S+\s*$/.test(lines[lines.length - 1])) {
    throw new Error('kubectl shim: rule ' + index + ' does not end in exit: ' + JSON.stringify(rule.match))
  }
  return [
    'if ' + terms.join(' && ') + '; then',
    "  [ -n \"$KUBECTL_HITS\" ] && printf '%s\\n' " + shellWord('r' + rule.of) + ' >> "$KUBECTL_HITS"',
    ...lines.map(line => '  ' + line),
    'fi'
  ].join('\n')
}

// The whole fake kubectl. `prelude` is the test file's own shell: the state files it
// reads, the helper functions its bodies call, and the trace it prints. It runs
// after the argv is logged and before any rule, so a body can rely on it.
export function kubectlShim (rules, { prelude = [] } = {}) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('kubectl shim: no rules')
  // A rule that answers more than one namespace names each of them, so the lanes a
  // case can pass as an argument are honest about it and no arm answers "any". One
  // dispatch per namespace, and each records the rule it came from.
  const declared = rules.length
  const dispatches = rules.flatMap((rule, of) => Array.isArray(rule.ns)
    ? rule.ns.map(ns => ({ ...rule, ns, of }))
    : [{ ...rule, of }])
  dispatches.forEach((rule, index) => {
    if (!Array.isArray(rule.match) || rule.match.length === 0) {
      throw new Error('kubectl shim: rule ' + index + ' names no words')
    }
    if (typeof rule.body !== 'string' || rule.body.trim() === '') {
      throw new Error('kubectl shim: rule ' + index + ' has no body: ' + JSON.stringify(rule.match))
    }
  })
  const script = [
    '#!/usr/bin/env bash',
    // Every call, in order, whatever answers it: the guarantees the cases make are
    // made of this record.
    "printf '%s\\n' \"$*\" >> \"$KUBECTL_LOG\"",
    'n=$#',
    ...prelude,
    ...dispatches.map(emitRule),
    // Nothing modelled this call. Say which, and fail: a script under `set -e` stops
    // here, and a case that reads the log finds the argv even when it did not.
    "printf 'kubectl shim: unmodelled argv: %s\\n' \"$*\" >&2",
    "printf '%s\\n' \"$*\" >> \"$KUBECTL_LOG.unmodelled\"",
    'exit 111',
    ''
  ].join('\n')
  // The id a hit records is the rule as declared, not the dispatch: a rule that answers
  // three lanes is one arm, and a case that uses one lane still reached it.
  return { script, ids: Array.from({ length: declared }, (rule, index) => 'r' + index) }
}

// The rules a test file's cases never reached, by id. A rule no case reaches models a
// call the script no longer makes, or a case is missing for one it does; both are the
// drift this module is for, so every converted file ends with a case that fails on a
// non-empty list.
export function deadRules (hits, ids) {
  const fired = new Set(fs.existsSync(hits) ? fs.readFileSync(hits, 'utf8').trim().split('\n').filter(Boolean) : [])
  return ids.filter(id => !fired.has(id))
}

// The argv the shim refused, in call order. A case asserts this is empty, so a
// script that swallowed the status still fails.
export function unmodelled (log) {
  const file = log + '.unmodelled'
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean)
}
