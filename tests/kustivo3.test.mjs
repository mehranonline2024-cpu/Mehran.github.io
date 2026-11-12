import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';

const root = new URL('../', import.meta.url);
const source = stripTypeScriptTypes(fs.readFileSync(new URL('supabase/functions/create-checkout/index.ts', root), 'utf8'), {mode:'strip'}).replace(/^import .*$/gm,'');
const fixedNow = new Date('2026-11-07T08:00:00Z');
class Clock extends Date { constructor(...args){super(...(args.length?args:[fixedNow]));} static now(){return +fixedNow;} }

function application(options={}) {
  const calls={orders:[],updates:[],coupons:[],sessions:[],expired:[],history:[],items:[],customerUpserts:[]};
  let active=options.active??null, handler;
  const session={id:'cs_test_fixture',status:options.sessionStatus??'open',payment_status:'unpaid',...options.session};
  const stripe={coupons:{create:async p=>{calls.coupons.push(p);return{id:'coupon_fixture'};}},checkout:{sessions:{
    create:async p=>{calls.sessions.push(p);return{id:'cs_test_fixture',url:'https://checkout.stripe.com/fixture'};},
    retrieve:async()=>({...session}),expire:async id=>{calls.expired.push(id);session.status='expired';return {...session};}
  }}};
  class Query {
    constructor(table){this.table=table;this.op='select';this.filters={};}
    select(){return this;} eq(k,v){this.filters[k]=v;return this;} in(){return this;} gte(){return this;}
    insert(data){this.op='insert';this.data=data;return this;} update(data){this.op='update';this.data=data;return this;}
    upsert(data,options){assert.equal(this.table,'customers');assert.equal(options.onConflict,'phone');calls.customerUpserts.push(data);this.op='upsert';this.data=data;return this;}
    async result(single=false){
      if(this.op==='update'){
        calls.updates.push({table:this.table,data:this.data,filters:this.filters});
        if(this.table==='orders'&&this.data.status==='cancelled')active=null;
        if(this.table==='customers'&&options.duplicatePhones&&this.data.phone)return{data:null,error:{code:'23505',message:'duplicate key violates unique constraint "customers_phone_key"'}};
        return {data:single?{id:this.filters.id||'customer_fixture'}:null,error:null};
      }
      if(this.table==='store_settings')return{data:{timezone:'Europe/Brussels',opens_at:'11:30:00',closes_at:'23:00:00',preparation_lead_minutes:30,preorder_days:7,delivery_paused:false},error:null};
      if(this.table==='order_products')return{data:[{id:'fixture_product',name:'Fixture product',category:'Pizza',price_cents:options.price??2500,active:true}],error:null};
      if(this.table==='customers')return{data:single?{id:'customer_fixture'}:(options.customers??[{id:'customer_fixture'}]),error:null};
      if(this.table==='orders'){
        if(this.op==='insert'){
          calls.orders.push(this.data);
          if(options.race)return{data:null,error:{code:'23505',message:'duplicate key violates unique constraint "orders_kustivo3_phone_once"'}};
          return{data:{id:'order_fixture',order_number:100,total_cents:this.data.total_cents,tracking_token:'00000000-0000-4000-8000-000000000001'},error:null};
        }
        if(this.filters.tracking_token)return{data:{id:'order_fixture',status:'pending_payment',payment_status:options.orderPaymentStatus??'unpaid',discount_code:'KUSTIVO3',stripe_checkout_session_id:'cs_test_fixture'},error:null};
        return{data:null,count:0,error:null};
      }
      if(this.table==='order_items'&&this.op==='insert'){calls.items.push(this.data);return{data:null,error:options.itemError?new Error('Fixture item failure'):null};}
      return{data:[],error:null};
    }
    single(){return this.result(true);} maybeSingle(){return this.result(true);} then(a,b){return this.result().then(a,b);}
  }
  const db={from:table=>new Query(table),rpc:(_name,p)=>({single:async()=>{
    calls.history.push(p);return{data:options.historyError?null:{completed_count:options.completed??1,active_discount:active},error:options.historyError?new Error('Fixture history failure'):null};
  }})};
  const env={STRIPE_SECRET_KEY:'sk_test_fixture',SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'fixture'};
  const context=vm.createContext({Stripe:function(){return stripe;},createClient:()=>db,proj4:()=>{throw Error('Unexpected address operation');},Deno:{env:{get:k=>env[k]},serve:h=>{handler=h;}},Date:Clock,Intl,Request,Response,URL,AbortSignal,console:{warn(){},error(){}},fetch:()=>{throw Error('Unexpected network operation');}});
  vm.runInContext(source,context);
  return{calls,context,async request(overrides={}){
    const body={quoteOnly:true,customer:{name:'Fixture',phone:options.phone??'+32 490 39 61 81'},orderType:'pickup',paymentMethod:'cash',requestedAt:'2026-11-07T10:30:00Z',items:[{productId:'fixture_product',qty:1}],discountCode:'KUSTIVO3',...overrides};
    const response=await handler(new Request('https://fixture.invalid/create-checkout',{method:'POST',headers:{Origin:'https://kustivo.be','Content-Type':'application/json'},body:JSON.stringify(body)}));
    return{status:response.status,body:await response.json()};
  }};
}

let tests=0;
async function test(name,run){await run();tests++;console.log('OK',name);}
await test('no automatic first-order or repeat-order discount',async()=>{
  for(const completed of [0,1,2]){const app=application({completed});const r=await app.request({discountCode:''});assert.equal(r.status,200);assert.equal(r.body.discountCents,0);assert.equal(r.body.totalCents,2500);assert.equal(app.calls.history.length,0);}
});
await test('second order at exactly EUR 25 gets EUR 3; code case is normalized',async()=>{
  const app=application();const r=await app.request({discountCode:' kustivo3 ',discountCents:99999});assert.equal(r.status,200);assert.equal(r.body.discountCents,300);assert.equal(r.body.totalCents,2200);assert.equal(r.body.discountCode,'KUSTIVO3');assert.equal(app.calls.history[0].p_phone,'0490396181');assert.equal(app.calls.orders.length,0);
});
await test('below EUR 25 and other codes are rejected',async()=>{
  assert.equal((await application({price:2499}).request()).body.code,'discount_minimum');
  for(const discountCode of ['LEKKER20','WELCOME10','KUSTIVO1'])assert.equal((await application().request({discountCode})).body.code,'discount_invalid');
});
await test('first and third orders cannot use KUSTIVO3',async()=>{
  for(const completed of [0,2,4])assert.equal((await application({completed}).request()).body.code,'discount_second_order');
});
await test('used and pending coupons stay reserved',async()=>{
  for(const status of ['new','completed','pending_payment']){
    const app=application({active:{id:'pending',status,paymentMethod:'online',sessionId:'cs_test_fixture'}});assert.equal((await app.request()).body.code,'discount_used');assert.equal(app.calls.updates.length,0);
  }
});
await test('expired unpaid checkout releases the coupon',async()=>{
  const app=application({active:{id:'pending',status:'pending_payment',paymentMethod:'online',sessionId:'cs_test_fixture'},sessionStatus:'expired'});const r=await app.request();assert.equal(r.status,200);assert.equal(r.body.discountCents,300);assert.equal(app.calls.updates[0].data.status,'cancelled');assert.equal(app.calls.history.length,2);
});
await test('coupon checks fail closed if history cannot be read',async()=>{assert.equal((await application({historyError:true}).request()).status,500);});
const expected={subtotalCents:2500,discountCents:300,discountCode:'KUSTIVO3',deliveryFeeCents:0,totalCents:2200};
await test('cash checkout stores the fixed discount and correct total',async()=>{
  const app=application();const r=await app.request({quoteOnly:false,termsAccepted:true,expectedPrice:expected});assert.equal(r.status,200);assert(r.body.cashOrder);assert.equal(app.calls.orders[0].discount_code,'KUSTIVO3');assert.equal(app.calls.orders[0].discount_cents,300);assert.equal(app.calls.orders[0].total_cents,2200);assert.equal(app.calls.coupons.length,0);
});
await test('duplicate normalized phone records prefer the exact phone without overwriting unique phone keys',async()=>{
  const customers=[{id:'international',phone:'+32490396181'},{id:'local',phone:'0490396181'}];
  const app=application({customers,duplicatePhones:true,phone:'0490396181'});
  const r=await app.request({quoteOnly:false,termsAccepted:true,expectedPrice:expected});
  assert.equal(r.status,200);assert(r.body.cashOrder);assert.equal(app.calls.orders[0].customer_id,'local');
  const update=app.calls.updates.find(u=>u.table==='customers');assert.equal(update.filters.id,'local');assert.equal(update.data.phone_normalized,'0490396181');assert.equal(update.data.phone,undefined);
});
await test('a formatted returning phone reuses its customer without a unique-key collision',async()=>{
  const app=application({customers:[{id:'local',phone:'0490396181'}],duplicatePhones:true,phone:'+32 490 39 61 81'});
  const r=await app.request({quoteOnly:false,termsAccepted:true,expectedPrice:expected});
  assert.equal(r.status,200);assert.equal(app.calls.orders[0].customer_id,'local');assert.equal(app.calls.orders[0].customer_phone,'+32 490 39 61 81');assert.equal(app.calls.customerUpserts.length,0);
});
await test('a new or concurrently registered phone uses conflict-safe customer storage',async()=>{
  const app=application({customers:[]});const r=await app.request({quoteOnly:false,termsAccepted:true,expectedPrice:expected});
  assert.equal(r.status,200);assert.equal(app.calls.customerUpserts.length,1);assert.equal(app.calls.customerUpserts[0].phone_normalized,'0490396181');assert.equal(app.calls.orders.length,1);
});
await test('online checkout applies fixed EUR coupon and safe cancellation URL',async()=>{
  const app=application();const r=await app.request({quoteOnly:false,termsAccepted:true,paymentMethod:'online',expectedPrice:expected});assert.equal(r.status,200);assert.equal(app.calls.coupons[0].amount_off,300);assert.equal(app.calls.coupons[0].currency,'eur');assert.equal(app.calls.coupons[0].duration,'once');
  const session=app.calls.sessions[0];assert.equal(session.discounts[0].coupon,'coupon_fixture');assert.equal(session.line_items[0].price_data.unit_amount,2500);assert(session.cancel_url.includes('order_token=00000000-0000-4000-8000-000000000001'));assert(session.expires_at>=Clock.now()/1000+1800);assert(session.expires_at<=Clock.now()/1000+86400);assert.equal(session.metadata.discount_code,'KUSTIVO3');
});
await test('changed eligibility/price and duplicate submissions cannot proceed',async()=>{
  assert.equal((await application().request({quoteOnly:false,termsAccepted:true,expectedPrice:{...expected,totalCents:1}})).body.code,'price_changed');
  const app=application({race:true});const r=await app.request({quoteOnly:false,termsAccepted:true,paymentMethod:'online',expectedPrice:expected});assert.equal(r.status,409);assert.equal(r.body.code,'discount_used');assert.equal(app.calls.coupons.length,0);assert.equal(app.calls.items.length,0);
});
await test('failed item creation releases the new coupon reservation',async()=>{
  const app=application({itemError:true});assert.equal((await app.request({quoteOnly:false,termsAccepted:true,expectedPrice:expected})).status,500);assert(app.calls.updates.some(u=>u.table==='orders'&&u.data.status==='cancelled'));
});
await test('cancelling open payment expires it before releasing the reservation',async()=>{
  const app=application();assert.equal((await app.request({action:'cancel-discount-checkout',trackingToken:'00000000-0000-4000-8000-000000000001'})).status,200);assert.equal(app.calls.expired.length,1);assert(app.calls.updates.some(u=>u.table==='orders'&&u.data.status==='cancelled'));
  for(const options of [{orderPaymentStatus:'paid'},{session:{status:'complete',payment_status:'paid'}}]){
    const paid=application(options);await paid.request({action:'cancel-discount-checkout',trackingToken:'00000000-0000-4000-8000-000000000001'});assert.equal(paid.calls.expired.length,0);assert.equal(paid.calls.updates.length,0);
  }
});
await test('frontend preserves code and sends it for server-side quotation',async()=>{
  const html=fs.readFileSync(new URL('order/index.html',root),'utf8');const fields={name:'Fixture',phone:'0490396181',discountCode:' kustivo3 ',requestedSlot:'2026-11-07T10:30:00Z|'};
  class Form {get(k){return fields[k]??null;}has(k){return Boolean(fields[k]);}}
  const context=vm.createContext({FormData:Form,document:{getElementById:()=>({})},orderType:'pickup',paymentMethod:'online',cart:[],checkoutDraft:{}});
  vm.runInContext(html.split('\n').find(l=>l.startsWith('function captureCheckoutDraft('))+'\n'+html.split('\n').find(l=>l.startsWith('function payload(')),context);
  vm.runInContext('captureCheckoutDraft()',context);assert.equal(context.checkoutDraft.discountCode,' kustivo3 ');assert.equal(vm.runInContext('payload()',context).discountCode,'KUSTIVO3');assert(html.includes('name="discountCode"'));assert(html.includes('<label for="discountCodeInput">Kortingscode'));assert(!/10%|WELCOME10|[Ww]elkomstkorting/.test(html));
});
console.log(`${tests} coupon checkout checks passed; no live network requests or payments.`);
