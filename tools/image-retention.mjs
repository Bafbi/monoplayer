#!/usr/bin/env node
// Which image tags GHCR can lose, and which it cannot (#118).
//
// The package holds one sha-<7> tag per merge and per branch build, and nothing
// pruned them. Deleting a tag is not a tidy-up: it can garbage-collect the
// digest a lane is running, and the next pod start then fails to pull. So the
// decision is an allowlist, never a count.
//
//   node tools/image-retention.mjs plan  [--json] [--versions FILE] [options]
//   node tools/image-retention.mjs apply --plan FILE [--dry-run] [options]
//
// Options, both commands:
//   --deploy <file>        the deploy branch's kustomization. Its digest pin is
//                          the image the live lane runs. Required.
//   --manifests <dir>      a directory of manifests to read pins from. Repeatable.
//                          Default: deploy
//   --pins <file>          the pin list: one tag or sha256: digest per line, for
//                          a pin no manifest carries. Default: deploy/pins.txt
//   --keep <n>             how many of the newest sha-* tags to keep. Default: 20
//   --min-age-days <n>     the grace period: never delete a version younger than
//                          this. Default: 1
//   plan only: --versions <file>  plan from a captured API response instead of
//                          the live package, so a reviewer can see the list
//                          without a token.
//   plan only: --out <file>       write the plan as JSON to this file too
//   plan only: --json             print the plan as JSON, not as a table
//
// What the allowlist holds, and why each one is on it:
//
//   main                 the moving tag the manifests on main reference. The
//                        live lane's manifests say :main, so a pod that pulls
//                        by tag must never find it missing.
//   the deploy digest    the deploy branch pins the running image by digest.
//                        Argo re-syncs it, and a restart must pull it.
//   a manifest pin       any tag or digest named by a manifest under deploy/.
//                        The dev, gate, and testbed lanes live there, so a lane
//                        that pins by digest is protected the moment the
//                        manifest lands.
//   a pin-list entry     deploy/pins.txt, for a pin no manifest carries. The dev
//                        lane's "mise run dev:image sha-<7>" only exists at
//                        runtime, so the operator writes it here.
//   the last 20 sha-*    so a bisect can still pull a recent image.
//   anything younger     one grace day, not a retention rule: a build that landed
//   than 1 day           today may already be running somewhere, and no pin file
//                        names it yet. Longer pins belong in deploy/pins.txt.
//   any other tag        fail closed. Retention does not delete a tag it cannot
//                        account for, so a "v1.2.3" or a hand-made tag stays.
//   an untagged version  buildx attaches provenance, so untagged versions exist
//                        and some are children of a tagged index. Not ours.
//
// Exit status: 0 planned or done; 1 the registry or a --versions file failed;
// 2 usage, or the allowlist could not be read, or a deletion target is pinned.
//
// Deleting only versions that carry a sha-* tag means untagged leftovers stay.
// The tag count falls; the version count may not. The plan says both.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DEFAULT_KEEP_LAST = 20
export const DEFAULT_MIN_AGE_DAYS = 1
export const IMAGE = 'ghcr.io/bafbi/monoplayer'
export const OWNER = 'Bafbi'
export const PACKAGE = 'monoplayer'
export const DEFAULT_API = 'https://api.github.com'

// The tag shape image.yaml and image-branch.yaml push.
const SHA_TAG = /^sha-[0-9a-f]{7,40}$/
const DIGEST = /^sha256:[0-9a-f]{64}$/

const USAGE = `usage: node tools/image-retention.mjs <plan|apply> [options]

  plan                  print what would be deleted, and delete nothing
  apply --plan <file>   delete the ids in a reviewed plan file

  --deploy <file>       the deploy branch's kustomization (required)
  --manifests <dir>     read pins from this directory (repeatable, default deploy)
  --pins <file>         the pin list (default deploy/pins.txt)
  --dry-run             apply without deleting

  plan only:
  --keep <n>            newest sha-* tags to keep (default ${DEFAULT_KEEP_LAST})
  --min-age-days <n>    grace period: keep anything younger (default ${DEFAULT_MIN_AGE_DAYS})
  --versions <file>     plan from a captured API response instead of the package
  --out <file>          write the plan as JSON to this file as well
  --json                print the plan as JSON, not as a table
`

class UsageError extends Error {}
class Refused extends Error {}

function usage (message) {
  throw new UsageError(message)
}

// ---------------------------------------------------------------------------
// The allowlist, read out of the tree
// ---------------------------------------------------------------------------

// Every tag and digest a manifest names for this image. A digest lands in
// digests; a tag reference lands in tags. A reference to another image is not
// this job's business, so it is dropped: deploy/driver/toxiproxy.yaml names
// ghcr.io/shopify/toxiproxy, and its tag must not enter the allowlist.
export function parsePins (text) {
  const tags = new Set()
  const digests = new Set()

  // The image the current kustomize entry names, so a newTag below it belongs to
  // that image and not to the one after it.
  let named = null

  for (const raw of text.split('\n')) {
    // A trailing comment is how someone says which lane a pin belongs to, so it
    // must not hide the pin. A '#' cannot appear inside an image reference.
    const line = raw.split('#')[0]

    const ref = line.match(/^\s*-?\s*(?:image|name):\s*['"]?([^\s'"#]+)['"]?\s*$/)
    if (ref !== null) {
      const value = ref[1]
      const at = value.indexOf('@')
      const name = at === -1 ? value.replace(/:[^:/]*$/, '') : value.slice(0, at)
      named = name === IMAGE ? IMAGE : null
      if (named === null) continue
      if (at !== -1) {
        const digest = value.slice(at + 1)
        if (DIGEST.test(digest)) digests.add(digest)
        continue
      }
      const colon = value.lastIndexOf(':')
      if (colon > value.lastIndexOf('/')) tags.add(value.slice(colon + 1))
      continue
    }

    // newTag is kustomize's own tag pin, and the form a lane is most likely to
    // reach for. It carries no image name of its own, so it needs the entry above.
    const newTag = line.match(/^\s*newTag:\s*['"]?([^\s'"#]+)['"]?\s*$/)
    if (newTag !== null) {
      if (named === IMAGE) tags.add(newTag[1])
      continue
    }

    // The kustomize images block can carry the pin as its own key.
    const pinned = line.match(/^\s*digest:\s*['"]?(sha256:[0-9a-f]{64})['"]?\s*$/)
    if (pinned !== null) digests.add(pinned[1])
  }

  return { tags, digests }
}

const MANIFEST = /\.ya?ml$/

// Read every pin the tree carries. A directory that is not there is an error,
// not an empty answer: a job that reads no pins must not delete anything.
export function readPins (dirs) {
  const pins = { tags: new Set(), digests: new Set() }

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!MANIFEST.test(entry.name)) continue
      const found = parsePins(fs.readFileSync(full, 'utf8'))
      for (const tag of found.tags) pins.tags.add(tag)
      for (const digest of found.digests) pins.digests.add(digest)
    }
  }

  for (const dir of dirs) {
    try {
      walk(dir)
    } catch (error) {
      throw new Refused('the manifests under ' + dir + ' cannot be read: ' + error.message)
    }
  }
  return pins
}

// The pin list: one tag or digest per line, '#' starts a comment. Its whole job
// is to hold a pin no manifest can, so a missing file is a refusal.
export function readPinList (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Refused('the pin list ' + file + ' cannot be read: ' + error.message)
  }
  const pins = { tags: new Set(), digests: new Set() }
  for (const [index, line] of text.split('\n').entries()) {
    const value = line.split('#')[0].trim()
    if (value === '') continue
    if (DIGEST.test(value)) {
      pins.digests.add(value)
      continue
    }
    // A full image reference is what kubectl and the branch workflow print, and it
    // is the likeliest paste. It matches no package tag, so accepting it would
    // protect nothing while looking like it did.
    if (SHA_TAG.test(value) || value === 'main') {
      pins.tags.add(value)
      continue
    }
    throw new Refused(
      'the pin list ' + file + ' line ' + (index + 1) + ' is not a pin: ' + value +
      '. Write sha-<7> or sha256:<64>, not a full image reference.'
    )
  }
  return pins
}

// The live pin: the digest the deploy branch carries. Read through --deploy so
// the workflow reads the deploy branch's own file, never main's.
export function readDeployPin (file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Refused('the deploy pin ' + file + ' cannot be read: ' + error.message)
  }
  const pins = parsePins(text)
  if (pins.digests.size === 0) {
    throw new Refused('the deploy pin ' + file + ' names no ' + IMAGE + ' digest, so the live image is unknown')
  }
  return pins
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

// One API version, as the planner reads it.
export function toEntry (version) {
  const tags = version?.metadata?.container?.tags ?? []
  return {
    id: version.id,
    digest: version.name,
    tags: [...tags],
    created: Date.parse(version.created_at ?? version.updated_at ?? '') || 0
  }
}

const reasonOf = (entry, decide) => ({ id: entry.id, digest: entry.digest, tags: entry.tags, reason: decide })

// Keep or remove every version. Pure: the clock, the pins, and the versions come
// in as arguments, so a fixture is the whole input.
export function plan ({
  versions,
  pins,
  keepLast = DEFAULT_KEEP_LAST,
  minAgeDays = DEFAULT_MIN_AGE_DAYS,
  now = Date.now()
}) {
  const entries = versions.map(toEntry)
  const floor = now - minAgeDays * 24 * 60 * 60 * 1000

  // The window: the newest keepLast sha-* tags across the whole package. A
  // branch build and a merge compete for the same slots, which is the point:
  // either can be worth bisecting.
  const newest = entries
    .flatMap(entry => entry.tags.filter(tag => SHA_TAG.test(tag)).map(tag => ({ tag, created: entry.created })))
    .sort((a, b) => b.created - a.created)
  const window = new Set(newest.slice(0, keepLast).map(item => item.tag))

  const keep = []
  const remove = []

  for (const entry of entries) {
    const keepWith = reason => keep.push(reasonOf(entry, reason))

    if (entry.tags.includes('main')) {
      keepWith('the main tag')
      continue
    }
    const pinnedTag = entry.tags.find(tag => pins.tags.has(tag))
    if (pinnedTag !== undefined) {
      keepWith('pinned by tag: ' + pinnedTag)
      continue
    }
    if (pins.digests.has(entry.digest)) {
      keepWith('pinned by digest')
      continue
    }
    if (entry.tags.length === 0) {
      keepWith('untagged: left alone, it may be a child of a tagged index')
      continue
    }
    const unmodelled = entry.tags.find(tag => !SHA_TAG.test(tag))
    if (unmodelled !== undefined) {
      keepWith('not a sha-* tag: ' + unmodelled)
      continue
    }
    if (entry.tags.some(tag => window.has(tag))) {
      keepWith('sha-* within the last ' + keepLast)
      continue
    }
    if (entry.created > floor) {
      keepWith('inside the ' + minAgeDays + '-day grace period')
      continue
    }
    remove.push(reasonOf(entry, 'sha-* outside the last ' + keepLast + ', past the grace period'))
  }

  // The deletion set is what is left after the allowlist, so this holds by
  // construction. Assert it anyway: those two lines are the whole failure mode of
  // this tool, and a refactor must not be able to lose them quietly.
  for (const entry of remove) {
    if (pins.digests.has(entry.digest)) throw new Error('refusing: ' + entry.digest + ' is pinned by digest')
    if (entry.tags.some(tag => pins.tags.has(tag))) throw new Error('refusing: a tag of ' + entry.digest + ' is pinned')
  }

  return {
    keepLast,
    minAgeDays,
    pins: { tags: [...pins.tags].sort(), digests: [...pins.digests].sort() },
    keep,
    remove,
    counts: {
      versions: entries.length,
      keep: keep.length,
      remove: remove.length,
      untagged: entries.filter(entry => entry.tags.length === 0).length
    }
  }
}

export function report (result) {
  const lines = []
  lines.push(
    'image-retention: ' + result.counts.versions + ' versions, keep ' + result.counts.keep +
    ', would delete ' + result.counts.remove +
    ' (window ' + result.keepLast + ' sha-*, grace ' + result.minAgeDays + ' day(s))'
  )
  // The allowlist itself, before the per-version verdicts. A pin that was read as
  // something else is invisible unless the reviewer can see what was read.
  lines.push(
    '  pins: ' + (result.pins.tags.join(', ') || 'no tag') +
    ' | ' + (result.pins.digests.length + ' digest(s)')
  )
  for (const entry of result.keep) {
    lines.push('  keep  ' + entry.digest + '  ' + (entry.tags.join(',') || '(untagged)') + '  ' + entry.reason)
  }
  lines.push('  would delete ' + result.counts.remove + ':')
  for (const entry of result.remove) {
    lines.push('  delete ' + entry.digest + '  ' + entry.tags.join(',') + '  ' + entry.reason)
  }
  if (result.counts.untagged > 0) {
    lines.push(
      '  ' + result.counts.untagged + ' untagged version(s) stay: buildx provenance is not a tag,' +
      ' and a child of a tagged index must not go'
    )
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

const HEADERS = (token) => ({
  accept: 'application/vnd.github+json',
  authorization: 'Bearer ' + token,
  'x-github-api-version': '2022-11-28',
  'user-agent': 'monoplayer-image-retention'
})

// A header bag, from a fetch Response or a plain object in a test.
function header (headers, name) {
  if (headers === undefined || headers === null) return null
  if (typeof headers.get === 'function') return headers.get(name)
  return headers[name] ?? null
}

// The next page, from the Link header GitHub sends. per_page and page are not
// documented on the user-owned endpoint, so the loop follows the header it does
// send and only falls back to a page number when a full page arrives without one.
export function nextPage (link, page) {
  if (typeof link === 'string') {
    const next = link.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (next !== null) return next[1]
  }
  return page
}

export async function listVersions ({
  token,
  owner = OWNER,
  pkg = PACKAGE,
  api = DEFAULT_API,
  fetchImpl = fetch,
  perPage = 100
}) {
  const base = api + '/users/' + owner + '/packages/container/' + pkg + '/versions?per_page=' + perPage
  const versions = []
  let url = base + '&page=1'

  for (;;) {
    const response = await fetchImpl(url, { headers: HEADERS(token) })
    if (response.ok !== true) {
      // The scope headers say what the token can do, which is the difference
      // between a missing read:packages and a package the repo cannot see.
      const body = typeof response.text === 'function' ? await response.text() : ''
      const scopes = header(response.headers, 'x-accepted-oauth-scopes')
      throw new Error(
        'cannot list ' + owner + '/' + pkg + ' versions: HTTP ' + response.status +
        (scopes === null ? '' : ' (this endpoint accepts: ' + scopes + ')') + ' ' + body.trim()
      )
    }
    const body = await response.json()
    versions.push(...body)
    const linked = header(response.headers, 'link')
    if (linked !== null) {
      const next = nextPage(linked, url)
      if (next === url) return versions
      url = next
      continue
    }
    if (body.length < perPage) return versions
    url = base + '&page=' + (Number(new URL(url).searchParams.get('page') ?? '1') + 1)
  }
}

export async function deleteVersion ({
  id,
  token,
  owner = OWNER,
  pkg = PACKAGE,
  api = DEFAULT_API,
  fetchImpl = fetch
}) {
  const url = api + '/users/' + owner + '/packages/container/' + pkg + '/versions/' + id
  const response = await fetchImpl(url, { method: 'DELETE', headers: HEADERS(token) })
  // 404 covers a second run of a plan whose ids are already gone, and GitHub's
  // own docs warn a repeat delete is not an error. Anything else is a failure.
  if (response.status === 404) return { gone: true }
  if (response.ok !== true) {
    const body = typeof response.text === 'function' ? await response.text() : ''
    throw new Error('cannot delete version ' + id + ': HTTP ' + response.status + ' ' + body.trim())
  }
  return { gone: false }
}

// ---------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------

function parseArgs (argv) {
  const [command, ...rest] = argv
  if (!command) usage('no command given')
  const options = {
    deploy: null,
    manifests: [],
    pins: 'deploy/pins.txt',
    keep: DEFAULT_KEEP_LAST,
    minAgeDays: DEFAULT_MIN_AGE_DAYS,
    versions: null,
    plan: null,
    out: null,
    json: false,
    dryRun: false
  }
  // Which flags the command line actually carried, so apply can refuse a
  // planning flag instead of quietly ignoring one that equals a default.
  const seen = new Set()
  const numbers = { '--keep': 'keep', '--min-age-days': 'minAgeDays' }
  const strings = {
    '--deploy': 'deploy',
    '--pins': 'pins',
    '--versions': 'versions',
    '--plan': 'plan',
    '--out': 'out',
    '--manifests': 'manifests'
  }

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index]
    seen.add(arg)
    if (arg === '--json') { options.json = true; continue }
    if (arg === '--dry-run') { options.dryRun = true; continue }
    if (arg in numbers) {
      const value = rest[index + 1]
      if (value === undefined) usage(arg + ' needs a number')
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 0) usage(arg + ' needs a whole number, not ' + value)
      options[numbers[arg]] = parsed
      index += 1
      continue
    }
    if (arg in strings) {
      const value = rest[index + 1]
      if (value === undefined) usage(arg + ' needs a value')
      if (strings[arg] === 'manifests') options.manifests.push(value)
      else options[strings[arg]] = value
      index += 1
      continue
    }
    usage('unknown option: ' + arg)
  }

  if (command !== 'plan' && command !== 'apply') usage('unknown command: ' + command)
  if (options.deploy === null) usage('--deploy <file> is required: the live image is a digest the deploy branch pins')
  if (command === 'apply' && options.plan === null) usage('apply needs --plan <file>')
  if (command === 'apply') {
    // apply deletes the reviewed list. A planning knob would look like it filtered
    // that list and would not, so it is a usage error rather than a silent no-op.
    for (const flag of ['--keep', '--min-age-days', '--versions', '--out', '--json']) {
      if (seen.has(flag)) usage(flag + ' belongs to plan, not apply')
    }
  }
  if (options.manifests.length === 0) options.manifests.push('deploy')
  return { command, options }
}

export async function main (argv, io = process) {
  const out = line => io.stdout.write(line + '\n')
  const err = line => io.stderr.write(line + '\n')

  try {
    const { command, options } = parseArgs(argv)

    const pins = readPins(options.manifests)
    const deploy = readDeployPin(options.deploy)
    const list = readPinList(options.pins)
    for (const tag of deploy.tags) pins.tags.add(tag)
    for (const digest of deploy.digests) pins.digests.add(digest)
    for (const tag of list.tags) pins.tags.add(tag)
    for (const digest of list.digests) pins.digests.add(digest)

    if (command === 'plan') {
      const token = process.env.GH_TOKEN ?? ''
      const versions = options.versions !== null
        ? JSON.parse(fs.readFileSync(options.versions, 'utf8'))
        : await listVersions({ token, api: process.env.GH_API ?? DEFAULT_API })
      const result = plan({ versions, pins, keepLast: options.keep, minAgeDays: options.minAgeDays })
      if (options.out !== null) fs.writeFileSync(options.out, JSON.stringify(result, null, 2) + '\n')
      out(options.json ? JSON.stringify(result, null, 2) : report(result))
      return 0
    }

    // apply: exactly the reviewed list, and only after the allowlist agrees.
    const reviewed = JSON.parse(fs.readFileSync(options.plan, 'utf8'))
    if (!Array.isArray(reviewed.remove)) throw new Refused('the plan ' + options.plan + ' carries no removal list')
    // A hand-edited plan is the one input apply cannot trust. An entry with no id
    // or no tag list would slip past the guards below.
    const malformed = reviewed.remove.filter(entry =>
      !Number.isInteger(entry.id) || entry.id <= 0 || !Array.isArray(entry.tags))
    if (malformed.length > 0) {
      throw new Refused(
        'refusing: ' + malformed.length + ' plan entries carry no usable id or tag list: ' +
        JSON.stringify(malformed.slice(0, 3))
      )
    }

    // The pins, and the planner's own rules: a plan must never name the version
    // that carries main, or one whose tag retention does not model. The plan
    // should not contain either, so an entry that does was edited.
    const offenders = reviewed.remove.filter(entry =>
      pins.digests.has(entry.digest) ||
      entry.tags.some(tag => pins.tags.has(tag)) ||
      entry.tags.some(tag => !SHA_TAG.test(tag)))
    if (offenders.length > 0) {
      throw new Refused(
        'refusing: ' + offenders.length + ' planned deletion(s) cannot go (pinned now, or not a sha-* tag): ' +
        offenders.map(entry => entry.digest + ' ' + entry.tags.join(',')).join('; ')
      )
    }

    if (reviewed.remove.length === 0) {
      out('apply: the plan removes nothing')
      return 0
    }

    const token = process.env.GH_TOKEN ?? ''
    const api = process.env.GH_API ?? DEFAULT_API
    if (!options.dryRun) {
      // A 404 from a delete means "already gone", which is only true if the
      // package itself is reachable. Prove that once, so a wrong owner or a token
      // without access fails loudly instead of reporting nineteen tidy successes.
      await listVersions({ token, api })
    }
    for (const entry of reviewed.remove) {
      if (options.dryRun) {
        out('would delete ' + entry.id + ' ' + entry.digest + ' ' + entry.tags.join(','))
        continue
      }
      const { gone } = await deleteVersion({ id: entry.id, token, api })
      out((gone ? 'already gone ' : 'deleted ') + entry.id + ' ' + entry.digest + ' ' + entry.tags.join(','))
    }
    return 0
  } catch (error) {
    err('image-retention: ' + String(error?.message ?? error))
    if (error instanceof UsageError) {
      err(USAGE)
      return 2
    }
    if (error instanceof Refused) return 2
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2))
}
