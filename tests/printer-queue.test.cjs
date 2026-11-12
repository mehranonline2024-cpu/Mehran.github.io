const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../admin/index.html'),'utf8');
const queueCode=source.slice(source.indexOf('async function pollPrinterQueue('),source.indexOf('\nfunction renderDeliverySettings()'));
function client(job){return {from(){
  let conditions=[],patch=null;
  const query={select(){return query},eq(k,v){conditions.push(r=>r[k]===v);return query},gte(k,v){conditions.push(r=>r[k]>=v);return query},in(k,values){conditions.push(r=>values.includes(k==='orders.status'?r.order_status:r[k]));return query},order(){return query},limit(){return query},update(v){patch=v;return query},maybeSingle(){return run(true)},then(ok,bad){return run(false).then(ok,bad)}};
  async function run(single){let rows=conditions.every(f=>f(job))?[job]:[];if(patch)rows.forEach(r=>Object.assign(r,patch));return {data:single?(rows[0]?{...rows[0]}:null):rows.map(r=>({...r})),error:null};}
  return query;
}};}
function station(job,print){
  job.created_at??=new Date().toISOString();job.order_status??='accepted';
  const ctx=vm.createContext({sb:client(job),printerStationEnabled:true,printerPollBusy:false,printerRecoveryLastCheck:Date.now(),GTPrinter:{printReceipt:print},renderPrinterStation(){},setPrinterMessage(){},loadFailedPrinterJob:async()=>{},failedPrinterJob:null,document:{getElementById:()=>({classList:{add(){}}})},Date});
  ctx.backlogReads=0;ctx.stopPrinterStation=()=>{ctx.printerStationEnabled=false};ctx.loadPrinterBacklog=async()=>{ctx.backlogReads++};
  vm.runInContext(queueCode,ctx);return ctx;
}
(async()=>{
  const job={id:'test',status:'queued',attempts:0,payload:{order_number:'TEST'}};let printed=0,release;
  const wait=new Promise(r=>release=r),a=station(job,async()=>{printed++;await wait}),b=station(job,async()=>{printed++});
  const one=a.pollPrinterQueue(),two=b.pollPrinterQueue();
  await new Promise(setImmediate);
  assert.equal(job.status,'printing');assert.equal(printed,1,'two stations must not print the same queued job');
  release();await Promise.all([one,two]);assert.equal(job.status,'printed');assert.equal(job.attempts,1);
  await a.pollPrinterQueue();assert.equal(printed,1,'completed job must not print again');
  const failed={id:'failed',status:'queued',attempts:0,payload:{}};
  await station(failed,async()=>{throw Error('Printer unavailable')}).pollPrinterQueue();assert.equal(failed.status,'failed');
  const stale={id:'stale',status:'queued',attempts:0,payload:{}};
  await station(stale,async()=>{stale.attempts=2;stale.status='printing'}).pollPrinterQueue();
  assert.equal(stale.status,'printing','an old attempt cannot complete a newer print attempt');
  const old={id:'old',status:'queued',attempts:0,created_at:new Date(Date.now()-25*60*60*1000).toISOString(),payload:{}};
  let oldPrints=0;const guarded=station(old,async()=>oldPrints++);await guarded.pollPrinterQueue();
  assert.equal(old.status,'queued');assert.equal(oldPrints,0);assert.equal(guarded.printerStationEnabled,true);assert.equal(guarded.backlogReads,0);
  await guarded.pollPrinterQueue(true,'old');assert.equal(oldPrints,1,'a specifically requested reprint is still possible');
  const recent={id:'recent',status:'queued',attempts:0,created_at:new Date().toISOString(),payload:{}};
  let freshPrints=0;await station(recent,async()=>freshPrints++).pollPrinterQueue();assert.equal(freshPrints,1);assert.equal(recent.status,'printed');
  const completed={id:'completed',status:'queued',attempts:0,order_status:'completed',payload:{}};
  let latePrints=0;const active=station(completed,async()=>latePrints++);await active.pollPrinterQueue();assert.equal(latePrints,0);assert.equal(completed.status,'queued');
  await active.pollPrinterQueue(true,'completed');assert.equal(latePrints,1,'explicit reprints of completed orders still work');
  console.log('Printer queue concurrency, failure and attempt-isolation tests passed');
})().catch(e=>{console.error(e);process.exitCode=1});
