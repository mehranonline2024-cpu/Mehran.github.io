(function(root){
  'use strict';
  const ids=new Set(['pizza-menu','duo-pizza-deal','family-deal']);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function isDeal(product){return ids.has(product?.id)}
  function sections(product){
    const keys=product.options||[];
    return [
      {kind:'pizza',icon:'🍕',nl:'Pizza’s',en:'Pizzas',keys:keys.filter(k=>/pizza/i.test(k))},
      {kind:'side',icon:'🍟',nl:'Sides',en:'Sides',keys:keys.filter(k=>/side/i.test(k))},
      {kind:'drink',icon:'🥤',nl:'Drankjes',en:'Drinks',keys:keys.filter(k=>/drink/i.test(k))}
    ].filter(s=>s.keys.length);
  }
  function render(product,groups,{text,translate,money}){
    const blocks=sections(product).map((section,index)=>{
      const fields=section.keys.map(key=>{
        const group=groups[key];if(!group)return '';
        const title=escape(section.kind==='side'&&section.keys.length===1?text('Kies side','Choose a side'):translate(group.title));
        const values=(group.values||[]).filter(v=>v.active!==false);
        const fieldId=`deal-${key}`;
        if(section.kind==='side')return `<fieldset class="deal-field deal-side-field" data-group="${escape(key)}"><legend>${title} *</legend><div class="deal-side-grid">${values.map(v=>`<label class="deal-side-choice"><input type="radio" name="${fieldId}" value="${escape(v.label)}" data-price="${Number(v.price_delta_cents||0)/100}"><span>${escape(translate(v.label))}${v.price_delta_cents?` <small>+ ${escape(money(v.price_delta_cents/100))}</small>`:''}</span></label>`).join('')}</div></fieldset>`;
        return `<div class="deal-field" data-group="${escape(key)}"><label for="${fieldId}">${title} *</label><select id="${fieldId}" class="deal-select" data-deal-select required><option value="">${escape(text('Maak je keuze…','Choose…'))}</option>${values.map(v=>`<option value="${escape(v.label)}" data-price="${Number(v.price_delta_cents||0)/100}">${escape(translate(v.label))}${v.price_delta_cents?` + ${escape(money(v.price_delta_cents/100))}`:''}</option>`).join('')}</select></div>`;
      }).join('');
      return `<section class="deal-section"><h4><span class="step-no">${index+1}</span> ${section.icon} ${escape(text(section.nl,section.en))}</h4><div class="deal-fields${section.kind==='side'?' deal-side-fields':''}">${fields}</div></section>`;
    }).join('');
    return `<div class="deal-intro">${escape(text('Kies alles op één scherm. Eventuele meerprijzen zie je meteen.','Choose everything on one screen. Any extra charges are shown immediately.'))}</div>${blocks}<details class="deal-allergens"><summary>${escape(text('Allergenen van jouw keuzes','Allergens for your choices'))}</summary><div id="dealAllergenChoices">${escape(text('Maak eerst je keuzes hierboven.','Make your choices above first.'))}</div></details>`;
  }
  function readSelections(area,groups){
    return [...area.querySelectorAll('[data-group]')].map(field=>{
      const key=field.dataset.group,group=groups[key];
      const picker=field.querySelector('select[data-deal-select]');
      const controls=picker?[...picker.selectedOptions].filter(option=>option.value):[...field.querySelectorAll('input:checked')];
      const chosen=controls.map(control=>{
        const value=group?.values.find(v=>v.label===control.value);
        return value?{raw:value.label,label:(group.display_prefix||'')+value.label,extra:Number(value.price_delta_cents||0)/100}:null;
      }).filter(Boolean);
      return {key,title:group?.title||key,chosen};
    });
  }
  function progress(product,selections,groups){
    const required=(product.options||[]).filter(key=>groups[key]?.required);
    const complete=required.filter(key=>selections.some(s=>s.key===key&&s.chosen.length===1)).length;
    return {complete,total:required.length,remaining:required.length-complete};
  }
  const api={isDeal,sections,render,readSelections,progress};
  root.GTDeals=api;
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
