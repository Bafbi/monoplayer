// Custody's boundary with the driver lane (#38).
//
// Custody has to keep secrets out of its own logs, reports, and error details.
// It imported that ability from the driver lane, which is a validation lane, so
// the security boundary of one lane pointed into another. The scanner now lives
// in `src/observability/secrets.js`, and this test is what stops the edge from
// coming back.
//
// RCON is the one import custody still takes from the driver lane. That is a
// decision, not an oversight: `docs/adr/name-the-tree-after-the-domain.md` puts
// the RCON adapter in the driver tree, `src/custody/cli.js` uses it for the
// backend whitelist, and it carries no secret shape (the password stays inside
// the pod). If that changes, the allowlist below changes with it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const custodyDir = path.join(root, 'src', 'custody')
const driverDir = path.join(root, 'src', 'driver')
const checksModule = path.join(driverDir, 'checks.js')
const scannerModule = path.join(root, 'src', 'observability', 'secrets.js')

// The one driver-lane module custody may import, and the only names it may take.
const ALLOWED = [{ module: path.join(driverDir, 'rcon.js'), names: ['createRcon'] }]

const SCANNER_NAMES = ['scanSecrets', 'redactSecrets', 'REDACTION_TAG']

// Every .js file under src/custody/, at any depth. A subdirectory must not become
// a way around the boundary.
function custodyFiles (dir = custodyDir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return custodyFiles(full)
    return entry.name.endsWith('.js') ? [full] : []
  })
}

// Every statement that names a module: a named import with an optional default,
// a default import, a namespace import, a star re-export, a side-effect import,
// and a dynamic import with a quoted literal. Each pattern is anchored to the
// statement's own shape, so a `from` that sits in unrelated code cannot stretch
// one statement into another.
function statements (source) {
  const found = []
  // import Default, { a, b as c } from 'x' / export { a } from 'x'
  for (const match of source.matchAll(/\b(?:import|export)\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g)) {
    const names = [match[1], ...match[2].split(',')]
      .filter(Boolean)
      .map(part => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean)
    found.push({ names, specifier: match[3] })
  }
  // import Default from 'x'
  for (const match of source.matchAll(/\b(?:import|export)\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
    found.push({ names: [match[1]], specifier: match[2] })
  }
  // import * as ns from 'x'
  for (const match of source.matchAll(/\b(?:import|export)\s+\*\s*as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"]/g)) {
    found.push({ names: [match[1]], specifier: match[2] })
  }
  // export * from 'x': the whole module, so no names to check against the allowlist.
  for (const match of source.matchAll(/\bexport\s+\*\s*from\s*['"]([^'"]+)['"]/g)) {
    found.push({ names: [], specifier: match[1] })
  }
  // import 'x'
  for (const match of source.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    found.push({ names: [], specifier: match[1] })
  }
  // import('x')
  for (const match of source.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    found.push({ names: [], specifier: match[1] })
  }
  return found
}
const resolve = (file, specifier) => path.resolve(path.dirname(file), specifier)

// A computed specifier is a hole this test cannot see through, so it fails the
// file instead of passing it. Only `import('x')` with one quoted literal counts
// as visible, and a CommonJS `require` is not visible at all, so a
// `createRequire` in custody fails the file too.
function hiddenTargets (source) {
  const computed = [...source.matchAll(/\bimport\s*\(/g)]
    .filter(match => !/^\s*['"][^'"]+['"]\s*\)/.test(source.slice(match.index + match[0].length)))
    .length
  const commonjs = [...source.matchAll(/\bcreateRequire\s*\(/g)].length
  return computed + commonjs
}

test('custody imports nothing from the driver lane except the RCON adapter', () => {
  for (const file of custodyFiles()) {
    const source = fs.readFileSync(file, 'utf8')
    const relative = path.relative(root, file)
    assert.equal(hiddenTargets(source), 0, `${relative} hides an import target behind a computed specifier or createRequire, so this test cannot see where it points`)
    for (const statement of statements(source)) {
      const target = resolve(file, statement.specifier)
      const entersDriver = target === driverDir || target.startsWith(driverDir + path.sep)
      if (!entersDriver) continue
      const allowed = ALLOWED.find(entry => entry.module === target)
      assert.ok(allowed, `${relative} imports ${statement.specifier}: custody may not depend on the driver lane`)
      const names = statement.names
      assert.ok(names.length > 0, `${relative} takes ${statement.specifier} as a whole module, so import its names instead`)
      for (const name of names) {
        assert.ok(allowed.names.includes(name), `${relative} imports ${name} from the driver lane, which is not on the allowlist`)
      }
    }
  }
})

test('the secret scanner has one home, and the driver lane keeps only its evidence helpers', () => {
  assert.ok(fs.existsSync(scannerModule), 'src/observability/secrets.js holds the scanner')

  const scanner = fs.readFileSync(scannerModule, 'utf8')
  for (const name of SCANNER_NAMES) {
    assert.match(scanner, new RegExp(`export (?:function|const) ${name}\\b`), `src/observability/secrets.js exports ${name}`)
  }

  // A re-export would leave the driver lane as a second door to the same shapes,
  // and the import direction would still run custody -> driver.
  const checksSource = fs.readFileSync(checksModule, 'utf8')
  for (const name of SCANNER_NAMES) {
    assert.doesNotMatch(checksSource, new RegExp(`\\b${name}\\b`), `src/driver/checks.js still mentions ${name}`)
  }
  assert.doesNotMatch(checksSource, /export\s*\*/, 'src/driver/checks.js star-exports a module, which would re-open the door without naming the shapes')
  for (const statement of statements(checksSource)) {
    assert.notEqual(resolve(checksModule, statement.specifier), scannerModule,
      'src/driver/checks.js imports or re-exports the scanner, so import it where it is used instead')
  }
})
