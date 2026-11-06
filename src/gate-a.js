#!/usr/bin/env node
// Gate A scenario runner: runs the full relay scenario, writes
// testdata/gate-a-report.json and prints a PASS/FAIL summary.
// Exits 0 on pass, 1 on failure.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runGateAScenario } from './scenario.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const report = await runGateAScenario({ logStream: process.stderr })

await mkdir(path.join(root, 'testdata'), { recursive: true })
await writeFile(path.join(root, 'testdata', 'gate-a-report.json'), JSON.stringify(report, null, 2) + '\n')

console.log('')
console.log('Gate A - protocol relay spike (minecraft 26.1 / protocol 775)')
console.log('')
for (const a of report.assertions) {
  console.log(`  [${a.ok ? 'PASS' : 'FAIL'}] ${a.name}`)
}
console.log('')
console.log(`${report.assertions.filter(a => a.ok).length}/${report.assertionCount} assertions passed`)
console.log(`metrics: ${JSON.stringify(report.metrics)}`)
console.log(`backend: logins=${report.backend.logins} positions=${report.backend.positions} digs=${report.backend.digs} places=${report.backend.places} chats=${report.backend.chats}`)
console.log(`report: testdata/gate-a-report.json`)
console.log('')

if (!report.passed) {
  console.error(`FAILED assertions: ${report.failedAssertions.join(', ')}`)
  process.exit(1)
}
