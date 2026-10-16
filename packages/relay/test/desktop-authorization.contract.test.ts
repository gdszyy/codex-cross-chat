import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {api,registerConv,registerDevice,startTestRelay,type TestRelay} from './helpers.js';

describe('desktop queue permission is distinct from observed execution',()=>{
 let t:TestRelay,a:any,b:any,ca:any,cb:any;
 beforeAll(async()=>{
  t=await startTestRelay();a=await registerDevice(t,'a');b=await registerDevice(t,'b');
  ca=await registerConv(t,a.device_token,{thread_id:'a',alias:'a',role:'worker'});
  cb=await registerConv(t,b.device_token,{thread_id:'b',alias:'b',role:'worker',allow_sources:[ca.conv_id]});
 });
 afterAll(async()=>{await t?.close();});
 async function request(){
  const r=await api(t.baseUrl,'POST','/v1/requests',{token:a.device_token,body:{from_conv:ca.conv_id,to:cb.conv_id,type:'QUERY',body:'fixture'}});
  expect(r.status).toBe(201);return r.body.data.request_id as string;
 }
 const grant=(id:string,body:any={execution_mode:'desktop_inbox'},token?:string)=>api(t.baseUrl,'POST',`/v1/requests/${id}/authorize-start`,{token:token??b.device_token,body});
 it('grants a pending queue permission idempotently and only a real turn report marks running',async()=>{
  const id=await request();const g=await grant(id);
  expect(g.status).toBe(200);expect(g.body.data.exec_status).toBe('pending');
  expect(g.body.data.start_authorized_at).toBeGreaterThan(0);expect(g.body.data.started_at).toBeNull();expect(g.body.data.turn_id).toBeNull();
  expect(g.body.data.delivery_status).toBe('device_received');
  const again=await grant(id);expect(again.body.data.start_authorized_at).toBe(g.body.data.start_authorized_at);
  expect((await grant(id,{})).status).toBe(409);
  const started=await api(t.baseUrl,'POST',`/v1/requests/${id}/start`,{token:b.device_token,body:{turn_id:'observed-owner-turn'}});
  expect(started.status).toBe(200);expect(started.body.data.exec_status).toBe('running');expect(started.body.data.turn_id).toBe('observed-owner-turn');
  expect(started.body.data.started_at).toBeGreaterThan(0);
 });
 it('keeps the legacy empty-body managed permit behavior',async()=>{
  const g=await grant(await request(),{});expect(g.status).toBe(200);expect(g.body.data.exec_status).toBe('running');
  expect(g.body.data.started_at).toBe(g.body.data.start_authorized_at);
 });
 it('does not grant a second desktop enqueue after another execution mode or observed turn is running',async()=>{
  const managed=await request();expect((await grant(managed,{})).status).toBe(200);
  expect((await grant(managed)).status).toBe(409);
  const desktop=await request();expect((await grant(desktop)).status).toBe(200);
  expect((await api(t.baseUrl,'POST',`/v1/requests/${desktop}/start`,{token:b.device_token,body:{turn_id:'already-observed'}})).status).toBe(200);
  expect((await grant(desktop)).status).toBe(409);
  expect((await grant(desktop,{})).status).toBe(409);
  expect((await api(t.baseUrl,'POST',`/v1/requests/${managed}/start`,{token:b.device_token,body:{turn_id:'managed-observed'}})).status).toBe(200);
  expect((await grant(managed,{})).status).toBe(409);
 });
 it('requires an exact nonempty turn ID and cannot overwrite an observed turn',async()=>{
  const id=await request();expect((await grant(id)).status).toBe(200);
  for(const body of [{},{turn_id:''},{turn_id:3},{turn_id:' spaced '}]) {
   expect((await api(t.baseUrl,'POST',`/v1/requests/${id}/start`,{token:b.device_token,body})).status).toBe(400);
  }
  expect((await t.relay.store.getRequestOrThrow(id)).exec_status).toBe('pending');
  const start=(turn_id:string)=>api(t.baseUrl,'POST',`/v1/requests/${id}/start`,{token:b.device_token,body:{turn_id}});
  expect((await start('exact-turn')).status).toBe(200);expect((await start('exact-turn')).status).toBe(200);
  expect((await start('different-turn')).status).toBe(409);expect((await t.relay.store.getRequestOrThrow(id)).turn_id).toBe('exact-turn');
  await api(t.baseUrl,'POST',`/v1/requests/${id}/result`,{token:b.device_token,body:{conv_id:cb.conv_id,kind:'STATUS',exec_status:'waiting_user',body:'waiting for user'}});
  expect((await start('exact-turn')).body.data.exec_status).toBe('waiting_user');
 });
 it('protects the registered identity while a desktop queue grant remains unresolved',async()=>{
  const target=await registerConv(t,b.device_token,{thread_id:'desktop-rebind-old',alias:'rebind-target',role:'worker',allow_sources:[ca.conv_id]});
  const sent=await api(t.baseUrl,'POST','/v1/requests',{token:a.device_token,body:{from_conv:ca.conv_id,to:target.conv_id,type:'QUERY',body:'pending queue'}});
  const id=sent.body.data.request_id;expect((await grant(id)).status).toBe(200);
  const rebind=()=>api(t.baseUrl,'POST',`/v1/roster/${target.conv_id}/rebind`,{token:b.device_token,body:{expected_thread_id:'desktop-rebind-old',profile:'default',thread_id:'desktop-rebind-new',reason:'lost_local_thread'}});
  expect((await rebind()).body.error.code).toBe('conversation_inflight');
  await t.relay.store.db.query('UPDATE requests SET expires_at=$2 WHERE request_id=$1',[id,Date.now()-1]);
  expect((await rebind()).body.error.code).toBe('conversation_inflight');
  await api(t.baseUrl,'POST',`/v1/requests/${id}/cancel`,{token:a.device_token,body:{from_conv:ca.conv_id}});
  expect((await rebind()).status).toBe(200);
 });
 it('does not allow a pending queue permit to bypass expiry before the sweeper runs',async()=>{
  const id=await request();expect((await grant(id)).status).toBe(200);
  await t.relay.store.db.query('UPDATE requests SET expires_at=$2 WHERE request_id=$1',[id,Date.now()-1]);
  expect((await grant(id)).status).toBe(409);
  expect((await api(t.baseUrl,'POST',`/v1/requests/${id}/start`,{token:b.device_token,body:{turn_id:'too-late'}})).status).toBe(409);
  expect((await t.relay.store.getRequestOrThrow(id)).turn_id).toBeNull();
 });
 it('allows cancelling a granted but not consumed queue entry without reporting model execution',async()=>{
  const id=await request();expect((await grant(id)).status).toBe(200);
  const cancelled=await api(t.baseUrl,'POST',`/v1/requests/${id}/cancel`,{token:a.device_token,body:{from_conv:ca.conv_id}});
  expect(cancelled.body.data.exec_status).toBe('interrupted');expect(cancelled.body.data.delivery_status).toBe('rejected');
  expect((await grant(id)).status).toBe(409);
  expect((await api(t.baseUrl,'POST',`/v1/requests/${id}/start`,{token:b.device_token,body:{turn_id:'cancelled'}})).status).toBe(409);
 });
 it('rejects wrong device and unsupported modes without granting permission',async()=>{
  const id=await request();expect((await grant(id,{execution_mode:'desktop_inbox'},a.device_token)).status).toBe(403);
  for(const body of [{execution_mode:null},{execution_mode:'anything'},[],null]) expect((await grant(id,body)).status).toBe(400);
  expect((await t.relay.store.getRequestOrThrow(id)).start_authorized_at).toBeNull();
 });
});
