# Prove a real client with a driven modded client and an unmodded witness

A protocol bot is not an oracle: the protocol library accepts frames a vanilla client rejects, and a bot models no rendering, UI, or chunk rebuild, yet the claim is that an official client plays normally through the puppet. The first live attach failed with `add_entity ... 114 bytes extra`, a class only the real client reported. The real-client rung drives a Fabric-modded client over a loopback socket, pairs every client-side claim with an assertion read from the server, and requires one manual unmodded run to pass the same row.

## Considered options

- **Protocol bots only.** Rejected: they cannot prove the claim. They stay on the cheaper rungs, where they catch wire and relay defects for seconds of runtime.
- **Manual real-client testing only.** Rejected: a human at the controls is the flakiest instrument in the repo, and the evidence bar is two consecutive clean runs, not one.
- **Assert from inside the mod, with no control socket.** Rejected: it moves the control plane into Java and away from the harness that already owns the scenario, the reports, and the redaction.
- **Screen-reading automation on the official client.** Rejected: brittle, and it cannot read game state. The mod reads state the client actually holds.
- **Skip the witness and trust the driver.** Rejected: the driver is a modded client with its own patches. Without an unmodded run, a driver bug reads as a product pass.
