// What the driver's click and screen ops read, held to the dialog a picker shows a
// joining client (#678).
//
// #678 asked whether a driven client can press the picker's Spectate button. The picker
// is not a GUI screen. It is a `minecraft:multi_action` dialog the front sends in the
// configuration phase (src/core/picker.js), and the client builds it as
// `MultiButtonDialogScreen`. Three properties of this mod make that press work, and each
// one breaks silently: the run would only say "no button matched".
//
// The reading itself is a run on the display host, and #720 takes it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { blockAfter } from '../support/source-scan.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER = 'tools/driver/src/main/java/eu/monoplayer/driver/DriverServer.java'

const source = () => readFileSync(path.join(ROOT, SERVER), 'utf8')

// One method's body, from its signature to the brace that closes it. Slicing to the
// matching brace rather than to the next signature keeps a reader pinned to itself when
// the op beside it is renamed or moved.
function method (signature) {
  const text = source()
  const start = text.indexOf(signature)
  assert.ok(start > -1, SERVER + ' holds ' + signature)
  return text.slice(start, blockAfter(text, signature, signature + ' in ' + SERVER).close + 1)
}

test('click reads the children list a dialog screen builds its buttons into', () => {
  // A dialog built as anything but a screen, or a reader that walked one known button
  // class, would find nothing here and report "no button matched" instead of a bug.
  const body = method('private JsonObject clickButton(')
  assert.match(body, /mc\.gui\.screen\(\)/, 'click reads the current screen')
  assert.match(body, /screen\.children\(\)/, 'click reads the screen children list')
  assert.match(body, /instanceof AbstractButton/, 'click reads buttons by their supertype')
})

test('click needs no world, because a client in the picker has none', () => {
  // The configuration phase has no level and no player. A requireWorld() here would
  // refuse every press in the picker and read as a bad label.
  assert.doesNotMatch(method('private JsonObject clickButton('), /requireWorld\(/,
    'click must not require a world: the picker is shown before one exists')
})

test('screen reports the same children list, as widgets', () => {
  // The claim names both readers. This one matches AbstractWidget, so a screen row
  // exists for the dialog's buttons and for anything else the dialog draws.
  const body = method('private static JsonArray widgetRows(')
  assert.match(body, /screen\.children\(\)/, 'screen reads the screen children list')
  assert.match(body, /instanceof AbstractWidget/, 'screen reports every widget, not only buttons')
})
