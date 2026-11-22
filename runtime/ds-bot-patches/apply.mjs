#!/usr/bin/env node
// Apply ordered image-build patches to a *copy* of the vendored ds-bot tree.
// The tree in git must stay pin-identical; this script is for the runtime image
// (and for the unit test that checks the patches still apply).
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export function listPatches(patchesDir = here) {
  return readdirSync(patchesDir)
    .filter((name) => name.endsWith('.patch'))
    .sort()
    .map((name) => join(patchesDir, name))
}

export function applyPatches({ root, patchesDir = here, check = false } = {}) {
  if (!root) throw new Error('applyPatches: root is required')
  const patches = listPatches(patchesDir)
  if (patches.length === 0) throw new Error(`no .patch files in ${patchesDir}`)
  const applied = []
  for (const patch of patches) {
    const args = ['apply']
    if (check) args.push('--check')
    args.push(patch)
    // Run inside the tree. `git apply --directory=/abs` is rejected as an
    // "invalid path" because the result looks absolute.
    const result = spawnSync('git', args, { cwd: resolve(root), encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
      throw new Error(`git apply failed for ${patch} (exit ${result.status})${detail ? `:\n${detail}` : ''}`)
    }
    applied.push(patch)
  }
  return applied
}

const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const rootIdx = argv.indexOf('--root')
  const root = rootIdx >= 0 ? argv[rootIdx + 1] : null
  if (!root) {
    console.error('usage: node apply.mjs --root <ds-bot-dir> [--check]')
    process.exit(2)
  }
  const files = applyPatches({ root, check: argv.includes('--check') })
  console.log(`${argv.includes('--check') ? 'checked' : 'applied'} ${files.length} patch(es)`)
}
