// The entities payload an operator reads in tools/driver/README.md, held to the
// reader that consumes it (#675).
//
// The doc states the shape once, in an example, and every field is one the reader in
// src/driver/entities.js needs. A field renamed in the reader and left behind in the
// example fails here, in the gate, rather than in a run at a live client. The parser
// is the same shape a report carries, so the example is a fixture the reader accepts
// rather than a picture beside it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { entityClaim, readEntityReading } from '../../src/driver/entities.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const README = 'tools/driver/README.md'

const text = () => readFileSync(path.join(ROOT, README), 'utf8')

// The one fenced JSON example in the page that holds an entities list.
function example () {
  const blocks = [...text().matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1])
  const block = blocks.find(candidate => candidate.includes('"entities"'))
  assert.ok(block, README + ' has no JSON example holding an entities list')
  return JSON.parse(block)
}

test('the command table names the op, with the radius it takes', () => {
  assert.match(text(), /^\| `entities \[radius\]` \|/m)
})

test('the documented payload carries every field the reader reads', () => {
  const payload = example()
  for (const key of ['dimension', 'radius', 'center', 'inLevel', 'truncated', 'entities']) {
    assert.ok(key in payload, 'the example carries no ' + key)
  }
  for (const key of ['id', 'type', 'uuid', 'name', 'pos', 'distance', 'local', 'player', 'skin']) {
    assert.ok(key in payload.entities[0], 'the example row carries no ' + key)
  }
  for (const key of ['x', 'y', 'z']) {
    assert.ok(key in payload.entities[0].pos, 'the example pos carries no ' + key)
  }
})

test('the documented payload is a payload the reader accepts, and its second row is not me', () => {
  const payload = example()
  const reading = readEntityReading(payload)
  assert.equal(reading.rows.length, payload.entities.length)
  assert.equal(reading.radius, payload.radius)
  const other = payload.entities.find(row => row.local !== true)
  assert.ok(other, 'the example needs a row that is not the local player')
  assert.ok(payload.entities.some(row => row.local === true), 'the example needs the local player too')
  const claim = entityClaim(reading, { uuid: other.uuid })
  assert.equal(claim.present, true)
  assert.equal(claim.local, false)
  assert.equal(claim.type, 'minecraft:player')
  assert.match(claim.sentence, /, type minecraft:player, not me$/)
})
