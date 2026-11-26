# Keep relative-move frames out of the entity ring

The entity ring this file was named for is the keyed entity domain now
([key-the-entity-domain-by-slot.md](key-the-entity-domain-by-slot.md)); the name
stayed because the decision did.

Entity state replays in capture order, so an attaching client ends where the
backend did. Absolute positions live in the `entity` domain. Relative-move
deltas live in `generic`, because they are per-tick traffic and an entity slot
holds the newest frame for its key: promoting them would replay the last delta
and none of the ones it built on, and the client would land where the backend
never put it. So the deltas stay in `generic` and replay merged with the entity
domain by capture sequence rather than in their section's place. `client-state` decodes them, because otherwise state parity
ignores them on both sides and cannot see the position a moved entity ends at.

## Considered options

- **Promote all position-bearing frames into the entity ring.** Rejected:
  per-tick delta traffic would evict spawn and metadata frames from the
  2048-entry bound.
- **Keep the plain FIFO ring and accept the eviction.** Rejected: an attaching
  client would miss whole entities, and state parity could not see a missing
  `spawn_entity`, because the client model builds an entity from
  `entity_metadata` alone. The ring has since been replaced by the keyed entity
  domain (#213).
- **Replace the ring with per-entity state, last absolute frame plus later
  deltas.** Rejected when this decision was taken, on the ground that a merged
  per-entity state needs a re-encoding pass inside a module whose contract is no
  decode and no encode. That ground no longer holds: the keying reads the
  metadata index the backend leg already decoded and keeps the raw frame per
  slot, so nothing is re-encoded. The domain is keyed by entity and slot now
  (#213), and this decision stands on its own reason rather than on that one. See
  [key-the-entity-domain-by-slot.md](key-the-entity-domain-by-slot.md).
- **Replay the two rings as two sections, in a fixed order.** Rejected: the
  cache routes an entity's absolutes and deltas to different rings, so a section
  order applies every delta after every absolute. An entity that moved before a
  correction landed ends at the correction plus the deltas it had already
  applied. That is the defect in issue #35.
- **Replay the whole `generic` ring merged with `entities`.** Rejected: it drags
  frames that have nothing to do with entity positions in front of
  `inventories` and `latest`, and a `close_window` then replays before the
  `window_items` it closed.
- **Replay the relative-move frames merged with `entities`, and leave the rest
  of `generic` in its place.** Kept. Every cached entry already carries a
  sequence, so the merge needs no new field and no eviction policy.

## Consequences

- `join-synth.replayFrames` owns the order, and `state-parity.snapshotFrames`
  calls it. A second copy of the order would let the parity expectation pass
  against a replay nobody sends.
- `client-state` decodes the frames the merge covers and `PARITY_FRAME_NAMES`
  captures them, so N13 compares where a moved entity ends and what state a body
  holds. Without the decode the check was blind to the defect both sides agreed
  on.
- A protocol rename costs a stale value, not a crash. The cache's
  `ENTITY_FRAMES` tracks which names route to the entity domain, join-synth's
  `ENTITY_GENERIC_FRAMES` tracks which generic names carry a body's state, and a
  name missing from both keeps its section's place.
  `test/core/entity-body-frames.test.js` derives the body-carrying frames from
  the vendored protocol and fails until a new one lands in one of the two lists
  or in its table of frames that keep their place.
- `vehicle_move` is absolute and stays in `generic`'s place, undecoded by the
  parity model. A replayed vehicle can sit one frame stale, and the error does
  not accumulate. `move_minecart` stays with it, for the same reason.
- The rule covers more than relative moves. It is "a generic frame whose value
  the client keeps for a body". Issue #222 offers one mechanism or the other,
  and the two hazards are different, so this change uses each where it is exact:
  `entity_update_attributes`,
  `entity_equipment`, and `set_passengers` replay by the same merge (#222). The
  effect pair goes the other way, into one slot: a slot outlives the 512-frame
  generic ring, so a merged removal would age out while its add stayed and the
  replay would keep an effect the backend removed. The file keeps its name
  because the decision does: these frames stay out of the entity domain.
