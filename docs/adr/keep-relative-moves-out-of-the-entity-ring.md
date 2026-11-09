# Keep relative-move frames out of the entity ring

The entity ring holds every frame that tells an attaching client where an entity
is, so that their capture order survives the replay. The relative-move frames
(`rel_entity_move`, `entity_move_look`, `entity_look`) are the exception: they
replay from the `generic` ring, after every `entity` frame. They are per-tick
deltas, and the entity ring is a 2048-entry FIFO, so promoting them would let
move traffic evict `spawn_entity` and `entity_metadata`, the frames that tell the
client the entity exists. A stale position is cheap. A missing entity is not.

## Considered options

- **Promote all position-bearing frames into the entity ring.** Rejected:
  per-tick delta traffic would evict spawn and metadata frames from the
  2048-entry bound.
- **Keep the plain FIFO ring and accept the eviction.** Rejected: an attaching
  client would miss whole entities, and state parity cannot see a missing
  `spawn_entity`, because the client model builds an entity from
  `entity_metadata` alone.
- **Replace the ring with per-entity state, last absolute frame plus later
  deltas.** Rejected for now: `entity_metadata` carries only changed keys and the
  attach stream replays raw buffers, so a merged per-entity state needs a
  re-encoding pass inside a module whose contract is no decode and no encode.
- **Replay the two rings in capture order.** This is the direction kept. Every
  cached entry already carries a capture sequence, so the merge needs no new
  field and no eviction policy. It is tracked as
  [issue #35](https://github.com/Bafbi/monoplayer/issues/35) and lands after the
  online rung proves the current attach cut.

## Consequences

- A delta captured before the last absolute frame replays after it, so an
  attaching client ends at that absolute plus the deltas it had already applied.
  Only a live client shows it: the parity model does not decode the relative
  moves, so N13 cannot.
- `ENTITY_FRAMES` is the one place that tracks protocol renames for entity
  routing. A name missing from it routes to `generic` and replays after the
  entity ring.
