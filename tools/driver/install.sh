#!/usr/bin/env bash
# Install the client driver into a Prism Launcher root on the display host.
#
# Usage:
#   BASE=<base instance> INSTANCE=<new instance id> \
#     ./install.sh /path/to/monoplayer-driver-0.1.0.jar
#
# Environment:
#   PRISM_ROOT  Prism data root (default: ~/.local/share/PrismLauncher)
#   BASE        Base instance to clone (required)
#   INSTANCE    New Fabric instance ID (required)
#   LOADER      Fabric Loader version (default: 0.20.1)
#
# The Minecraft version is not a value here. It comes from the base instance's
# mmc-pack.json, so the driver instance cannot drift from the client the
# operator already has, and the pin lives in one place: tools/driver/build.gradle.
#
# The pair is not a value here either. A jar loads one Minecraft version, so a
# default pair goes stale when the jar moves. The guess that shipped cloned the
# 26.1.2 record for a 26.2 jar (#123). The caller names both, and
# tools/driver/README.md shows the pair the 26.2 jar loads (#190).
set -euo pipefail

# The lane this checkout derives, from the one owner of that name (#327). The
# installer prints a launch command and an operator copies it, so the address in
# it has to be the address a rung joins. scripts/gate-lane.sh derives the lane,
# honours MONOPLAYER_GATE_NAMESPACE, and refuses a name that is not a lane. A host
# whose checkout cannot answer gets a placeholder and the command that fills it:
# a plausible-looking hostname that resolves to nothing reads as a broken cluster.
root=$(cd "$(dirname "$0")/../.." && pwd -P)
lane=$(bash "$root/scripts/gate-lane.sh" name 2>/dev/null) || lane=''

jar=${1:-}
if [ -z "$jar" ] || [ ! -f "$jar" ]; then
  echo "usage: BASE=<base instance> INSTANCE=<new instance id> $0 /path/to/monoplayer-driver-0.1.0.jar" >&2
  exit 2
fi
prism_root=${PRISM_ROOT:-"$HOME/.local/share/PrismLauncher"}
base=${BASE:-}
instance=${INSTANCE:-}
loader=${LOADER:-0.20.1}

# An empty BASE resolves base_dir to the instances root, which exists, so it is
# refused here rather than by the mmc-pack.json check below. An empty INSTANCE
# resolves instance_dir to the same root, which then reads as an instance that
# already exists.
if [ -z "$base" ] || [ -z "$instance" ]; then
  echo "BASE and INSTANCE name the instances to clone and to create; neither has a" >&2
  echo "default. tools/driver/README.md shows the pair the current jar loads." >&2
  exit 2
fi

base_dir="$prism_root/instances/$base"
instance_dir="$prism_root/instances/$instance"

if [ ! -d "$base_dir" ]; then
  echo "base instance not found: $base_dir" >&2
  exit 1
fi
if [ ! -f "$base_dir/mmc-pack.json" ]; then
  echo "base instance has no mmc-pack.json: $base_dir" >&2
  exit 1
fi

if [ -e "$instance_dir" ]; then
  echo "instance already exists: $instance_dir" >&2
  echo "remove it or set INSTANCE to a new name" >&2
  exit 1
fi

cp -a "$base_dir" "$instance_dir"
mkdir -p "$instance_dir/minecraft/mods"
cp "$jar" "$instance_dir/minecraft/mods/monoplayer-driver.jar"

# Take the Minecraft version from the base instance, then add the two Fabric
# components pinned to it. Prism resolves the rest from its meta API.
mc_version=$(python3 - "$base_dir/mmc-pack.json" "$instance_dir/mmc-pack.json" "$loader" <<'PY'
import json
import sys
from pathlib import Path

base_pack = json.loads(Path(sys.argv[1]).read_text())
out_path = Path(sys.argv[2])
loader_version = sys.argv[3]

components = [c for c in base_pack.get("components", [])
              if c.get("uid") in ("org.lwjgl3", "net.minecraft")]
minecraft = next((c for c in components if c.get("uid") == "net.minecraft"), None)
if minecraft is None:
    raise SystemExit("base mmc-pack.json has no net.minecraft component")
version = minecraft["version"]

components.append({
    "cachedName": "Intermediary Mappings",
    "cachedRequires": [{"equals": version, "uid": "net.minecraft"}],
    "cachedVersion": version,
    "dependencyOnly": True,
    "uid": "net.fabricmc.intermediary",
    "version": version,
})
components.append({
    "cachedName": "Fabric Loader",
    "cachedRequires": [{"uid": "net.fabricmc.intermediary"}],
    "cachedVersion": loader_version,
    "uid": "net.fabricmc.fabric-loader",
    "version": loader_version,
})

out_path.write_text(json.dumps({"components": components, "formatVersion": 1}, indent=4) + "\n")
print(version)
PY
)

python3 - "$instance_dir/instance.cfg" "$instance" <<'PY'
from pathlib import Path
import re, sys
p = Path(sys.argv[1])
name = sys.argv[2]
s = p.read_text()

def set_key(s, key, value):
    pat = re.compile(rf'^{re.escape(key)}=.*$', re.M)
    if pat.search(s):
        return pat.sub(f'{key}={value}', s)
    return s.replace('[General]\n', f'[General]\n{key}={value}\n', 1)

s = re.sub(r'^name=.*$', f'name={name}', s, flags=re.M)
if 'OverrideMemory=' not in s:
    s = s.replace('[General]\n', '[General]\nOverrideMemory=true\nMaxMemAlloc=4096\nMinMemAlloc=1024\n', 1)
# Keep Prism's console window out of the desktop; the driver socket is enough.
s = set_key(s, 'OverrideConsole', 'true')
s = set_key(s, 'ShowConsole', 'false')
s = set_key(s, 'ShowConsoleOnError', 'false')
p.write_text(s)
PY

echo "installed $instance (Minecraft $mc_version, Fabric Loader $loader)"
echo "launch, from the workspace:"
echo "  tools/nath.sh launch $instance \\"
echo "    -s ${lane:-monoplayer-gate-<instance>}-paper.tail41e568.ts.net:25565 -a Bafbi"
echo
if [ -n "$lane" ]; then
  echo "lane: $lane, from scripts/gate-lane.sh name"
else
  echo "lane: not derived here, so <instance> stands for it. From a checkout,"
  echo "      scripts/gate-lane.sh name prints this worktree's lane"
fi
echo "another lane: pass its hostname to -s instead, <lane>-paper.tail41e568.ts.net:25565"
echo
echo "driver: 127.0.0.1:25599"
echo "screenshots: $instance_dir/minecraft/screenshots/"
