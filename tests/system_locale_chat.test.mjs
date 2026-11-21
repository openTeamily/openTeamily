import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {createPageHandler} from '../runtime/openteamily-web/src/pages.js';
import {CHAT_MESSAGES} from '../openteamily/static/shell/system-locale-chat.mjs';

const staticUrl = new URL('../openteamily/static/', import.meta.url);
const chatHtml = await readFile(new URL('chat/index.html', staticUrl), 'utf8');
const markup = /<[a-z][\w-]*(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi;
const markers = /\bdata-ui-(text|title|label|placeholder|alt)="([^"]+)"/g;
const fields = {title: 'title', label: 'aria-label', placeholder: 'placeholder', alt: 'alt'};

test('Chat locale keys are backed by Chinese source and English phrases', () => {
  const referenced = new Set();
  for (const match of chatHtml.matchAll(markup)) {
    const [tag] = match;
    for (const [, kind, key] of tag.matchAll(markers)) {
      assert.match(key, /^chat\.[a-z][a-z0-9_.]*$/);
      const pair = CHAT_MESSAGES[key];
      assert.ok(pair?.length === 2 && pair.every(phrase => typeof phrase === 'string' && phrase.trim()), key);
      referenced.add(key);
      if (kind === 'text') {
        const name = tag.match(/^<([\w-]+)/)[1];
        const end = chatHtml.indexOf(`</${name}>`, match.index + tag.length);
        const original = chatHtml.slice(match.index + tag.length, end);
        assert.equal(original.trim(), pair[0], key);
      } else {
        const attribute = tag.match(new RegExp(`\\s${fields[kind]}="([^"]*)"`));
        assert.equal(attribute?.[1], pair[0], key);
      }
    }
  }
  assert.deepEqual(referenced, new Set(Object.keys(CHAT_MESSAGES)));
});

test('Native English Chat localizes controls and leaves dynamic identity slots owned by Chat', async () => {
  const page = createPageHandler({pagesDir: fileURLToPath(staticUrl), identity: {instanceId:'a'.repeat(32)},
    getSystemLanguage: async () => 'en'});
  const response = await page(new Request('http://localhost/api/openteamily/page?path=/chat'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-language'), 'en');
  const html = await response.text();
  assert.match(html, /<title[^>]*>Chat · OpenTeamily<\/title>/);
  assert.match(html, /id="chat-back"[^>]*aria-label="Back to conversations"[^>]*><svg/);
  assert.match(html, /id="chat-body"[^>]*name="body"[^>]*placeholder="Type a message"/);
  assert.match(html, /id="chat-send"[^>]*aria-label="Send"[^>]*><svg/);
  assert.match(html, /id="conversation-search-tab-photos"[^>]*>Photos<\/button>/);
  assert.match(html, /id="group-info-toggle"[^>]*aria-label="Group info"/);
  assert.match(html, /id="image-create-preview"[^>]*alt="Generated image"/);
  assert.match(html, /id="website-create-preview"[^>]*title="Generated website preview"[^>]*sandbox="allow-scripts"/);
  assert.match(html, /<h1 id="chat-title" tabindex="-1"><span[^>]*>Chat<\/span><\/h1>/);
  assert.match(html, /<h2 id="group-info-title"><span[^>]*>Group info<\/span><\/h2>/);
  assert.match(html, /id="account-menu-button"[^>]*aria-label="Account menu"/);
  assert.match(html, /<ol id="message-list"><\/ol>/);
});
