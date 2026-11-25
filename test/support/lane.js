// The lane this worktree's scripts derive (#279), mirrored once for every test that
// needs it: the worktree's short commit, then a short hash of its path, so two
// checkouts at one commit are two lanes.
//
// The mirror is the point of the cases that use it: a script that typed a name
// instead of deriving one could not match it. One mirror is one oracle, so the test
// files that assert against a derived lane cannot drift apart.
//
// `pwd -P` in scripts/gate-lane.sh, `realpathSync` here: one worktree has one path, so
// it hashes to one lane however the caller spelled its way in.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on
// its own.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const WORKTREE = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'))
export const COMMIT = spawnSync('git', ['-C', WORKTREE, 'rev-parse', '--short=7', 'HEAD'], { encoding: 'utf8' }).stdout.trim()

// POSIX cksum keeps this to what every machine has, which is what the script does.
const crc = text => Number(spawnSync('cksum', [], { input: text, encoding: 'utf8' }).stdout.trim().split(/\s+/)[0])
export const pathHash = dir => (crc(dir) % 0x1000000).toString(16).padStart(6, '0')
export const instanceOf = (dir, commit = COMMIT) => commit + '-' + pathHash(dir)
export const INSTANCE = instanceOf(WORKTREE)
export const LANE = 'monoplayer-gate-' + INSTANCE
