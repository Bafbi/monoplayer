// Testbed client: Bafbi's real Microsoft account through the testbed front.
//
//   node src/testbed/client.js [host] [port]
//
// It attaches, records the play login, and on a kick logs the reason and
// retries until it lands on the new server. Run it before
// `node src/testbed/switch.js transfer`. A stable attach for the whole window
// is the seamless-switch success signal; an end plus a successful reattach is
// the current kick behavior.
import fs from 'node:fs'
import { createTokenCustody } from '../auth/cache.js'
import { createBot } from '../ladder/bot.js'

const host = process.argv[2] ?? process.env.TESTBED_FRONT_HOST ?? 'monoplayer-testbed.tail41e568.ts.net'
const port = Number(process.argv[3] ?? 25565)
const windowMs = Number(process.env.TESTBED_CLIENT_MS ?? 150_000)
const dir = '.secrets/accounts/6eb73524-ff88-4a62-a8d0-c63905e7afba'
const uuid = '6eb73524-ff88-4a62-a8d0-c63905e7afba'
const profile = JSON.parse(fs.readFileSync(`${dir}/profile.json`, 'utf8'))

const custody = createTokenCustody({ account: 'bafbi', dir, uuid, create: false, legacyAccount: 'bafbi' })
const lock = custody.writerLock.acquire()
if (!lock.ok) {
  console.error('bafbi custody writer lock is held', lock.holder)
  process.exit(2)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = Date.now() + windowMs

function once (index) {
  return new Promise((resolve) => {
    const bot = createBot({
      host,
      port,
      username: 'Bafbi',
      version: '26.2',
      auth: 'microsoft',
      profilesFolder: custody.cacheFactory,
      authTitle: profile.authTitle,
      deviceType: profile.deviceType,
      flow: 'live',
      logStream: null
    })

    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      try { bot.close() } catch { /* already closed */ }
      resolve(outcome)
    }

    bot.ready(60_000).then(() => {
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        event: 'attached',
        attempt: index,
        entityId: bot.received.login?.entityId ?? null,
        worldNames: bot.received.login?.worldNames ?? null
      }))
      // A stable attach until the window closes is the seamless outcome.
      const remaining = Math.max(0, deadline - Date.now())
      Promise.race([bot.ended, sleep(remaining)]).then(() => {
        if (bot.received.ended === null && Date.now() >= deadline) {
          console.log(JSON.stringify({ t: new Date().toISOString(), event: 'stable', attempt: index, ms: windowMs }))
          finish('stable')
          return
        }
        console.log(JSON.stringify({
          t: new Date().toISOString(),
          event: 'ended',
          attempt: index,
          reason: bot.received.ended,
          kick: bot.received.kick ?? null,
          errors: bot.received.errors
        }))
        finish('ended')
      })
    }, (error) => {
      console.log(JSON.stringify({
        t: new Date().toISOString(),
        event: 'attach_failed',
        attempt: index,
        error: String(error?.message ?? error).slice(0, 200)
      }))
      finish('failed')
    })
  })
}

let attempt = 0
while (Date.now() < deadline) {
  const outcome = await once(attempt++)
  if (outcome === 'stable') break
  await sleep(3000)
}
try { lock.release?.() } catch { /* best effort */ }
process.exit(0)
