const {test}=require('node:test');
const assert=require('node:assert/strict');
const deals=require('../order/deals.js');
const sideValues=[{label:'Kleine friet',price_delta_cents:0},{label:'4 nuggets',price_delta_cents:0},{label:'1 frikandel',price_delta_cents:0},{label:'3 chicken wings',price_delta_cents:0}];
const pizzas=[{label:'Margherita',price_delta_cents:0},{label:'Scampi',price_delta_cents:200}];
const groups={};
for(const key of ['familyPizza1','familyPizza2','familyPizza3'])groups[key]={title:key,required:true,values:pizzas};
for(const key of ['dealSide1','dealSide2'])groups[key]={title:key,required:true,values:sideValues};
for(const key of ['dealDrink1','dealDrink2','dealDrink3'])groups[key]={title:key,required:true,values:[{label:'Coca-Cola',price_delta_cents:0}]};
const family={id:'family-deal',options:Object.keys(groups)};
const format={text:(nl,en)=>en,translate:value=>value==='Kleine friet'?'Small fries':value,money:value=>'€'+value.toFixed(2)};

test('Family has six compact selectors and two independent four-side choices, without preselected paid extras',()=>{
  const html=deals.render(family,groups,format);
  assert.equal((html.match(/data-deal-select/g)||[]).length,6);
  assert.equal((html.match(/type="radio"/g)||[]).length,8);
  assert.equal((html.match(/value=""/g)||[]).length,6);
  assert.ok(!html.includes(' checked')&&!html.includes(' selected'));
  assert.match(html,/Scampi \+ €2\.00/);
  assert.match(html,/value="Kleine friet"[^>]*><span>Small fries/);
});

function field(key,value,select=false){
  const control={value,dataset:{price:'999'}};
  return {dataset:{group:key},querySelector:()=>select?{selectedOptions:value?[control]:[]}:null,querySelectorAll:()=>value?[control]:[]};
}
test('Native dropdowns and side radios serialize the original labels and catalog prices, including repeated sides',()=>{
  const fields=family.options.map(key=>field(key,key.includes('Pizza')?'Scampi':key.includes('Side')?'4 nuggets':'Coca-Cola',!key.includes('Side')));
  const selections=deals.readSelections({querySelectorAll:()=>fields},groups);
  assert.equal(selections.length,8);
  assert.equal(selections.filter(s=>s.key.includes('Side')).length,2);
  assert.ok(selections.filter(s=>s.key.includes('Side')).every(s=>s.chosen[0].raw==='4 nuggets'));
  assert.equal(selections.flatMap(s=>s.chosen).reduce((sum,c)=>sum+c.extra,0),6);
  assert.equal(deals.progress(family,selections,groups).remaining,0);
  selections.find(s=>s.key==='familyPizza3').chosen=[];
  assert.equal(deals.progress(family,selections,groups).remaining,1);
});

test('An empty or unavailable dropdown choice cannot count as a completed required selection',()=>{
  const selections=deals.readSelections({querySelectorAll:()=>[field('familyPizza1','',true),field('familyPizza2','Unknown',true)]},groups);
  assert.ok(selections.every(s=>s.chosen.length===0));
  assert.equal(deals.progress(family,selections,groups).remaining,8);
});

test('Catalog labels are escaped in both visible text and option values',()=>{
  const product={id:'pizza-menu',options:['dealPizza']};
  const html=deals.render(product,{dealPizza:{title:'Pizza',values:[{label:'<img src=x onerror=alert(1)>',price_delta_cents:0}]}},format);
  assert.ok(!html.includes('<img'));
  assert.match(html,/&lt;img/);
});
