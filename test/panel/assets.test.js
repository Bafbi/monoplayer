// The panel's own files: the vendored htmx, the compiled Tailwind bundle, and the
// pixel font. Each is served by the panel itself, because the tailnet Service is
// the only thing answering on that name (#248).
//
// Three promises are asserted here, and each one is a way the page can break
// without a test noticing:
//
//   1. every vendored script has its licence beside it, so the image ships the
//      terms it is used under;
//   2. a request cannot walk out of src/panel/public with a dot segment, because
//      the directory sits one level below the service's source;
//   3. the committed CSS bundle is a real Tailwind build, not a placeholder: it
//      carries the font face, the palette, and a utility the page actually uses.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { createPanelHandler } from '../../src/panel/server.js'
import { PUBLIC_DIR } from '../../src/panel/assets.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const VENDOR = path.join(ROOT, 'src', 'panel', 'public', 'vendor')

const puppet = {
  name: 'glowsquidye',
  namespace: 'monoplayer',
  deployment: 'monoplayer',
  controlConfigMap: 'monoplayer-control',
  seedConfigMap: 'monoplayer-config',
  frontHostname: 'glowsquidye.tail41e568.ts.net',
  backend: 'play2.excalia.fr:25565',
}

const kubernetes = {
  deployment: async () => ({ spec: { selector: { matchLabels: { app: 'monoplayer' } } } }),
  pods: async () => ({ items: [] }),
  podLog: async () => ''
}

async function panel (options = {}) {
  const server = http.createServer(createPanelHandler({
    registry: () => ({ version: 1, puppets: [puppet] }),
    kubernetes,
    ...options
  }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { url: 'http://127.0.0.1:' + port, close: () => new Promise(resolve => server.close(resolve)) }
}

test('the vendored scripts and the font are served by the panel, with their types', async () => {
  const { url, close } = await panel()
  try {
    const wanted = [
      ['/static/app.css', /^text\/css/],
      ['/static/vendor/htmx.min.js', /^text\/javascript/],
      ['/static/vendor/htmx-ext-sse.min.js', /^text\/javascript/],
      ['/static/panel.js', /^text\/javascript/],
      ['/static/fonts/VT323-Regular.ttf', /^font\/ttf/]
    ]
    for (const [route, type] of wanted) {
      const response = await fetch(url + route)
      assert.equal(response.status, 200, route + ' is served')
      assert.match(response.headers.get('content-type'), type, route + ' has its type')
      assert.equal(response.headers.get('cache-control'), 'no-store',
        route + ' is never cached: a stale script or stylesheet after a deploy is a page that lies')
      assert.ok((await response.arrayBuffer()).byteLength > 0, route + ' is not empty')
    }
  } finally {
    await close()
  }
})

test('every vendored script ships its licence beside it', () => {
  const scripts = fs.readdirSync(VENDOR).filter(name => name.endsWith('.js'))
  assert.ok(scripts.length >= 2, 'the vendor directory holds htmx and its sse extension')
  for (const script of scripts) {
    const licence = script.replace(/\.js$/, '.LICENSE')
    assert.ok(fs.existsSync(path.join(VENDOR, licence)), script + ' has ' + licence + ' beside it')
    const text = fs.readFileSync(path.join(VENDOR, licence), 'utf8')
    assert.match(text, /BSD|MIT|OFL/, licence + ' names a licence')
  }
  // The font is OFL, and its licence file is the one the OFL requires beside it.
  const font = fs.readFileSync(path.join(PUBLIC_DIR, 'fonts', 'OFL.txt'), 'utf8')
  assert.match(font, /SIL OPEN FONT LICENSE/, 'the pixel font ships under the OFL')
})

test('nothing can walk out of the public directory', async () => {
  const { url, close } = await panel()
  try {
    for (const route of [
      '/static/../server.js',
      '/static/%2e%2e/server.js',
      '/static/..%2fserver.js',
      '/static/vendor/../../server.js',
      '/static//etc/passwd'
    ]) {
      const response = await fetch(url + route)
      assert.ok(response.status === 404 || response.status === 400,
        route + ' answers ' + response.status + ' instead of serving a file outside public/')
      assert.doesNotMatch(await response.text(), /createPanelHandler|root:x:/, route + ' leaks no file')
    }
  } finally {
    await close()
  }
})

test('the icon a browser asks for is an empty 204, not a console error', async () => {
  const { url, close } = await panel()
  try {
    const response = await fetch(url + '/favicon.ico')
    assert.equal(response.status, 204, 'the panel has no icon, and says so once per load')
    assert.equal((await response.arrayBuffer()).byteLength, 0)
  } finally {
    await close()
  }
})

test('a path the panel does not ship is a 404, not an empty file', async () => {
  const { url, close } = await panel()
  try {
    for (const route of ['/static/', '/static/nothing.css', '/static/vendor', '/static/app.css.in']) {
      assert.equal((await fetch(url + route)).status, 404, route + ' is not served')
    }
  } finally {
    await close()
  }
})

test('the committed bundle is a Tailwind build, not a placeholder', () => {
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'app.css'), 'utf8')
  // The font, the palette, and one utility the page uses: a file that has any of
  // them missing is a bundle compiled from a different tree than the page was.
  assert.match(css, /font-family:\s*"?VT323/, 'the pixel font is declared')
  assert.match(css, /VT323-Regular\.ttf/, 'the font file is served from the panel')
  assert.match(css, /--color-grass/, 'the 2.5D palette is in the bundle')
  assert.match(css, /\.isometric|clip-path/, 'the isometric blocks are in the bundle')
  assert.ok(css.length > 2000, 'the bundle holds more than a reset')
  assert.doesNotMatch(css, /@tailwind\b|@import\s+"tailwindcss"/,
    'the bundle is compiled: no directives are left for a browser to resolve')
})
