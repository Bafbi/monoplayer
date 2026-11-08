import mc from 'minecraft-protocol'
import fs from 'node:fs'
import { createTokenCustody } from '/home/neudeline/.t3/projects/monoplayer/src/auth/cache.js'

const dir = '/home/neudeline/.t3/projects/monoplayer/.secrets/accounts/6eb73524-ff88-4a62-a8d0-c63905e7afba'
const uuid = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const profile = JSON.parse(fs.readFileSync(dir + '/profile.json', 'utf8'))
const custody = createTokenCustody({ account: 'bafbi', dir, uuid, create: false, legacyAccount: 'bafbi' })
const lock = custody.writerLock.acquire()
if (!lock.ok) { console.log('LOCK HELD'); process.exit(2) }

const client = mc.createClient({
  host: process.argv[2] ?? 'play2.excalia.fr', port: 25565, version: '26.2', username: uuid, auth: 'microsoft',
  profilesFolder: custody.cacheFactory, authTitle: profile.authTitle, deviceType: profile.deviceType, flow: 'live', keepAlive: true
})
const origWrite = client.write.bind(client)
client.write = (name, params, ...rest) => {
  const interesting = ['settings', 'client_information', 'custom_payload', 'chat_session_update', 'login_acknowledged', 'select_known_packs', 'accept_code_of_conduct']
  if (interesting.includes(name)) {
    let detail = ''
    if (name === 'custom_payload') {
      detail = ' channel=' + String(params?.channel) + ' data=' + JSON.stringify(params?.data ? String(params.data).slice(0, 80) : null)
    } else if (name === 'settings' || name === 'client_information') {
      detail = ' ' + JSON.stringify(params).slice(0, 300)
    } else if (name === 'chat_session_update') {
      detail = ' keys=' + Object.keys(params ?? {}).join(',')
    }
    console.log('C2S', name + detail)
  }
  return origWrite(name, params, ...rest)
}
client.on('login', p => {
  console.log('LOGIN', JSON.stringify({ enforcesSecureChat: p.enforcesSecureChat, onlineMode: p.onlineMode }))
  setTimeout(() => { try { client.end('probe_done') } catch {}; setTimeout(() => process.exit(0), 300) }, 6000)
})
client.on('error', e => console.log('ERR', e.message))
client.on('end', r => { console.log('END', r); try { lock.release?.() } catch {}; process.exit(0) })
setTimeout(() => { try { lock.release?.() } catch {}; process.exit(1) }, 35000)
