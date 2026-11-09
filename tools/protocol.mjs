#!/usr/bin/env node
// One protocol question per command.
//
// diff compares the fully resolved param type of each frame: every named type is
// followed to its definition at every depth. Label tables (a mapper's mappings, a
// set of flags, a switch's compareTo) are compared literally, because their
// strings name enum values, not types. A difference that no top-level field
// explains is reported by the path it sits at.
//
//   node tools/protocol.mjs packets <version> <state> <dir>
//   node tools/protocol.mjs frame <version> <state> <dir> <name>
//   node tools/protocol.mjs diff <v1> <v2> <state> <dir>
//
// The version resolves through minecraft-data, so one command answers for both
// trees: 26.1 from the npm package, and 26.2 from vendor/minecraft-data-26.2,
// which scripts/patch-minecraft-data-26.2.mjs applies at install time.
//
// minecraft-data calls these packets, and numbers them in types.packet. The
// domain calls them frames (GLOSSARY.md). The commands keep the issue's names
// (`packets`, `frame`); everything below that reads the table says frame.
//
// The layout is one expression, identical in both trees:
//   types.packet[1][0].type[1].mappings   id -> name
//   types.packet[1][1].type[1].fields     name -> the frame's param type
//
// Output is line-oriented: one frame per line, one JSON type per line. A
// session pipes it or reads it, and never re-derives the shape.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)

const USAGE = `usage: node tools/protocol.mjs <command> ...

  packets <version> <state> <dir>            every frame name with its id
  frame   <version> <state> <dir> <name>     one frame's id and field layout
  diff    <v1> <v2> <state> <dir>            frames added, removed, or changed

  version  a minecraft-data version: 26.1, 26.2, ...
  state    handshaking, status, login, configuration, play
  dir      toClient, toServer
`

class UsageError extends Error {}

// A version the installed data does not know, or a state, direction, or frame
// the version does not define, is the caller's mistake: exit 2.
function usage (message) {
  throw new UsageError(message)
}

// minecraft-data answers null for a version it has no data for. A missing
// package is different: the install has not run, and the caller must run it.
function loadProtocol (version) {
  let minecraftData
  try {
    minecraftData = require('minecraft-data')
  } catch (error) {
    throw new Error(`minecraft-data is not installed: run mise run install (${error.message})`)
  }
  const data = minecraftData(version)
  if (!data) usage(`unknown protocol version: ${version}`)
  return data.protocol
}

function states (protocol) {
  return Object.keys(protocol).filter(name => name !== 'types')
}

function typesOf (protocol, state, dir) {
  const known = states(protocol)
  if (!known.includes(state)) usage(`unknown state: ${state} (expected one of ${known.join(', ')})`)
  const directions = protocol[state] ? Object.keys(protocol[state]) : []
  if (!directions.includes(dir)) {
    usage(`unknown direction: ${dir} (expected one of ${directions.join(', ')})`)
  }
  return protocol[state][dir].types
}

// The two halves of the packet table, read in one place so the shape is never
// guessed at a call site.
function frameTable (protocol, state, dir) {
  const types = typesOf(protocol, state, dir)
  const packet = types.packet
  if (!Array.isArray(packet) || !Array.isArray(packet[1])) {
    throw new Error(`${state}.${dir} has no packet table; the protocol data shape changed`)
  }
  const nameField = packet[1].find(field => field?.name === 'name')
  const paramsField = packet[1].find(field => field?.name === 'params')
  const mappings = nameField?.type?.[1]?.mappings
  const params = paramsField?.type?.[1]?.fields
  if (!mappings || !params) {
    throw new Error(`${state}.${dir} packet table has no mapper or switch; the protocol data shape changed`)
  }
  return { types, mappings, params }
}

function hex (id) {
  return '0x' + id.toString(16).padStart(2, '0')
}

// id -> name, in id order. The ids are hex strings in the data.
function listFrames (protocol, state, dir) {
  const { mappings } = frameTable(protocol, state, dir)
  return Object.entries(mappings)
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((left, right) => left.id - right.id)
}

// Follow a named type through the state's type table until it lands on a
// container. A plain scalar or an inline type stops the walk.
function resolveType (types, type, seen = new Set()) {
  if (typeof type !== 'string' || seen.has(type)) return type
  seen.add(type)
  const next = types[type]
  return next === undefined ? type : resolveType(types, next, seen)
}

// A comparator only needs the resolved shape, not a readable one: expand every
// type position so a named type that changed behind an unchanged name still
// differs. A mapping value, a flag name, or a switch's compareTo names an enum
// value or a field, never a type, so those strings are left alone.
const LABEL_KEYS = new Set(['mappings', 'flags', 'compareTo'])

function deepResolve (types, type, seen = new Set()) {
  if (typeof type === 'string') {
    if (seen.has(type)) return type
    const next = types[type]
    if (next === undefined) return type
    return deepResolve(types, next, new Set(seen).add(type))
  }
  if (Array.isArray(type)) return type.map(item => deepResolve(types, item, seen))
  if (type && typeof type === 'object') {
    const out = {}
    for (const [key, value] of Object.entries(type)) {
      out[key] = LABEL_KEYS.has(key) ? value : deepResolve(types, value, seen)
    }
    return out
  }
  return type
}

// The container's named fields, or null when the type is not a container.
function containerFields (type) {
  if (!Array.isArray(type) || type[0] !== 'container' || !Array.isArray(type[1])) return null
  return type[1]
    .filter(field => field && typeof field === 'object' && typeof field.name === 'string')
    .map(field => ({ name: field.name, type: field.type }))
}

function renderType (type) {
  return typeof type === 'string' ? type : JSON.stringify(type)
}

// One frame: its id, the name of its param type, and the top-level fields of
// that type. A packet with a `void` param type has no fields.
function describeFrame (protocol, state, dir, name) {
  const { types, mappings, params } = frameTable(protocol, state, dir)
  const entry = Object.entries(mappings).find(([, mapped]) => mapped === name)
  if (!entry) usage(`unknown frame: ${name} (in ${state}.${dir})`)

  const [rawId] = entry
  const paramType = params[name]
  if (paramType === undefined) {
    throw new Error(`${state}.${dir} lists ${name} in its mapper but has no param type for it`)
  }
  const resolved = resolveType(types, paramType)
  const fields = containerFields(resolved) ?? []
  return {
    id: Number(rawId),
    name,
    type: typeof paramType === 'string' ? paramType : renderType(paramType),
    fields: fields.map(field => ({ name: field.name, type: renderType(field.type) }))
  }
}

const MAX_PATHS = 8
const MAX_DEPTH = 6

// The paths where two resolved values differ. A change inside an {anon:true}
// switch shows as `fields.add.2`, which names the branch that moved where no
// named top-level field can.
function differingPaths (before, after, path = '', depth = 0, out = []) {
  if (out.length >= MAX_PATHS) return out
  if (JSON.stringify(before) === JSON.stringify(after)) return out

  const walkable = depth < MAX_DEPTH &&
    before !== null && after !== null &&
    typeof before === 'object' && typeof after === 'object'
  if (!walkable) {
    out.push(path === '' ? '(value)' : path)
    return out
  }
  // Array positions carry no meaning here; the key after them does. The
  // container's field list is an array, so its indices are dropped and
  // `fields.add` names the switch branch.
  const indexed = Array.isArray(before) || Array.isArray(after)
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const segment = indexed ? '' : key
    const next = segment === '' ? path : path === '' ? segment : `${path}.${segment}`
    differingPaths(before[key], after[key], next, depth + 1, out)
    if (out.length >= MAX_PATHS) break
  }
  return out
}

// What changed between two versions for one state and direction.
export function diffProtocols (before, after, state, dir) {
  const left = frameTable(before, state, dir)
  const right = frameTable(after, state, dir)
  const leftByName = new Map(Object.entries(left.mappings).map(([id, name]) => [name, Number(id)]))
  const rightByName = new Map(Object.entries(right.mappings).map(([id, name]) => [name, Number(id)]))

  const added = [...rightByName].filter(([name]) => !leftByName.has(name))
  const removed = [...leftByName].filter(([name]) => !rightByName.has(name))
  const changed = []

  for (const [name, id] of rightByName) {
    if (!leftByName.has(name)) continue
    const oldId = leftByName.get(name)
    const fields = fieldChanges(
      left.types,
      left.params[name],
      right.types,
      right.params[name]
    )
    if (oldId !== id || fields) changed.push({ name, id, oldId, fields })
  }

  return { added, removed, changed }
}

// Compare the resolved param types, not the param names: both versions name
// the type `packet_open_book`, while the type behind that name differs.
//
// A named field type is followed the same way, so a redefined field type shows
// up even when both versions declare the field identically. A difference that
// no named field can explain (a change inside an {anon:true} switch) is
// reported as nested.
function fieldChanges (oldTypes, oldParam, newTypes, newParam) {
  const oldResolved = deepResolve(oldTypes, oldParam)
  const newResolved = deepResolve(newTypes, newParam)
  const sameShape = JSON.stringify(oldResolved) === JSON.stringify(newResolved)
  if (sameShape) return null

  const paths = differingPaths(oldResolved, newResolved)
  const oldFields = containerFields(resolveType(oldTypes, oldParam))
  const newFields = containerFields(resolveType(newTypes, newParam))
  if (!oldFields || !newFields) return { lines: [], paths }

  const oldByName = new Map(oldFields.map(field => [field.name, field.type]))
  const newByName = new Map(newFields.map(field => [field.name, field.type]))
  const removed = []
  const added = []
  const changed = []
  for (const [name, type] of oldByName) {
    if (!newByName.has(name)) removed.push(`- ${name}: ${renderType(type)}`)
  }
  for (const [name, type] of newByName) {
    if (!oldByName.has(name)) {
      added.push(`+ ${name}: ${renderType(type)}`)
      continue
    }
    const oldType = oldByName.get(name)
    if (JSON.stringify(oldType) !== JSON.stringify(type)) {
      changed.push(`~ ${name}: ${renderType(oldType)} -> ${renderType(type)}`)
    } else if (JSON.stringify(deepResolve(oldTypes, oldType)) !== JSON.stringify(deepResolve(newTypes, type))) {
      // The field names the same type in both versions, and the definition
      // behind that name moved.
      changed.push(`~ ${name}: ${renderType(oldType)} (definition changed)`)
    }
  }
  // Removed, then added, then changed: the same order as the frame sections.
  const lines = [...removed, ...added, ...changed]
  return { lines, paths: lines.length ? [] : paths }
}
export function main (argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const write = line => io.stdout.write(line + '\n')
  const [command, ...args] = argv

  try {
    if (!command) usage('no command given')

    if (command === 'packets') {
      if (args.length !== 3) usage('packets needs a version, a state, and a direction')
      const [version, state, dir] = args
      for (const frame of listFrames(loadProtocol(version), state, dir)) {
        write(`${hex(frame.id)} ${frame.name}`)
      }
      return 0
    }

    if (command === 'frame') {
      if (args.length !== 4) usage('frame needs a version, a state, a direction, and a frame name')
      const [version, state, dir, name] = args
      const frame = describeFrame(loadProtocol(version), state, dir, name)
      write(`${version} ${state} ${dir} ${frame.name} = ${hex(frame.id)} (${frame.type})`)
      for (const field of frame.fields) write(`  ${field.name}: ${field.type}`)
      return 0
    }

    if (command === 'diff') {
      if (args.length !== 4) usage('diff needs two versions, a state, and a direction')
      const [before, after, state, dir] = args
      const diff = diffProtocols(loadProtocol(before), loadProtocol(after), state, dir)
      const total = diff.added.length + diff.removed.length + diff.changed.length
      const head = `${before} -> ${after} ${state} ${dir}`
      if (total === 0) {
        write(`${head}: no differences`)
        return 0
      }

      write(`${head}: ${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed`)
      if (diff.added.length) {
        write('added:')
        for (const [name, id] of diff.added) write(`  + ${hex(id)} ${name}`)
      }
      if (diff.removed.length) {
        write('removed:')
        for (const [name, id] of diff.removed) write(`  - ${hex(id)} ${name}`)
      }
      if (diff.changed.length) {
        write('changed:')
        for (const change of diff.changed) {
          write(`  ~ ${change.name} ${hex(change.oldId)} -> ${hex(change.id)}`)
          for (const line of change.fields?.lines ?? []) write(`      ${line}`)
          for (const path of change.fields?.paths ?? []) write(`      at ${path}`)
        }
      }
      return 0
    }

    usage(`unknown command: ${command}`)
  } catch (error) {
    io.stderr.write(`protocol: ${String(error?.message ?? error)}\n`)
    if (error instanceof UsageError) io.stderr.write(USAGE)
    return error instanceof UsageError ? 2 : 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A reader that closes the pipe first (head, grep -m1) is not an error.
  process.stdout.on('error', (error) => {
    if (error.code === 'EPIPE') process.exit(0)
    throw error
  })
  process.exitCode = main()
}
