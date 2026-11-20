#!/usr/bin/env node
/**
 * The client-module id must equal the package name.
 *
 * DSH's client-modules registry looks the browser-side factory up by package
 * name and rejects a registration whose `id` differs: the loader reports
 * "loaded without registering", retries, then hits a duplicate factory
 * registration and skips the whole batch of initial bundles — which surfaces
 * to the user as "web boot: N entries did not activate". Renaming a package
 * therefore has to touch package.json, the bundle patch and this file; this
 * check is what catches the third one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'client.js'), 'utf8')

const problems = []

const registration = source.match(/__ModuleLoader__\s*\.\s*load\s*\(\s*\{\s*id\s*:\s*['"]([^'"]+)['"]/)
if (!registration) {
  problems.push('client.js: could not find `__ModuleLoader__.load({ id: "..." })`')
} else if (registration[1] !== pkg.name) {
  problems.push(`client.js registers id "${registration[1]}" but package.json names this package "${pkg.name}"`)
}

const legacy = source.match(/['"]@local\/[^'"]*['"]/g)
if (legacy) {
  problems.push(`client.js still mentions a legacy local package name: ${[...new Set(legacy)].join(', ')}`)
}

if (problems.length > 0) {
  console.error('client module check failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`ok  client.js registers "${pkg.name}"`)