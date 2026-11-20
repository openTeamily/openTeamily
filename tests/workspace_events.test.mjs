import test from 'node:test';
import assert from 'node:assert/strict';
import {eventsEndpoint,isDsBotPage,mountWorkspaceEvents} from '../openteamily/static/shell/workspace-events.mjs';
function fixture(){
 const elements={'workspace-events-status':{textContent:''},'workspace-events-retry':{addEventListener(_n,fn){this.click=fn},removeEventListener(){}}};
 const listeners={},instances=[];
 const document={visibilityState:'visible',getElementById:id=>elements[id],addEventListener(n,fn){listeners[n]=fn},removeEventListener(n){delete listeners[n]}};
 class FakeSource{
  constructor(url,options){this.url=url;this.options=options;this.handlers={};instances.push(this)}
  addEventListener(n,fn){this.handlers[n]=fn}
  emit(n,data){this.handlers[n]?.({data:JSON.stringify(data)})}
  close(){this.closed=true}
 }
 return {document,elements,listeners,instances,FakeSource};
}
const packet=(social='a')=>({version:'f'.repeat(64),domains:{social:social.repeat(64),artifacts:'b'.repeat(64),notifications:'c'.repeat(64)}});
test('real transport is same-origin, idempotent by workspace, validates domains and reports only changed fingerprints',async()=>{
 const f=fixture(),seen=[];const mount=mountWorkspaceEvents(f.document,{EventSource:f.FakeSource,onInvalidate:e=>seen.push(e)});
 mount.start('1'.repeat(32));mount.start('1'.repeat(32));assert.equal(f.instances.length,1);
 const source=f.instances[0];assert.equal(source.url,'/v1/workspaces/'+'1'.repeat(32)+'/events');assert.deepEqual(source.options,{withCredentials:true});
 source.emit('invalidate',packet());source.emit('invalidate',packet());source.emit('invalidate',packet('d'));
 assert.equal(seen.length,2);assert.equal(seen[0].initial,true);assert.equal(seen[1].initial,false);assert.deepEqual(seen[1].changed,['social']);
 source.emit('invalidate',{version:'bad',domains:{social:'leak'}});assert.equal(seen.length,2);
 source.emit('invalidate',{...packet(),domains:{secret:'a'.repeat(64)}});assert.equal(seen.length,2);
 mount.close();assert.equal(source.closed,true);
});
test('workspace switch, same-workspace reconnect and visibility close ignore all stale events and preserve baseline',()=>{
 const f=fixture(),seen=[];const mount=mountWorkspaceEvents(f.document,{EventSource:f.FakeSource,onInvalidate:e=>seen.push(e)});
 mount.start('1'.repeat(32));const old=f.instances[0];old.emit('invalidate',packet());
 f.document.visibilityState='hidden';f.listeners.visibilitychange();assert.equal(old.closed,true);
 f.document.visibilityState='visible';f.listeners.visibilitychange();const newer=f.instances[1];
 old.emit('invalidate',packet('d'));assert.equal(seen.length,1);
 newer.emit('invalidate',packet('d'));assert.equal(seen.length,2);assert.equal(seen[1].initial,false);
 mount.start('2'.repeat(32));newer.emit('invalidate',packet('e'));assert.equal(seen.length,2);
 f.instances[2].emit('invalidate',packet());assert.equal(seen[2].initial,true);
 mount.close();assert.equal(f.instances[2].closed,true);assert.equal(f.listeners.visibilitychange,undefined);
});
test('revocation closes transport, explicit retry restores it, unsupported browsers stay honest',()=>{
 const f=fixture();const mount=mountWorkspaceEvents(f.document,{EventSource:f.FakeSource});mount.start('1'.repeat(32));
 f.instances[0].emit('revoked',{});assert.equal(f.instances[0].closed,true);assert.match(f.elements['workspace-events-status'].textContent,/失效/);
 f.elements['workspace-events-retry'].click();assert.equal(f.instances.length,2);mount.close();
 const g=fixture();mountWorkspaceEvents(g.document,{EventSource:null}).start('1'.repeat(32));assert.match(g.elements['workspace-events-status'].textContent,/不支持/);
 const h=fixture();mountWorkspaceEvents(h.document,{EventSource:class{constructor(){throw new Error('host blocked')}}}).start('1'.repeat(32));assert.match(h.elements['workspace-events-status'].textContent,/无法建立/);
});


test('a closed non-200 handshake gets bounded recovery; stale timers and close cannot reconnect',()=>{
 const f=fixture(),timers=new Map();let id=0;
 const mount=mountWorkspaceEvents(f.document,{EventSource:f.FakeSource,setTimer:(fn,ms)=>{timers.set(++id,{fn,ms});return id;},clearTimer:key=>timers.delete(key)});
 mount.start('1'.repeat(32));
 for(const delay of [3000,6000,12000]){
  const source=f.instances.at(-1);source.readyState=2;source.emit('error');source.emit('error');
  assert.equal(timers.size,1);const [key,timer]=[...timers][0];assert.equal(timer.ms,delay);timers.delete(key);timer.fn();
 }
 f.instances.at(-1).readyState=2;f.instances.at(-1).emit('error');assert.equal(timers.size,0);assert.match(f.elements['workspace-events-status'].textContent,/请点重连/);
 f.elements['workspace-events-retry'].click();f.instances.at(-1).readyState=2;f.instances.at(-1).emit('error');
 const stale=[...timers.values()][0].fn;mount.close();assert.equal(timers.size,0);const count=f.instances.length;stale();assert.equal(f.instances.length,count);
});

test('a page served by DS-Bot streams from its own plugin endpoint; platform pages keep /v1',()=>{
 const wid='1'.repeat(32);
 const platform=fixture();
 mountWorkspaceEvents(platform.document,{EventSource:platform.FakeSource}).start(wid);
 assert.equal(platform.instances[0].url,'/v1/workspaces/'+wid+'/events');
 assert.equal(isDsBotPage(platform.document),false);
 const moved=fixture();
 moved.document.querySelector=selector=>selector.includes('openteamily-served-by')?{content:'ds-bot'}:null;
 assert.equal(isDsBotPage(moved.document),true);
 mountWorkspaceEvents(moved.document,{EventSource:moved.FakeSource}).start(wid);
 assert.equal(moved.instances[0].url,'/b/api/openteamily/events?workspace='+wid);
 assert.equal(eventsEndpoint(wid,{dsbot:true}),'/b/api/openteamily/events?workspace='+wid);
 assert.equal(eventsEndpoint(wid),'/v1/workspaces/'+wid+'/events');
});
