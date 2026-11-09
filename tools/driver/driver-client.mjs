#!/usr/bin/env node
// Tiny client for the client driver. Run from the workspace with an SSH tunnel:
//   ssh -N -L 25599:127.0.0.1:25599 bafbi@nath.tail41e568.ts.net
//   node tools/driver/driver-client.mjs status
import net from 'node:net'

const args = process.argv.slice(2)
const op = args.shift() || 'status'
const host = process.env.GATEB_DRIVER_HOST || '127.0.0.1'
const port = Number(process.env.GATEB_DRIVER_PORT || 25599)

const request = { op }
if (op === 'click') request.label = args.join(' ')
if (op === 'move') request.ms = Number(args[0] || 1000)
if (op === 'look') {
  request.yaw = Number(args[0] || 0)
  request.pitch = Number(args[1] || 0)
}
if ((op === 'break' || op === 'place') && args.length >= 3) {
  request.x = Number(args[0])
  request.y = Number(args[1])
  request.z = Number(args[2])
}
if ((op === 'break' || op === 'place') && args.length >= 4) request.ms = Number(args[3])
if (process.env.GATEB_DRIVER_TOKEN) request.token = process.env.GATEB_DRIVER_TOKEN

const socket = net.createConnection({ host, port }, () => {
  socket.write(JSON.stringify(request) + '\n')
})

let buffer = ''
socket.setEncoding('utf8')
socket.on('data', chunk => {
  buffer += chunk
  const newline = buffer.indexOf('\n')
  if (newline === -1) return
  const line = buffer.slice(0, newline)
  buffer = buffer.slice(newline + 1)
  try {
    console.log(JSON.stringify(JSON.parse(line), null, 2))
  } catch {
    console.log(line)
  }
  socket.end()
})
socket.on('error', err => {
  console.error(`driver error: ${err.message}`)
  process.exitCode = 1
})
socket.setTimeout(15000, () => {
  console.error('driver timeout')
  socket.destroy()
  process.exitCode = 1
})
