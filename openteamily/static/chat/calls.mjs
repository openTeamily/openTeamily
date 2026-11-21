import { meetingCodeFromHash, meetingHref, parseMeetingCode } from '../shell/meeting-link.mjs';

const POLL_MS = 900;
const typeLabel = kind => kind === 'video' ? '视频通话' : '语音通话';
const stopTracks = stream => stream?.getTracks().forEach(track => track.stop());

export function mountChatCalls(document, {request, context} = {}) {
  const element = id => document.getElementById(id);
  const launcher = element('chat-call');
  if (!launcher) return {refresh() {}, sync() {}, openMeeting() {}, resumeMeeting() {}};
  const dialog = element('chat-call-dialog');
  const status = element('chat-call-status');
  const incoming = element('chat-call-incoming');
  const media = element('chat-call-media');
  const local = element('chat-call-local').querySelector('video');
  const peersNode = element('chat-call-peers');
  const play = element('chat-call-play');
  const mute = element('chat-call-mute');
  const camera = element('chat-call-camera');
  const close = element('chat-call-close');
  const choices = element('chat-call-choices');
  const startAudio = element('chat-call-start-audio');
  const startVideo = element('chat-call-start-video');
  const controls = element('chat-call-controls');
  const form = element('chat-meeting-form');
  const field = element('chat-meeting-field');
  const input = element('chat-meeting-input');
  const submit = element('chat-meeting-submit');
  const mic = element('chat-meeting-mic');
  const webcam = element('chat-meeting-camera');
  const share = element('chat-meeting-share');
  const link = element('chat-meeting-link');
  const shareStatus = element('chat-meeting-share-status');
  const end = element('chat-meeting-end');
  const hangup = element('chat-meeting-hangup');
  const view = document.defaultView ?? globalThis;
  const setTimer = view.setTimeout?.bind(view) ?? globalThis.setTimeout;
  const clearTimer = view.clearTimeout?.bind(view) ?? globalThis.clearTimeout;
  let current = null;
  let available = null;
  let prejoin = null;
  let active = null;
  let joining = null;
  let readSequence = 0;
  let previewTimer;
  let watching = true;

  const currentKey = value => value ? value.wid + '/' + value.cid : '';
  const path = (scope, action = '') => scope.meeting ? '/v1/meeting-calls/' + action :
    `/v1/workspaces/${scope.wid}/social/conversations/${scope.cid}/call${action && '/' + action}`;
  const payload = own => ({call_id: own.call.id, peer_id: own.id});
  const note = text => { status.textContent = text; };

  function renderLauncher() {
    launcher.hidden = !current;
    element('group-call-video').hidden = !current;
    element('group-call-audio').hidden = !current;
    incoming.hidden = !current || !available || Boolean(active);
    if (!incoming.hidden) element('chat-call-incoming-label').textContent = `${typeLabel(available.kind)}进行中`;
  }

  async function refresh() {
    const scope = current;
    if (!scope || active || joining) return;
    const sequence = ++readSequence;
    const result = await request('GET', path(scope)).catch(() => null);
    if (readSequence !== sequence || current !== scope || active || joining) return;
    if (result?.status !== 200) return;
    available = result.body.call;
    renderLauncher();
  }

  function watch() {
    clearTimer(previewTimer);
    if (!current || !watching) return;
    previewTimer = setTimer(async () => {
      if (document.visibilityState !== 'hidden') await refresh();
      watch();
    }, 4000);
    previewTimer?.unref?.();
  }

  function stopLocal(own) {
    if (!own) return;
    clearTimer(own.timer);
    for (const peer of own.peers.values()) peer.connection.close();
    own.peers.clear();
    peersNode.replaceChildren();
    stopTracks(own.stream);
    local.srcObject = null;
    active = null;
    controls.hidden = true;
    media.hidden = true;
    play.hidden = true;
    camera.disabled = false;
    mute.disabled = false;
    close.hidden = false;
    close.textContent = '关闭';
    share.hidden = true;
    end.hidden = true;
    hangup.hidden = true;
    renderLauncher();
  }

  async function leave({dismiss = true} = {}) {
    const own = active;
    joining = null;
    if (dismiss) {
      prejoin = null;
      if (dialog.open) dialog.close();
    }
    stopLocal(own);
    if (own) {
      await request('POST', path(own.scope, 'leave'), payload(own)).catch(() => {});
      if (currentKey(own.scope) === currentKey(current)) void refresh();
    }
  }

  function sync() {
    const next = context();
    if (currentKey(current) === currentKey(next)) return;
    readSequence++;
    if ((dialog.open || active) && !prejoin?.scope.meeting && !active?.scope.meeting) void leave();
    current = next;
    available = null;
    renderLauncher();
    void refresh();
    watch();
  }

  function showDialog(scope = current) {
    if (!scope) return false;
    element('chat-call-conversation').textContent = scope.title || '';
    if (!dialog.open) dialog.showModal();
    return true;
  }

  function showChoices() {
    if (!showDialog() || active || joining) return;
    prejoin = null;
    drawPrejoin(false);
    element('chat-call-title').textContent = '通话';
    choices.hidden = false;
    startAudio.disabled = false;
    startVideo.disabled = false;
    close.textContent = '关闭';
    note(available ? `正在进行${typeLabel(available.kind)}，可以加入。` : '');
    startAudio.focus();
  }

  function drawPrejoin(visible) {
    form.hidden = !visible;
    submit.hidden = !visible;
    dialog.toggleAttribute('data-prejoin', visible);
  }

  function prepareVideo(scope, action, code = '') {
    if (active || joining || !showDialog(scope)) return;
    prejoin = {scope, action};
    const creating = action === 'create';
    const invite = scope.meeting && !creating;
    element('chat-call-title').textContent = creating ? '发起视频会议' : '加入视频会议';
    element('chat-meeting-field-label').textContent = invite ? '会议链接或会议码' : '会议名称';
    field.hidden = !creating && !invite;
    input.required = !field.hidden;
    input.maxLength = invite ? 512 : 80;
    input.value = invite ? code : creating ? (scope.title || '视频会议').slice(0, 80) : '';
    mic.checked = true;
    webcam.checked = true;
    submit.disabled = false;
    submit.textContent = creating ? '开始会议' : '加入会议';
    close.textContent = '取消';
    choices.hidden = true;
    drawPrejoin(true);
    note('');
    if (field.hidden) submit.focus();
    else {
      input.focus();
      if (creating) input.select();
    }
  }

  function openMeeting(action, code) {
    prepareVideo({meeting: true}, action, code);
  }

  function resumeMeeting() {
    const code = meetingCodeFromHash(view.location?.hash);
    if (!code) return;
    view.history.replaceState(view.history.state, '', view.location.pathname + view.location.search);
    openMeeting('join', code);
  }

  function openCall(kind, start = !available) {
    if (available) kind = available.kind;
    if (kind === 'video' && current) {
      const scope = {...current, title: available?.title || current.title};
      prepareVideo(scope, start ? 'create' : 'join');
    } else void join(kind, {start});
  }

  function peerStatus(own) {
    if (active !== own) return;
    const count = own.peers.size;
    const connected = [...own.peers.values()].filter(peer => peer.connection.connectionState === 'connected').length;
    if (connected) note(`通话中 · ${connected + 1} 人`);
    else if (!count) note('等待其他成员加入…');
    else if ([...own.peers.values()].some(peer => ['failed', 'disconnected'].includes(peer.connection.connectionState))) {
      note(own.ice.some(server => /^turns?:/.test(server.urls))
        ? '连接未建立。可以挂断后重新加入。'
        : '连接未建立。跨网络通话可能需要管理员配置中继。');
    } else note('正在建立通话连接…');
  }

  function queueSignal(own, peer, signal) {
    const data = {...payload(own), to: peer.id, client_key: view.crypto.randomUUID(), ...signal};
    const send = async () => {
      if (active !== own || own.peers.get(peer.id) !== peer) return;
      const url = path(own.scope, 'signal');
      let result;
      try { result = await request('POST', url, data); }
      catch { result = await request('POST', url, data); }
      if (result.status !== 200 && result.status !== 404) throw new Error('Call signal was refused');
    };
    peer.outgoing = peer.outgoing.then(send).catch(() => {
      if (active === own) note('通话连接中断。可以挂断后重新加入。');
    });
    return peer.outgoing;
  }

  async function describePeer(own, peer, type) {
    const pc = peer.connection;
    await pc.setLocalDescription(type === 'offer' ? await pc.createOffer() : await pc.createAnswer());
    if (active !== own || own.peers.get(peer.id) !== peer) return;
    void queueSignal(own, peer, {description: pc.localDescription.toJSON()});
    peer.localReady = true;
    for (const candidate of peer.earlyLocal) void queueSignal(own, peer, {candidate});
    peer.earlyLocal.length = 0;
  }

  function syncPlayback(own) {
    if (active === own) play.hidden = ![...own.peers.values()].some(peer => peer.playbackBlocked);
  }

  async function playRemote(own, peer) {
    try {
      await peer.video.play();
      peer.playbackBlocked = false;
    } catch (error) {
      if (error?.name === 'NotAllowedError') peer.playbackBlocked = true;
    }
    syncPlayback(own);
  }

  function createPeer(own, item) {
    const connection = new view.RTCPeerConnection({iceServers: own.ice});
    const tile = document.createElement('div');
    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.hidden = true;
    const name = document.createElement('span');
    name.textContent = item.name;
    tile.append(video, name);
    peersNode.append(tile);
    const peer = {id: item.id, tile, video, connection, outgoing: Promise.resolve(), localReady: false,
      senders: new Map(), remote: new view.MediaStream(),
      earlyLocal: [], earlyRemote: [], playbackBlocked: false};
    own.peers.set(item.id, peer);
    video.addEventListener('playing', () => {
      peer.playbackBlocked = false;
      syncPlayback(own);
    });
    connection.onconnectionstatechange = () => peerStatus(own);
    connection.ontrack = event => {
      if (active !== own) return;
      const track = event.track;
      peer.remote.addTrack(track);
      if (video.srcObject !== peer.remote) video.srcObject = peer.remote;
      if (track.kind === 'video') {
        const update = () => { video.hidden = track.muted; };
        track.addEventListener('mute', update);
        track.addEventListener('unmute', update);
        update();
      }
      void playRemote(own, peer);
    };
    connection.onicecandidate = event => {
      if (!event.candidate?.candidate || active !== own) return;
      const candidate = event.candidate.toJSON();
      if (peer.localReady) void queueSignal(own, peer, {candidate});
      else peer.earlyLocal.push(candidate);
    };
    // One tab assigns the audio and video slots. A slot stays usable with its device off.
    if (own.id < item.id) {
      for (const kind of own.kinds) {
        const track = own.stream.getTracks().find(item => item.kind === kind);
        const {sender} = connection.addTransceiver(track || kind, {direction: 'sendrecv'});
        peer.senders.set(kind, sender);
      }
      void describePeer(own, peer, 'offer').catch(() => peerStatus(own));
    }
    return peer;
  }

  function syncPeers(own, call) {
    const wanted = new Set(call.peers.map(peer => peer.id));
    for (const [id, peer] of own.peers) {
      if (wanted.has(id)) continue;
      own.peers.delete(id);
      peer.connection.close();
      peer.tile.remove();
    }
    for (const item of call.peers) if (item.id !== own.id && !own.peers.has(item.id)) createPeer(own, item);
    syncPlayback(own);
    peerStatus(own);
  }

  async function receive(own, signal) {
    const peer = own.peers.get(signal.from);
    if (!peer) return;
    const pc = peer.connection;
    if (signal.description) {
      if ((signal.description.type === 'offer') !== (own.id > peer.id)) return;
      await pc.setRemoteDescription(signal.description);
      for (const candidate of peer.earlyRemote.splice(0)) await pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') {
        for (const slot of pc.getTransceivers()) {
          const kind = slot.receiver.track.kind;
          slot.direction = 'sendrecv';
          peer.senders.set(kind, slot.sender);
          const track = own.stream.getTracks().find(item => item.kind === kind);
          if (track) await slot.sender.replaceTrack(track);
        }
        await describePeer(own, peer, 'answer');
      }
    } else if (signal.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(signal.candidate);
      else peer.earlyRemote.push(signal.candidate);
    }
  }

  async function poll(own) {
    try {
      const result = await request('POST', path(own.scope, 'poll'), {...payload(own), after: own.cursor});
      if (active !== own) return;
      if ([401, 403, 404].includes(result.status)) {
        stopLocal(own);
        available = null;
        renderLauncher();
        note(own.scope.meeting ? '会议已结束。' : '通话已结束。');
        return;
      }
      if (result.status !== 200) throw new Error('Call poll failed');
      own.failures = 0;
      syncPeers(own, result.body.call);
      for (const signal of result.body.signals) {
        if (active !== own) return;
        try { await receive(own, signal); }
        catch { if (active === own) note('无法连接到部分成员。可以重新加入通话。'); }
        own.cursor = signal.seq;
      }
    } catch {
      if (active !== own) return;
      note('连接中断，正在重连…');
      if (++own.failures >= 4) {
        void leave({dismiss: false});
        note('暂时无法连接。关闭后可以重新加入。');
        return;
      }
    }
    if (active === own) own.timer = setTimer(() => poll(own), POLL_MS);
  }

  async function join(kind, {start = true, setup = null} = {}) {
    const scope = setup?.scope || current;
    if (active || joining || !showDialog(scope)) return;
    const ticket = {scope};
    joining = ticket;
    choices.hidden = true;
    submit.disabled = true;
    const roomLabel = scope.meeting || setup ? '会议' : '通话';
    if (!setup) {
      drawPrejoin(false);
      element('chat-call-title').textContent = typeLabel(kind);
    }
    let stream;
    let own;
    try {
      if (typeof view.RTCPeerConnection !== 'function') {
        note('当前浏览器无法使用实时通话。请在支持通话的 HTTPS 页面打开。');
        return;
      }
      if (setup?.code) {
        note('正在查找会议…');
        const preview = await request('POST', path(scope, 'preview'), {code: setup.code});
        if (joining !== ticket) return;
        if (preview.status !== 200) {
          note(preview.status === 404 ? '会议不存在或已结束。' : '暂时无法验证会议，请重试。');
          return;
        }
        element('chat-call-conversation').textContent = preview.body.title;
      }
      const devices = {audio: setup?.audio ?? true, video: kind === 'video' && (setup?.video ?? true)};
      if (devices.audio || devices.video) {
        if (!view.navigator?.mediaDevices?.getUserMedia) {
          note('无法访问设备，请在支持通话的 HTTPS 页面打开。');
          return;
        }
        note('正在请求设备权限…');
        stream = await view.navigator.mediaDevices.getUserMedia(devices);
      } else stream = new view.MediaStream();
      if (joining !== ticket) return;
      note('正在加入' + roomLabel + '…');
      const id = view.crypto.randomUUID();
      const action = scope.meeting && start ? 'create' : 'join';
      const data = {peer_id: id, ...(scope.meeting ? {} : {kind, start})};
      if (setup?.title) data.title = setup.title;
      if (setup?.code) data.code = setup.code;
      const url = path(scope, action);
      let result;
      try { result = await request('POST', url, data); }
      catch { result = await request('POST', url, data); }
      if (result.status !== 200) {
        const code = result.body?.error?.code;
        if (joining === ticket) note(code === 'call_full' ? roomLabel + '已达到 6 人上限。'
          : code === 'call_already_joined' ? '此账号已经在另一个标签页加入。'
          : ['call_ended', 'meeting_ended'].includes(code) ? roomLabel + '已结束。'
          : '无法加入' + roomLabel + '，请重试。');
        return;
      }
      const meeting = result.body.meeting;
      own = {scope, id: result.body.peer_id, call: result.body.call, ice: result.body.ice_servers,
        stream, kinds: kind === 'video' ? ['audio', 'video'] : ['audio'], deviceBusy: new Set(),
        peers: new Map(), cursor: 0, failures: 0, timer: null};
      if (joining !== ticket) {
        void request('POST', path(scope, 'leave'), payload(own)).catch(() => {});
        return;
      }
      active = own;
      prejoin = null;
      drawPrejoin(false);
      renderLauncher();
      controls.hidden = false;
      media.hidden = false;
      element('chat-call-title').textContent = meeting?.title || own.call.title || typeLabel(kind);
      element('chat-call-conversation').textContent = meeting ? '视频会议' : current?.title || '';
      local.srcObject = stream;
      camera.hidden = kind !== 'video';
      updateDevices(own);
      close.hidden = Boolean(meeting);
      close.textContent = '挂断';
      hangup.hidden = !meeting;
      share.hidden = !meeting?.host;
      end.hidden = !meeting?.host;
      end.disabled = false;
      end.textContent = '结束会议';
      shareStatus.textContent = '';
      if (meeting?.host) link.value = new URL(meetingHref(meeting.code), view.location.origin).href;
      (meeting?.host ? element('chat-meeting-copy') : mute).focus();
      syncPeers(own, own.call);
      void poll(own);
    } catch (error) {
      if (joining !== ticket) return;
      if (active === own) void leave({dismiss: false});
      note(error?.name === 'NotAllowedError' ? '设备权限未开启，可以关掉对应设备后加入。'
        : error?.name === 'NotFoundError' ? '未找到设备，可以关掉对应设备后加入。'
        : '无法开始' + roomLabel + '，请重试。');
    } finally {
      if (!own || active !== own) stopTracks(stream);
      if (joining === ticket) {
        joining = null;
        if (!active && !setup) choices.hidden = false;
        submit.disabled = false;
        if (!active && setup && dialog.open) submit.focus();
      }
    }
  }

  function updateDevices(own) {
    const audioOn = Boolean(own.stream.getAudioTracks().length);
    const videoOn = Boolean(own.stream.getVideoTracks().length);
    local.hidden = !videoOn;
    mute.setAttribute('aria-pressed', String(!audioOn));
    mute.textContent = audioOn ? '静音' : '打开麦克风';
    camera.setAttribute('aria-pressed', String(videoOn));
    camera.textContent = videoOn ? '关闭摄像头' : '开启摄像头';
  }

  async function toggleDevice(kind, button) {
    const own = active;
    if (!own || own.deviceBusy.has(kind)) return;
    own.deviceBusy.add(kind);
    button.disabled = true;
    let captured;
    try {
      let track = own.stream.getTracks().find(item => item.kind === kind);
      if (track) {
        own.stream.removeTrack(track);
        track.stop();
        track = null;
      } else {
        captured = await view.navigator.mediaDevices.getUserMedia({[kind]: true});
        if (active !== own) return;
        track = captured.getTracks()[0];
        own.stream.addTrack(track);
      }
      await Promise.all([...own.peers.values()].map(peer => peer.senders.get(kind)?.replaceTrack(track)));
      if (active === own) updateDevices(own);
    } catch {
      if (active === own) note(kind === 'audio' ? '无法访问麦克风。' : '无法访问摄像头。');
    } finally {
      if (active !== own) stopTracks(captured);
      if (!active || active === own) button.disabled = false;
      own.deviceBusy.delete(kind);
    }
  }

  launcher.addEventListener('click', () => available ? openCall(available.kind, false) : showChoices());
  element('group-call-video').addEventListener('click', () => openCall('video'));
  element('group-call-audio').addEventListener('click', () => openCall('audio'));
  element('chat-call-join').addEventListener('click', () => available && openCall(available.kind, false));
  startAudio.addEventListener('click', () => openCall('audio'));
  startVideo.addEventListener('click', () => openCall('video'));
  close.addEventListener('click', () => leave());
  hangup.addEventListener('click', () => leave());
  dialog.addEventListener('cancel', event => { event.preventDefault(); void leave(); });
  mute.addEventListener('click', () => toggleDevice('audio', mute));
  camera.addEventListener('click', () => toggleDevice('video', camera));
  input.addEventListener('input', () => { if (!joining) note(''); });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!prejoin) return;
    const {scope, action} = prejoin;
    const start = action === 'create';
    const title = start ? input.value.trim() : '';
    const code = scope.meeting && !start ? parseMeetingCode(input.value, view.location.origin) : '';
    if ((start && !title) || (scope.meeting && !start && !code)) {
      note(start ? '请输入会议名称。' : '请输入有效的会议链接或会议码。');
      input.focus();
      return;
    }
    void join('video', {start, setup: {scope, title, code, audio: mic.checked, video: webcam.checked}});
  });
  element('chat-meeting-copy').addEventListener('click', async () => {
    try {
      await view.navigator.clipboard.writeText(link.value);
      shareStatus.textContent = '邀请链接已复制。';
    } catch {
      link.select();
      shareStatus.textContent = '已选中链接，可以手动复制。';
    }
  });
  end.addEventListener('click', async () => {
    const own = active;
    if (!own?.scope.meeting) return;
    if (end.textContent !== '确认结束') {
      end.textContent = '确认结束';
      shareStatus.textContent = '结束后，所有参会者都会离开。';
      return;
    }
    end.disabled = true;
    const result = await request('POST', path(own.scope, 'end'), payload(own)).catch(() => null);
    if (active !== own) return;
    end.disabled = false;
    if (result?.status === 200 || result?.status === 404) {
      stopLocal(own);
      note('会议已结束。');
      close.focus();
    } else shareStatus.textContent = '无法结束会议，请重试。';
  });
  play.addEventListener('click', async () => {
    const own = active;
    if (!own) return;
    await Promise.all([...own.peers.values()].filter(peer => peer.playbackBlocked).map(peer => playRemote(own, peer)));
  });
  view.addEventListener?.('pagehide', () => {
    const own = active;
    watching = false;
    clearTimer(previewTimer);
    if (own) {
      view.navigator?.sendBeacon?.('/b/api/openteamily', new Blob([JSON.stringify({
        endpoint: 'messenger/v1', payload: {method: 'POST', path: path(own.scope, 'leave'), body: payload(own)},
      })], {type: 'application/json'}));
      stopLocal(own);
    }
    joining = null;
    prejoin = null;
  });
  view.addEventListener?.('pageshow', () => {
    watching = true;
    if (dialog.open && !prejoin && !active && !joining) dialog.close();
    void refresh();
    watch();
  });
  return {sync, refresh, openMeeting, resumeMeeting};
}
