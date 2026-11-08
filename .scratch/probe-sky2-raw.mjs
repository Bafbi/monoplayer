import mc from 'minecraft-protocol'
import fs from 'node:fs'
import { createTokenCustody } from '/home/neudeline/.t3/projects/monoplayer/src/auth/cache.js'
import { withTransferIntent } from '/home/neudeline/.t3/projects/monoplayer/src/monoplayer/live-backend.js'

const dir = '/home/neudeline/.t3/projects/monoplayer/.secrets/accounts/6eb73524-ff88-4a62-a8d0-c63905e7afba'
const uuid = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const profile = JSON.parse(fs.readFileSync(dir + '/profile.json', 'utf8'))
const custody = createTokenCustody({ account: 'bafbi', dir, uuid, create: false, legacyAccount: 'bafbi' })
const lock = custody.writerLock.acquire()
if (!lock.ok) { console.log('LOCK HELD', lock.holder); process.exit(2) }

const client = mc.createClient({
  host: 'sky-2.excalia.fr',
  port: 25565,
  version: '26.2',
  username: uuid,
  auth: 'microsoft',
  profilesFolder: custody.cacheFactory,
  authTitle: profile.authTitle,
  deviceType: profile.deviceType,
  flow: 'live',
  keepAlive: true
})

const origWrite = client.write.bind(client)
client.write = withTransferIntent((name, params, ...rest) => {
  let p = ''
  try { p = JSON.stringify(params, (k, v) => typeof v === 'bigint' ? String(v) : (Buffer.isBuffer(v) ? `<buf ${v.length}>` : v))?.slice(0, 400) } catch {}
  console.log('C2S', name, p)
  return origWrite(name, params, ...rest)
}, true)
client.on('packet', (data, meta) => {
  let p = ''
  try { p = JSON.stringify(data, (k, v) => typeof v === 'bigint' ? String(v) : (Buffer.isBuffer(v) ? `<buf ${v.length}>` : v))?.slice(0, 600) } catch {}
  console.log('S2C', meta.state, meta.name, p)
})
client.on('error', e => console.log('ERR', e.message))
client.on('end', r => {
  console.log('END', r)
  try { lock.release?.() } catch {}
  process.exit(0)
})
setTimeout(() => { console.log('TIMEOUT'); try { lock.release?.() } catch {}; process.exit(1) }, 25000)
