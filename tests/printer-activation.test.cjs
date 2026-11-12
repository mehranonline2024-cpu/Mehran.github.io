const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {test}=require('node:test');
const html=fs.readFileSync(__dirname+'/../admin/index.html','utf8');
const code=html.slice(html.indexOf('async function printPrinterTest('),html.indexOf('let printerRecoveryLastCheck='));
function station({confirmed=true,oldJobs=false,checkError=false,printError=false}={}){
 let starts=0,polls=0,message='';const saved={};
 const c=vm.createContext({printerStationEnabled:false,printerTestPassed:false,printerPollBusy:false,printerBacklogJobs:[],printerBacklogLoaded:false,
  confirm:()=>confirmed,localStorage:{setItem:(key,value)=>saved[key]=value},renderPrinterStation(){},setPrinterMessage:s=>message=s,
  GTPrinter:{printTestReceipt:async()=>{if(printError)throw Error('Printer unavailable')}},
  loadPrinterBacklog:async()=>{c.printerBacklogLoaded=!checkError;c.printerBacklogJobs=oldJobs?[{id:'old'}]:[]},
  stopPrinterStation:()=>c.printerStationEnabled=false,startPrinterStation:()=>starts++,pollPrinterQueue:async()=>polls++
 });vm.runInContext(code,c);return{c,saved,get starts(){return starts},get polls(){return polls},get message(){return message}};
}
test('A physically confirmed test starts the printstation and polls without a second Start click',async()=>{
 const s=station();await s.c.printPrinterTest();assert.equal(s.c.printerStationEnabled,true);assert.equal(s.saved['gt-kitchen-printer-enabled'],'true');assert.equal(s.starts,1);assert.equal(s.polls,1);assert.equal(s.c.printerPollBusy,false);
});
test('Unconfirmed, failed or unchecked printer tests never start automatic printing',async()=>{
 for(const options of [{confirmed:false},{oldJobs:true},{checkError:true},{printError:true}]){const s=station(options);await s.c.printPrinterTest();assert.equal(s.starts,0);assert.equal(s.polls,0);assert.equal(s.c.printerStationEnabled,false);assert.ok(s.message);}
});
