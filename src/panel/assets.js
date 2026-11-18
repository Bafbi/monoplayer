// The panel's own files, served from src/panel/public.
//
// The tailnet Service is the only thing answering on the panel's name, so a
// stylesheet fetched from anywhere else is a request that fails. Everything the
// browser loads therefore lives in this directory and is served here: the
// compiled Tailwind bundle, the vendored htmx and its SSE extension, the pixel
// font, and the one small script that sends a write (#248).
//
// An extension allowlist, not a directory listing. A file that lands in public/
// is not served until its type is named below: a stray .map or a .bak must not
// become a route because it was copied in beside the assets. A path with an
// unlisted extension is not this route's, so the router answers its own 404.
//
// Two shapes of refusal, and they are different facts:
//
//   400  the path decodes to something that is not a path this route takes,
//        including a dot segment that would leave public/
//   404  the path is well formed, its type is served, and no such file exists
//
// The dot-segment check is on the decoded segments and runs before the filesystem
// is touched. src/panel/public sits one level below the service's own source, so
// a single dot segment that reached readFileSync would serve the panel's handler.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PREFIX = '/static/'
// Resolved, so the trailing separator the URL carries is gone: the escape guard
// below compares a joined path against this directory plus one separator, and a
// double separator there would refuse every file.
export const PUBLIC_DIR = path.resolve(fileURLToPath(new URL('./public/', import.meta.url)))

// The types this route serves. Anything else is not this route's to answer.
export const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.LICENSE': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
}

const TEXT = 'text/plain; charset=utf-8'

// The path this route takes, or null when it is not an asset request at all.
// The result names a path inside PUBLIC_DIR with no dot segment; whether it
// exists is the handler's question, because a match that stats the disk would let
// a caller time the filesystem from the route table.
export function assetPath (requestPath) {
  if (typeof requestPath !== 'string' || !requestPath.startsWith(PREFIX)) return null
  let decoded
  try {
    decoded = decodeURIComponent(requestPath.slice(PREFIX.length))
  } catch {
    return { invalid: true }
  }
  if (decoded === '') return null
  const segments = decoded.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return { invalid: true }
  // A backslash separates path segments on a Windows checkout, and a NUL ends a
  // C string: neither is a name this route carries.
  if (decoded.includes('\\') || decoded.includes('\u0000')) return { invalid: true }
  const type = TYPES[path.extname(decoded)]
  if (type === undefined) return null
  return { invalid: false, file: segments.join(path.sep), type }
}

export function createAssetRoute ({ root = PUBLIC_DIR, log = () => {} } = {}) {
  function match (requestPath) {
    return assetPath(requestPath)
  }

  async function handle (req, res, { send }) {
    const found = match((req.url ?? '/').split('?')[0])
    if (found === null || found.invalid === true) {
      return send(res, 400, TEXT, 'that is not a path this panel serves\n')
    }
    // Both halves of the join are inside the route's own tree: the file has no
    // dot segment and no leading separator, and the root is the panel's own
    // directory. The guard below is the assertion, not the mechanism, so a future
    // edit that relaxes assetPath fails closed instead of serving server.js.
    const base = path.resolve(root)
    const full = path.resolve(base, found.file)
    if (!full.startsWith(base + path.sep)) {
      log('panelAssetEscaped', { file: found.file })
      return send(res, 400, TEXT, 'that is not a path this panel serves\n')
    }
    let body
    try {
      body = fs.readFileSync(full)
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'EISDIR' && error?.code !== 'ENOTDIR') {
        log('panelAssetUnreadable', { file: found.file, reason: String(error?.message ?? error) })
      }
      return send(res, 404, TEXT, 'no such file\n')
    }
    return send(res, 200, found.type, body)
  }

  return { match, handle }
}
