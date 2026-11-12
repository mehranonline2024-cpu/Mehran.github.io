const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const html=fs.readFileSync(__dirname+'/../admin/index.html','utf8');
const code=html.slice(html.indexOf('function filterList()'),html.indexOf('function orderHtml('));
function setup(error=null,race=false){
 const rows=[
  {id:'finished',status:'completed',payment_method:'cash',payment_status:'paid',total_cents:1200},
  {id:'active',status:'accepted',payment_method:'cash',payment_status:'unpaid'},
  {id:'refund',status:'rejected',payment_method:'online',payment_status:'paid'},
  {id:'unpaid',status:'completed',payment_method:'online',payment_status:'unpaid'},
 ];
 let calls=0,patch,ids,statuses;
 const message={textContent:''},ctx=vm.createContext({orders:rows,currentFilter:'history',Date,Map,confirm:()=>true,
  document:{getElementById:()=>message},loadOrders:async()=>{},
  sb:{from(table){assert.equal(table,'orders');calls++;const q={update(value){patch=value;return q},in(key,value){if(key==='id')ids=value;else if(key==='status')statuses=value;else assert.fail(key);return q},select(){return Promise.resolve({data:race?[]:rows.filter(r=>ids.includes(r.id)&&statuses.includes(r.status)).map(r=>({id:r.id,...patch})),error})}};return q}}
 });
 vm.runInContext(code+'\nrender=()=>{};',ctx);
 return {ctx,rows,message,get calls(){return calls}};
}
test('History hiding persists on the server, restores and preserves order amounts',async()=>{
 const s=setup();await s.ctx.setOrderHidden('finished',true);
 assert.equal(s.calls,1);assert.equal(s.ctx.ordersForFilter('history',s.ctx.orders).some(o=>o.id==='finished'),false);
 assert.equal(s.ctx.ordersForFilter('history',s.ctx.orders,true).some(o=>o.id==='finished'),true);
 assert.equal(s.ctx.orders.find(o=>o.id==='finished').total_cents,1200);
 await s.ctx.setOrderHidden('finished',false);
 assert.equal(s.ctx.ordersForFilter('history',s.ctx.orders).some(o=>o.id==='finished'),true);
 assert.match(s.message.textContent,/teruggezet/);
});
test('Active orders and pending online refunds cannot be hidden',async()=>{
 const s=setup();await s.ctx.setOrderHidden('active',true);await s.ctx.setOrderHidden('refund',true);assert.equal(s.calls,0);
 assert.equal(s.ctx.ordersForFilter('preparing',s.rows).length,1);
});
test('Failed writes and concurrent status changes keep the history visible',async()=>{
 for(const s of [setup({message:'Log opnieuw in'}),setup(null,true)]){
  await s.ctx.setOrderHidden('finished',true);
  assert.equal(s.ctx.ordersForFilter('history',s.ctx.orders).some(o=>o.id==='finished'),true);
  assert.ok(s.message.textContent);
 }
});
