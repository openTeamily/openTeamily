// DSH plugin entry for the OpenTeamily FlyBot runtime image.
// Boots the unmodified upstream ds-bot runtime, then attaches the FlyBot social
// façade. This file must keep living at runtime/flybot-image/plugin/ so the
// relative imports into the vendored trees resolve. Do not copy it out of this
// layout; the image profile uses a link: dependency to this directory.
import { createRuntime } from '../../ds-bot-upstream/ds-bot/index.js'
import { applyOnRuntime } from '../../flybot-social-host/index.js'
import { registerFlybotRoute } from '../../flybot-web-slots/index.js'
import { loadBotSocialConfig } from '../bot-social-config.js'
import { startBridge, runTurn } from '../ds-bot-bridge.mjs'
import { normalizeImportedSession } from '../../openteamily-web/features/agents/history.js'
import { attachRuntime } from '../../openteamily-web/src/host.js'

// Same inject list as runtime/ds-bot-upstream/ds-bot/index.js — this plugin
// stands in for ds-bot in the web profile so createRuntime runs once.
export const name = 'openteamily-flybot'
export const inject = ['llm', 'tools', 'systemPrompt', 'sessionController', 'sessions', 'sessionTitle', 'workspaceRegistry', 'connection']

export function apply(ctx, config = {}) {
  // Prepare is detached/read-only: no Session is entered, persisted or announced.
  // Install before core agent restoration, whose projections read old imports.
  normalizeImportedSession(ctx.sessions.prepare('openteamily-import-schema-' + globalThis.crypto.randomUUID()))
  const rt = createRuntime(ctx, config)
  // Publish once, after the complete bridge services exist. Early pending imports
  // must not capture a permanently incomplete frozen runtime handle.
  const collaboration = loadBotSocialConfig()
  const attached = applyOnRuntime(rt, ctx, {
    inboxPollMs: 15_000,
    facePollMs: 4_000,
    presence: true,
    ...(config.social ?? {}),
    ...(collaboration.server ? {
      server: collaboration.server,
      ...(collaboration.displayName ? { displayName: collaboration.displayName } : {}),
    } : {}),
  })
  registerFlybotRoute(ctx, attached.flybot)
  // OpenTeamily features send native turns to this user's DS-Bot.
  if (config.openteamilyBridge !== false && process.env.OPENTEAMILY_DS_BOT_BRIDGE !== '0') {
    const { bridge } = startBridge(rt, ctx)
    // Services for @openteamily/web features (chat, skills): native DS-Bot turns in
    // this user's own runtime, serialized by bridge.exclusive.
    const chatTurn = (key, text, requestId) => bridge.exclusive(async () => {
      await bridge.prepareModel()
      await bridge.selectConversation(key)
      bridge.requireModel(bridge.botId)
      return runTurn(rt, ctx, bridge.botId, text, requestId)
    })
    const mainBot = async () => { await bridge.setup(); return bridge.botId }
    const attachmentStore = () => ctx.get?.('attachments')
    const nativeTurn = (botId, sessionId, text, requestId, options = {}) => bridge.exclusive(async () => {
      await bridge.prepareModel()
      if (!rt.botOf(botId)) throw new Error('Mapped native Bot no longer exists')
      await rt.switchPart(botId, sessionId)
      await rt.applyModel(rt.botOf(botId), { force: true })
      const parts = [], stored = []
      const uploads = ctx.get?.('fileUploads')
      for (const file of options.files || []) {
        if (!uploads) throw Object.assign(new Error('Native attachment service unavailable'), {code:'agents/attachment-unavailable'})
        const bytes = async function* () { yield file.data }
        const scope = {sessionId:rt.chatOf(botId), name:file.title, data:bytes()}
        const image = file.mime.startsWith('image/')
        const result = image ? await uploads.uploadImageStream({...scope, mediaType:file.mime}) : await uploads.uploadStream(scope)
        // Prompt images may be normalized by DSH. A shared work's download
        // must keep the exact bytes of the saved revision.
        const original = file.resource && image
          ? await attachmentStore().saveFileStream({name:file.title,data:bytes()}) : null
        const ref = original || (image ? result.image : result.file)
        parts.push({type:'file', receiptId:result.receiptId})
        stored.push({title:file.title, mime:original ? file.mime : ref.mediaType || file.mime, bytes:ref.bytes, image:image && !original, ref})
      }
      if (stored.length) options.onStaged?.(stored)
      bridge.requireModel(botId)
      return runTurn(rt, ctx, botId, text, requestId, undefined, parts, { onProgress: options.onProgress })
    })
    const readNativeAttachment = async file => {
      const store = attachmentStore()
      if (!store) throw new Error('Native attachment service unavailable')
      if (file.image) return Buffer.from((await store.readImage(file.ref)).data)
      const chunks = []
      let bytes = 0
      for await (const chunk of store.readFileStream(file.ref)) {
        bytes += chunk.byteLength
        if (bytes > file.bytes) throw new Error('Native attachment size mismatch')
        chunks.push(chunk)
      }
      if (bytes !== file.bytes) throw new Error('Native attachment size mismatch')
      return Buffer.concat(chunks)
    }
    const privateText = async prompt => {
      await bridge.setup()
      const response = await fetch(bridge.baseURL + '/chat/completions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bridge.state.token },
        body: JSON.stringify({ model: 'openteamily-model', messages: [{ role: 'user', content: prompt }], stream: false }),
        signal: AbortSignal.timeout(170000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Text-only model inference failed')
      const data = await response.json(), text = data.choices?.[0]?.message?.content
      if (typeof text !== 'string' || !text.trim()) throw new Error('Text-only model returned no text')
      return text.slice(0, 20000)
    }
    const textOnly = prompt => bridge.exclusive(() => privateText(prompt))
    attachRuntime({ rt, ctx, chatTurn, mainBot, nativeTurn, readNativeAttachment, textOnly, backgroundTextOnly: privateText, exclusive: bridge.exclusive, legacySession: bridge.legacySession })
  } else attachRuntime({ rt, ctx })
  return attached
}

export { createRuntime }
