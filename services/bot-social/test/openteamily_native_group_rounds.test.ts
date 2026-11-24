import {after, before, test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {bulkAuth, startServer} from "./helpers.js";
import {home} from "./openteamily_helpers.js";

let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });

const inbox = "/v1/ot/native-group-inbox";
const rooms = "/v1/ot/conversations";
const agents = [{agent_ref:"native-a",name:"Planner"},{agent_ref:"native-b",name:"Reviewer"}];

test("a solo native group queues one real round and mirrors its Bot handoffs exactly once", async () => {
  const owner = await home(service.base, "native-round-owner");
  const outsider = await home(service.base, "native-round-outsider");
  const {owner_id} = await owner.ok("GET", "/v1/ot/me");
  const group = await owner.ok("POST", rooms, {kind:"group",account_group:true,title:"Native group",agents});
  const room = rooms + "/" + group.id;
  const message = {body:"Check the native discussion",native_round:true,client_key:randomUUID(),
    agent_mentions:[{owner_id,agent_id:agents[0].agent_ref}]};
  const first = await owner.ok("POST", room + "/messages", message);
  assert.deepEqual(first.reply_jobs, []);
  assert.equal(first.body, "@Planner " + message.body);
  assert.equal((await owner.ok("POST", room + "/messages", message)).id, first.id);
  const second = await owner.ok("POST", room + "/messages", {body:"Follow up",native_round:true,client_key:randomUUID()});
  const firstPath = room + "/native-rounds/" + first.id;
  const secondPath = room + "/native-rounds/" + second.id;
  assert.deepEqual((await owner.ok("GET", inbox)).items, [
    {conversation_id:group.id,message_id:first.id,body:message.body,agent_mentions:message.agent_mentions,state:"queued",seq:first.seq},
    {conversation_id:group.id,message_id:second.id,body:"Follow up",agent_mentions:[],state:"queued",seq:second.seq},
  ]);
  assert.deepEqual((await outsider.ok("GET", inbox)).items, []);
  assert.equal((await outsider.call("POST", firstPath, {action:"start"})).status, 404);
  assert.equal((await owner.call("POST", secondPath, {action:"start"})).status, 409);

  const firstLine = {agent_ref:agents[0].agent_ref,body:"@Reviewer Verify the plan",client_key:"native-room:10"};
  assert.equal((await owner.call("POST", firstPath + "/lines", firstLine)).status, 409);
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"start"}), {state:"running",started:true});
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"start"}), {state:"running",started:false});
  assert.equal((await owner.ok("GET", inbox)).items[0].state, "running");
  const called = await owner.ok("POST", firstPath + "/lines", firstLine);
  assert.equal((await owner.ok("POST", firstPath + "/lines", firstLine)).id, called.id);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,body:"Different"})).status, 409);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,agent_ref:"no-seat",client_key:"invalid"})).status, 404);
  const answer = await owner.ok("POST", firstPath + "/lines", {agent_ref:agents[1].agent_ref,body:"Verified",client_key:"native-room:11"});
  assert.deepEqual([called.author.name,answer.author.name], ["Planner","Reviewer"]);
  assert.deepEqual(called.reply_jobs, []);
  assert.deepEqual(answer.reply_jobs, []);
  assert.deepEqual((await owner.ok("GET", "/v1/ot/agent-inbox?managed=1")).jobs, []);
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"finish"}), {state:"finished"});
  assert.deepEqual(await owner.ok("POST", firstPath, {action:"finish"}), {state:"finished"});
  assert.equal((await owner.ok("POST", firstPath + "/lines", firstLine)).id, called.id);
  assert.equal((await owner.call("POST", firstPath + "/lines", {...firstLine,client_key:"late"})).status, 409);
  assert.deepEqual((await owner.ok("GET", inbox)).items.map((row: {message_id:string}) => row.message_id), [second.id]);
  assert.deepEqual(await owner.ok("POST", secondPath, {action:"start"}), {state:"running",started:true});
});

test("native rounds cannot bypass membership in shared groups or consume quotes", async () => {
  const owner = await home(service.base, "native-round-shared-owner");
  const peer = await home(service.base, "native-round-shared-peer");
  const request = await owner.ok("POST", "/v1/ot/contacts", {handle:peer.handle});
  await peer.ok("POST", "/v1/ot/contacts/" + request.id, {action:"accept"});
  const group = await owner.ok("POST", rooms, {kind:"group",account_group:true,title:"Shared group",members:[peer.handle],agents});
  const messages = rooms + "/" + group.id + "/messages";
  const mark = {body:"Looks good",native_round:true,client_key:randomUUID()};
  assert.equal((await owner.call("POST", messages, mark)).status, 409);
  assert.equal((await peer.call("POST", messages, mark)).status, 409);
  const legacy = await owner.ok("POST", messages, {body:"Please check this"});
  assert.equal(legacy.reply_jobs.length, 2);
  assert.equal((await owner.call("POST", messages, {...mark,reply_to:legacy.id})).status, 400);
  assert.deepEqual((await owner.ok("GET", inbox)).items, []);
});
