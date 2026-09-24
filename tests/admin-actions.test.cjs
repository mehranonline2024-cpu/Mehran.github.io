const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(__dirname+'/../supabase/functions/admin-order-action-v2/index.ts','utf8').replace(/^import .*\n/gm,''));
const id='11111111-1111-4111-8111-111111111111';
async function run(action,options={}){
 const order={id,status:'new',payment_method:'cash',payment_status:'unpaid',order_type:'delivery',stripe_payment_intent_id:'pi_mock',...options.order};
 let handler,refundCalls=0,updates=0,phoneConfirmed=options.phoneConfirmed||false;
 const db={auth:{getUser:async()=>({data:{user:options.unauthorized?null:{id:'admin'}}})},from(table){let patch=null;const filters=[];const q={select:()=>q,eq:(key,value)=>{filters.push([key,value]);return q},update:p=>{patch=p;return q},maybeSingle:()=>q,single:()=>q};q.then=(resolve,reject)=>{
  let result={data:null,error:null};
  if(table==='restaurant_admins')result.data={user_id:'admin'};
  if(table==='orders'){
   if(patch){if(options.race&&patch.status)order.status='accepted';if(filters.every(([k,v])=>order[k]===v)){Object.assign(order,patch);updates++;result.data={id};}}
   else result.data={...order};
  }
  return Promise.resolve(result).then(resolve,reject);
 };return q},rpc:async()=>({error:null})};
 const refund=async()=>{refundCalls++;if(options.refundError)throw Error('Stripe unavailable');assert.equal(order.status,'rejected');return{id:'re_mock',status:options.refundStatus||'succeeded'}};
 const ctx=vm.createContext({Request,Response,URL,atob,console:{error(){}},createClient:()=>db,Stripe:class{constructor(){this.refunds={create:refund,retrieve:refund};this.checkout={sessions:{retrieve:async()=>({payment_intent:'pi_mock'})}}}},Deno:{env:{get:key=>({SUPABASE_URL:'https://mock.test',SUPABASE_SERVICE_ROLE_KEY:'mock',STRIPE_SECRET_KEY:'mock'})[key]},serve:fn=>handler=fn}});
 vm.runInContext(source,ctx);
 const token='x.'+Buffer.from(JSON.stringify({aal:options.aal||'aal2'})).toString('base64url')+'.x';
 const r=await handler(new Request('https://mock.test',{method:'POST',headers:{authorization:'Bearer '+token,origin:'https://grilltime.be','content-type':'application/json'},body:JSON.stringify({orderId:id,action,phoneConfirmed})}));
 return{status:r.status,body:await r.json(),order,updates,refundCalls};
}
(async()=>{
 assert.equal((await run('accept')).order.status,'accepted');
 for(const settings of [{aal:'aal1'},{unauthorized:true}]){const r=await run('accept',settings);assert.equal(r.status,401);assert.equal(r.updates,0);}
 const unpaid=await run('accept',{order:{payment_method:'online'}});assert.equal(unpaid.status,409);assert.equal(unpaid.updates,0);
 const race=await run('accept',{race:true});assert.equal(race.status,500);assert.equal(race.updates,0);
 assert.equal((await run('accept',{order:{first_cash_phone_warning:true}})).status,409);
 assert.equal((await run('accept',{order:{first_cash_phone_warning:true},phoneConfirmed:true})).status,200);
 for(const action of ['preparing','ready','on_way','completed']){assert.equal((await run(action,{order:{status:'accepted'}})).order.status,action);assert.equal((await run(action,{order:{status:'accepted',payment_method:'online'}})).status,409);}
 assert.equal((await run('on_way',{order:{status:'ready',order_type:'pickup'}})).status,409);
 const cash=await run('reject');assert.equal(cash.order.status,'rejected');assert.equal(cash.refundCalls,0);
 const paid={payment_method:'online',payment_status:'paid'};
 const refunded=await run('reject',{order:paid});assert.equal(refunded.order.payment_status,'refunded');assert.equal(refunded.refundCalls,1);
 const pending=await run('reject',{order:paid,refundStatus:'pending'});assert.equal(pending.body.refundPending,true);assert.equal(pending.order.payment_status,'paid');assert.equal(pending.order.stripe_refund_id,'re_mock');
 const failed=await run('reject',{order:paid,refundError:true});assert.equal(failed.status,503);assert.equal(failed.order.status,'rejected');assert.equal(failed.order.payment_status,'paid');assert.equal(failed.body.refundNeedsAttention,true);
 const retry=await run('reject',{order:{...paid,status:'rejected',stripe_refund_id:'re_mock'}});assert.equal(retry.order.payment_status,'refunded');
 const done=await run('reject',{order:{...paid,status:'rejected',payment_status:'refunded'}});assert.equal(done.refundCalls,0);
 assert.equal((await run('reject',{order:{status:'accepted'}})).status,409);
 assert.equal((await run('reject',{order:{status:'pending_payment',payment_method:'online'}})).status,409);
 const conflict=await run('reject',{order:paid,race:true});assert.equal(conflict.refundCalls,0);assert.equal(conflict.order.status,'accepted');
 const html=fs.readFileSync(__dirname+'/../admin/index.html','utf8');for(const s of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(s[1]);
 const filterCode=html.slice(html.indexOf('function filterList()'),html.indexOf('function orderHtml('));const filters=vm.createContext({});vm.runInContext(filterCode,filters);
 assert.equal(filters.filterList()[0].id,'active');assert.match(filters.filterList()[0].label,/Home/);assert.equal(filters.filterList().at(-1).id,'history');assert.equal(filters.filterList().some(f=>f.id==='all'||f.id==='completed'||f.id==='unpaid'),false);
 const rows=[{status:'new',payment_method:'cash',payment_status:'unpaid'},{status:'new',payment_method:'online',payment_status:'unpaid'},{status:'preparing',payment_method:'online',payment_status:'unpaid'},{status:'pending_payment',payment_method:'online',payment_status:'unpaid'},{status:'preparing',payment_method:'online',payment_status:'paid'},{status:'completed',payment_method:'online',payment_status:'paid'},{status:'rejected',payment_method:'cash',payment_status:'unpaid'},{status:'cancelled',payment_method:'online',payment_status:'unpaid'},{status:'completed',payment_method:'online',payment_status:'failed'}];
 assert.deepEqual(Array.from(filters.ordersForFilter('active',rows),x=>x.status+':'+x.payment_method),['new:cash','preparing:online']);
 assert.deepEqual(Array.from(filters.ordersForFilter('history',rows),x=>x.status+':'+x.payment_method),['completed:online','rejected:cash']);
 for(const filter of filters.filterList().map(f=>f.id))assert.equal(filters.ordersForFilter(filter,rows).some(filters.isOnlineUnpaid),false,`online unpaid order leaked into ${filter}`);
 const code=html.slice(html.indexOf('const busyOrderIds='),html.indexOf('async function runOrderAction('));const c=vm.createContext({});vm.runInContext(code,c);
 assert.match(c.orderActionHtml({id,status:'new',payment_method:'cash',payment_status:'unpaid'}),/Accepteren/);
 assert.doesNotMatch(c.orderActionHtml({id,status:'new',payment_method:'online',payment_status:'unpaid'}),/onclick/);
 assert.match(c.orderActionHtml({id,status:'rejected',payment_method:'online',payment_status:'paid'}),/Terugbetaling controleren/);
 assert.match(html,/if\(actionSucceeded\)currentFilter='active'/);
 console.log('PASS: admin actions, MFA, payment guards, cash refusal, refund success/pending/failure/retry, concurrent transitions, active/history separation and dashboard rendering. Stripe and database calls mocked.');
})().catch(e=>{console.error(e);process.exitCode=1});
