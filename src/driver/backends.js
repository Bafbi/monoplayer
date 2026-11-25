// Row registry for the backend matrix (docs/driver-lane-plan.md, "Backend
// matrix" / "Pins that matter"). Pure data + pure helpers: no I/O, no env, no
// child processes, so the M4 unit tests stay fully offline.
//
// Names here must match the Kubernetes objects in deploy/driver/:
//   service/deployment  <deployment>  (in the run's lane, from src/driver/lane.js)
//   rcon                kubectl exec deploy/<rcon.deployment> -- rcon-cli
//
// No row carries a lane (#282). A lane is the run's, not the registry's: one worktree
// gets one, and a row that spelled one told a renamed lane's run to administer the
// lane that shipped. rconTarget takes the lane as an argument, and the tailnet name
// comes from lane.js's tailnetHost and the row's deployment.

// Toxiproxy listeners ("puppet leg" per the plan: Monoplayer back leg ->
// Toxiproxy -> Velocity/Vanilla/Fabric). The M1 vanilla and M3 fabric rows are
// planned: `deploy/driver/toxiproxy.yaml` carries only the listeners whose row has a
// backend, so their proxy, containerPort and Service port land together with the row
// (#115). Until then these entries are the plan, not a running listener.
export const PROXY_PLAN = Object.freeze([
  Object.freeze({
    name: 'puppet-velocity',
    listenPort: 25570,
    upstreamHost: 'velocity',
    upstreamPort: 25566,
    row: 'M4',
    enabled: true,
  }),
  Object.freeze({
    name: 'puppet-vanilla',
    listenPort: 25571,
    upstreamHost: 'vanilla',
    upstreamPort: 25565,
    row: 'M1',
    enabled: false,
  }),
  Object.freeze({
    name: 'puppet-fabric',
    listenPort: 25572,
    upstreamHost: 'fabric',
    upstreamPort: 25565,
    row: 'M3',
    enabled: false,
  }),
  Object.freeze({
    name: 'puppet-paper-m4',
    listenPort: 25573,
    upstreamHost: 'paper-m4',
    upstreamPort: 25565,
    row: 'M4',
    enabled: false,
  }),
])

function row ({
  id, lane, deployment, port, pins, status, notes = [], proxyRoute = null, tailscale = null,
}) {
  return Object.freeze({
    id,
    lane,
    deployment,
    endpoints: Object.freeze({
      clusterService: `${deployment}:${port}`,
      port,
      ...(proxyRoute ? Object.freeze({ proxyRoute: Object.freeze(proxyRoute) }) : {}),
      ...(tailscale ? Object.freeze({ tailscale: Object.freeze(tailscale) }) : {}),
    }),
    pins: Object.freeze(pins),
    status, // 'running' = live in the cluster, 'planned' = manifest/plan only
    rcon: Object.freeze({ deployment }),
    notes: Object.freeze(notes),
  })
}

// M5 is not a separate backend: it is M4's proxy route + the fault plan.
export const FAULT_PLAN = Object.freeze([
  Object.freeze({ id: 'F1', shape: 'five-minute detach (no fault; RCON mutation while detached)' }),
  Object.freeze({ id: 'F2', shape: 'latency 100ms +/- 30ms both directions on the puppet leg' }),
  Object.freeze({ id: 'F3', shape: 'timeout(0) five-second freeze, then remove' }),
  Object.freeze({ id: 'F4', shape: 'backend SIGKILL while detached; restart' }),
  Object.freeze({ id: 'F5', shape: 'RCON kick of the puppet' }),
  Object.freeze({ id: 'F6', shape: 'down 60s, then restore' }),
])

export const BACKENDS = Object.freeze([
  row({
    id: 'vanilla',
    lane: 'M1',
    deployment: 'vanilla',
    port: 25565,
    status: 'planned', // owned by the M1 workstream; not in this slice's manifests
    pins: {
      version: '26.1.2',
      serverSha1: '97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51',
      image: 'itzg/minecraft-server:2026.10.1-java25',
    },
    notes: [
      'online-mode=false, secure-profile=false (Monoplayer handles auth)',
      'whitelist = puppet only',
      'flat world, seed 775, RD/SD 4',
    ],
    proxyRoute: { listener: puppetListenerFor('vanilla').name, listenPort: 25571, through: 'toxiproxy' },
  }),
  row({
    id: 'paper',
    lane: 'M2',
    deployment: 'paper',
    port: 25565,
    status: 'running', // G0 baseline (deploy/driver/paper.yaml); do not touch
    pins: {
      version: '26.2',
      paperBuild: 135,
      image: 'itzg/minecraft-server:2026.10.1-java25',
    },
    notes: [
      'G0 direct lane: online-mode=true, secure-profile=true',
      'exposed only through Tailscale for nath; RCON ClusterIP only',
    ],
    tailscale: { service: 'paper-g0' },
  }),
  row({
    id: 'fabric',
    lane: 'M3',
    deployment: 'fabric',
    port: 25565,
    status: 'planned', // owned by the M3 workstream
    pins: {
      version: '26.1.2',
      fabricLoader: '0.20.1',
      fabricApi: '0.155.3+26.1.2',
      carpet: '26.1',
      java: '25',
    },
    notes: ['compatibility report, not gate-blocking', 'online-mode=false for the Monoplayer lane'],
    proxyRoute: { listener: puppetListenerFor('fabric').name, listenPort: 25572, through: 'toxiproxy' },
  }),
  row({
    id: 'paper-m4',
    lane: 'M4',
    deployment: 'paper-m4',
    port: 25565,
    status: 'planned', // deploy/driver/paper-m4.yaml in this slice
    pins: {
      version: '26.1.2',
      paperBuild: 74,
      image: 'itzg/minecraft-server:2026.10.1-java25',
      velocity: '4.3.1 build 45',
      velocitySha256: '0844bcabdcdb4f5b875906fd4c3365bc1bb76918e42bc595ed88ad195258dd75',
      velocityImage: 'itzg/mc-proxy:java25',
      forwarding: 'modern (PAPER_VELOCITY_SECRET env; partial paper-global.yml pre-seed)',
    },
    notes: [
      'backend offline/insecure; Velocity online-mode=true in front',
      'whitelist = puppet only (GlowSquidye)',
      'flat world, seed 775, RD/SD 4',
      'RCON via ClusterIP only',
    ],
    proxyRoute: { listener: 'puppet-velocity', listenPort: 25570, through: 'toxiproxy' },
    tailscale: { service: 'velocity-m4' },
  }),
])

// M5: fault row = paper-m4 route + FAULT_PLAN on the puppet-velocity listener.
export const M5_FAULT_ROW = Object.freeze({
  id: 'M5',
  backend: 'paper-m4',
  route: BACKENDS.find(b => b.id === 'paper-m4').endpoints.proxyRoute,
  faults: FAULT_PLAN,
})

function puppetListenerFor (upstreamHost) {
  return PROXY_PLAN.find(p => p.upstreamHost === upstreamHost)
}

export function getBackend (id) {
  return BACKENDS.find(b => b.id === id) ?? null
}

export function activeBackends () {
  return BACKENDS.filter(b => b.status === 'running')
}

// The row's RCON target in the lane the run named. The lane is a parameter because
// it is decided at the run's boundary, by src/driver/lane.js, and a registry that
// carried one would be a second answer (#282).
export function rconTarget (id, namespace) {
  const backend = getBackend(id)
  return backend ? { namespace, deployment: backend.rcon.deployment } : null
}
