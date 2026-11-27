// The Mojang sessionserver, faked for a test that drives the real protocol library
// (#722, #756).
//
// `minecraft-protocol`'s login handler answers `yggdrasil`'s `hasJoined` before
// `options.beforeLogin`, so a test whose subject is a login reaching a leg at all has to
// stand where that call stands: on the module object the library's own login handler
// holds. Calling the leg's end handler by hand would prove nothing about who calls it, or
// when. `yggdrasil` is the library's dependency and not this repo's, so there is no
// `node_modules/yggdrasil` to import. `createRequire` on the library resolves the same
// copy the handler holds, and patching that copy is what changes the answer.
//
// The answers below are the sessionserver's, as `yggdrasil` delivers them. A 204 carries
// an empty body, so `JSON.parse('')` throws and `hasJoined` calls back with that error,
// and the login handler cares only that there was one. The fake answers on the next tick,
// as a reply over the network arrives.
//
// Not a test file: `mise run test` runs `test/*/*.test.js`, so nothing here runs on its
// own.
import { createRequire } from 'node:module'

const repoRequire = createRequire(import.meta.url)
const protocolRequire = createRequire(repoRequire.resolve('minecraft-protocol'))
const yggdrasil = protocolRequire('yggdrasil')

// A 204 from the sessionserver: the session is not joined, and every cause of that is one
// error to the login handler.
export const refusesAsA204Does = callback => {
  try { JSON.parse('') } catch (error) { callback(error) }
}

// A joined session, as the profile the login handler then stamps onto the client. The id
// is undashed, which is the form the sessionserver answers with.
export const acceptsAsASession = ({ id, name }) => callback => callback(null, { id, name })

// One lane's session answer, for the length of `run`. The patch is undone whether the run
// returned or threw.
export async function withSessionserver (answer, run) {
  const original = yggdrasil.server
  yggdrasil.server = () => ({
    // A server never calls this. It is here so the fake is the shape login.js uses.
    join: (...args) => args[args.length - 1](new Error('a server never joins a session')),
    hasJoined: (username, serverId, sharedSecret, publicKey, callback) => {
      setTimeout(() => answer(callback), 10)
    }
  })
  try {
    return await run()
  } finally {
    yggdrasil.server = original
  }
}
