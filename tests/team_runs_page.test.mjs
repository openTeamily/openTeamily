import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {csrfCookie, groupByStage, readSteps, STATUS_LABELS} from '../openteamily/static/team-runs/app.mjs';
import {scopeChanges} from '../openteamily/static/agents/memory-scope.mjs';

test('DAG stage board preserves parallel steps and ordered stages', () => {
  const a={position:0,stage:1}, b={position:1,stage:1}, c={position:2,stage:2};
  assert.deepEqual(groupByStage([a,b,c]), [[1,[a,b]],[2,[c]]]);
  assert.equal(STATUS_LABELS.blocked, '被前置失败挡住');
});
test('form payload contains only selected earlier dependencies', () => {
  const rows=[0,1,2].map((n)=>({querySelector(selector){return {value:selector.includes('select')?'a'+n:' 指令 '+n+' '};},
    querySelectorAll(){return n===2?[{value:'0'},{value:'1'},{value:'3'}]:[];}}));
  assert.deepEqual(readSteps({querySelectorAll(){return rows;}}), [
    {agent_id:'a0',instruction:'指令 0',depends_on:[]},
    {agent_id:'a1',instruction:'指令 1',depends_on:[]},
    {agent_id:'a2',instruction:'指令 2',depends_on:[0,1]},
  ]);
});
test('memory scope payload keeps topics only in topic mode',()=>{
  const form={querySelector(){return {value:'all'};},querySelectorAll(){throw Error('not used');}};
  assert.deepEqual(scopeChanges(form),{mode:'all'});
  form.querySelector=()=>({value:'topics'});form.querySelectorAll=()=>[{value:'产品'}];
  assert.deepEqual(scopeChanges(form),{mode:'topics',topics:['产品']});
});
test('CSRF cookie and page contains actual execution controls, no sample results',()=>{
  assert.equal(csrfCookie('ot_dev_csrf=abc%2Ddef; x=1'), 'abc-def');
  const html=readFileSync(new URL('../openteamily/static/team-runs/index.html',import.meta.url),'utf8');
  for(const id of ['run-form','step-editor','run-list','stage-board','cancel-run','remove-run']) assert.ok(html.includes(`id="${id}"`));
  assert.ok(html.includes('不调用工具'));
});
