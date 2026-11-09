// #12: the direct baseline join refuses what it cannot do before it opens a
// socket. The join itself needs a real Paper server, so what is testable here is
// the setup contract: a host, a port, and an account that resolves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runBaseline } from '../../src/ladder/observer-baseline.js'

const UUID = '73e0e19b-d4e4-4cc1-a553-a3952f0c1aed'

function accountsDir (profile = { uuid: UUID, name: 'GlowSquidye', alias: 'glowsquidye' }) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'observer-baseline-'))
  if (profile) {
    const account = path.join(dir, profile.uuid)
    fs.mkdirSync(account, { recursive: true })
    fs.writeFileSync(path.join(account, 'profile.json'), JSON.stringify(profile))
  }
  return dir
}

test('a host is required', async () => {
  await assert.rejects(() => runBaseline({ host: '', port: 25565, accountsDir: accountsDir() }), /host is required/)
})

test('the port has to be a port', async () => {
  for (const port of [0, 70000, 1.5, Number.NaN]) {
    await assert.rejects(
      () => runBaseline({ host: '127.0.0.1', port, accountsDir: accountsDir() }),
      /port must be an integer/,
      String(port)
    )
  }
})

test('an account that does not resolve fails before any socket opens', async () => {
  await assert.rejects(
    () => runBaseline({ host: '127.0.0.1', port: 25565, accountsDir: accountsDir(), account: 'nosuchpuppet' }),
    /cannot resolve the account/
  )
})

test('an empty accounts directory is reported, not guessed at', async () => {
  await assert.rejects(
    () => runBaseline({ host: '127.0.0.1', port: 25565, accountsDir: accountsDir(null) }),
    /cannot resolve the account/
  )
})
