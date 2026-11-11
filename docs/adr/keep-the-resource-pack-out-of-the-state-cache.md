# Keep the resource pack out of the state cache

A server sends `add_resource_pack` once per backend connection and never again,
because the puppet's own accept closes the round. The only copy a later client
can receive is the one Monoplayer keeps. As ordinary state a play-state pack
landed in the `generic` ring, a 512-entry FIFO: on the live server 512 generic
frames follow the pack inside 90 seconds, mostly `rel_entity_move`, and the pack
is evicted. A player who reattaches after that gets no pack, and the server has
no reason to send one. So the pack is a control frame, held one copy per pack
UUID in `src/core/pending-resource-pack.js`, relayed to the player who answers
it and never cached or replayed. The human's `resource_pack_receive` is
forwarded as the puppet's own frame; with no player able to answer, the puppet
accepts and loads.

## Considered options

- **Leave the pack as ordinary state and replay it.** Rejected: measured, the
  `generic` ring drops it 90 seconds after it arrives, so "the pack shows up on
  a reattach" is false for every reattach after the first minute and a half. The
  eviction is not a cache bug to fix in the cache: a pack is a request that one
  connection answers, not world state that keeps getting resent.
- **Give packs their own cache domain with no bound.** Rejected: the cache's
  contract is bounded domains, and a domain with no bound is the unbounded ring
  the cache exists to replace. It also splits one frame's lifecycle across two
  owners, the cache and the answer path.
- **Keep the puppet's auto-accept and only stop dropping the player's answer.**
  Rejected: two answers for one pack, one of them invented. The server reads a
  status the player's client never produced, which is the thing the player's
  answer is supposed to fix.
- **Release the held pack when the player answers.** Rejected: a pack stays
  installed on the puppet's connection until the server withdraws it, so the
  next player needs it too, whether or not an earlier player answered. A
  client's Minecraft install keeps a downloaded pack, but a fresh install and a
  different machine do not.
- **Answer the player's decline as an accept.** Rejected: the server decides
  what a decline means. A required pack ends the session, and the proxy must not
  turn that into a lie about the player's client.
- **Hold the pack in the pending dialog holder.** Rejected: the two holders are
  the same shape and opposite rules. A dialog is released by the player's answer,
  because an answered question is closed. A pack must never be released by an
  answer, because the server keeps it installed and the next player needs it
  too; only a withdrawal releases it. Sharing the structure would mean sharing
  none of the behaviour, and a dialog and a pack can be pending on one
  connection at once.

## Consequences

- `add_resource_pack` and `remove_resource_pack` are `control` in both states,
  so `state-cache`, `join-synth`, and the front leg's configuration replay
  cannot place them. The front leg's configuration replay delivers a
  configuration-phase pack from the holder at `configuringReady`, because that
  is the only moment the client parses the frame: a warm attach is in play.
- A play-state pack is re-delivered to every client that attaches while it is
  held, in send order. A client that already has the pack re-applies its local
  copy; the frame costs one packet, not one download.
- A pack a player never answered becomes the puppet's answer on detach, the same
  shape as #73's gate fallback, because a required pack the server hears nothing
  about can end the session. The puppet answers only when no player is attached:
  a player who is attached but still in its own configuration round is offered
  the pack at its replay, and answering beside them is the defect this ADR is
  about.
- `remove_resource_pack` carries `option UUID`, and an absent one withdraws every
  pack the connection pushed. The holder empties on that form: a client that was
  told to drop a pack must not be offered it again.
- A configuration-phase pack whose player arrives after the puppet left
  configuration still reaches the client, and its answer cannot: the packet id is
  state-scoped, so the frame is dropped with `resourcePackAnswerUnforwardable`.
  The server already heard the puppet's accept.
- `pendingPacks.clear()` runs where `pendingDialog.clear()` does, and on the two
  paths that put a client back on another server: a failed followed transfer, and
  the reconnect that restores the snapshot. A pack belongs to the backend session
  that sent it, and a copy from a dead one would be offered beside the new one's
  — or answered to a server that never sent it.
- `client-parity` predicts `both` for a control frame. Before this, a control
  frame had no prediction and any one-sided pack row reported as unexplained.
