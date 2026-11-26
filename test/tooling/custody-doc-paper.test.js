// docs/custody.md prints a backend-whitelist command an operator copies, and that
// command writes exactly one Paper's whitelist: it exec's rcon-cli inside the Paper's
// Deployment (src/driver/rcon.js). #328 made --namespace required and left step 4
// asking for `--namespace <ns>`, "the namespace that holds the Paper" (#378). The live
// namespace holds the proxy and the playit agent, so no value that placeholder could
// stand for exists, and the reader had nothing to type.
//
// The rule: a backend-whitelist command the page prints names a namespace a deploy tree
// in this repository declares, and that tree declares the Deployment the command writes
// in it, as a Paper. A placeholder fails, because it is not a name, and a real name with
// no Paper behind it fails too, because kubectl answers NotFound and the operator reads a
// broken cluster rather than a wrong line. #397 was the same shape one page over.
//
// The trees are read, not listed: a rename in deploy/ moves this with it. A Paper is
// recognised by its image, the way deploy/dev and the gate lanes run it, so the proxy
// Deployment cannot be named here by giving --deployment its own name.
//
// What a line has to look like to be read: a `node` command line, or a line quoting
// `whitelist backend`. The second half is what catches the defect this file exists for —
// #328's step 4 was prose in backticks, not a command — and its cost is that a bullet
// joining those two words with a `--namespace` value is read as a command too. That is
// the safe direction: the page is free to say "the live namespace holds no Paper", and
// it does, because that sentence names the namespace without naming `whitelist backend`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATE_LANE_SCRIPT } from '../../src/driver/lane.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8')

const PAGE = 'docs/custody.md'

// A Paper, by the image every Paper manifest in this repository runs and no other
// Deployment does.
const PAPER = /^\s+image: itzg\/minecraft-server/m

// A lane and a worktree are both derived, so a page that names one prints the resolver
// the tree reads rather than a literal. The script that answers it is exported once
// (src/driver/lane.js), so a page that prints a moved script fails here instead of
// leaving a command a reader copies and a shell cannot run.
const RESOLVER_SCRIPT = path.relative(ROOT, GATE_LANE_SCRIPT).split(path.sep).join('/')
const RESOLVER = new RegExp('^"?\\$\\(' + RESOLVER_SCRIPT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' name\\)"?$')

// The placeholder a gate tree spells its lane with, so the objects it declares can be
// read as objects of a lane that will exist (`deploy/driver/README.md`).
const LANE_TEMPLATE = /__instance__$/

// Every kustomization under deploy/, at any depth, with the objects its own files declare.
// An object's namespace is its own: the panel's Role lives in the puppet's namespace while
// the panel's tree is elsewhere, and that is still a declared row.
function trees () {
  const found = []
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name === 'kustomization.yaml') found.push(full)
    }
  }
  walk(path.join(ROOT, 'deploy'))
  return found.map(kustomization => {
    const dir = path.dirname(kustomization)
    const documents = [...fs.readFileSync(kustomization, 'utf8').matchAll(/^ {2}- (\S+\.ya?ml)$/gm)]
      .flatMap(([, file]) => fs.readFileSync(path.join(dir, file), 'utf8').split(/^---$/m))
    return {
      kustomization: path.relative(ROOT, kustomization),
      objects: documents.flatMap(document => {
        const name = /^ {2}name: (\S+)$/m.exec(document)?.[1]
        const kind = /^kind: (\S+)$/m.exec(document)?.[1]
        // A Namespace object is named by itself, and one of these trees declares it.
        const namespace = /^ {2}namespace: (\S+)$/m.exec(document)?.[1] ?? (kind === 'Namespace' ? name : undefined)
        return name === undefined || kind === undefined || namespace === undefined
          ? []
          : [{ kind, name, namespace, paper: PAPER.test(document) }]
      })
    }
  })
}

// The deployment the command writes when the page names none. It is the CLI's own
// default, read from the CLI, so a page and the command cannot disagree about it.
function defaultDeployment () {
  const found = /const BACKEND_DEPLOYMENT = '([^']+)'/.exec(read('src/custody/cli.js'))
  assert.ok(found, 'src/custody/cli.js names BACKEND_DEPLOYMENT, and this test reads it')
  return found[1]
}

// A flag's value, as a page prints it: double-quoted whole, or up to the first space,
// backtick or sentence punctuation. A page writes `"$(scripts/gate-lane.sh name)"`
// because a lane holds a space, and the prose about the flag ("--namespace (required)")
// carries no value at all, so this never reads a word of English as a namespace.
const VALUE = '(?:"([^"]*)"|([^\\s`\'"().,;:]*[^\\s`\'"().,;:]))'
const values = (line, flag) =>
  [...line.matchAll(new RegExp(flag + '\\s+' + VALUE, 'g'))].map(([, quoted, bare]) => quoted ?? bare)

// The backend-whitelist commands the page prints.
const commands = page => page.split('\n')
  .filter(line => /^\s*node\s/.test(line) || line.includes('whitelist backend'))
  .flatMap(line => values(line, '--namespace').map((namespace, at) => ({
    line: line.trim(),
    namespace,
    deployment: values(line, '--deployment')[at] ?? defaultDeployment()
  })))

test('every Paper docs/custody.md writes is one a deploy tree declares, and that Paper is a Paper', () => {
  const declared = trees()
  const papers = (deployment) => [...new Set(declared.flatMap(tree =>
    tree.objects
      .filter(object => object.kind === 'Deployment' && object.paper && object.name === deployment)
      .map(object => object.namespace)))]
  const deployment = defaultDeployment()
  const writable = papers(deployment)

  const commands_ = commands(read(PAGE))
  assert.ok(commands_.length > 0,
    PAGE + ' prints no --namespace on a backend-whitelist command, and it is the page that gives that command')

  for (const { line, namespace, deployment } of commands_) {
    const where = PAGE + ' prints --namespace ' + namespace + ': ' + line + '\n'
    if (RESOLVER.test(namespace)) {
      // The lane's name is derived, so the namespace cannot be matched against a
      // manifest. The Deployment half still can: the gate tree declares the Paper
      // every lane renders, and a page naming another one would fail on the lane.
      assert.ok(declared.some(candidate => candidate.objects.some(object => object.kind === 'Deployment' &&
        object.name === deployment && LANE_TEMPLATE.test(object.namespace))),
      where + 'names a gate lane, and no gate tree declares a ' + deployment + ' Deployment for one. ' +
      'A lane renders deploy/driver, so that tree is where the Paper the command writes is declared')
      continue
    }
    assert.ok(!/^[<{[]/.test(namespace), where +
      'That is a placeholder rather than a Paper. A step that cannot name one says which Paper it means: ' +
      papers(deployment).join(', ') + ', or $(scripts/gate-lane.sh name) for a gate lane')

    const tree = declared.find(candidate =>
      candidate.objects.some(object => object.kind === 'Namespace' && object.name === namespace))
    assert.ok(tree, where +
      'No deploy tree declares that namespace. The backend whitelist is one Paper in this cluster, so ' +
      'the value is a namespace whose tree declares a ' + deployment + ' Paper: ' +
      papers(deployment).join(', ') + ', or $(scripts/gate-lane.sh name) for a gate lane')

    assert.ok(tree.objects.some(object => object.kind === 'Deployment' &&
      object.name === deployment && object.namespace === namespace && object.paper),
    where + tree.kustomization + ' declares no ' + deployment + ' Paper Deployment there, and rcon-cli ' +
    'runs inside that Deployment (src/driver/rcon.js). A namespace without one answers NotFound, and ' +
    'the Deployments that are not Papers run no rcon-cli at all')
  }
})
