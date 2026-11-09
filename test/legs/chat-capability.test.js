// The pinned minecraft-protocol signs a spoken message, and the backend leg
// calls its entry point. No offline rung holds real profile keys, and the
// client's chat plugin installs only once the connection reaches play, so
// nothing else in the gate would notice a version bump that moved it. This test
// reads the installed package and fails the bump here, not on the first live
// chat.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function packageRoot () {
  let dir = path.dirname(require.resolve('minecraft-protocol'))
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir
    dir = path.dirname(dir)
  }
  throw new Error('minecraft-protocol package root not found')
}

test('the installed minecraft-protocol still carries the signed-chat path', () => {
  const root = packageRoot()
  const sources = [
    ['src/client/chat.js', /client\._signedChat\s*=/],
    ['src/client/play.js', /client\.chat\s*=\s*client\._signedChat/]
  ]
  for (const [file, pattern] of sources) {
    const full = path.join(root, file)
    assert.ok(fs.existsSync(full), `${file} is missing`)
    assert.match(fs.readFileSync(full, 'utf8'), pattern, `${file} no longer assigns it`)
  }
})
