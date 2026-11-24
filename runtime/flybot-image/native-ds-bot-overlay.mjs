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
    '98713d86c6cbf85adab1d0a2d303140778d9ed85fb2220abdadfab377a5f539f',
    'a074c82b37c0a02dfbfa9acd6465b7a14151e86e5208d7093b28d431460c2f9d',
  ],
  'src/client/at-menu.js': [
    'a0feee8fdb684324e7160f422c7930ec4ae032ef214d5d4651a7f6ede3c82124',
    '774bc40c1b6894be3913d9c7161d3f89c125038c8e81874ee9b6dbc0ec0c5bb7',
  ],
  'src/client/group-settings.js': [
    '4f4aa19f4972f734c6fe8d71553a6c17386d9418bd84e56106ed4e48b9b7fdca',
    '32851a465705573537a4c8298469d3d2d4f6140ff18a521651a546214b7d7915',
  ],
  'src/client/i18n.js': [
    '6b9e5157267f10cf8cdb554a770c3672ae5dcfef722d4a3730c65ea8a18ab83c',
    'f0f0b0b26c6698f06e991c30fda2f3494a9302f359a5c459216e2c55d153cabb',
  ],
  'src/client/new-chat.js': [
    '3f98f6db4cf84f6a9ad9aaef9228a6332970e0ce5bfa1533cda100faf570bf06',
    'cc44ddde3947c8ca20c6c0a8806366f57a4b2f6b86f22ef21dde63cc97d8d6c9',
  ],
  'src/client/team-actions.js': [
    '90f2dd67f80cea35d08c0a8553891b03e44cab5929130d364bbff87c9a1389dd',
    'c09d6d8de803d46a8ca1346cc16f866561d13acb8e2fb67bfb9809618dc4f066',
  ],
  'src/host/groups.js': [
    '06c261868b55ee7cdc53dc3b98759779c1d0e5cd60ad6f39beeca24458e7a91c',
    '5d43add77c3a7dd0ddc1e4dfcb14e05be11b95c0029ff04b8405bfff8575b0fb',
  ],
  'src/host/capabilities.js': [
    '656fcc0b0fb7fd597dfd0f62bd49522d92becd4ed1c77dd53ba016f045614c89',
    '321be0845446f49d8e0a8a2c6fc6acc95e178042b33a5c37e93aa7f2e6c079ca',
  ],
  'src/host/channel.js': [
    '34b2a23af48a7c90984cca4050d3187816a9873fd513005cfb4663a6b8a33cb8',
    'a24c9c2421c93aaacb5f50b58bbf3733883976908b8ee64866d9ef4e3f32cd0f',
  ],
  'src/host/bot-tasks.js': [
    '07701ae804298f68aa54f6fb8d69c7b98b4b99afd059d81d107d320bdc593e7e',
    '16c61d88dd2e9d3a5257fe12d818e830c9392d72b5f1db24a52f012481f87243',
  ],
  'src/host/parts.js': [
    'd0c762e46a00d053220eda242efaf503d24e15dbcff65ea6ac39c42f3d5234a6',
    'ea7ca0a5bd1b60db291c4a555dc0694d089b4a3a4fb04a916b63ee0c480af924',
  ],
  'src/host/store.js': [
    '6494f21fe71c208d246d56947680fdcbe55b77546c12bdf1da240854e0d5a504',
    '76fbe8fe334567c266ef740335fa8ef6cdf9d5f8fa7be37296b9fcd511e85972',
  ],
  'src/host/threads.js': [
    'e93710eacf98a2e86c74bd768f55590f1ac9af98748e4dc74148e5bc5b6e90e0',
    'e3d1421905a6b1bbbeb9ce12bd94b2cc997cd6ba95cd90558a00fd5f2b0d1118',
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
