// Deliberately failing test: proves the required "check" context blocks a merge
// into main. Deleted in the next commit of the same branch.
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('merge proof: this assertion fails on purpose', () => {
  assert.equal(1, 2, 'deliberately failing to prove the required check blocks the merge')
})
