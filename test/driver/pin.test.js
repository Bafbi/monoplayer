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
// has its own manifest to agree with. Every Paper manifest under deploy/ that
// pins a build is classified below, and each one either serves the gate Paper's
// pin or names the pin it serves (#117).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getBackend } from '../../src/driver/backends.js'
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

// The gate Paper leads: the dev lane and the transfer testbed are what the driver
// and the client are measured against, so they run what it runs (#117).
// `paper-conduct` is the gate lane's sibling (#78) and the observer test below
// holds it to the gate Paper, so it is classified here and compared there.
const GATE_PAPER = 'deploy/driver/paper.yaml'
const GATE_SIBLING = 'deploy/driver/paper-conduct.yaml'
const FOLLOWERS = [
  'deploy/dev/paper.yaml',
  'deploy/testbed/paper-hub.yaml',
  'deploy/testbed/paper-sky.yaml'
]

// `paper-m4` is not a gate Paper: it is the M4 backend row behind Velocity, and
// its own row in src/driver/backends.js is the pin it serves.
const M4_PAPER = 'deploy/driver/paper-m4.yaml'
const M4_PINS = {
  VERSION: getBackend('paper-m4').pins.version,
  PAPER_BUILD: String(getBackend('paper-m4').pins.paperBuild)
}

// Every .yaml under deploy/, at any depth, that pins a Paper build. PAPER_BUILD is
// Paper's own env name, so the walk asks for it rather than guessing at the
// image, and MONOPLAYER_VERSION or VELOCITY_VERSION cannot drag a file in.
const papersPinningABuild = () => {
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    if (!entry.name.endsWith('.yaml')) return []
    const file = path.relative(root, full).split(path.sep).join('/')
    const text = readFileSync(full, 'utf8')
    if (!/- name: PAPER_BUILD$/m.test(text)) return []
    // One pin per name: a second container's pair must not slip past unread.
    assert.equal(text.match(/- name: VERSION$/gm)?.length, 1, file + ' sets VERSION once')
    return [file]
  })
  return walk(path.join(root, 'deploy')).sort()
}

test('every Paper manifest that pins a build is classified in this file', () => {
  // Without this the guard is only as complete as someone's memory of the deploy
  // tree, which is how paper-sky went unchecked until #117: a version move that
  // missed the transfer target passed the gate.
  assert.deepEqual(papersPinningABuild(), [GATE_PAPER, GATE_SIBLING, ...FOLLOWERS, M4_PAPER].sort(),
    'classify a new Paper manifest here: it serves the gate pin, or it names the pin it serves')
})

test('the dev lane and the transfer testbed run the gate Paper\'s version and build', () => {
  // Editing one manifest alone fails here, and so does editing the gate alone.
  for (const file of FOLLOWERS) {
    for (const name of ['VERSION', 'PAPER_BUILD']) {
      assert.equal(envValue(file, name), envValue(GATE_PAPER, name),
        file + ' must serve the same ' + name + ' as the gate Paper')
    }
  }
})

test('the M4 backend row runs the Paper pin its row declares', () => {
  // Deliberately older, and not drift: paper-m4 is the M4 row behind Velocity,
  // measured on its own build. The manifest and src/driver/backends.js move
  // together, and either one alone fails here.
  for (const [name, value] of Object.entries(M4_PINS)) {
    assert.equal(envValue(M4_PAPER, name), value,
      M4_PAPER + ' must serve the ' + name + ' src/driver/backends.js declares for paper-m4')
  }
})

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

test('the dev lane serves the version the driver builds for', () => {
  // The dev lane is where a branch image is measured, so a lane a version behind
  // would be unmeasurable. Its Paper's version is the test above.
  assert.equal(envValue('deploy/dev/monoplayer.yaml', 'MONOPLAYER_VERSION'), buildPin(),
    'deploy/dev/monoplayer.yaml serves the version the driver builds for')
})

test('the installer reads the version from the base instance instead of naming one', () => {
  const installer = read('tools/driver/install.sh')
  assert.doesNotMatch(installer, /"version": "2[0-9]\./,
    'install.sh must not hardcode a Minecraft version in its mmc-pack')
  assert.match(installer, /mmc-pack\.json/, 'install.sh reads the base instance mmc-pack')
})

test('rung 4 pins describe the backend rung 4 actually drives', () => {
  // The G0 lane is a different deployment from the proxy, so it has its own
  // manifest to agree with: the runbook's pins must not describe a server that
  // is not there.
  assert.equal(DEFAULT_PINS.minecraftVersion, envValue('deploy/driver/paper.yaml', 'VERSION'))
  assert.equal(String(DEFAULT_PINS.paperBuild).match(/(\d+)$/)?.[1],
    envValue('deploy/driver/paper.yaml', 'PAPER_BUILD'))
})

test('the gate Paper serves the version the driver builds for', () => {
  // #71: the gate Paper sat a version behind the driver build, and only a client
  // relaunch found out. The rung-4 manifest and the build pin are checked here so
  // rung 1 fails first instead.
  assert.equal(envValue('deploy/driver/paper.yaml', 'VERSION'), buildPin(),
    'deploy/driver/paper.yaml must serve the version tools/driver/build.gradle targets')
})

test('the observer rung speaks the version the gate Paper serves', () => {
  // The observer's baseline bot joins the gate Paper directly (#12), so its
  // default version has to be the version that server accepts.
  const match = read('src/ladder/observer-baseline.js').match(/MONOPLAYER_VERSION (?:\?\?|\|\|) '([^']+)'/)
  assert.ok(match, 'src/ladder/observer-baseline.js defaults MONOPLAYER_VERSION')
  assert.equal(match[1], envValue('deploy/driver/paper.yaml', 'VERSION'),
    'the baseline bot joins the gate Paper with the version it serves')
})

test('the observer lane serves the same Paper build as the gate Paper', () => {
  // #78: the observer measures `paper-conduct`, not the G0 `paper`, because only the
  // first one can serve the code of conduct. The observer still reads the version
  // from `deploy/driver/paper.yaml`, so the two must not drift apart.
  for (const name of ['VERSION', 'PAPER_BUILD']) {
    assert.equal(envValue('deploy/driver/paper-conduct.yaml', name), envValue('deploy/driver/paper.yaml', name),
      'deploy/driver/paper-conduct.yaml must pin the same ' + name + ' as the gate Paper')
  }
})

test('the observer lane is the one that serves the code of conduct', () => {
  // The lane exists for the gate: if the setting or the document folder goes, the
  // observer's two gate fields go back to being absent for no measured reason.
  const lane = read('deploy/driver/paper-conduct.yaml')
  assert.match(lane, /- name: CUSTOM_SERVER_PROPERTIES\n\s+value: enable-code-of-conduct=true/,
    'the lane turns the gate on, through the image\'s custom-properties knob')
  assert.match(lane, /codeofconduct\/terms\.txt/, 'the lane writes a document Paper will read')
})

test('the observer plugin compiles against the gate Paper build', () => {
  // docs/adr/pin-protocollib-for-the-observer.md: the plugin compiles against the
  // same Paper build the gate server runs, so the jar loads on the server it
  // measures.
  const gradle = read('tools/observer/build.gradle')
  const match = gradle.match(/io\.papermc\.paper:paper-api:([0-9][^'"]+)-stable/)
  assert.ok(match, 'tools/observer/build.gradle pins a paper-api version')
  const version = envValue('deploy/driver/paper.yaml', 'VERSION')
  const build = envValue('deploy/driver/paper.yaml', 'PAPER_BUILD')
  assert.equal(match[1], version + '.build.' + build,
    'tools/observer/build.gradle must target the Paper build the gate runs')
})

test('the installer and rung 4 agree on the Fabric Loader version', () => {
  const installer = read('tools/driver/install.sh')
  const match = installer.match(/loader=\$\{LOADER:-([^}]+)\}/)
  assert.ok(match, 'install.sh defaults LOADER')
  assert.equal(match[1], DEFAULT_PINS.fabricLoader)
})
