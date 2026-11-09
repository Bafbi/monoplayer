// Registry probe for the transfer testbed.
//
//   node src/testbed/registry.js <host> <intent> <port>
//
// Connects as Bafbi with handshake intent 2 (LOGIN) or 3 (TRANSFER), captures
// the configuration registry_data frames, and prints one line:
//   REGISTRIES [{"id":"minecraft:dimension_type","entries":5,"hash":"..."}]
//
// The testbed orchestrator compares the hub and sky dimension_type entries to
// prove the target has a different registry than the hub before the seamless
// switch is exercised.
import fs from 'node:fs'
import crypto from 'node:crypto'
import mc from 'minecraft-protocol'
import { createTokenCustody } from '../custody/cache.js'
import { withTransferIntent } from '../legs/live-backend.js'

const host = process.argv[2] ?? '127.0.0.1'
const intent = Number(process.argv[3] ?? 2)
const port = Number(process.argv[4] ?? 25565)
const dir = '.secrets/accounts/6eb73524-ff88-4a62-a8d0-c63905e7afba'
const uuid = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const profile = JSON.parse(fs.readFileSync(`${dir}/profile.json`, 'utf8'))

const custody = createTokenCustody({ account: 'bafbi', dir, uuid, create: false, legacyAccount: 'bafbi' })
const lock = custody.writerLock.acquire()
if (!lock.ok) {
  console.error('bafbi custody writer lock is held', lock.holder)
  process.exit(2)
}

const registries = new Map()
let done = false
const finish = (code) => {
  try { lock.release?.() } catch { /* best effort */ }
  process.exit(code)
}

const client = mc.createClient({
  host,
  port,
  version: '26.2',
  username: uuid,
  auth: 'microsoft',
  profilesFolder: custody.cacheFactory,
  authTitle: profile.authTitle,
  deviceType: profile.deviceType,
  flow: 'live',
  keepAlive: true
})
client.write = withTransferIntent(client.write.bind(client), intent === 3)

client.on('packet', (data, meta) => {
  if (meta.state !== 'configuration' || meta.name !== 'registry_data') return
  const entries = Array.isArray(data.entries) ? data.entries : []
  const hash = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
  registries.set(data.id, { id: data.id, entries: entries.length, hash })
})

client.on('login', packet => {
  done = true
  const dimension = registries.get('minecraft:dimension_type') ?? null
  console.log('LOGIN ' + JSON.stringify({
    entityId: packet.entityId,
    worldNames: packet.worldNames,
    dimensionType: dimension
  }))
  console.log('REGISTRIES ' + JSON.stringify([...registries.values()].sort((a, b) => a.id.localeCompare(b.id))))
  setTimeout(() => {
    try { client.end('probe_done') } catch { /* already gone */ }
    setTimeout(() => finish(0), 300)
  }, 500)
})
client.on('end', reason => {
  if (done) return
  console.error('END', reason)
  finish(1)
})
client.on('error', error => {
  console.error('ERR', String(error?.message ?? error).slice(0, 300))
})
setTimeout(() => {
  console.error('TIMEOUT')
  finish(1)
}, 45_000)
