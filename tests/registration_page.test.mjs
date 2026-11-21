import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAccount, mountRegistration} from '../openteamily/static/register/app.mjs';
import {takeSignupSession} from '../openteamily/static/home/runtime-readiness.mjs';

const synthetic = 'synthetic fixture only';
test('registration posts JSON only to same-origin existing API', async () => {
  const result = await registerAccount('synthetic', synthetic, async (url, options) => {
    if(url==='/v1/auth/session'){assert.equal(options.method,'GET');assert.equal(options.credentials,'same-origin');return {status:200,json:async()=>({user:{id:'fixture-id',username:'synthetic'}})};}
    assert.equal(url, '/v1/auth/register');
    assert.equal(options.method, 'POST');
    assert.equal(options.credentials, 'same-origin');
    assert.equal(options.mode, 'same-origin');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(options.body), {username: 'synthetic', password: synthetic});
    return {status: 201};
  });
  assert.deepEqual(result, {ok: true});
});
test('failure text never echoes response/exception credentials', async () => {
  for (const fetcher of [
    async () => ({status: 403, json: async () => ({error: {code: 'registration_closed', message: synthetic}})}),
    async () => ({status: 500, json: async () => ({error: {code: synthetic, message: synthetic}})}),
    async () => { throw new Error(synthetic); },
  ]) {
    const result = await registerAccount('synthetic', synthetic, fetcher);
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(synthetic));
  }
});
function elements(valid = true) {
  const ids = ['register-form', 'register-submit', 'register-status', 'register-username', 'register-password'];
  const all = Object.fromEntries(ids.map(id => [id, {value: synthetic, textContent: '', disabled: false, focus() {}}]));
  all['register-form'].reportValidity = () => valid;
  all['register-form'].addEventListener = (_, fn) => { all.submit = fn; };
  return {all, document: {getElementById: id => all[id]}};
}
test('successful form clears password and navigates only to fixed home destination with a verified session', async () => {
  const {all, document} = elements();
  let destination;
  mountRegistration(document, path => { destination = path; }, async url => url==='/v1/auth/register'?{status:201}:{status:200,json:async()=>({user:{id:'fixture-id',username:synthetic}})});
  await all.submit({preventDefault() {}});
  assert.equal(destination, '/');
  assert.equal(all['register-password'].value, '');
  assert.equal(all['register-submit'].disabled, true);
});
test('invalid forms do not send and failure does not navigate', async () => {
  for (const valid of [false, true]) {
    const {all, document} = elements(valid);
    let sends = 0;
    mountRegistration(document, () => assert.fail('failure navigated'), async () => {
      sends++; return {status: 403, json: async () => ({error: {code: 'registration_closed'}})};
    });
    await all.submit({preventDefault() {}});
    assert.equal(sends, valid ? 1 : 0);
    if (valid) assert.equal(all['register-password'].value, '');
  }
});

test('201 without actual session is not claimed as a successful login',async()=>{
 for(const response of [{status:401,json:async()=>({})},{status:200,json:async()=>({user:{id:'other',username:'other'}})}]){
  const result=await registerAccount('synthetic',synthetic,async url=>url==='/v1/auth/register'?{status:201}:response);
  assert.equal(result.ok,false);assert.equal(result.created,true);assert.ok(!JSON.stringify(result).includes(synthetic));
 }
});

test('registration hands off cookie confirmation without a duplicate session read when the tab can carry the account ID', async () => {
  const values = new Map();
  const view = {sessionStorage: {
    setItem: (key, value) => values.set(key, value), getItem: key => values.get(key), removeItem: key => values.delete(key),
  }};
  const id = 'a'.repeat(32);
  const result = await registerAccount('SYNTHETIC', synthetic, async url => {
    assert.equal(url, '/v1/auth/register');
    return {status: 201, json: async () => ({user: {id, username: 'synthetic'}})};
  }, view);
  assert.deepEqual(result, {ok: true, pendingSession: true});
  assert.doesNotMatch([...values.values()].join(''), /synthetic/);
  assert.equal(takeSignupSession(view), id);
  assert.equal(takeSignupSession(view), null);
});

test('denied tab storage or missing signup identity keeps the same-origin cookie confirmation', async () => {
  for (const [view, user] of [
    [{get sessionStorage() { throw new Error('storage denied'); }}, {id: 'a'.repeat(32), username: 'synthetic'}],
    [{sessionStorage: {setItem() { assert.fail('an invalid identity must not be carried'); }}}, {username: 'synthetic'}],
  ]) {
    const reads = [];
    const result = await registerAccount('synthetic', synthetic, async url => {
      reads.push(url);
      return url === '/v1/auth/register'
        ? {status: 201, json: async () => ({user})}
        : {status: 401, json: async () => ({})};
    }, view);
    assert.equal(result.created, true);
    assert.equal(result.ok, false);
    assert.deepEqual(reads, ['/v1/auth/register', '/v1/auth/session']);
  }
});
