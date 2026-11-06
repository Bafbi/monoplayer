#!/usr/bin/env bash
# Install the Gate B driver into a Prism Launcher root on the display host.
#
# Usage:
#   ./install.sh /path/to/gate-b-driver-0.1.0.jar
#
# Environment:
#   PRISM_ROOT  Prism data root (default: ~/.local/share/PrismLauncher)
#   BASE        Base 26.1.2 instance (default: gate-b-player)
#   INSTANCE    New Fabric instance ID (default: gate-b-player-fabric)
set -euo pipefail

jar=${1:-}
if [ -z "$jar" ] || [ ! -f "$jar" ]; then
  echo "usage: $0 /path/to/gate-b-driver-0.1.0.jar" >&2
  exit 2
fi

prism_root=${PRISM_ROOT:-"$HOME/.local/share/PrismLauncher"}
base=${BASE:-gate-b-player}
instance=${INSTANCE:-gate-b-player-fabric}
base_dir="$prism_root/instances/$base"
instance_dir="$prism_root/instances/$instance"

if [ ! -d "$base_dir" ]; then
  echo "base instance not found: $base_dir" >&2
  exit 1
fi

if [ -e "$instance_dir" ]; then
  echo "instance already exists: $instance_dir" >&2
  echo "remove it or set INSTANCE to a new name" >&2
  exit 1
fi

cp -a "$base_dir" "$instance_dir"
mkdir -p "$instance_dir/minecraft/mods"
cp "$jar" "$instance_dir/minecraft/mods/gate-b-driver.jar"

cat > "$instance_dir/mmc-pack.json" <<'JSON'
{
  "components": [
    {
      "cachedName": "LWJGL 3",
      "cachedVersion": "3.4.1",
      "dependencyOnly": true,
      "uid": "org.lwjgl3",
      "version": "3.4.1"
    },
    {
      "cachedName": "Minecraft",
      "cachedRequires": [
        { "suggests": "3.4.1", "uid": "org.lwjgl3" }
      ],
      "cachedVersion": "26.1.2",
      "important": true,
      "uid": "net.minecraft",
      "version": "26.1.2"
    },
    {
      "cachedName": "Intermediary Mappings",
      "cachedRequires": [
        { "equals": "26.1.2", "uid": "net.minecraft" }
      ],
      "cachedVersion": "26.1.2",
      "dependencyOnly": true,
      "uid": "net.fabricmc.intermediary",
      "version": "26.1.2"
    },
    {
      "cachedName": "Fabric Loader",
      "cachedRequires": [
        { "uid": "net.fabricmc.intermediary" }
      ],
      "cachedVersion": "0.20.1",
      "uid": "net.fabricmc.fabric-loader",
      "version": "0.20.1"
    }
  ],
  "formatVersion": 1
}
JSON

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
p.write_text(s)
PY

echo "installed $instance"
echo "launch:"
echo "  XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 \\"
echo "    prismlauncher -l $instance -s monoplayer-gate-b-paper.tail41e568.ts.net:25565 -a Bafbi"
echo
echo "driver: 127.0.0.1:25599"
echo "screenshots: $instance_dir/minecraft/screenshots/"
