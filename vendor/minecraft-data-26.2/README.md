# minecraft-data 26.2 snapshot

Vendored copy of the Minecraft 26.2 data from the PrismarineJS `minecraft-data`
repository. `minecraft-data` 3.119.0 on npm does not ship this data yet, so
`scripts/patch-minecraft-data-26.2.mjs` adds it to the installed package after
`pnpm install`.

## Source

- Repository: <https://github.com/PrismarineJS/minecraft-data>
- Branch: `pc_26_2`
- Commit: `282f19b06c7cc98f055c39787acf93904b9587fa` (2026-10-29)

## Contents

- `data/pc/26.2/` is a verbatim copy of `data/pc/26.2`.
- `data/pc/1.20.3/windows.json` is copied verbatim. The 26.2 data paths point
  `windows` at `pc/1.20.3`, and the 3.119.0 package does not include that file.
- `protocolVersions.json` is a copy of `data/pc/common/protocolVersions.json`
  from the same commit. The patch merges its entries into the installed
  package and keeps the entries for other versions.
- `dataPaths-26.2.json` is the `pc["26.2"]` entry from `data/dataPaths.json`.

## Update

Replace the files above from a newer commit on the same branch, then run
`pnpm install` so the postinstall script applies them to `node_modules`.

Files the 26.2 data paths resolve outside `pc/26.2` (`pc/26.1` effects,
enchantments, and instruments, `pc/1.20.2` map icons, and `pc/latest` proto)
already ship in `minecraft-data` 3.119.0 and are not vendored.
