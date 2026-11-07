#!/usr/bin/env node
// Add the vendored Minecraft 26.2 data to the installed minecraft-data package.
// package.json runs this from "postinstall"; running it again is safe.

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const VERSION = '26.2'
const BASE_VERSION = '26.1'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '..')
const vendorRoot = path.join(repoRoot, 'vendor', 'minecraft-data-26.2')
const require = createRequire(import.meta.url)

function readJson (file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`)
  }
}

// pnpm links package files from its store. Replace the directory entry instead
// of truncating in place so the store's copy is never modified.
function writeFresh (file, contents) {
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, contents)
  fs.renameSync(tmp, file)
}

let packageJson
try {
  packageJson = require.resolve('minecraft-data/package.json')
} catch (err) {
  throw new Error(`minecraft-data is not installed: ${err.message}`)
}
const packageRoot = path.dirname(packageJson)
const dataRoot = path.join(packageRoot, 'minecraft-data')

// 1. Pinned data files. The vendor tree mirrors the package layout.
const vendoredPc = path.join(vendorRoot, 'data', 'pc')
for (const version of fs.readdirSync(vendoredPc)) {
  fs.cpSync(path.join(vendoredPc, version), path.join(dataRoot, 'data', 'pc', version), {
    recursive: true,
    force: true
  })
}

// 2. Data paths for the version.
const dataPathsFile = path.join(dataRoot, 'data', 'dataPaths.json')
const dataPaths = readJson(dataPathsFile)
const vendoredDataPaths = readJson(path.join(vendorRoot, `dataPaths-${VERSION}.json`))
dataPaths.pc[VERSION] = { ...(dataPaths.pc[VERSION] ?? {}), ...vendoredDataPaths }
writeFresh(dataPathsFile, `${JSON.stringify(dataPaths, null, 2)}\n`)

// 3. Protocol versions, replaced by minecraftVersion.
const protocolVersionsFile = path.join(dataRoot, 'data', 'pc', 'common', 'protocolVersions.json')
const protocolVersions = readJson(protocolVersionsFile)
for (const entry of readJson(path.join(vendorRoot, 'protocolVersions.json'))) {
  const index = protocolVersions.findIndex((other) => other.minecraftVersion === entry.minecraftVersion)
  if (index === -1) {
    protocolVersions.push(entry)
  } else {
    protocolVersions[index] = entry
  }
}
writeFresh(protocolVersionsFile, JSON.stringify(protocolVersions))

// 4. data.js entry, built from the 26.1 field list and the 26.2 data paths.
const dataJsFile = path.join(packageRoot, 'data.js')
let dataJs = fs.readFileSync(dataJsFile, 'utf8')

const hasEntry = new RegExp(`^ {4}'${VERSION.replaceAll('.', '\\.')}': \\{`, 'm').test(dataJs)
if (!hasEntry) {
  const baseBlock = new RegExp(
    `^ {4}'${BASE_VERSION.replaceAll('.', '\\.')}': \\{\\n([\\s\\S]*?)^ {4}\\},?$`,
    'm'
  ).exec(dataJs)
  if (!baseBlock) {
    throw new Error(`no '${BASE_VERSION}' entry in ${dataJsFile}; cannot build the '${VERSION}' entry`)
  }

  const fields = [...baseBlock[1].matchAll(/^ {6}get (\w+) \(\)/gm)].map((match) => match[1])
  if (fields.length === 0) {
    throw new Error(`no data fields in the '${BASE_VERSION}' entry of ${dataJsFile}`)
  }

  const dataPathsForVersion = dataPaths.pc[VERSION]
  const lines = fields.map((field) => {
    const dir = dataPathsForVersion[field]
    if (!dir) {
      throw new Error(`no '${field}' data path for ${VERSION}`)
    }
    if (!fs.existsSync(path.join(dataRoot, 'data', dir, `${field}.json`))) {
      throw new Error(`missing ${field} data at ${path.join(dataRoot, 'data', dir, `${field}.json`)}`)
    }
    return `      get ${field} () { return require("./minecraft-data/data/${dir}/${field}.json") },`
  })

  const protoDir = dataPathsForVersion.proto
  if (!protoDir || !fs.existsSync(path.join(dataRoot, 'data', protoDir, 'proto.yml'))) {
    throw new Error(`missing proto data for ${VERSION}`)
  }
  lines.push(`      proto: __dirname + '/minecraft-data/data/${protoDir}/proto.yml'`)

  const entry = `    '${VERSION}': {\n${lines.join('\n')}\n    }`
  const insertAt = baseBlock.index + baseBlock[0].length
  dataJs = `${dataJs.slice(0, insertAt)},\n${entry}${dataJs.slice(insertAt)}`
  writeFresh(dataJsFile, dataJs)
}

const version = readJson(packageJson).version
console.log(
  `minecraft-data@${version}: applied ${VERSION} data at ${dataRoot}` +
  ` (${hasEntry ? 'data.js entry already present' : 'data.js entry added'})`
)
