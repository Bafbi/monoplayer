// #891: a front or backend address is a host and a port, and loadConfig refuses one
// this service cannot bind or dial. Every other key it validates was checked, and the
// four address keys were not, so a mistyped MONOPLAYER_BACKEND_HOST started a service
// that could not connect and said nothing until a client tried.
//
// The rule loadConfig applies is the record's (#815): an address is a host and a port,
// and a record spells the pair `host:port` with an IPv6 host in brackets. Config takes
// the two apart, so the host it accepts is the one the socket layer takes — bare — and
// the port is the integer beside it. The round-trip case at the end holds the two rules
// together: an address config accepts is one a record can print and split back.
//
// What is not asked here is whether the host resolves. A DNS query in a config loader
// would make the service refuse to start on a backend that is coming back up, and the
// leg already retries. The shape is the whole question (#891).
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_CONFIG, loadConfig } from '../../src/service/monoplayer.js'
import { addressName, pickTarget } from '../../src/core/picker.js'

// A document that is right everywhere but the key a case moves, so a throw names the
// case and not a neighbour.
const config = doc => loadConfig({
  front: { host: '127.0.0.1', port: 25565 },
  backend: { host: '127.0.0.1', port: 25565 },
  ...doc
})

const refuses = (fn, pattern, why) => assert.throws(fn, error => {
  assert.match(error.message, pattern)
  return error instanceof TypeError
}, why)

test('#891 loadConfig refuses a host that is not a host', () => {
  for (const section of ['front', 'backend']) {
    for (const [bad, reason] of [
      ['', /must be a host/],
      ['   ', /must be a host/],
      [' paper.monoplayer-dev.svc.cluster.local', /no surrounding space/],
      ['play2.excalia.fr ', /no surrounding space/],
      ['play2 excalia.fr', /no space/],
      ['http://play2.excalia.fr', /no scheme and no path/],
      ['play2.excalia.fr/25565', /no scheme and no path/],
      [null, /must be a host/],
      [42, /must be a host/],
      // The record's spelling is not the config's: a bracket carries a host:port
      // string, and the socket takes the host without one.
      ['[::1]', /no brackets/],
      ['[2001:db8::1]:25565', /no brackets/],
      // A colon is either an IPv6 address or the start of the port a neighbour key
      // holds. Anything else is the run-together address #815 is about.
      ['play2.excalia.fr:25565', /no port/],
      ['play2.excalia.fr:', /no port/],
      ['2001:db8::1:25565:', /no port/]
    ]) {
      refuses(() => config({ [section]: { host: bad } }),
        new RegExp('config\\.' + section + '\\.host'), section + ' host ' + JSON.stringify(bad))
      refuses(() => config({ [section]: { host: bad } }),
        reason, section + ' host ' + JSON.stringify(bad) + ' is refused for its shape')
    }
  }
})

test('#891 loadConfig names the value it refused, so an operator reads the typo', () => {
  refuses(() => config({ backend: { host: 'play2.excalia.fr:25565' } }),
    /got "play2\.excalia\.fr:25565"/, 'the message carries the value that was set')
  refuses(() => config({ front: { port: '2556O' } }), /got "2556O"/,
    'and a port that is not a number reads as the text that produced it')
})

test('#891 loadConfig refuses a port that is not an integer in its range', () => {
  // The front's floor is 0 and the backend's is 1, so a port no socket can dial is
  // refused where it would be dialled and allowed where it asks for a free one.
  for (const section of ['front', 'backend']) {
    const floor = section === 'front' ? 0 : 1
    for (const bad of [undefined, NaN, '25565', 25565.5, null, -1, 70000, -0.5]) {
      refuses(() => config({ [section]: { port: bad } }),
        new RegExp('config\\.' + section + '\\.port must be an integer from ' + floor + ' to 65535'),
        section + ' port ' + String(bad))
    }
  }
  refuses(() => config({ backend: { port: 0 } }),
    /config\.backend\.port must be an integer from 1 to 65535/,
    'a dial to port 0 reaches nothing, whatever the OS makes of a bind to it')
})

test('#891 the defaults still load, so the rule refuses only what is set', () => {
  const cfg = loadConfig()
  assert.deepEqual(cfg.front, { ...DEFAULT_CONFIG.front }, 'an unset document keeps the compiled front')
  assert.deepEqual(cfg.backend, { ...DEFAULT_CONFIG.backend }, 'and the compiled backend')
})

test('#891 the front may ask the OS for a port, and that is the one 0', () => {
  // The offline rung and the parity lane bind an ephemeral front (src/ladder/loopback.js),
  // so a config that refuses 0 would refuse the gate's own lane. A listener on 0 answers
  // with the port it took; a dialler on 0 reaches nothing, which is the case above.
  assert.equal(loadConfig({ front: { port: 0 } }).front.port, 0)
})

test('#891 loadConfig accepts an address of each family', () => {
  for (const [host, port] of [
    ['127.0.0.1', 25565],
    ['0.0.0.0', 25565],
    ['play2.excalia.fr', 25565],
    ['paper.monoplayer-dev.svc.cluster.local', 25565],
    ['2001:db8::1', 25565],
    ['::1', 1],
    ['::', 65535]
  ]) {
    const cfg = loadConfig({ front: { host, port }, backend: { host, port } })
    assert.equal(cfg.front.host, host, 'the front keeps the host it was given')
    assert.equal(cfg.front.port, port)
    assert.equal(cfg.backend.host, host, 'and so does the backend')
    assert.equal(cfg.backend.port, port)
  }
})

test('#891 an address loadConfig accepts is one a record can split back', () => {
  // #815's rule is what a record prints, and this is the other end of it: the config
  // accepts a host and a port, the record writes them as one address, and a reader that
  // parses that address back gets the pair the config asked for. A host that no record
  // could spell is refused above; this holds the two rules to each other.
  for (const host of ['127.0.0.1', '0.0.0.0', 'play2.excalia.fr', '2001:db8::1', '::1', '::']) {
    for (const port of [1, 25565, 65535]) {
      const cfg = loadConfig({ backend: { host, port } })
      assert.deepEqual(pickTarget(addressName(cfg.backend.host, cfg.backend.port)), { host, port },
        host + ':' + port + ' survives the spelling a record prints')
    }
  }
})

test('#891 an ephemeral front still prints an address a reader can split', () => {
  // 0 is the one accepted port the picker declines to dial, and a name it declines is
  // offered as written. #891 was filed on exactly that: the start record wrote
  // `2001:db8::1:0`, where nothing tells the host from the port. The config accepts 0
  // because a bind asks the OS for a port, so the spelling has to carry it.
  for (const host of ['127.0.0.1', 'play2.excalia.fr', '2001:db8::1', '::1']) {
    const cfg = loadConfig({ front: { host, port: 0 } })
    const spelled = addressName(cfg.front.host, cfg.front.port)
    const split = spelled.lastIndexOf(':')
    assert.equal(spelled.slice(split + 1), '0', host + ':0 keeps its port in the tail: ' + spelled)
    assert.equal(spelled.slice(0, split), host.includes(':') ? '[' + host + ']' : host,
      host + ':0 keeps its host on the left, bracketed where a record brackets one: ' + spelled)
  }
})
