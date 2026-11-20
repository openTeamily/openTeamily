// Server invalidations only: content remains behind the ordinary authenticated APIs.
export function isDsBotPage(document){
  try{return Boolean(document?.querySelector?.('meta[name="openteamily-served-by"][content="ds-bot"]'));}catch{return false;}
}
// Moved pages are served by the user's own DS-Bot and must stream from it. The
// legacy platform path stays the fallback for pages the platform still serves.
export function eventsEndpoint(workspace,{dsbot=false,mount='/b'}={}){
  return dsbot?`${mount}/api/openteamily/events?workspace=${encodeURIComponent(workspace)}`:'/v1/workspaces/'+workspace+'/events';
}
export function mountWorkspaceEvents(document,{onInvalidate=()=>{},EventSource=globalThis.EventSource,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout,dsbot=isDsBotPage(document),mount='/b'}={}){
  let source=null,wid='',fingerprints={},closed=false,generation=0,retryTimer=null,retryAttempts=0;
  const status=document.getElementById('workspace-events-status');
  const show=text=>{if(status)status.textContent=text;};
  function disconnect(){generation++;if(retryTimer!==null)clearTimer(retryTimer);retryTimer=null;source?.close();source=null;}
  function connect(){
    disconnect();
    if(closed||!wid||document.visibilityState==='hidden')return;
    if(typeof EventSource!=='function'){show('此浏览器不支持实时更新；保留定时 / 手动刷新。');return;}
    const own=wid,ownGeneration=generation;
    try{source=new EventSource(eventsEndpoint(wid,{dsbot,mount}),{withCredentials:true});}
    catch{show('无法建立实时连接，保留定时 / 手动刷新。');return;}
    show('连接实时更新…');
    source.addEventListener('open',()=>{if(wid===own&&generation===ownGeneration){retryAttempts=0;show('实时更新已连接（非模型逐字推送）。');}});
    source.addEventListener('renew',()=>{
      if(wid!==own||generation!==ownGeneration||closed)return;
      // Server streams have a short bounded lease. Normal expiry must not be
      // confused with an actual network error (whose handler stays unchanged).
      disconnect();
      show('实时更新已连接（正在续接）。');
      const renewalGeneration=generation;
      retryTimer=setTimer(()=>{
        retryTimer=null;
        if(wid===own&&generation===renewalGeneration&&!closed)connect();
      },250);
    });
    source.addEventListener('error',()=>{
      if(wid!==own||generation!==ownGeneration||closed)return;
      // Non-200 handshakes (including a temporary lease-limit429 during rapid
      // page navigation) can permanently close native EventSource. Its normal
      // CONNECTING retries remain native; only CLOSED receives bounded retries.
      if(source?.readyState===2){
        if(retryAttempts>=3){show('实时连接不可用，请点重连；仍可定时 / 手动刷新。');return;}
        if(retryTimer===null){const delay=3000*2**retryAttempts++;retryTimer=setTimer(()=>{
          retryTimer=null;if(wid===own&&generation===ownGeneration&&!closed)connect();
        },delay);retryTimer?.unref?.();}
      }
      show('实时连接中断，正在重连；仍可定时 / 手动刷新。');
    });
    source.addEventListener('invalidate',event=>{
      if(wid!==own||closed||generation!==ownGeneration)return;
      try{
        const data=JSON.parse(event.data);
        if(!/^[a-f0-9]{64}$/.test(data.version)||!data.domains||Object.keys(data.domains).some(k=>!['social','artifacts','notifications'].includes(k)||!/^[a-f0-9]{64}$/.test(data.domains[k])))return;
        const initial=Object.keys(fingerprints).length===0;
        const changed=Object.keys(data.domains).filter(k=>fingerprints[k]!==data.domains[k]);
        fingerprints={...data.domains};
        if(changed.length)Promise.resolve(onInvalidate({workspace:own,changed,initial})).catch(()=>show('更新读取失败，请手动刷新；未丢弃草稿。'));
      }catch{show('实时事件格式错误，未应用内容。');}
    });
    for(const name of ['revoked','unavailable'])source.addEventListener(name,()=>{
      if(wid!==own||generation!==ownGeneration)return;disconnect();show(name==='revoked'?'访问已失效，实时更新已关闭。':'实时更新暂不可用，请重试或手动刷新。');
    });
  }
  const visible=()=>{if(document.visibilityState==='hidden')disconnect();else connect();};
  const retry=()=>{retryAttempts=0;connect();};
  document.addEventListener?.('visibilitychange',visible);
  document.getElementById('workspace-events-retry')?.addEventListener('click',retry);
  return {
    start(value){if(value===wid&&source)return;if(value!==wid){fingerprints={};retryAttempts=0;}wid=value||'';connect();},
    close(){closed=true;disconnect();document.removeEventListener?.('visibilitychange',visible);document.getElementById('workspace-events-retry')?.removeEventListener('click',retry);},
  };
}
