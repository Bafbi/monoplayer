// Test harness: a TCP proxy that records the Minecraft handshake intent and
// rewrites TRANSFER (3) to LOGIN (2) for the fake backend.
//
// Why this exists: minecraft-protocol's server predates handshake intent 3 and
// throws on it. A fake backend therefore cannot prove that the real client leg
// advertises a transfer; this proxy records the intent on the wire and lets
// the fake backend accept the rewritten login. It is also the regression guard
// for the 2026-11-08 sky-2 failure (intent 2 was rejected as "not by this
// method").
import net from 'node:net'

function encodeVarint (value) {
  const out = []
  let n = value >>> 0
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n)
  return Buffer.from(out)
}

function readVarint (buffer, offset) {
  let value = 0
  let shift = 0
  let index = offset
  while (index < buffer.length) {
    const byte = buffer[index]
    value |= (byte & 0x7f) << shift
    index++
    if ((byte & 0x80) === 0) return { value, offset: index }
    shift += 7
    if (shift > 35) return null
  }
  return null
}

function parseHandshake (buffer) {
  const lengthField = readVarint(buffer, 0)
  if (!lengthField) return null
  const total = lengthField.offset + lengthField.value
  if (buffer.length < total) return null
  const body = buffer.subarray(lengthField.offset, total)

  const packetId = readVarint(body, 0)
  if (!packetId || packetId.value !== 0x00) return null
  const protocol = readVarint(body, packetId.offset)
  if (!protocol) return null
  const hostLength = readVarint(body, protocol.offset)
  if (!hostLength) return null
  const hostStart = hostLength.offset
  const hostEnd = hostStart + hostLength.value
  if (hostEnd + 2 > body.length) return null
  const host = body.subarray(hostStart, hostEnd).toString('utf8')
  const port = body.readUInt16BE(hostEnd)
  const nextState = readVarint(body, hostEnd + 2)
  if (!nextState) return null

  const rewrittenBody = Buffer.concat([
    encodeVarint(0x00),
    encodeVarint(protocol.value),
    encodeVarint(Buffer.byteLength(host, 'utf8')),
    Buffer.from(host, 'utf8'),
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(port); return b })(),
    encodeVarint(2)
  ])
  const rewritten = Buffer.concat([encodeVarint(rewrittenBody.length), rewrittenBody])

  return {
    total,
    protocolVersion: protocol.value,
    host,
    port,
    nextState: nextState.value,
    rewritten
  }
}

// Start a proxy to targetPort. Resolves when listening with:
//   { port, nextStates, close() }.
export function createHandshakeProxy ({
  targetHost = '127.0.0.1',
  targetPort,
  log = () => {}
} = {}) {
  if (!Number.isInteger(targetPort) || targetPort < 1) throw new TypeError('targetPort is required')

  const nextStates = []
  const sockets = new Set()
  const server = net.createServer(client => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.on('error', () => { /* the other side owns the close */ })

    let buffer = Buffer.alloc(0)
    let forwarded = false

    const onData = chunk => {
      if (forwarded) return
      buffer = Buffer.concat([buffer, chunk])
      const parsed = parseHandshake(buffer)
      if (!parsed) return
      forwarded = true
      client.off('data', onData)
      nextStates.push(parsed.nextState)
      log('handshake', {
        nextState: parsed.nextState,
        protocolVersion: parsed.protocolVersion,
        host: parsed.host,
        port: parsed.port
      })

      const target = net.connect(targetPort, targetHost, () => {
        target.write(parsed.rewritten)
        if (buffer.length > parsed.total) target.write(buffer.subarray(parsed.total))
        client.pipe(target)
        target.pipe(client)
      })
      sockets.add(target)
      target.on('close', () => sockets.delete(target))
      target.on('error', () => client.destroy())
      client.on('error', () => target.destroy())
    }
    client.on('data', onData)
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        nextStates,
        close () {
          for (const socket of sockets) {
            try { socket.destroy() } catch { /* already gone */ }
          }
          sockets.clear()
          try { server.close() } catch { /* already closed */ }
        }
      })
    })
  })
}
