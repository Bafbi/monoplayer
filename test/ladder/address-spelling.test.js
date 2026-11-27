// #889: one rule spells an address, and every record that prints one calls it.
//
// #815 gave the start record one spelling for a dialled address: a host holding a colon keeps
// its brackets, so the host and the port split back (\`src/core/picker.js\`, the rule
// \`canonicalPickName\` names a row with). It sits in \`src/service/start-live.js\` as
// \`addressName\`, which a leg cannot import without a service-to-leg dependency, so two
// writers kept joining a host and a port with a colon and nothing else: the claim landing's
// record, and the offline rung's \`backendReconnect\`. The parity runner's two joins are the
// same defect, and the ticket's own comment names them. The rule now lives in
// \`src/core/picker.js\`, and all four sites call it.
//
// The records are object literals inside long files, so each case reads the text the file writes
// and not the record it builds. \`test/legs/picker-click-routing.test.js\` reads what a claim
// landing actually logs; this file reads the rule and the three rung-side sites.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { addressName, pickerRows, pickTarget } from '../../src/core/picker.js'
import { blockAfter, callSpans, signatureSpan } from '../support/source-scan.js'

// An IPv4 address cannot see this defect: it holds one colon, so \`host + ':' + port\` reads
// back. An IPv6 host holds several, and the port is only separable while the brackets are there.
const IPV6 = { host: '2001:db8::1', port: 25565 }
const WRITTEN = '[2001:db8::1]:25565'
// The spelling the rule replaces, so a case that still gets it says which defect it is.
const RUN_TOGETHER = '2001:db8::1:25565'

const read = path => fs.readFileSync(new URL('../../' + path, import.meta.url), 'utf8')

test('#889 the rule brackets a host that holds a colon, so the port splits back', () => {
  assert.equal(addressName(IPV6.host, IPV6.port), WRITTEN,
    'an IPv6 host keeps its brackets, or the host and the port run together')
  assert.deepEqual(pickTarget(addressName(IPV6.host, IPV6.port)), { host: IPV6.host, port: IPV6.port },
    'and what the rule writes, the picker reads back as the address it dials')
})

test('#889 a host that needs no bracket is written as it always was', () => {
  assert.equal(addressName('127.0.0.1', 25565), '127.0.0.1:25565', 'an IPv4 host has one colon')
  assert.equal(addressName('paper.monoplayer-gate-b.svc.cluster.local', 25565),
    'paper.monoplayer-gate-b.svc.cluster.local:25565', 'and so does a name')
  assert.equal(addressName('[2001:db8::1]', 25565), WRITTEN,
    'a host already bracketed is not bracketed twice, so the rule is safe to call on its own output')
})

test('#889 the picker names a row with the rule and spells no bracket of its own', () => {
  const source = read('src/core/picker.js')
  const rule = blockAfter(source, 'export function addressName', 'the address rule in src/core/picker.js')
  assert.match(rule.body, /indexOf\(':'\)/, 'the rule is where a host is judged to need brackets')
  // The rest of the file, with the rule taken out: a second place that brackets a host is the
  // re-spelling this ticket is about, and every case above reads green through the first one.
  const outside = source.slice(0, rule.open) + source.slice(rule.close + 1)
  assert.doesNotMatch(outside, /indexOf\(':'\)/, 'one place decides the bracket, and it is the rule')
  assert.doesNotMatch(outside, /\+'\[' \+ |'\[' \+ host/, 'and nothing outside it brackets a host')

  const named = signatureSpan(source, 'function canonicalPickName', 'canonicalPickName in src/core/picker.js')
  assert.match(named.body, /addressName\(target\.host, target\.port\)/,
    'the picker names a row by calling the rule, not by spelling the same brackets again')
  // The rule is the name a caller outside the picker uses, so it is exported and calls nothing
  // that a leg cannot reach.
  assert.match(source, /export function addressName \(/, 'the rule is exported')
  assert.equal(pickerRows([{ name: RUN_TOGETHER }])[0].name, WRITTEN,
    'a row handed over in the spelling the rule replaces is offered in the rule\'s spelling')
})

// The rung and the parity runner are the two writers the ticket names. Both records are
// object literals inside one long file, so the scan reads the literal and the file's own
// \`log(\` calls rather than a run: neither file runs in the unit gate.
test('#889 the offline rung\'s backendReconnect prints the address with the rule', () => {
  const source = read('src/ladder/loopback.js')
  const record = blockAfter(source, "log('backendReconnect', {", "the offline rung's backendReconnect record")
  assert.match(record.body, /addressName\(target\.host, target\.port\)/,
    'the record spells the address it dialled with the one rule')
  assert.doesNotMatch(record.body, /target\.host \+ ':' \+ target\.port|\`\$\{target\.host\}:\$\{target\.port\}\`/,
    'and joins nothing itself, in either spelling')

  // A record added tomorrow that joins an address itself fails here too, so the scan runs over
  // every record the file logs rather than over that one marker.
  const calls = [...callSpans(source, 'log'), ...callSpans(source, 'event')]
  for (const site of calls) {
    const literal = site.args.join(',')
    assert.doesNotMatch(literal,
      /\.host \+ ':' \+ [^,\n]*port|\$\{[^\`}]*\.host\}:\$\{[^\`}]*\.port\}/,
      'the record at byte ' + site.at + ' joins a host and a port itself, which is the second spelling')
  }
})

test('#889 the parity runner joins its endpoints with the rule', () => {
  const source = read('src/ladder/client-parity.js')
  const join = signatureSpan(source, 'function joinEndpoint', 'joinEndpoint in src/ladder/client-parity.js')
  assert.match(join.body, /addressName\(host, port\)/,
    'the endpoint it builds from a host and a port is the rule\'s spelling')
  const started = signatureSpan(source, 'function startJoin', 'startJoin in src/ladder/client-parity.js')
  assert.match(started.body, /endpoint: addressName\(host, port\)/,
    'and the endpoint the report prints is the same spelling')
  assert.doesNotMatch(source, /host \+ ':' \+ port/,
    'no site in the file joins a host and a port itself')
})
