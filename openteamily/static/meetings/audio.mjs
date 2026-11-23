const SAMPLE_RATE = 16000;
const SEGMENT_SAMPLES = 15 * SAMPLE_RATE;
const MAX_SECONDS = 600;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const PREPARING = new Set(['checking', 'downloading', 'loading', 'cancelling']);

export function waveBase64(samples) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const wave = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
    for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i);
  }
  wave.setUint32(4, bytes.length - 8, true);
  wave.setUint32(16, 16, true);
  wave.setUint16(20, 1, true);
  wave.setUint16(22, 1, true);
  wave.setUint32(24, SAMPLE_RATE, true);
  wave.setUint32(28, SAMPLE_RATE * 2, true);
  wave.setUint16(32, 2, true);
  wave.setUint16(34, 16, true);
  wave.setUint32(40, bytes.length - 44, true);
  samples.forEach((value, index) => {
    const sample = Math.max(-1, Math.min(1, value));
    wave.setInt16(44 + index * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
  });
  let text = '';
  for (let i = 0; i < bytes.length; i += 32768) text += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return btoa(text);
}

async function decodeAudio(blob) {
  const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!Audio || !Offline) throw new Error('当前浏览器无法解码音频。');
  const audio = new Audio();
  try {
    const input = await audio.decodeAudioData(await blob.arrayBuffer()).catch(() => null);
    if (!input || !input.duration) throw new Error('无法读取这份音频，请更换文件。');
    if (input.duration > MAX_SECONDS) throw new Error('请选择时长不超过 10 分钟的音频。');
    const output = new Offline(1, Math.max(1, Math.ceil(input.duration * SAMPLE_RATE)), SAMPLE_RATE);
    const source = output.createBufferSource();
    source.buffer = input;
    source.connect(output.destination);
    source.start();
    return (await output.startRendering()).getChannelData(0);
  } finally {
    await audio.close().catch(() => {});
  }
}

export function mountMeetingAudio(document, {request, base, transcript}) {
  const el = id => document.getElementById(id);
  const panel = el('meeting-audio'), preview = el('meeting-audio-preview'), file = el('meeting-audio-file');
  const status = el('meeting-audio-status'), prepare = el('meeting-audio-prepare');
  const record = el('meeting-audio-record'), stop = el('meeting-audio-stop');
  const start = el('meeting-audio-start'), discard = el('meeting-audio-discard');
  if (!panel) return {reset() {}};
  let input = null, used = false, url = '', phase = '', ready = false, checking = false, asking = false;
  let capture = null, captureTimer, pollTimer, operation = null, scope = 0;

  function refreshButtons() {
    prepare.hidden = !['unprepared', 'failed', 'cancelled'].includes(phase);
    prepare.disabled = checking;
    const busy = Boolean(capture || operation || asking);
    record.disabled = !ready || busy || !globalThis.navigator?.mediaDevices?.getUserMedia || !globalThis.MediaRecorder;
    stop.hidden = !capture;
    file.disabled = !ready || busy;
    start.disabled = !input || used || !ready || busy;
    discard.disabled = !input && !operation;
    discard.textContent = operation ? '取消转写' : '移除音频';
  }

  function audioInput(blob) {
    if (url) URL.revokeObjectURL(url);
    input = blob;
    used = false;
    url = blob ? URL.createObjectURL(blob) : '';
    preview.hidden = !url;
    if (url) preview.src = url;
    else preview.removeAttribute('src');
    file.value = '';
    refreshButtons();
  }

  async function checkSpeech(method = 'GET') {
    const epoch = scope;
    clearTimeout(pollTimer);
    checking = true;
    refreshButtons();
    try {
      const result = await request(method, base() + '/speech', method === 'POST' ? {} : undefined);
      if (epoch !== scope) return;
      if (result.status !== 200) throw new Error(result.body.error?.message || '无法读取语音识别状态。');
      ({phase, ready} = result.body);
      if (operation || capture) return;
      const progress = result.body.progress;
      if (ready) status.textContent = '';
      else if (phase === 'unavailable') status.textContent = '当前 DS-Bot 尚未启用本地语音识别。';
      else if (phase === 'failed') status.textContent = '语音识别准备失败，请重试。';
      else if (PREPARING.has(phase)) {
        status.textContent = Number.isFinite(progress) ? `正在准备语音识别，下载 ${progress}%` : '正在准备语音识别…';
        if (panel.open) pollTimer = setTimeout(checkSpeech, 1800);
      } else status.textContent = '首次使用需要准备本地语音识别。';
    } catch (error) {
      if (epoch === scope) status.textContent = error.message || '无法读取语音识别状态。';
    } finally {
      if (epoch === scope) {
        checking = false;
        refreshButtons();
      }
    }
  }

  function stopCapture() {
    clearTimeout(captureTimer);
    if (!capture) return;
    if (capture.recorder.state !== 'inactive') capture.recorder.stop();
    for (const track of capture.stream.getTracks()) track.stop();
  }

  function reset() {
    scope += 1;
    clearTimeout(pollTimer);
    stopCapture();
    capture = null;
    operation?.abort();
    operation = null;
    phase = '';
    ready = checking = asking = false;
    audioInput(null);
    status.textContent = '';
    panel.open = false;
  }

  panel.addEventListener('toggle', () => {
    if (panel.open) void checkSpeech();
    else clearTimeout(pollTimer);
  });
  prepare.addEventListener('click', () => checkSpeech('POST'));
  file.addEventListener('change', () => {
    const blob = file.files?.[0];
    if (!blob) return;
    if (!blob.size || blob.size > MAX_FILE_BYTES) {
      file.value = '';
      status.textContent = '请选择大小不超过 32 MB 的音频。';
      return;
    }
    audioInput(blob);
    status.textContent = '音频已选好，试听后可以开始转写。';
  });
  record.addEventListener('click', async () => {
    const epoch = scope;
    let stream;
    asking = true;
    refreshButtons();
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio: true, video: false});
      if (scope !== epoch) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      const recorder = new MediaRecorder(stream);
      const clips = [];
      capture = {recorder, stream};
      recorder.ondataavailable = event => { if (event.data.size) clips.push(event.data); };
      recorder.onstop = () => {
        if (scope !== epoch) return;
        stopCapture();
        capture = null;
        const blob = new Blob(clips, {type: recorder.mimeType});
        if (blob.size) {
          audioInput(blob);
          status.textContent = '录音已完成，试听后可以开始转写。';
        } else status.textContent = '没有录到音频，请重试。';
        refreshButtons();
      };
      recorder.start();
      captureTimer = setTimeout(stopCapture, MAX_SECONDS * 1000);
      status.textContent = '正在录音…';
    } catch (error) {
      for (const track of stream?.getTracks() || []) track.stop();
      if (scope === epoch) {
        capture = null;
        status.textContent = error.name === 'NotAllowedError' ? '请允许麦克风权限，或上传音频。' : '无法录音，请检查麦克风。';
      }
    } finally {
      if (scope === epoch) { asking = false; refreshButtons(); }
    }
  });
  stop.addEventListener('click', stopCapture);
  discard.addEventListener('click', () => {
    if (operation) operation.abort();
    else audioInput(null);
    status.textContent = operation ? '已取消转写。' : '';
  });
  start.addEventListener('click', async () => {
    if (start.disabled) return;
    const work = new AbortController();
    const target = base();
    operation = work;
    refreshButtons();
    status.textContent = '正在读取音频…';
    try {
      const samples = await decodeAudio(input);
      const total = Math.ceil(samples.length / SEGMENT_SAMPLES);
      const notes = [];
      for (let i = 0; i < total; i += 1) {
        work.signal.throwIfAborted();
        status.textContent = `正在转写第 ${i + 1} / ${total} 段…`;
        const audio_base64 = waveBase64(samples.subarray(i * SEGMENT_SAMPLES, (i + 1) * SEGMENT_SAMPLES));
        const result = await request('POST', target + '/transcribe', {audio_base64}, undefined, work.signal);
        work.signal.throwIfAborted();
        if (result.status !== 200) throw new Error(result.body.error?.message || '转写失败，请重试。');
        if (result.body.text) notes.push(result.body.text);
      }
      if (!notes.length) { status.textContent = '没有识别到语音。'; return; }
      const combined = [transcript.value, notes.join('\n')].filter(Boolean).join('\n\n');
      if (combined.length > transcript.maxLength) throw new Error('正文已达上限，请精简后重试。');
      transcript.value = combined;
      transcript.dispatchEvent(new Event('input', {bubbles: true}));
      used = true;
      status.textContent = '已将转写加入正文，可核对并保存。';
    } catch (error) {
      if (!work.signal.aborted && operation === work) status.textContent = error.message || '转写失败，请重试。';
    } finally {
      if (operation === work) {
        operation = null;
        refreshButtons();
      }
    }
  });
  globalThis.addEventListener?.('pagehide', () => {
    panel.open = false;
    reset();
  });
  refreshButtons();
  return {reset};
}
