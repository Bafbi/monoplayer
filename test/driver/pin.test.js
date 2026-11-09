// The driver's Minecraft version follows the deployed proxy. This test is the
// guard for #62's second decision: the driver can never drift a version behind
// the thing it validates.
//
// Four files carry the pin, and none of them may disagree:
//
//   tools/driver/build.gradle                        the build target
//   tools/driver/src/main/resources/fabric.mod.json  what Fabric accepts at load
//   deploy/manifests/deployment.yaml                 the deployed proxy
//   src/driver/scenario.js DEFAULT_PINS              what rung 4 says it drove
//
// The rung 4 target is the gate-B Paper, which is a separate deployment, so it
// has its own manifest to agree with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PINS } from '../../src/driver/scenario.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(path.join(root, relative), 'utf8')

const buildPin = () => {
  const match = read('tools/driver/build.gradle').match(/com\.mojang:minecraft:([0-9][^'"\s]*)/)
  assert.ok(match, 'tools/driver/build.gradle pins a com.mojang:minecraft version')
  return match[1]
}

const envValue = (file, name) => {
  const match = read(file).match(new RegExp('- name: ' + name + '\\n\\s+value: "?([^"\\n]+)"?'))
  assert.ok(match, file + ' sets ' + name)
  return match[1].trim()
}

test('the build pin and the mod metadata name the same Minecraft version', () => {
  const metadata = JSON.parse(read('tools/driver/src/main/resources/fabric.mod.json'))
  assert.equal(metadata.depends.minecraft, buildPin(),
    'fabric.mod.json refuses to load the jar on any version the build did not target')
})

test('the driver pin follows the deployed proxy', () => {
  // The decision, in one assertion: the live proxy's version is the build target.
  assert.equal(buildPin(), envValue('deploy/manifests/deployment.yaml', 'MONOPLAYER_VERSION'),
    'tools/driver/build.gradle must target the version the deployed proxy serves')
})

test('the dev lane and the transfer testbed serve the same version the driver builds for', () => {
  // Both are parity targets, so a lane a version behind would be unmeasurable.
  const targets = [
    ['deploy/dev/monoplayer.yaml', 'MONOPLAYER_VERSION'],
    ['deploy/dev/paper.yaml', 'VERSION'],
    ['deploy/testbed/paper-hub.yaml', 'VERSION']
  ]
  for (const [file, name] of targets) {
    assert.equal(envValue(file, name), buildPin(), file + ' serves the version the driver builds for')
  }
})

test('the installer reads the version from the base instance instead of naming one', () => {
  const installer = read('tools/driver/install.sh')
  assert.doesNotMatch(installer, /"version": "2[0-9]\./,
    'install.sh must not hardcode a Minecraft version in its mmc-pack')
  assert.match(installer, /mmc-pack\.json/, 'install.sh reads the base instance mmc-pack')
})

test('rung 4 pins describe the backend rung 4 actually drives', () => {
  // The G0 lane is a different deployment from the proxy, and it is still on the
  // older version: #71 moves it. Until then these two files must agree, so the
  // runbook's pins cannot describe a server that is not there.
  assert.equal(DEFAULT_PINS.minecraftVersion, envValue('deploy/driver/paper.yaml', 'VERSION'))
  assert.equal(String(DEFAULT_PINS.paperBuild).match(/(\d+)$/)?.[1],
    envValue('deploy/driver/paper.yaml', 'PAPER_BUILD'))
})

test('the installer and rung 4 agree on the Fabric Loader version', () => {
  const installer = read('tools/driver/install.sh')
  const match = installer.match(/loader=\$\{LOADER:-([^}]+)\}/)
  assert.ok(match, 'install.sh defaults LOADER')
  assert.equal(match[1], DEFAULT_PINS.fabricLoader)
})
