import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {withSpeechOverlay} from '../speech-overlay.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const repo = join(root, '..', '..')
const read = (rel) => readFileSync(join(root, rel), 'utf8')

test('the web image enables local meeting speech without repeating the optional voice bundle', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ot-speech-profile-'))
  t.after(() => rmSync(home, {recursive:true, force:true}))
  const profile = join(home, 'profiles', 'web')
  mkdirSync(profile, {recursive:true})
  const writeProfile = bundles => writeFileSync(join(profile, 'package.json'), JSON.stringify({dsh:{profile:{bundles}}}))
  const args = ['--profile', 'web', '--no-open']
  writeProfile([])
  const expanded = withSpeechOverlay(args, home)
  assert.deepEqual(expanded, ['--profile', 'web', '--patch', join(root, 'meeting-speech.patch.yml'), '--no-open'])
  assert.match(read('meeting-speech.patch.yml'), /defaultProvider: sensevoice-local/)
  assert.match(read('meeting-speech.patch.yml'), /dshHomePath\('speech-to-text', 'sensevoice'\)/)
  writeProfile(['@deepseek-ai/dsh-experimental-voice-input-bundle'])
  assert.deepEqual(withSpeechOverlay(args, home), args)
})

test('image matches the compose manager contract (UID 1000, port 8080, healthcheck)', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /^\s*USER 1000:1000\s*$/m)
  assert.match(docker, /^\s*EXPOSE 8080\s*$/m)
  assert.match(docker, /^\s*HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --start-interval=1s --retries=5 /m)
  assert.match(docker, /DSH_LISTEN_PORT=8080/)
  assert.match(docker, /flybot-image\/entrypoint\.sh/)
  const engine = readFileSync(join(repo, 'openteamily', 'manager', 'engine.py'), 'utf8')
  assert.match(engine, /'target': 8080/)
  assert.match(engine, /'user': '1000:1000'/)
  assert.match(engine, /'read_only': True/)
  assert.match(engine, /'target': '\/data'/)
})

test('entrypoint is non-root and keeps the workspace on /data', () => {
  const entry = read('entrypoint.sh')
  const body = entry.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.doesNotMatch(body, /\b(gosu|groupmod|usermod|chown)\b/)
  assert.match(entry, /DSH_LISTEN_PORT:-8080/)
  assert.match(entry, /mkdir -p \/data\/workspace/)
  assert.match(entry, /TMPDIR=\/data\/tmp/)
  assert.match(entry, /launch\.mjs/)
  assert.match(entry, /cd \/data\/workspace/)
  const patch = read('docker.patch.yml')
  assert.match(patch, /workspace: \/data\/workspace/)
})

test('wrapper plugin boots upstream createRuntime and the social façade once', () => {
  const plugin = read('plugin/index.js')
  assert.match(plugin, /from '\.\.\/\.\.\/ds-bot-upstream\/ds-bot\/index\.js'/)
  assert.match(plugin, /from '\.\.\/\.\.\/flybot-social-host\/index\.js'/)
  assert.match(plugin, /createRuntime\(/)
  assert.match(plugin, /applyOnRuntime\(/)
  assert.match(plugin, /loadBotSocialConfig/)
  assert.doesNotMatch(plugin, /onboard:\s*false/)
  assert.match(plugin, /registerFlybotRoute\(/)
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /name !== 'ds-bot'/)
  assert.match(prepare, /symlinkSync\(dir, dest\)/)
  assert.match(prepare, /link:\$\{dir\}/)

  assert.match(prepare, /@openteamily\/flybot-runtime/)
  const manifest = JSON.parse(read('plugin/package.json'))
  assert.equal(manifest.name, '@openteamily/flybot-runtime')
  assert.equal(manifest.license, 'MIT')
  assert.equal(manifest.exports['./client'], '../../flybot-web-slots/client.js')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  const cordis = read('plugin/cordis.patch.yml')
  const cordisBody = cordis.split('\n').filter((line) => !line.trim().startsWith('#')).join('\n')
  assert.match(cordisBody, /id: bot/)
  assert.match(cordisBody, /name: '@openteamily\/flybot-runtime'/)
  assert.doesNotMatch(cordisBody, /name: ds-bot/)

})

test('recipe does not edit the vendored upstream tree', () => {
  const docker = read('Dockerfile')
  assert.match(docker, /COPY ds-bot-upstream\/ds-bot /)
  assert.match(docker, /npm ci --omit=dev/)
  assert.match(docker, /COPY ds-bot-upstream\/LICENSE \/opt\/licenses\/ds-bot\/LICENSE/)
  assert.match(docker, /COPY ds-bot-upstream\/NOTICE \/opt\/licenses\/ds-bot\/NOTICE/)
  assert.match(docker, /COPY flybot\/LICENSE \/opt\/licenses\/flybot\/LICENSE/)
  assert.match(docker, /COPY third_party\/libreoffice-kit \/opt\/licenses\/libreoffice-kit/)
  assert.match(docker, /COPY third_party\/font-notices \/opt\/licenses\/font-notices/)
  assert.match(docker, /COPY third_party\/sharp-libvips \/opt\/licenses\/sharp-libvips/)
  assert.match(docker, /COPY third_party\/anthropic-sdk \/opt\/licenses\/anthropic-sdk/)
  assert.match(docker, /install-redistribution-notices\.mjs/)

  assert.doesNotMatch(docker, /soffice\.wasm/)
  assert.match(docker, /warm-native-bindings\.cjs/)
  assert.doesNotMatch(docker, /sk-[A-Za-z0-9]/)
  assert.doesNotMatch(docker, /api_key\s*=/)
})

test('image recipe does not bake a model API key', () => {
  const files = ['Dockerfile', 'entrypoint.sh', 'launch.mjs', 'docker.patch.yml', 'plugin/index.js']
  for (const rel of files) {
    const text = read(rel)
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/, rel)
    assert.doesNotMatch(text, /["']api_key["']\s*:\s*["'][^"']+["']/, rel)
  }
})

test('template links the web-slot host and loads the social client without bundling ds-bot', () => {
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /@openteamily\/flybot-web-slots/)
  assert.match(prepare, /@openteamily\/flybot-social-web/)
  assert.match(prepare, /filtered.push\('@openteamily\/flybot-social-web'\)/)
  assert.match(prepare, /name !== 'ds-bot'/)
  const docker = read('Dockerfile')
  assert.match(docker, /COPY flybot-web-slots /)
  const host = JSON.parse(readFileSync(join(root, '..', 'flybot-web-slots', 'package.json'), 'utf8'))
  assert.equal(host.name, '@openteamily/flybot-web-slots')
  const socialWeb = JSON.parse(readFileSync(join(root, '..', 'flybot-web-slots', 'social-web', 'package.json'), 'utf8'))
  assert.equal(socialWeb.exports['./client'], './client.js')
})

test('template bundles the OpenTeamily DS-Bot plugin and its pages stage', () => {
  const prepare = read('prepare-template.mjs')
  assert.match(prepare, /'@openteamily\/web': `\$\{ROOT\}\/openteamily-web`/)
  assert.match(prepare, /filtered.push\('@openteamily\/web'\)/)
  const docker = read('Dockerfile')
  assert.match(docker, /FROM scratch AS openteamily-static/)
  assert.match(docker, /COPY openteamily-web \/opt\/openteamily\/runtime\/openteamily-web/)
  assert.match(docker, /COPY --from=openteamily-static \/ \/opt\/openteamily\/runtime\/openteamily-web\/pages\//)
  assert.ok(docker.indexOf('COPY openteamily-web') < docker.indexOf('dsh plugin --profile web'), 'plugin is copied before the profile is prepared and chowned')
  const plugin = JSON.parse(readFileSync(join(root, '..', 'openteamily-web', 'package.json'), 'utf8'))
  assert.equal(plugin.name, '@openteamily/web')
  assert.equal(plugin.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(!JSON.stringify(plugin).includes('@flybot/project'), 'never @flybot/project')
})

test('notice installer runs again after the web profile is installed', () => {
  const docker = read('Dockerfile')
  const profile = docker.indexOf('dsh plugin --profile web')
  const second = docker.lastIndexOf('install-redistribution-notices.mjs')
  assert.ok(profile !== -1 && second !== -1)
  assert.ok(second > profile)
})
