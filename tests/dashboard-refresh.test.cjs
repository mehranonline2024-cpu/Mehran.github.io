const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const html=fs.readFileSync(__dirname+'/../admin/index.html','utf8');
const helpers=html.slice(html.indexOf('const panelHtmlCache='),html.indexOf('let deliveryPaused='));
const render=html.split('\n').find(line=>line.startsWith('function render(){'));
const filterCode=html.slice(html.indexOf('function filterList()'),html.indexOf('function orderHtml('));

function setup(){
 const writes={},panels={},timers=new Map();let nextTimer=1,readCount=0,error=null,heldResolve=null,hold=false;
 for(const id of ['stats','filters','orders']){let value='';writes[id]=0;panels[id]={get innerHTML(){return value},set innerHTML(s){value=s;writes[id]++}};}
 const order={id:'order',status:'new',payment_method:'cash',payment_status:'unpaid',created_at:new Date().toISOString(),total_cents:2198};
 const context=vm.createContext({Date,Map,Set,orders:[],currentFilter:'active',loadInFlight:false,
  document:{getElementById:id=>panels[id]},euroCents:n=>String(n),
  orderHtml:o=>`<article>${o.id}:${o.status}</article>`,
  loadDeliverySettings(){},detectFresh(){return false},updateTabTitle(){},syncAlarmReminder(){},
  setTimeout(fn){const id=nextTimer++;timers.set(id,fn);return id},clearTimeout(id){timers.delete(id)},
  sb:{from(table){assert.equal(table,'orders');const q={select(fields){assert.match(fields,/order_items/);assert.ok(!fields.startsWith('*'));return q},or(value){assert.equal(value,'payment_method.neq.online,payment_status.in.(paid,refunded)');return q},order(){return q},limit(){return q},then(resolve,reject){readCount++;const result={data:[{...order}],error};if(hold){return new Promise(r=>heldResolve=()=>r(result)).then(resolve,reject)}return Promise.resolve(result).then(resolve,reject)}};return q}}
 });
 vm.runInContext(filterCode+'\n'+helpers+'\n'+render,context);
 return {context,writes,panels,timers,order,get readCount(){return readCount},setError(value){error=value},hold(){hold=true},release(){hold=false;heldResolve()}};
}

test('Unchanged polling preserves order buttons; status and filter changes still repaint',async()=>{
 const s=setup();await s.context.loadOrders();
 assert.deepEqual(s.writes,{stats:1,filters:1,orders:1});
 await s.context.loadOrders();assert.deepEqual(s.writes,{stats:1,filters:1,orders:1});
 s.order.status='accepted';await s.context.loadOrders();assert.equal(s.writes.orders,2);
 s.context.setFilter('history');assert.equal(s.writes.filters,2);assert.equal(s.writes.orders,3);
});

test('A load error can recover even when the restored orders have not changed',async()=>{
 const s=setup();await s.context.loadOrders();s.setError({message:'offline'});await s.context.loadOrders();
 assert.match(s.panels.orders.innerHTML,/Toegang geweigerd/);
 s.setError(null);await s.context.loadOrders();assert.match(s.panels.orders.innerHTML,/order:new/);
});

test('Realtime bursts are coalesced and an event received during loading gets a follow-up refresh',async()=>{
 const s=setup();for(let i=0;i<5;i++)s.context.scheduleOrdersRefresh();assert.equal(s.timers.size,1);
 s.timers.clear();s.hold();const pending=s.context.loadOrders();await Promise.resolve();await Promise.resolve();
 await s.context.loadOrders();assert.equal(s.readCount,1);s.release();await pending;assert.equal(s.timers.size,1);
 const timer=s.timers.values().next().value;s.timers.clear();timer();await new Promise(r=>setImmediate(r));
 assert.equal(s.readCount,2);
});
