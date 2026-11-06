// NDJSON client for the Gate B Fabric driver socket (127.0.0.1:25599 on the
// display host, usually tunneled to the workspace with SSH). One request per
// connection, one JSON response back, matching tools/gate-b-driver:
//
//   request  -> {"op":"status","token":...}\n
//   response -> {"ok":true,"data":{...}}  |  {"ok":false,"error":"..."}
//
// Transport failures (connect refused, timeouts, protocol garbage) throw a
// DriverError; an `ok:false` envelope is returned as-is so the scenario can
// record it as evidence instead of guessing. Env: GATEB_DRIVER_HOST/PORT/TOKEN.
import net from 'node:net'

export function createDriverClient ({
  host = process.env.GATEB_DRIVER_HOST || '127.0.0.1',
  port = Number(process.env.GATEB_DRIVER_PORT || 25599),
  token = process.env.GATEB_DRIVER_TOKEN || '',
  connectTimeoutMs = 5000,
} = {}) {
  let requestSeq = 0

  async function request (op, params = {}, { timeoutMs = 20000 } = {}) {
    const id = ++requestSeq
    return await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host, port })
      socket.setEncoding('utf8')
      let buffer = ''
      let settled = false
      let timer = setTimeout(() => {
        fail(new DriverError(`op ${op} (#${id}) timed out after ${timeoutMs} ms`, 'timeout'))
      }, timeoutMs)

      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      const done = envelope => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.end(() => resolve(envelope))
      }

      socket.on('connect', () => {
        const payload = { op, ...params }
        if (token !== '') payload.token = token
        socket.write(JSON.stringify(payload) + '\n')
      })
      socket.on('data', chunk => {
        buffer += chunk
        const newline = buffer.indexOf('\n')
        if (newline === -1) return
        const line = buffer.slice(0, newline)
        try {
          done(JSON.parse(line))
          const rest = buffer.slice(newline + 1)
          if (rest.trim() !== '') fail(new DriverError('unexpected extra data after one response', 'protocol'))
        } catch {
          fail(new DriverError(`op ${op} (#${id}) got non-JSON response: ${line.slice(0, 200)}`, 'protocol'))
        }
      })
      socket.on('error', error => {
        fail(new DriverError(`op ${op} (#${id}) socket error: ${error.message}`, 'connect'))
      })
      socket.on('close', () => {
        fail(new DriverError(`op ${op} (#${id}) connection closed before a response`, 'connect'))
      })
    })
  }

  return { request, host, port }
}

export class DriverError extends Error {
  constructor (message, code) {
    super(message)
    this.name = 'DriverError'
    this.code = code
  }
}
