// #432: the body a backend leg's records name.
//
// The slug is the one a claim names a body with, `pickSlug(host:port)`
// (`src/core/picker.js`). The leg derives it from the target it holds, and reads
// that target at each record because a claim moves it before the next dial.
//
// Seam: the leg's constructors, which open no socket. The record read here is the
// one a live constructor writes before the leg exists, which is the one record the
// leg's own wrapper cannot stamp.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { bodySlugFor, createLiveBackendLeg } from '../../src/legs/live-backend.js'

const ACCOUNT_UUID = '7fad1e81-b0e9-4a3c-8ccb-9e41f3a4b3af'

test('#432 a target derives the slug a claim names it with', () => {
  assert.equal(bodySlugFor({ host: '127.0.0.1', port: 25565 }), '127.0.0.1_25565')
  assert.equal(bodySlugFor({ host: 'paper.example', port: 25565 }), 'paper.example_25565')
  assert.equal(bodySlugFor({ host: 'paper.example', port: '25565' }), 'paper.example_25565',
    'a quoted port is still an address, and pickSlug reads it')
})

test('#432 a target that names no address is no body', () => {
  assert.equal(bodySlugFor(null), null)
  assert.equal(bodySlugFor({}), null)
  assert.equal(bodySlugFor({ host: '', port: 25565 }), null)
  assert.equal(bodySlugFor({ host: 'paper.example' }), null)
})

test('#432 the record a constructor writes before the leg exists names its body', () => {
  const lines = []
  createLiveBackendLeg({
    host: '127.0.0.1',
    port: 25565,
    accountDir: '/data/accounts/' + ACCOUNT_UUID,
    cacheDir: '/data/puppet',
    log: (event, fields = {}) => lines.push({ event, fields })
  })

  assert.equal(lines.length, 1)
  assert.equal(lines[0].event, 'deprecation')
  assert.equal(lines[0].fields.body, '127.0.0.1_25565',
    'a record written before the leg exists names the target it was built for')
})
