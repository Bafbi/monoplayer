// The image does not ship the trees the CMD never runs, so a path under
// .dockerignore that the service imports is an image that boots and then dies
// on a missing module. The fake legs go out with the code that imports
// them: src/legs/fake-backend.js with the ladder and the spike, and
// src/legs/fake-legs.js with test/, which runs from a checkout. A rung never
// needs the image's `src`: scripts/online-cluster.sh:196 and
// scripts/dev-custody.sh:166 copy `./src` into the pod and run from there.
// These two lists are checked against each other here, where a contradiction
// costs a test instead of a deploy.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// What the container runs, read from the Dockerfile CMD, not restated by hand.
function entryPoint () {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8')
  const cmd = dockerfile.match(/^CMD\s+(\[.*\])$/m)
  assert.ok(cmd, 'the Dockerfile has no JSON CMD line')
  const argv = JSON.parse(cmd[1])
  assert.equal(argv[0], 'node', 'the CMD does not run node')
  return argv[1]
}

function ignoreEntries () {
  return fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
}

// No entry is skipped: an entry this file cannot evaluate would hide exactly
// the case it exists for. A pattern with no slash is matched against each
// segment of the path, a pattern with one against the path and its ancestors,
// and `*` never crosses a `/`.
function globFor (pattern) {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*')
  return new RegExp('^' + source + '$')
}

function ignored (file, entries) {
  const segments = file.split('/')
  const ancestors = segments.map((_, index) => segments.slice(0, index + 1).join('/'))
  return entries.some(entry => {
    const clean = entry.replace(/^\.?\//, '').replace(/\/$/, '')
    const pattern = clean.includes('*') || clean.includes('?') ? globFor(clean) : null
    const matches = candidate => pattern ? pattern.test(candidate) : candidate === clean
    if (!clean.includes('/')) return ancestors.some(matches)
    return matches(file) || ancestors.slice(0, -1).some(matches)
  })
}

// An edge this walk cannot follow is worse than no walk: it would report a
// closure short by a file the service loads. A computed specifier fails the
// test instead of passing it, the same rule as
// test/custody/imports.test.js:84.
function hiddenTargets (source) {
  return [/\bimport\s*\(/g, /\brequire\s*\(/g, /\bcreateRequire\s*\(/g]
    .flatMap(pattern => [...source.matchAll(pattern)])
    .filter(match => !/^\s*['"][^'"]+['"]\s*\)/.test(source.slice(match.index + match[0].length)))
    .length
}

// Every relative specifier the entrypoint reaches, followed to the file.
function closure (from) {
  const seen = new Set()
  const stack = [from]
  const specifier = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|\n)\s*import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g
  while (stack.length > 0) {
    const file = stack.pop()
    if (seen.has(file)) continue
    seen.add(file)
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8')
    assert.equal(hiddenTargets(source), 0, `${file} hides an import target behind a computed specifier, so this test cannot see where it points`)
    for (const match of source.matchAll(specifier)) {
      const spec = match[1] ?? match[2] ?? match[3] ?? match[4]
      if (!spec || !spec.startsWith('.')) continue
      const base = path.posix.join(path.posix.dirname(file), spec)
      const found = [base, base + '.js', base + '.mjs', base + '.cjs', base + '.json', base + '/index.js']
        .find(candidate => fs.existsSync(path.join(ROOT, candidate)))
      assert.ok(found, `${file} imports ${spec}, which is not in the tree`)
      stack.push(found)
    }
  }
  return seen
}

test('.dockerignore drops the ladder, the driver lane, the testbed, the spike, and the fake legs', () => {
  const entries = ignoreEntries()
  for (const dropped of ['src/ladder', 'src/driver', 'src/testbed', 'src/spike', 'src/legs/fake-legs.js', 'src/legs/fake-backend.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, dropped)), `the ignore file names ${dropped}, which is not in the tree`)
    assert.ok(ignored(dropped, entries), `.dockerignore does not drop ${dropped}`)
  }
})

test('the entrypoint reaches nothing the ignore file drops', () => {
  const entries = ignoreEntries()
  const reached = closure(entryPoint())
  // The walk is the assertion's own instrument: prove it walked something.
  assert.ok(reached.size > 20, `the import walk reached only ${reached.size} files`)
  const shipped = [...reached].filter(file => ignored(file, entries))
  assert.deepEqual(shipped, [], `the image would not ship ${shipped.join(', ')}`)
})
