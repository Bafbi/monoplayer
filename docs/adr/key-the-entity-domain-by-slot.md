# Key the entity domain by entity and slot

Entity state is a map per entity, not a stream. Two frames about one body are
usually two different facts: `entity_metadata` carries only the indexes it
changed, so a frame that sets index 5 says nothing about index 6. A FIFO over
frames therefore made metadata volume evict `spawn_entity`, and a reattaching
client got a body it never spawned, or a correction for a body it never had:
present in the tab list, absent from the world.

The cache keys every entity frame by `entityId` and by the slot of state it
carries, and keeps the newest raw frame for each slot. A slot is:

- one metadata index, `metadata:<key>`, because the client merges each pair;
- one effect, `effect:<id>`, because the newest frame about that effect is its
  state: the add and the removal share the slot, so neither the replay order nor
  the generic ring's bound can separate them (#222);
- one `destroy`, because a removal means the same for the whole body;
- any other entity frame under its own name, because it carries a whole value:
  a spawn, a teleport, a velocity.

Each slot holds the bytes the backend sent. The domain locates an index; it
never rebuilds a frame, so the replay stays a raw-buffer replay.

## Considered options

- **Keep the FIFO over frames.** Rejected: it is the defect. Move and metadata
  traffic for one entity evicts the frame that tells the client the entity
  exists, and a stale position is cheap while a missing body is not.
- **Per-entity latest-wins for the whole body.** Rejected: the body is not one
  value. A newer teleport would drop the spawn that gives the entity its model
  and its first position.
- **Decode `entity_metadata` and re-encode one merged metadata frame.** Rejected:
  a re-encoded frame is a frame the server never sent, and the module's contract
  is that a replayed frame is the captured one.
- **Key the metadata indexes and leave the other entity frames in a FIFO.**
  Rejected: `spawn_entity` is the frame that goes missing, so the fix would
  leave the reported symptom in place.
- **Key by `(entityId, slot)` and keep the raw frame per slot.** Kept. The
  decoded metadata index is a field the backend leg already hands over, so this
  needs no decode of its own: `data.metadata[i].key` is in the frame the leg
  passed in.
- **Truncate a record's head at the depth bound.** Rejected: a dropped index
  replays at the client's default, which is the defect arriving by another
  route. The whole entity goes instead.
- **A record per id a removal names, tracked or not.** Rejected: every body the
  join prefix spawned is untracked here, so a busy world's removals would each
  take a record and evict the bodies that are still alive. An untracked removal
  waits in a bounded list instead.
- **Let a dropped body rebuild itself from its next metadata frame.** Rejected:
  the rebuilt record has no spawn, so the replay hands the client a body it
  cannot model — the reported symptom, reached from the bound instead of the
  ring. The id stays dropped until a spawn.
- **Flush the entity map in the composition root.** Rejected: `respawn` is
  ordinary play state that no other module inspects, and a hook a caller must
  remember is a hook that is missing after the next refactor. The cache sees
  every play frame, so the flush is its own.

## Consequences

- Three bounds, because two of them multiplied. `maxEntitySlots` (128 per entity)
  drops the whole entity past its depth (`metrics.overflows.entityDepth`). 128 is
  the count that clears any real body with room: the protocol defines 43 metadata
  indexes, 8 whole-value frames, and one slot per effect id. `maxEntities`
  (2048) evicts the least recently updated body (`metrics.overflows.entity`).
  `maxEntityFrames` (32768) bounds the slots the domain holds
  (`metrics.overflows.entityFrames`): without it the ceiling is 2048 x 128
  entries, and 32768 small frames with their decoded metadata is about 3 MB,
  which is what caps the memory in practice.
- Two kinds of state live outside a record, and both exist because the bound must
  never spend a live body on a dead one. A removal for an id the domain never
  held — every body the join prefix spawned is that — waits in a bounded list
  instead of taking a record: it is still one raw frame, it still names the ids
  it removes, and a removal storm cannot evict the bodies that are alive. An id a
  bound dropped is remembered, and later frames for it are suppressed
  (`metrics.entitySuppressed`) until a `spawn_entity` or `add_entity` starts
  the body again: replaying metadata for a body with no spawn is the defect
  itself, and #218 counts that same gap in production. Both travel with
  `snapshot()` (`entityDropped`), so a restore suppresses the same frames.
- A metadata frame with N indexes occupies N slots and is still one entry in
  `snapshot().entities`: the section is deduplicated by entry and sorted by
  capture sequence, so `join-synth`, which merges that list with the generic move
  frames by `seq`, is unchanged.
- A play `login` and a `respawn` flush the domain (`metrics.entityFlushes`).
  26.x has no separate dimension-change frame; `respawn` carries the new
  dimension. A restored snapshot is not flushed: `restore` rebuilds the map
  through the capture path's own keying.
- Superseding a slot drops a frame the client-state model cannot miss, because
  the model applies the same slot last-write-wins. That is why the equivalence
  property in `test/core/cache-equivalence.test.js` is still the whole stream for
  these cases, rather than the suffix the old ring forced.
- A transient frame keeps one slot per body like the rest, so the newest
  `entity_sound_effect` or `entity_velocity` per entity replays and an older one
  does not. A replayed sound is one the attach is about to make stale anyway, and
  the old ring only replayed them because it had no opinion; this is the one
  client-visible difference the keying accepts on purpose. `entity_sound_effect`
  without an entity carries `entityId: 0`, so all of those share one slot.
- The bounds are defaults, not measurements. Nothing here says how many entities
  a real backend tracks; that measurement is its own ticket, and read
  `stats().sizes.entities`, `stats().entitySlots`, `stats().entityRemovals`
  and the three overflow counters until it lands. The login and warm log lines
  carry `sizes`; `entitySlots` and the counters reach an operator through
  `stats()` and the attach record #218 adds.
- Relative-move frames stay in `generic`: a slot holds one frame per key, so
  routing per-tick deltas here would replay the last delta and none of the ones
  it built on. See [keep-relative-moves-out-of-the-entity-ring.md](keep-relative-moves-out-of-the-entity-ring.md).
