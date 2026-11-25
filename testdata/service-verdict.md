# The deployed service carried a vanilla client onto Excalia Season 3

> **Record, not documentation.** Taken 2026-11-07T23:51:50Z by the deployed
> pod's heartbeat log and the `gate-b-player-262` Prism client on `nath`. Every
> number below belongs to that run: read it as evidence of what happened, never
> as a current claim, and do not update it to match today.

Verdict: **PASS**, `passed: true`, with 8 assertions passed and V9 `not_observed`.
Date: 2026-11-07T23:51:50Z.
Command: the record names its own regeneration command, `kubectl -n monoplayer logs deploy/monoplayer | grep '"event":"heartbeat"' | tail -1`.
Fact: the image running in the cluster held the puppet's session on a live public backend and served a vanilla client through the front leg with one backend login.

Source: `testdata/v1-deployed-front-verdict.json`, removed from git. Every quote below comes from it.

## The topology

Cluster `deepmine`, namespace `monoplayer`, Argo app `deepmine-dev-monoplayer` at `Synced/Healthy`, one replica with the `Recreate` strategy, GitOps commit `5a82b13`. The pod ran image `registry.internal/deepmine/monoplayer@sha256:bf0741b224a53793af574eb28aa3c04f90ee43e3648ee4134b4d8f37a19cc266`, tagged `sha-f26bc38`. The front leg was a Tailscale Service at `glowsquidye.tail41e568.ts.net:25565` with load-balancer IP `100.66.20.83`. The backend leg reached `play2.excalia.fr:25565` on 26.2, protocol 776, directly, so the `play.excalia.fr` limbo dialog and its transfer are bypassed. The client was the vanilla Prism instance `gate-b-player-262` on `nath`, and its only join log line was `Connecting to glowsquidye.tail41e568.ts.net, 25565`.

## What passed

- V1: the puppet logged in to Season 3 as GlowSquidye on 26.2, and the backend leg loaded the player.
- V2: the front leg was ready from backend frames before the attach, with the warm fallback and 573 prefix frames.
- V3: the online-mode Bafbi attach was allowed by the attach whitelist, with no denials.
- V4: configuration replayed from the cache, 33 frames, with 28 `registry_data` suppressed.
- V5: 673 frames replayed and 401 `map_chunk` frames came from the cache. The client log read `chunk section buffers resized to 128 during world load`.
- V6 and V7: one backend login across one attach, 572 serverbound frames forwarded, 8 dropped, and 1 chat blocked.
- V8: the wire checker inspected 785 frames and rejected none, 33 configuration and 752 play.
- V9 stayed `not_observed`. The record's reason reads `needs the player's in-world confirmation; client frames alone do not prove the backend accepted the actions`.

## The counters report no denial and no kick

779 backend frames, 34 configuration frames, 752 cached, 673 replayed, 1 synthesized position, 1 attach, 0 denials, 0 front kicks, and 3 non-play frames ignored. The named backend frames were 401 `map_chunk`, 82 `update_time`, 81 `entity_metadata`, 78 `entity_teleport`, 78 `keep_alive`, 25 `system_chat`, and 10 `player_info`.

The record leaves the movement and block-edit rows open. It proves the deployed image serves a vanilla client, not that the player could play.
