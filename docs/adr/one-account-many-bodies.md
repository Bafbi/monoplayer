# One account, many bodies

One Minecraft account can hold sessions on several servers at once, because custody is one *refresher*, not one session ([one-account-one-writer-one-replica.md](one-account-one-writer-one-replica.md)), and nothing in the refresh chain ties the account to one address. So the account fans out to many bodies, one session per allowed server: a player joining the front leg lands in a picker served during the configuration phase, and picking a server offers that body's claim, which the picking player's own connection holds. Another player may spectate a claimed body and never control it, and a body outlives its claim.

## Considered options

- **Keep one session on one server, and one player at a time.** Rejected: a player who wants to be on one server while a friend plays another as the same account cannot, and the account is welded to whichever backend the control document names.
- **Let several players drive one body.** Rejected: two players sending movement for one body is two sources of truth, and the server sees one player, so the commands spoken as the puppet and the body's pose are single-valued. The claim is exclusive, and watching is a role beside it.
- **A lobby world with rooms, a shared venue and chat.** Rejected: the picker is one question asked and answered in a dialog. A world for it costs a server, a world, and a protocol of its own.
- **Put the picker in the play phase.** Rejected: a play-phase dialog needs a registry entry of its own, and the configuration phase is the one place the front can write frames with no backend behind them.
- **Keep the backend move, and add the picker beside it.** Rejected: the move answers an operator's question about a session that already has a server, and the picker answers the player's question about which server they want. Two mechanisms for choosing a server is what this removes.
- **Keep one reusable slot, and let whoever holds it pick again.** Rejected: a slot says nothing about which body a player is on, so two players on two servers cannot be told apart, and neither can a driver and a spectator.
- **Cap bodies and players now.** Rejected: the caps wait for the per-body and per-channel numbers, and they are configuration when they land. A premise is not a measurement.
- **Give each pair of player and server its own account.** Rejected: multi-account lanes stay out of scope, and a second account is a second custody chain, which [one-account-one-writer-one-replica.md](one-account-one-writer-one-replica.md) refuses.

## Consequences

- **The transparency claim narrows to the claimed body.** [docs/transparency.md](../transparency.md) claims that what a player sees after claiming a body matches a direct connection to that server. A spectator's view is not a direct connection and does not carry that claim, and the picker's own frames are a known difference the parity report names as one rather than reports as a finding.
- **The cache moves to the body, and delivery to the channel.** Today one state cache, one attach, one pending dialog and one client settings object are single-valued in the composition root's closure. A body owns its cache, shared by its driver and its spectators, so a replay is computed once; what a player has been sent, and whether they drive the body, belongs to their own connection. This is a rewrite of the core loop around two owners, not a feature branch, and it lands in #260.
- **The move route retires.** The backend-move route, its key in the control document, and the operator-move code path are deleted once the fan-out exists (#264). The reconfiguration machine stays: the picker's hand-off into a claimed body is that machine running.
- **The front serves a configuration phase with no backend.** By decision the service does not dial an allowed server until a player claims it, so the front leg answers configuration itself: its own registry data and its own dialog. Nothing in the front may assume a backend exists before a pick.
- **The vocabulary lands before the code.** Until a slice rebuilds it, the code keeps today's words, so this glossary marks an entry *Superseded by* its replacement and the slice that lands the replacement deletes the entry (#260, #269). A reader of the code finds both the word it uses and the word the model gives it.
