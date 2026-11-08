import mc from 'minecraft-protocol'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { createTokenCustody } from '/home/neudeline/.t3/projects/monoplayer/src/auth/cache.js'
import { withTransferIntent } from '/home/neudeline/.t3/projects/monoplayer/src/monoplayer/live-backend.js'

const host = process.argv[2] ?? 'sky-2.excalia.fr'
const intent = Number(process.argv[3] ?? 3)
const dir = '/home/neudeline/.t3/projects/monoplayer/.secrets/accounts/6eb73524-ff88-4a62-a8d0-c63905e7afba'
const uuid = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const profile = JSON.parse(fs.readFileSync(dir + '/profile.json', 'utf8'))
const custody = createTokenCustody({ account: 'bafbi', dir, uuid, create: false, legacyAccount: 'bafbi' })
const lock = custody.writerLock.acquire()
if (!lock.ok) { console.log('LOCK HELD'); process.exit(2) }

const client = mc.createClient({
  host, port: 25565, version: '26.2', username: uuid, auth: 'microsoft',
  profilesFolder: custody.cacheFactory, authTitle: profile.authTitle,
  deviceType: profile.deviceType, flow: 'live', keepAlive: true
})
const baseWrite = client.write.bind(client)
client.write = withTransferIntent((name, params, ...rest) => baseWrite(name, params, ...rest), intent === 3)
client.write = ((prev) => (name, params, ...rest) => prev(name, params, ...rest))(client.write)

const regs = new Map()
client.on('packet', (data, meta) => {
  if (meta.state === 'configuration' && meta.name === 'registry_data') {
    const entries = Array.isArray(data.entries) ? data.entries : []
    const h = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)
    regs.set(data.id, { id: data.id, entries: entries.length, hash: h })
  }
  if (meta.state === 'configuration' && ['feature_flags','select_known_packs','tags'].includes(meta.name)) {
    console.log('CFG', meta.name, JSON.stringify(data).slice(0, 200))
  }
})
client.on('login', p => {
  console.log('LOGIN', { entityId: p.entityId, worldNames: p.worldNames, onlineMode: p.onlineMode, enforcesSecureChat: p.enforcesSecureChat })
  console.log('REGISTRIES', JSON.stringify([...regs.values()].sort((a,b)=>a.id.localeCompare(b.id))))
  console.log('REGISTRY_HASHES', JSON.stringify([...regs.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(r => `${r.id}:${r.hash}`)))
  setTimeout(() => { try { lock.release?.() } catch {}; client.end('probe_done'); setTimeout(() => process.exit(0), 300) }, 1000)
})
client.on('end', r => { console.log('END', r); try { lock.release?.() } catch {}; process.exit(0) })
client.on('error', e => console.log('ERR', e.message))
setTimeout(() => { console.log('TIMEOUT'); try { lock.release?.() } catch {}; process.exit(1) }, 30000)
