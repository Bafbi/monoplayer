// The recorded document that stands in for a cluster, for --fixture (#248).
//
// A branch has to be reviewable before it is merged, and a screenshot of a page
// that reads a cluster nobody can reach proves nothing. This file is the document
// a panel is started from instead: the puppets it serves, and for each of them the
// facts GET /api/puppets/<name> answered when the recording was made.
//
// The shape, and each part of it is validated:
//
//   {
//     "version": 1,
//     "puppets": [ ...the registry rows, exactly as the registry validates them... ],
//     "facts": { "<puppet name>": { ...what GET /api/puppets/<name> returned... } }
//   }
//
// The puppets are checked by src/panel/registry.js itself, so a fixture cannot
// describe a puppet the panel would refuse in a pod. Every field it does not name
// is refused, by name: a typo that is silently ignored is a fixture that renders
// something other than what its author meant.
//
// It is re-read on every request, like the registry, and that is a feature: an
// edit to the file reaches an open page on its next tick, which is how the stream
// is shown to update rather than assumed to.
import { parseRegistry } from './registry.js'

export const FIXTURE_FIELDS = ['facts', 'puppets', 'version']

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const quote = value => JSON.stringify(value ?? null)

export function parseFixture (text) {
  let doc
  try {
    doc = JSON.parse(String(text))
  } catch (error) {
    throw new Error('fixture: not JSON: ' + error.message)
  }
  if (!isObject(doc)) throw new Error('fixture: the document is not an object')
  for (const key of Object.keys(doc)) {
    if (!FIXTURE_FIELDS.includes(key)) {
      throw new Error('fixture: the document has the unknown key ' + quote(key) +
        '; one of ' + FIXTURE_FIELDS.join(', ') + ' is expected')
    }
  }
  if (!isObject(doc.facts)) throw new Error('fixture: facts must be an object keyed by puppet name')

  // The registry document is the puppets list and its version, so it is validated
  // by the same function a pod uses. A fixture that disagrees with the panel's own
  // rules is refused here rather than rendered and doubted later.
  let registry
  try {
    registry = parseRegistry(JSON.stringify({ version: doc.version, puppets: doc.puppets }))
  } catch (error) {
    throw new Error('fixture: ' + String(error?.message ?? error).replace(/^registry: /, ''))
  }

  const names = new Set(registry.puppets.map(puppet => puppet.name))
  for (const key of Object.keys(doc.facts)) {
    if (!names.has(key)) {
      throw new Error('fixture: facts has an entry for ' + quote(key) + ', which no puppet in the document names')
    }
  }
  const facts = new Map()
  for (const puppet of registry.puppets) {
    const recorded = doc.facts[puppet.name]
    if (!isObject(recorded)) {
      throw new Error('fixture: facts has no recorded document for ' + quote(puppet.name) +
        '; every puppet in the fixture needs one, or its card would be blank')
    }
    if (recorded.name !== puppet.name) {
      throw new Error('fixture: facts[' + quote(puppet.name) + '].name is ' + quote(recorded.name) +
        ', and a recorded document is the one that puppet answered')
    }
    if (!isObject(recorded.state) || typeof recorded.state.state !== 'string' || typeof recorded.state.reason !== 'string') {
      throw new Error('fixture: facts[' + quote(puppet.name) + '] has no state sentence; ' +
        'the page renders state.state and state.reason, and a fixture without them proves nothing')
    }
    facts.set(puppet.name, recorded)
  }
  return { registry, facts }
}
