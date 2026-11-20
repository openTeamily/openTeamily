import test from 'node:test';
import assert from 'node:assert/strict';
import {registerAccount, mountRegistration, requestPasswordSetup, requestEmailLoginCode, loginWithEmailCode} from '../openteamily/static/register/app.mjs';
import {readToken, validatePasswords} from '../openteamily/static/set-password/app.mjs';

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
  assert.equal(all['register-submit'].disabled, false);
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


test('email password setup posts only email and terms and returns generic copy', async () => {
  const result = await requestPasswordSetup('admin@example.com', async (url, options) => {
    assert.equal(url, '/v1/auth/password/request');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), {email: 'admin@example.com', accept_terms: true});
    return {status: 200, json: async () => ({ok: true})};
  });
  assert.equal(result.ok, true);
  assert.match(result.message, /设置密码链接/);
  const denied = await requestPasswordSetup('x@example.com', async () => ({status: 403, json: async () => ({error: {code: 'registration_closed'}})}));
  assert.equal(denied.ok, false);
  assert.match(denied.message, /尚未开放/);
});

test('email login code is separate from password setup', async () => {
  const started = await requestEmailLoginCode('admin@example.com', async (url, options) => {
    assert.equal(url, '/v1/auth/email/login/start');
    assert.deepEqual(JSON.parse(options.body), {email: 'admin@example.com'});
    return {status: 200, json: async () => ({ok: true})};
  });
  assert.equal(started.ok, true);
  const verified = await loginWithEmailCode('admin@example.com', '123456', async (url, options) => {
    assert.equal(url, '/v1/auth/email/login/verify');
    assert.deepEqual(JSON.parse(options.body), {email: 'admin@example.com', code: '123456'});
    return {status: 200, json: async () => ({user: {id: 'fixture'}})};
  });
  assert.deepEqual(verified, {ok: true});
  const wrong = await loginWithEmailCode('admin@example.com', '000000', async () => ({status: 400, json: async () => ({error: {code: 'invalid_code'}})}));
  assert.equal(wrong.ok, false);
  assert.match(wrong.message, /验证码/);
});

test('set-password token and confirmation validation stay local', () => {
  assert.equal(readToken('?token=' + 'A'.repeat(43)), 'A'.repeat(43));
  assert.equal(readToken('?x=1'), '');
  assert.equal(validatePasswords('short', 'short'), '密码需要 12–256 个字符。');
  assert.equal(validatePasswords('a'.repeat(13), 'a'.repeat(12)), '两次输入的密码不一致。');
  assert.equal(validatePasswords('a'.repeat(13), 'a'.repeat(13)), '');
});
