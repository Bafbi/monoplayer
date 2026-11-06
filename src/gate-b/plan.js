// Pure arena/edit planning for one Gate B driver-lane run.
//
// Every run gets fresh coordinates so runs never overlap each other's edits
// or the player's spawn platform, and the edit targets are always at least
// 3 blocks away from the player's teleport position. Nothing here touches the
// network; the scenario executor turns the plan into RCON setblock/fill and
// driver ops.

export const ARENA = {
  // Arena footprint: side x side floor at floorY, clearedLayers above it.
  side: 21,
  radiusInt: 10,
  floorY: -61, // stone floor layer (built by the run if missing)
  clearedLayers: [-60, -59], // feet + head space kept air
  feetY: -60, // teleport feet level
  floorBlock: 'minecraft:stone',
  // The player's standing spot on the pre-existing safe platform. Runs must
  // never edit near it, and it is far outside any run's arena footprint.
  spawnPlatform: { x: 13.5, y: -60, z: -4.5 },
}

// First run's arena centre. Each extra run shifts the centre by one stride so
// consecutive runs cannot share blocks, and the spawn platform stays far away.
export const PLAN_BASE = { x: 96, z: 96 }
export const PLAN_STRIDE = { x: 64, z: 64 }

export const SAFETY = {
  minTargetDistanceBlocks: 3, // edit targets must be at least this far from the player
}

export function runCenter (runIndex) {
  const index = Math.max(1, Math.trunc(runIndex)) - 1
  return {
    x: PLAN_BASE.x + index * PLAN_STRIDE.x,
    z: PLAN_BASE.z + index * PLAN_STRIDE.z,
  }
}

// nonce: distinct token per run (e.g. timestamp-based), so two runs on the
// same runIndex (re-runs after a --force retry) are still labelled apart.
export function buildRunPlan ({ runIndex, nonce }) {
  const center = runCenter(runIndex)
  const minX = center.x - ARENA.radiusInt
  const maxX = center.x + ARENA.radiusInt
  const minZ = center.z - ARENA.radiusInt
  const maxZ = center.z + ARENA.radiusInt

  const teleport = { x: center.x + 0.5, y: ARENA.feetY, z: center.z + 0.5 }
  const blockUnderPlayer = { x: center.x, y: ARENA.floorY, z: center.z }
  const breakTarget = { x: center.x + 4, y: ARENA.feetY, z: center.z }
  const placeSupport = { x: center.x - 4, y: ARENA.floorY, z: center.z } // floor block itself is the support
  const placeTarget = { x: placeSupport.x, y: ARENA.feetY, z: placeSupport.z }

  return {
    runIndex,
    nonce,
    center,
    arena: {
      side: ARENA.side,
      radius: ARENA.radiusInt,
      floorY: ARENA.floorY,
      clearedLayers: [...ARENA.clearedLayers],
      floorBlock: ARENA.floorBlock,
      clearBox: { minX, minZ, maxX, maxZ },
    },
    teleport,
    blockUnderPlayer,
    edits: {
      break: { target: breakTarget },
      place: { support: placeSupport, target: placeTarget },
    },
    // Expected block states checked before any edit. Kind marks how the
    // scenario must classify the RCON call.
    preflight: [
      { name: 'preflight: break target is air before seeding', kind: 'assertion', at: breakTarget, expect: 'air' },
      { name: 'preflight: place support floor block is stone', kind: 'assertion', at: placeSupport, expect: 'stone' },
      { name: 'preflight: place target is air before placing', kind: 'assertion', at: placeTarget, expect: 'air' },
      { name: 'preflight: block under player is solid floor', kind: 'assertion', at: blockUnderPlayer, expect: 'stone' },
    ],
  }
}

// Pure safety validator: returns a list of human-readable issues, [] when the
// plan is safe to execute. Used by the scenario executor before it starts and
// directly by unit tests.
export function planSafetyIssues (plan) {
  const issues = []
  const center = runCenter(plan.runIndex)
  if (plan.center.x !== center.x || plan.center.z !== center.z) {
    issues.push(`center ${plan.center.x},${plan.center.z} does not match runIndex ${plan.runIndex}`)
  }
  if (!plan.nonce || String(plan.nonce).trim() === '') issues.push('nonce must be non-empty')

  const under = plan.blockUnderPlayer
  const underKey = `${under.x},${under.y},${under.z}`
  const player = plan.teleport
  const underMatches =
    Math.floor(player.x) === under.x &&
    Math.floor(player.y) - 1 === under.y &&
    Math.floor(player.z) === under.z
  if (!underMatches) issues.push('blockUnderPlayer must sit under the teleport position')

  const targets = []
  if (plan.edits?.break?.target) targets.push({ label: 'break target', at: plan.edits.break.target })
  if (plan.edits?.place?.target) targets.push({ label: 'place target', at: plan.edits.place.target })
  if (plan.edits?.place?.support) targets.push({ label: 'place support', at: plan.edits.place.support })

  for (const target of targets) {
    const key = `${target.at.x},${target.at.y},${target.at.z}`
    if (key === underKey) issues.push(`${target.label} targets the block under the player`)
    const distance = Math.hypot(
      target.at.x + 0.5 - player.x,
      target.at.y + 0.5 - player.y,
      target.at.z + 0.5 - player.z
    )
    if (distance < SAFETY.minTargetDistanceBlocks) {
      issues.push(`${target.label} is only ${distance.toFixed(2)} blocks from the player position (< ${SAFETY.minTargetDistanceBlocks})`)
    }
  }

  if (plan.edits?.break?.target && plan.edits?.place?.target) {
    const a = plan.edits.break.target
    const b = plan.edits.place.target
    if (a.x === b.x && a.y === b.y && a.z === b.z) {
      issues.push('break and place target the same block')
    }
  }

  // The spawn platform must never be inside a run's arena box.
  const platform = ARENA.spawnPlatform
  const box = plan.arena?.clearBox
  if (box) {
    const inside = block =>
      block.x >= box.minX && block.x <= box.maxX && block.z >= box.minZ && block.z <= box.maxZ
    for (const target of targets) {
      if (!inside(target.at)) issues.push(`${target.label} outside the arena footprint`)
    }
    if (!inside(under)) issues.push('player position outside the arena footprint')
    if (Math.floor(platform.x) >= box.minX && Math.floor(platform.x) <= box.maxX &&
        Math.floor(platform.z) >= box.minZ && Math.floor(platform.z) <= box.maxZ) {
      issues.push('arena footprint overlaps the pre-existing spawn platform')
    }
  }
  return issues
}
