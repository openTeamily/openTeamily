import { mkdtempSync, cpSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'
import { applyPatches, listPatches } from './apply.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../..')
const vendorRoot = join(repoRoot, 'runtime/ds-bot-upstream/ds-bot')
const FILES = [
  'client.js',
  'src/client/group-settings.js',
  'src/host/channel.js',
]

function stageVendorCopy() {
  const dir = mkdtempSync(join(tmpdir(), 'ds-bot-patches-'))
  for (const rel of FILES) {
    const dest = join(dir, rel)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(join(vendorRoot, rel), dest)
  }
  return dir
}

test('there is at least one ordered patch', () => {
  assert.ok(listPatches(here).length >= 1)
})

test('patches apply to the pinned vendor tree and restore the #524 hook', () => {
  const dir = stageVendorCopy()
  try {
    applyPatches({ root: dir, check: true })
    const applied = applyPatches({ root: dir })
    assert.equal(applied.length, listPatches(here).length)
    const group = readFileSync(join(dir, 'src/client/group-settings.js'), 'utf8')
    const channel = readFileSync(join(dir, 'src/host/channel.js'), 'utf8')
    const client = readFileSync(join(dir, 'client.js'), 'utf8')
    assert.match(group, /remoteParticipants/)
    assert.match(group, /Shared human participants/)
    assert.match(channel, /remoteParticipants: Array\.isArray\(body\.remoteParticipants\)/)
    assert.match(client, /room2\.openteamily\?\.conversation_id/)
    assert.match(client, /Shared human participants/)
    assert.throws(() => applyPatches({ root: dir }), /git apply failed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
