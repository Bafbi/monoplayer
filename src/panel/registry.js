// The registry: the puppets the panel may touch, and the only objects it may
// write.
//
// It is a ConfigMap in Git (deploy/panel/registry.yaml), not a discovery step.
// The panel never lists pods to find work: the list it can act on is the list a
// reviewer reads in the diff. The RBAC in deploy/panel/role.yaml is checked
// against this document by test/tooling/panel-manifests.test.js, so a write
// target the panel can name and a write target the cluster allows are the same
// set or the gate is red.
//
// Two readers read this through one function. The pod mounts the ConfigMap, so
// it reads one file of JSON (the ConfigMap's `puppets.json` key, which the kubelet
// projects as that file). A checkout, and the guard test, have the ConfigMap
// itself. `registryDocument` accepts either, so a manifest edit and a pod start
// cannot disagree about what the panel may write.
//
// Every rejection below names the field that broke it. The alternative is a
// document that parses and then writes to `undefined` in the one place where the
// failure looks like the cluster's fault.

export const REGISTRY_KEY = 'puppets.json'

// Alphabetical, so the message that lists the expected fields reads the same
// wherever it is printed.
const FIELDS = ['allowBackendSwitch', 'backend', 'controlConfigMap', 'deployment', 'frontHostname', 'name', 'namespace']

// A name the API server accepts for a namespace, a Deployment, or a ConfigMap.
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
// A hostname with at least two labels: no scheme, no port, no trailing dot.
const HOSTNAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)+$/
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/

const quote = value => JSON.stringify(value ?? null)

// A host a dial can target: a DNS name of at least two labels with no scheme, no
// port and no trailing dot, or an IPv4 literal. Exported because the write route
// (#233) accepts the same two shapes in a request body, and a second rule would
// drift from this one.
export function isTargetHost (value) {
  return typeof value === 'string' && (HOSTNAME.test(value) || IPV4.test(value))
}

// The JSON text inside the document, from either shape. A bare JSON document is
// returned as it arrived, so a mounted `puppets.json` costs no branch at the call
// site.
export function registryDocument (text) {
  if (typeof text !== 'string') throw new Error('registry: the document is not text')
  if (text.trimStart().startsWith('{')) return text

  const lines = text.split('\n')
  const key = new RegExp('^(\\s+)' + REGISTRY_KEY.replace('.', '\\.') + ':\\s*\\|\\s*$')
  const start = lines.findIndex(line => key.test(line))
  if (start === -1) {
    throw new Error('registry: the document is neither JSON nor a ConfigMap with a ' +
      REGISTRY_KEY + ' block')
  }
  const keyIndent = lines[start].match(key)[1].length

  // The block runs until a line dedents to the key's own level. A block is
  // indented deeper than its key; the kubelet writes the same bytes it holds.
  const body = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (line.trim() === '') { body.push(''); continue }
    if (line.length - line.trimStart().length <= keyIndent) break
    body.push(line)
  }
  while (body.length > 0 && body[body.length - 1] === '') body.pop()
  const content = body.filter(line => line.trim() !== '')
  if (content.length === 0) throw new Error('registry: the ' + REGISTRY_KEY + ' block is empty')
  const dedent = Math.min(...content.map(line => line.length - line.trimStart().length))
  return body.map(line => line.slice(dedent)).join('\n')
}

export function parseRegistry (text) {
  const json = registryDocument(text)
  let doc
  try {
    doc = JSON.parse(json)
  } catch (error) {
    throw new Error('registry: not JSON: ' + error.message)
  }
  return validate(doc)
}

function validate (doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('registry: the document is not an object')
  }
  if (doc.version !== 1) throw new Error('registry: version must be 1, not ' + quote(doc.version))
  for (const key of Object.keys(doc)) {
    if (key !== 'version' && key !== 'puppets') {
      throw new Error('registry: the document has an unknown key ' + key + ', version and puppets are expected')
    }
  }
  if (!Array.isArray(doc.puppets)) throw new Error('registry: puppets must be a list of puppets')
  if (doc.puppets.length === 0) throw new Error('registry: puppets is empty, so the panel serves nothing')

  const names = new Set()
  const targets = new Set()
  const puppets = doc.puppets.map((entry, index) => puppet(entry, index, { names, targets }))
  return { version: 1, puppets }
}

function puppet (entry, index, seen) {
  const where = 'puppets[' + index + ']'
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error('registry: ' + where + ' is not an object')
  }
  for (const key of Object.keys(entry)) {
    if (!FIELDS.includes(key)) {
      throw new Error('registry: ' + where + ' has the unknown key ' + quote(key) +
        '; one of ' + FIELDS.join(', ') + ' is expected')
    }
  }
  for (const key of FIELDS) {
    if (!(key in entry)) throw new Error('registry: ' + where + ' has no ' + key)
  }
  // The four names the API server must accept, because three of them are the
  // address of an object and the fourth names the puppet.
  for (const key of ['name', 'namespace', 'deployment', 'controlConfigMap']) {
    const value = entry[key]
    if (typeof value !== 'string' || value.length > 63 || !DNS_LABEL.test(value)) {
      throw new Error('registry: ' + where + '.' + key + ' must be a lowercase DNS label of at most 63 characters, not ' + quote(value))
    }
  }
  if (typeof entry.frontHostname !== 'string' || !HOSTNAME.test(entry.frontHostname)) {
    throw new Error('registry: ' + where + '.frontHostname must be a hostname with no scheme and no port, not ' + quote(entry.frontHostname))
  }
  const backend = hostPort(entry.backend, where + '.backend')
  // #233: whether the panel may ask this puppet to move. It is not the fence:
  // the puppet's own `control.allowBackendSwitch` decides whether it obeys, and
  // this value only decides whether the panel writes the request at all
  // (docs/panel.md).
  if (typeof entry.allowBackendSwitch !== 'boolean') {
    throw new Error('registry: ' + where + '.allowBackendSwitch must be true or false, not ' +
      quote(entry.allowBackendSwitch))
  }

  if (seen.names.has(entry.name)) {
    throw new Error('registry: the name ' + quote(entry.name) + ' appears twice, and a puppet has one name')
  }
  seen.names.add(entry.name)
  // One owner per control ConfigMap: two puppets writing one document would let
  // the last write win, and the panel's whole promise is that a write lands on
  // the object the registry named.
  const target = entry.namespace + '/' + entry.controlConfigMap
  if (seen.targets.has(target)) {
    throw new Error('registry: two puppets write ' + target + ', and one control ConfigMap has one owner')
  }
  seen.targets.add(target)

  return {
    name: entry.name,
    namespace: entry.namespace,
    deployment: entry.deployment,
    controlConfigMap: entry.controlConfigMap,
    frontHostname: entry.frontHostname,
    backend,
    allowBackendSwitch: entry.allowBackendSwitch
  }
}

// `host:port`, kept as the text the page shows rather than split, so a reader of
// the registry and a reader of the page see one string.
function hostPort (value, where) {
  const at = typeof value === 'string' ? value.lastIndexOf(':') : -1
  const host = at > 0 ? value.slice(0, at) : ''
  const port = Number(at > 0 ? value.slice(at + 1) : NaN)
  if (at <= 0 || !isTargetHost(host) ||
      !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('registry: ' + where + ' must be host:port, not ' + quote(value))
  }
  return value
}
