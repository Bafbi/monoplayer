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
//     "facts": { "<puppet name>": { ...what GET /api/puppets/<name> returned... } },
//     "whitelist": { "<puppet name>": { "resourceVersion": "41221",
//                                       "puppetUuid": "…",
//                                       "document": { "version": 1, "players": [...] } } }
//   }
//
// The puppets are checked by src/panel/registry.js itself, so a fixture cannot
// describe a puppet the panel would refuse in a pod, and the whitelist document is
// checked by src/panel/routes/whitelist.js, so a fixture cannot hold an attach
// whitelist the route would refuse to rewrite. Every field it does not name is
// refused, by name: a typo that is silently ignored is a fixture that renders
// something other than what its author meant.
//
// It is re-read on every request, like the registry, and that is a feature: an
// edit to the file reaches an open page on its next tick, which is how the stream
// is shown to update rather than assumed to.
//
// `createFixtureClient` is the other half: the recording served through the methods a
// Kubernetes client has, so the whitelist block reads a document the panel parses and
// renders exactly as it would in a pod. Writes are refused there, by name, because a
// recording is not a cluster and a fixture that silently accepted one would be a page
// claiming a write that never happened.
import fs from 'node:fs'

import { WriteRefused } from './kube.js'
import { parseRegistry } from './registry.js'
import { parseWhitelist, WHITELIST_KEY } from './routes/whitelist.js'

export const FIXTURE_FIELDS = ['facts', 'puppets', 'version', 'whitelist']
// One recorded attach whitelist: the document the route writes, the version it was read
// at, and the puppet's own account uuid, which the route's rule compares against.
export const WHITELIST_FIELDS = ['document', 'puppetUuid', 'resourceVersion']

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
  if (!isObject(doc.whitelist)) {
    throw new Error('fixture: whitelist must be an object keyed by puppet name, so the attach block has a list to show')
  }
  const whitelists = new Map()
  for (const puppet of registry.puppets) {
    const recorded = doc.whitelist[puppet.name]
    if (!isObject(recorded)) {
      throw new Error('fixture: whitelist has no entry for ' + quote(puppet.name) +
        '; the page reads the attach whitelist of every puppet it draws')
    }
    // Every field this record may hold, refused by name when it holds another. A typo
    // like puppetUUID would otherwise be a recording that names no puppet account, and
    // the panel would say "the Deployment names no MONOPLAYER_PUPPET_UUID" about a file
    // that names it under the wrong spelling.
    for (const key of Object.keys(recorded)) {
      if (!WHITELIST_FIELDS.includes(key)) {
        throw new Error('fixture: whitelist[' + quote(puppet.name) + '] has the unknown key ' + quote(key) +
          '; one of ' + WHITELIST_FIELDS.join(', ') + ' is expected')
      }
    }
    const parsed = parseWhitelist(JSON.stringify(recorded.document))
    if (parsed.failure) {
      throw new Error('fixture: whitelist[' + quote(puppet.name) + '].document: ' + parsed.failure)
    }
    if (recorded.resourceVersion !== undefined && typeof recorded.resourceVersion !== 'string') {
      throw new Error('fixture: whitelist[' + quote(puppet.name) + '].resourceVersion must be a string')
    }
    if (recorded.puppetUuid !== undefined && typeof recorded.puppetUuid !== 'string') {
      throw new Error('fixture: whitelist[' + quote(puppet.name) + '].puppetUuid must be a string')
    }
    whitelists.set(puppet.name, {
      document: parsed.document,
      resourceVersion: recorded.resourceVersion ?? null,
      puppetUuid: recorded.puppetUuid ?? null
    })
  }
  for (const key of Object.keys(doc.whitelist)) {
    if (!names.has(key)) {
      throw new Error('fixture: whitelist has an entry for ' + quote(key) + ', which no puppet in the document names')
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
  return { registry, facts, whitelists }
}

// The recording, read on every call so an edit to the file reaches an open page.
export function fixtureReader (file) {
  const load = () => {
    let text
    try {
      text = fs.readFileSync(file, 'utf8')
    } catch (error) {
      throw new Error('fixture: cannot read ' + file + ': ' + error.message)
    }
    return parseFixture(text)
  }
  return { load, registry: () => load().registry, facts: name => load().facts.get(name) ?? null }
}

// The recorded documents, through the methods the panel's client has. A fixture is a
// recording, so `patchConfigMapKey` refuses: a page that reported a write no cluster
// saw would be the exact failure this page exists to prevent.
//
// `lookup` answers null, which is what the name resolver answers when it can reach
// nothing: a name in a fixture comes back as the route's 400 asking for the uuid, which
// is the instruction the block has to render, and no recording can invent a real one.
export function createFixtureClient (load) {
  const entryFor = (namespace, name, field) => {
    const document = load()
    const puppet = document.registry.puppets.find(row =>
      row.namespace === namespace && (field === 'configMap' ? row.controlConfigMap : row.deployment) === name)
    if (puppet === undefined) {
      throw new Error('fixture: no recorded puppet owns ' + namespace + '/' + name)
    }
    return { puppet, recorded: document.whitelists.get(puppet.name) ?? null }
  }

  return {
    async configMap (namespace, name) {
      const { recorded } = entryFor(namespace, name, 'configMap')
      if (recorded === null) throw new Error('fixture: no recorded attach whitelist for ' + namespace + '/' + name)
      return {
        metadata: recorded.resourceVersion === null ? {} : { resourceVersion: recorded.resourceVersion },
        data: { [WHITELIST_KEY]: JSON.stringify(recorded.document, null, 2) + '\n' }
      }
    },
    async deployment (namespace, name) {
      const { recorded } = entryFor(namespace, name, 'deployment')
      const env = recorded?.puppetUuid === null || recorded?.puppetUuid === undefined
        ? []
        : [{ name: 'MONOPLAYER_PUPPET_UUID', value: recorded.puppetUuid }]
      return {
        spec: {
          selector: { matchLabels: { app: 'monoplayer' } },
          template: { spec: { containers: [{ name: 'monoplayer', env }] } }
        }
      }
    },
    async patchConfigMapKey () {
      throw new WriteRefused('fixture mode is a recording, so no document was written. Start the panel against a cluster to write one', { status: 0 })
    }
  }
}

export async function lookupNothing () {
  return null
}
