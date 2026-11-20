import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canRecord, voiceDurationLabel, voiceFileExtension, voicePayload } from '../openteamily/static/chat/app.mjs';

const html = readFileSync(new URL('../openteamily/static/chat/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../openteamily/static/chat/app.mjs', import.meta.url), 'utf8');
const css = readFileSync(new URL('../openteamily/static/chat/app.css', import.meta.url), 'utf8');

test('voiceDurationLabel prints a mm:ss length and never a negative one', () => {
  assert.equal(voiceDurationLabel(3200), '0:03');
  assert.equal(voiceDurationLabel(1000), '0:01');
  assert.equal(voiceDurationLabel(61000), '1:01');
  assert.equal(voiceDurationLabel(0), '0:00');
  assert.equal(voiceDurationLabel(-5), '0:00');
  assert.equal(voiceDurationLabel('x'), '0:00');
});

test('canRecord is false without MediaRecorder and without a microphone API', () => {
  assert.equal(canRecord({}), false);
  assert.equal(canRecord({MediaRecorder: function Recorder() {}}), false);
  const noCapture = {MediaRecorder: function Recorder() {}, navigator: {mediaDevices: {}}};
  assert.equal(canRecord(noCapture), false);
  const ready = {
    MediaRecorder: function Recorder() {},
    navigator: {mediaDevices: {getUserMedia: async () => ({getTracks: () => []})}},
  };
  assert.equal(canRecord(ready), true);
});

test('voiceFileExtension follows the recorded mime type', () => {
  assert.equal(voiceFileExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(voiceFileExtension('audio/ogg'), 'ogg');
  assert.equal(voiceFileExtension('audio/mp4'), 'm4a');
  assert.equal(voiceFileExtension('audio/wav'), 'wav');
  assert.equal(voiceFileExtension(''), 'webm');
});

test('voicePayload sends the clip id and a positive length', () => {
  assert.deepEqual(voicePayload('a'.repeat(32), 3200), {
    body: '', artifact_id: 'a'.repeat(32), voice_ms: 3200,
  });
  assert.equal(voicePayload('a'.repeat(32), 0).voice_ms, 1);
});

test('the microphone button is enabled and the recorder can list its fallback', () => {
  assert.ok(!html.includes('未实现：语音消息'), 'the disabled voice placeholder is still present');
  assert.match(html, /id="composer-voice"/);
  assert.ok(!/id="composer-voice"[^>]*disabled/.test(html), 'the microphone button is still disabled');
  assert.match(html, /id="voice-bar"/);
  assert.match(html, /id="voice-preview"[^>]*controls/);
  assert.match(html, /id="voice-send"/);
  assert.ok(app.includes('本浏览器不支持录音'), 'there is no explicit unsupported-browser message');
  assert.ok(app.includes('new globalThis.MediaRecorder('), 'recording never starts a MediaRecorder');
});

test('a voice bubble gets a play bar, not a document card', () => {
  const render = app.slice(app.indexOf('function renderSocialMessages('), app.indexOf('function renderSocialMessages(') + 5000);
  assert.ok(render.includes("player.className = 'voice-message'"));
  assert.ok(render.includes("document.createElement('audio')"));
  assert.ok(render.includes('item.voice.duration_ms'));
  assert.ok(render.includes('&& !item.voice'), 'an audio clip would still be rendered as a DOC card');
  assert.ok(css.includes('.voice-message audio'), 'the play bar has no styling');
});
