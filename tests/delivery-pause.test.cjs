const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {stripTypeScriptTypes}=require('node:module');
const root=require('node:path').resolve(__dirname,'..');
for(const page of ['admin','order']){
 const html=fs.readFileSync(`${root}/${page}/index.html`,'utf8');
 for(const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
}
const source=stripTypeScriptTypes(fs.readFileSync(`${root}/supabase/functions/create-checkout/index.ts`,'utf8').replace(/^import .*\n/gm,''));
function brusselsSlot(){const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});const parts=d=>Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));const p=parts(new Date(Date.now()+48*3600000)),guess=Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day),12,0),q=parts(new Date(guess)),offset=Date.UTC(Number(q.year),Number(q.month)-1,Number(q.day),Number(q.hour),Number(q.minute))-guess;return new Date(guess-offset)}
async function checkout({paused=[false],type='delivery',payment='cash',get=false,statusError=false}={}){
 let handler,reads=0,writes=[],stripeCalls=0;
 const db={from(table){let mutation=null,payload;const q={};for(const method of ['select','eq','gte','in','single'])q[method]=()=>q;
  for(const method of ['insert','update'])q[method]=p=>{mutation=method;payload=p;return q};
  q.then=(resolve,reject)=>{let result={data:[],error:null,count:0};
   if(mutation){writes.push({table,mutation,payload});result.data=table==='orders'?{id:'order',order_number:123,total_cents:payload.total_cents}:{id:'customer'};}
   else if(table==='store_settings'){result=statusError?{error:new Error('unavailable')}:{data:{timezone:'Europe/Brussels',opens_at:'12:00:00',closes_at:'23:00:00',preorder_days:7,preparation_lead_minutes:30,delivery_estimate_min:25,delivery_estimate_max:45,delivery_paused:paused[Math.min(reads,paused.length-1)]},error:null};reads++;}
   else if(table==='products')result.data=[{id:'pizza',name:'Pizza',category:'Pizza',price_cents:2000,active:true}];
   return Promise.resolve(result).then(resolve,reject);
  };return q;}};
 const context=vm.createContext({Request,Response,URL,console:{error(){}},createClient:()=>db,Stripe:class {constructor(){this.coupons={create:async()=>({id:'coupon'})};this.checkout={sessions:{create:async()=>{stripeCalls++;return{id:'session',url:'https://stripe.example'}}}}}},Deno:{env:{get:key=>({SUPABASE_URL:'https://example.test',SUPABASE_SERVICE_ROLE_KEY:'mock',STRIPE_SECRET_KEY:'mock'})[key]},serve:fn=>handler=fn},fetch:async url=>new Response(JSON.stringify(String(url).includes('nominatim')?[{lat:'51.23',lon:'2.91',address:{country_code:'be',postcode:'8400',city:'Oostende'}}]:{routes:[{distance:2000}]}))});
 vm.runInContext(source,context);
 const req=new Request('https://example.test',{method:get?'GET':'POST',headers:{origin:'https://grilltime.be','content-type':'application/json'},...(!get?{body:JSON.stringify({paymentMethod:payment,orderType:type,requestedAt:brusselsSlot().toISOString(),requestedWindowEnd:type==='delivery'?new Date(brusselsSlot().getTime()+15*60000).toISOString():null,items:[{productId:'pizza',qty:1}],customer:{name:'Test',phone:'0490000001'},address:'Teststraat 1',city:'8400 Oostende'})}:{})});
 const response=await handler(req);return{status:response.status,body:await response.json(),reads,writes,stripeCalls};
}
async function admin(){
 const html=fs.readFileSync(`${root}/admin/index.html`,'utf8');const code=html.slice(html.indexOf('let deliveryPaused=null'),html.indexOf('function subscribeRealtime()'));
 let paused=false,fail=false,aal='aal2',updates=0;const elements={};
 const sb={auth:{mfa:{getAuthenticatorAssuranceLevel:async()=>({data:{currentLevel:aal}})}},from(){let update;const q={select:()=>q,eq:()=>q,update:p=>{update=p;updates++;return q},single:async()=>{if(fail)return{error:new Error('failure')};if(update)paused=update.delivery_paused;return{data:{delivery_paused:paused}}}};return q}};
 const c=vm.createContext({sb,document:{getElementById:id=>elements[id]??=( {setAttribute(){}} )}});vm.runInContext(code,c);
 await c.loadDeliverySettings();assert.equal(elements.deliveryState.textContent,'Bezorging actief');
 await c.toggleDeliveryPause();assert.equal(paused,true);assert.match(elements.deliveryPauseBtn.textContent,/hervatten/);
 await c.toggleDeliveryPause();assert.equal(paused,false);
 aal='aal1';await c.toggleDeliveryPause();assert.equal(updates,2);assert.equal(paused,false);assert.match(elements.deliverySettingsError.textContent,/Authenticator/);
 aal='aal2';await c.loadDeliverySettings();fail=true;await c.toggleDeliveryPause();assert.equal(paused,false);assert.equal(elements.deliveryPauseBtn.disabled,true);assert.match(elements.deliverySettingsError.textContent,/Niet opgeslagen/);
}
(async()=>{
 for(const paused of [false,true]){const r=await checkout({get:true,paused:[paused]});assert.equal(r.status,200);assert.deepEqual(r.body,{deliveryPaused:paused,settings:{timezone:'Europe/Brussels',opensAt:'12:00',closesAt:'23:00',preorderDays:7,preparationLeadMinutes:30,deliveryEstimateMin:25,deliveryEstimateMax:45}});assert.equal(r.writes.length,0);}
 assert.equal((await checkout({get:true,statusError:true})).status,503);
 for(const payment of ['cash','online']){const r=await checkout({paused:[true],payment});assert.equal(r.status,409);assert.equal(r.body.code,'delivery_paused');assert.equal(r.body.pickupAvailable,true);assert.equal(r.writes.length,0);assert.equal(r.stripeCalls,0);}
 const late=await checkout({paused:[false,true]});assert.equal(late.status,409);assert.equal(late.reads,2);assert.equal(late.writes.length,0);
 const unavailable=await checkout({statusError:true});assert.equal(unavailable.status,503);assert.equal(unavailable.writes.length,0);
 for(const payment of ['cash','online']){const pickup=await checkout({type:'pickup',paused:[true],payment});assert.equal(pickup.status,200);assert.equal(pickup.reads,1);assert.equal(pickup.body.deliveryFeeCents,0);assert.equal(pickup.writes.filter(w=>w.table==='orders'&&w.mutation==='insert').length,1);}
 const active=await checkout();assert.equal(active.status,200);assert.equal(active.body.deliveryFeeCents,299);assert.equal(active.reads,2);
 await admin();console.log('PASS: scripts parse; pause/resume; MFA; save errors; cash/online blocking; late pause; fail-closed delivery; pickup stays available; active delivery fee unchanged. All database and Stripe calls mocked.');
})().catch(error=>{console.error(error);process.exitCode=1});
