// Apply the OpenTeamily integration to an image's copy of the pinned Apache-2.0
// DS-Bot source. Keep the upstream tree and pin in Git independently verifiable.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sourceDir = fileURLToPath(new URL('../ds-bot-upstream/ds-bot/', import.meta.url))
const patch = fileURLToPath(new URL('./native-ds-bot.patch', import.meta.url))
const files = {
  'client.js': [
    '2527e2a9bc6dcae9d4b08973e6b677db7e515cadb3d0843c7474bffbdff56034',
    '34d617b7c6472695a2139ceed94879d1ef8c5ebd049d597b18f7e14346df9999',
  ],
  'src/client/at-menu.js': [
    'a0feee8fdb684324e7160f422c7930ec4ae032ef214d5d4651a7f6ede3c82124',
    '774bc40c1b6894be3913d9c7161d3f89c125038c8e81874ee9b6dbc0ec0c5bb7',
  ],
  'src/client/group-settings.js': [
    '4f4aa19f4972f734c6fe8d71553a6c17386d9418bd84e56106ed4e48b9b7fdca',
    'bc23ba5a3fa351d83c1714441055a022fb1d4f813479908777519b0b191b240b',
  ],
  'src/client/i18n.js': [
    'b4532d9f3df3570690ce67ca16f6bf31b4daad7a37be0a8800bedcbcbd77f606',
    '424ee582bfca9ab5b46e604b54d74de7cf1b75b521bf0250669a3aae982a72f6',
  ],
  'src/client/new-chat.js': [
    '3f98f6db4cf84f6a9ad9aaef9228a6332970e0ce5bfa1533cda100faf570bf06',
    'cc44ddde3947c8ca20c6c0a8806366f57a4b2f6b86f22ef21dde63cc97d8d6c9',
  ],
  'src/client/team-actions.js': [
    'd827f54bbcd41e2572ba6fd02879b182f596cd7cc48e03f5ad1bdcb5ab036008',
    '37217792866074e48a6ed890615db2633f9dd4e817c23e18570c174c5f046419',
  ],
  'src/host/capabilities.js': [
    'c9f9a62de52275fa93a289b49894fcbaa8bd01c4d5f37e932cdedc8afd65738a',
    'f23fc96ac541c79a0fdd58fb0872421a1ddc9903dc9c460480fab176a8328b9b',
  ],
  'src/host/channel.js': [
    'ac73e8f9b1d14eb9aae4672f7c1e5c33d4b803362db7f5bd34efefb3a748c51f',
    '91d8d69a6dfcfb0308fedb0e03881e0f9edf8a584fff40296ac64f9e0630b796',
  ],
}

const digest = (root, path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex')

export function applyNativeOverlay(root) {
  const observed = Object.entries(files).map(([path, [upstream, deployed]]) => ({
    path, upstream, deployed, bytes: digest(root, path),
  }))
  if (observed.every(file => file.bytes === file.deployed)) return
  const invalid = observed.find(file => file.bytes !== file.upstream)
  if (invalid) throw new Error(`Unexpected pinned DS-Bot source: ${invalid.path}`)
  execFileSync('git', ['apply', '--check', patch], { cwd: root, stdio: 'inherit' })
  execFileSync('git', ['apply', patch], { cwd: root, stdio: 'inherit' })
  for (const { path, deployed } of observed) {
    if (digest(root, path) !== deployed) throw new Error(`Unexpected DS-Bot overlay result: ${path}`)
  }
}

export function assertNativeConsentOverlay(root = sourceDir) {
  const path = 'src/host/capabilities.js'
  if (digest(root, path) !== files[path][1]) {
    throw new Error('Build the FlyBot image to load the OpenTeamily native skill consent integration')
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length !== 3) throw new Error('Pass the image build copy of the DS-Bot source directory')
  applyNativeOverlay(resolve(process.argv[2]))
}
