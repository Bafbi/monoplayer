// scripts/build-image.sh builds the image and, by default, publishes it. The
// deploy rung proves a Dockerfile change by building it, so the script needs a
// mode that writes no registry at all: PUSH=0.
//
// Every case here runs the real script with a fake kubectl and a fake buildctl
// on PATH, so the buildctl output attribute the script passes is the assertion.
// No cluster, no registry, no network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tempRoot } from '../support/temp.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = path.join(ROOT, 'scripts', 'build-image.sh')
const DIGEST = 'sha256:deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'

// kubectl only has to stay alive: the script polls the port-forward's pid and
// kills it on exit. buildctl answers the readiness probe and, for a build,
// writes the metadata file the script reads its digest from.
const FAKE_KUBECTL = "#!/bin/sh\nexec sleep 30\n"
const FAKE_BUILDCTL = "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$BUILDCTL_ARGS\"\ncase \"$*\" in\n\t*\"debug workers\"*) exit 0 ;;\nesac\nwhile [ $# -gt 0 ]; do\n\tcase \"$1\" in\n\t\t--metadata-file) META=$2; shift 2 ;;\n\t\t*) shift ;;\n\tesac\ndone\nprintf '{\"containerimage.digest\":\"%s\"}\\n' \"$BUILDCTL_DIGEST\" > \"$META\"\n"

function fixture () {
  const root = tempRoot('monoplayer-build-image-')
  const bin = path.join(root, 'bin')
  const argsFile = path.join(root, 'buildctl-args')
  fs.mkdirSync(bin)

  fs.writeFileSync(path.join(bin, 'kubectl'), FAKE_KUBECTL)
  fs.writeFileSync(path.join(bin, 'buildctl'), FAKE_BUILDCTL)
  for (const name of ['kubectl', 'buildctl']) fs.chmodSync(path.join(bin, name), 0o755)

  return { root, bin, argsFile }
}

function run (env = {}) {
  const { root, bin, argsFile } = fixture()
  fs.writeFileSync(argsFile, '')
  const result = spawnSync('sh', [SCRIPT], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      BUILDCTL_ARGS: argsFile,
      BUILDCTL_DIGEST: DIGEST,
      PUSH: '',
      ...env
    }
  })
  return {
    ...result,
    output: result.stdout + result.stderr,
    buildctl: fs.readFileSync(argsFile, 'utf8')
  }
}

test('the default build publishes, and prints the digest', () => {
  const result = run()

  assert.equal(result.status, 0, result.output)
  assert.match(result.buildctl, /type=image,name=\S+,push=true/, 'the default still publishes')
  const sha = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  assert.match(result.stdout, new RegExp(`zot\\.deepmine-core\\.svc:5000/deepmine/monoplayer sha-${sha} ${DIGEST}`), 'prints image, tag, and digest')
})

test('PUSH=0 builds the same image and publishes nothing', () => {
  const result = run({ PUSH: '0' })

  assert.equal(result.status, 0, result.output)
  assert.match(result.buildctl, /type=image,name=\S+,push=false/, 'the output attribute turns the push off')
  assert.doesNotMatch(result.buildctl, /push=true/, 'no attribute asks for a push')
  assert.match(result.stdout, new RegExp(`sha-\\S+ ${DIGEST}`), 'still prints the digest')
})

test('a PUSH value that is neither 0 nor 1 refuses before it touches anything', () => {
  // A typo must not fall through to a publish. The build never starts.
  const result = run({ PUSH: 'flase' })

  assert.equal(result.status, 1, 'the script exits non-zero')
  assert.match(result.output, /PUSH/, 'the refusal names the variable')
  assert.equal(result.buildctl, '', 'buildctl never ran')
})
