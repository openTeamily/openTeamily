import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { bulkAuth, startServer } from "./helpers.js";
import { home } from "./openteamily_helpers.js";

type Actor = Awaited<ReturnType<typeof home>>;
let service: Awaited<ReturnType<typeof startServer>>;
before(async () => { service = await startServer(bulkAuth); });
after(async () => { await service.stop(); });
const queue = "/v1/ot/agent-inbox?managed=1";
const targets = (message: any) => message.reply_jobs.map((job: any) => [job.agent_owner_id, job.agent_id]);
const pair = (owner_id: string, agent_id: string) => ({owner_id,agent_id});
const idOf = async (actor: Actor) => (await actor.ok("GET", "/v1/ot/me")).owner_id;

test("named group reply policy is owner-only and revisioned, with authoritative exact lead and audience overrides", async () => {
  const [owner, teammate, outsider] = await Promise.all([
    home(service.base, "policy-owner"), home(service.base, "policy-teammate"), home(service.base, "policy-outside"),
  ]);
  const ownerId = await idOf(owner), teammateId = await idOf(teammate);
  const team = await owner.ok("POST", "/v1/ot/teams", {name: "Group reply settings"});
  const {code} = await owner.ok("POST", `/v1/ot/teams/${team.id}/invites`, {});
  await teammate.ok("POST", "/v1/ot/invites/accept", {code});
  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${teammate.handle}`, {role:"admin"});
  const {workspaces} = await owner.ok("GET", "/v1/ot/workspaces");
  const workspace = workspaces.find((row: any) => row.id === team.id).workspace_id;
  const group = await owner.ok("POST", "/v1/ot/conversations", {
    kind:"group", title:"Policy scope", team_id:team.id, members:[teammate.handle],
    agents:[{agent_ref:"shared",name:"Owner helper"},{agent_ref:"auto",name:"Auto observer"}],
  });
  const room = "/v1/ot/conversations/" + group.id;
  const change = (actor: Actor, body: object) => actor.call("POST", room + "/management", {workspace,action:"reply_policy",...body});
  const send = (actor: Actor, body: string, extra = {}) => actor.ok("POST", room + "/messages", {body,...extra});
  await owner.ok("PATCH", room + "/agents/auto", {auto_reply:true});
  await teammate.ok("PUT", room + "/agents/shared", {name:"Teammate helper"});
  await teammate.ok("PUT", room + "/agents/other:helper", {name:"Second teammate helper"});
  const selected = pair(teammateId, "shared");
  assert.deepEqual(group.group_agent_routing, {mode:"shared",policy:{mode:"default"},can_edit:true});
  const initial = await owner.ok("GET", room);
  const revision = initial.group_management.revision;
  const chooseLead = {revision,mode:"lead",lead:selected};
  assert.equal((await change(teammate, chooseLead)).status, 403, "team administrator cannot edit another owner's group policy");
  assert.equal((await change(outsider, chooseLead)).status, 404);
  assert.equal((await change(owner, {...chooseLead, workspace:"f".repeat(32)})).status, 404);
  assert.equal((await change(owner, {...chooseLead, lead:pair(ownerId,"other:helper")})).data.error.code, "group_reply_lead_unavailable");
  assert.equal((await change(owner, {revision,mode:"default",lead:selected})).status, 400);
  assert.equal((await change(owner, {revision,mode:"lead"})).status, 400);

  const saved = (await change(owner, chooseLead)).data.conversation;
  assert.equal(saved.group_management.revision,revision + 1);
  assert.notEqual(saved.activity_version, initial.activity_version);
  assert.deepEqual(saved.group_agent_routing.policy, {mode:"lead",lead:selected});
  assert.deepEqual((await teammate.ok("GET", room)).group_agent_routing,
    {mode:"shared",policy:{mode:"lead",lead:selected},can_edit:false});
  assert.equal((await change(owner, {...chooseLead,lead:{agent_id:"shared",owner_id:teammateId}})).data.conversation.group_management.revision, revision + 1);
  assert.equal((await change(owner, {revision,mode:"everyone"})).data.error.code, "group_management_conflict");
  const noOp = await change(owner, {...chooseLead,revision:revision + 1});
  assert.equal(noOp.data.conversation.group_management.revision,revision + 1);

  const ordinary = await send(owner,"请整理今天的进展");
  assert.deepEqual(targets(ordinary),[[teammateId,"shared"]]);
  assert.equal((await owner.ok("GET",queue)).items.some((item: any) => item.message.id === ordinary.id),false);
  const leadJob = ordinary.reply_jobs[0];
  const claim_id = randomUUID();
  const claimLead = {
    action:"start",attempt:1,source_revision:ordinary.revision,claim_id,accept_group_text_turn:true,
  };
  assert.equal((await teammate.call("POST","/v1/ot/agent-reply-jobs/"+leadJob.id,claimLead)).status,409);
  assert.deepEqual(await teammate.ok("POST","/v1/ot/agent-reply-jobs/"+leadJob.id,{
    ...claimLead,accept_discretionary_reply:true,
  }),{ok:true,group_text_only:true,discretionary:true,prior_replies:[]});
  const reply = await teammate.ok("POST",room+"/agent-messages",{
    agent_ref:"shared",body:"当前进展已核对",mode:"mention",reply_to:ordinary.id,job_id:leadJob.id,attempt:1,claim_id,
  });
  const explicit = await send(owner,"@Owner helper 请再检查", {agent_mentions:[pair(ownerId,"shared")]});
  assert.deepEqual(targets(explicit),[[ownerId,"shared"]]);
  const all = await send(owner,"@all 请大家提供意见");
  assert.deepEqual(new Set(targets(all).map(([owner,agent]:string[])=>owner+"/"+agent)),
    new Set([ownerId+"/shared",ownerId+"/auto",teammateId+"/shared",teammateId+"/other:helper"]));

  const everyone = (await change(owner, {revision:revision + 1,mode:"everyone"})).data.conversation;
  assert.deepEqual(everyone.group_agent_routing.policy,{mode:"everyone"});
  const everyoneMessage = await send(owner,"这是今天的发布计划");
  assert.equal(targets(everyoneMessage).length,4);
  for (const actor of [owner, teammate]) {
    const jobs = (await actor.ok("GET", queue)).jobs.filter((job: any) => job.message.id === everyoneMessage.id);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((job: any) => job.discretionary));
  }
  assert.deepEqual(targets(await send(owner,"再解释一项", {reply_to:reply.id})),[[teammateId,"shared"]]);
  const last = (await change(owner,{revision:everyone.group_management.revision,mode:"lead",lead:selected})).data.conversation;
  assert.deepEqual(last.group_agent_routing.policy,{mode:"lead",lead:selected});

  await owner.ok("PATCH", `/v1/ot/teams/${team.id}/members/${teammate.handle}`, {suspended:true});
  const stale = await owner.ok("GET",room);
  assert.deepEqual(stale.group_agent_routing.policy,{mode:"lead",lead:selected,lead_unavailable:true});
  const fallback = await send(owner,"今天再帮我检查发布记录");
  assert.deepEqual(new Set(targets(fallback).map(([id,agent]:string[])=>id+"/"+agent)),
    new Set([ownerId+"/shared",ownerId+"/auto"]));
  const fallbackJobs = (await owner.ok("GET",queue)).jobs.filter((job: any) => job.message.id === fallback.id);
  assert.equal(fallbackJobs.length,2);
  assert.ok(fallbackJobs.every((job: any) => job.discretionary));
  const quotedUnavailable = await send(owner,"同一个问题", {reply_to:reply.id});
  assert.deepEqual(targets(quotedUnavailable),[]);
  assert.equal((await owner.call("POST", room+"/agent-messages",{
    agent_ref:"auto",body:"Unselected legacy reply",mode:"auto",reply_to:quotedUnavailable.id,
  })).data.error.code,"reply_job_unavailable");
  const explicitAvailable = await send(owner,"请回答", {agent_mentions:[pair(ownerId,"shared")]});
  assert.deepEqual(targets(explicitAvailable),[[ownerId,"shared"]]);
  const reset = (await change(owner,{revision:stale.group_management.revision,mode:"default"})).data.conversation;
  assert.deepEqual(reset.group_agent_routing.policy,{mode:"default"});
  const autoOptIn = await send(owner,"默认策略的普通消息");
  const inbox = await owner.ok("GET",queue);
  assert.ok(inbox.items.some((item: any) => item.message.id === autoOptIn.id && item.agent_ref === "auto"));
  assert.ok(!inbox.items.some((item: any) => item.message.id === quotedUnavailable.id));
});

test("the personal group retains unavailable-lead metadata with an empty roster and transfers edit authority with ownership", async () => {
  const [owner, teammate] = await Promise.all([home(service.base,"policy-personal-owner"),home(service.base,"policy-personal-peer")]);
  const ownerId = await idOf(owner), teammateId = await idOf(teammate);
  const contact = await owner.ok("POST","/v1/ot/contacts",{handle:teammate.handle});
  await teammate.ok("POST",`/v1/ot/contacts/${contact.id}`,{action:"accept"});
  const group = await owner.ok("POST","/v1/ot/conversations", {
    kind:"group",account_group:true,title:"Private policy",members:[teammate.handle],agents:[{agent_ref:"first",name:"First"}],
  });
  const room = "/v1/ot/conversations/" + group.id;
  const notOwned = await teammate.call("POST",room+"/management",{
    action:"reply_policy",mode:"everyone",revision:group.group_management.revision,direct:true,
  });
  assert.equal(notOwned.status,403);
  const lead = pair(ownerId,"first");
  const picked = (await owner.ok("POST",room+"/management",{
    action:"reply_policy",mode:"lead",lead,revision:group.group_management.revision,direct:true,
  })).conversation;
  await owner.ok("DELETE",room+"/agents/first");
  const empty = await owner.ok("GET",room);
  assert.deepEqual(empty.agents,[]);
  assert.deepEqual(empty.group_agent_routing.policy,{mode:"lead",lead,lead_unavailable:true});
  const moved = (await owner.ok("POST",room+"/management",{
    action:"transfer",member_id:teammateId,revision:picked.group_management.revision,direct:true,
  })).conversation;
  assert.equal(moved.group_agent_routing.can_edit,false);
  assert.equal((await teammate.ok("GET",room)).group_agent_routing.can_edit,true);
  await teammate.ok("PUT",room+"/agents/replacement",{name:"Replacement"});
  const fallback = await owner.ok("POST",room+"/messages",{body:"请现在可用的智能体看看"});
  assert.deepEqual(targets(fallback),[[teammateId,"replacement"]]);
  const queued = (await teammate.ok("GET",queue)).jobs.find((job: any) => job.message.id === fallback.id);
  assert.ok(queued?.discretionary);
  const updated = (await teammate.ok("POST",room+"/management",{
    action:"reply_policy",mode:"lead",lead:pair(teammateId,"replacement"),revision:moved.group_management.revision,direct:true,
  })).conversation;
  assert.deepEqual(updated.group_agent_routing.policy,{mode:"lead",lead:pair(teammateId,"replacement")});
  assert.deepEqual(targets(await owner.ok("POST",room+"/messages",{body:"新主答可以回复"})),[[teammateId,"replacement"]]);
});
