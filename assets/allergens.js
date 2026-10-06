(function(root){
  'use strict';
  const entries=[
    ['wheat','Tarwe (gluten)','Wheat (gluten)'],['rye','Rogge (gluten)','Rye (gluten)'],['barley','Gerst (gluten)','Barley (gluten)'],['oats','Haver (gluten)','Oats (gluten)'],['spelt','Spelt (gluten)','Spelt (gluten)'],['khorasan','Khorasantarwe (gluten)','Khorasan wheat (gluten)'],
    ['crustaceans','Schaaldieren','Crustaceans'],['eggs','Eieren','Eggs'],['fish','Vis','Fish'],['peanuts',"Pinda’s",'Peanuts'],['soy','Soja','Soy'],['milk','Melk (incl. lactose)','Milk (including lactose)'],
    ['almonds','Amandelen','Almonds'],['hazelnuts','Hazelnoten','Hazelnuts'],['walnuts','Walnoten','Walnuts'],['cashews','Cashewnoten','Cashews'],['pecans','Pecannoten','Pecans'],['brazil_nuts','Paranoten','Brazil nuts'],['pistachios','Pistachenoten','Pistachios'],['macadamia','Macadamianoten','Macadamia nuts'],
    ['celery','Selderij','Celery'],['mustard','Mosterd','Mustard'],['sesame','Sesam','Sesame'],['sulphites','Zwaveldioxide en sulfieten','Sulphur dioxide and sulphites'],['lupin','Lupine','Lupin'],['molluscs','Weekdieren','Molluscs']
  ];
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const keys=new Set(entries.map(x=>x[0]));
  function verified(row){return !!row?.allergens_verified_at&&Array.isArray(row.allergens_contains)&&Array.isArray(row.allergens_may_contain)&&[...row.allergens_contains,...row.allergens_may_contain].every(x=>keys.has(x));}
  function describe(row,lang='nl'){
    const en=lang==='en';
    if(!verified(row))return en?'Not yet verified. Contact us before ordering if you have an allergy.':'Nog niet gecontroleerd. Heb je een allergie? Neem vóór je bestelt contact met ons op.';
    const names=a=>a.map(k=>entries.find(e=>e[0]===k)[en?2:1]).join(', ');
    const contains=row.allergens_contains.length?(en?'Contains: ':'Bevat: ')+names(row.allergens_contains):(en?'None of the 14 regulated allergens reported as an ingredient.':'Geen van de 14 wettelijke allergenen als ingrediënt opgegeven.');
    return contains+(row.allergens_may_contain.length?(en?'. May contain: ':'. Kan bevatten: ')+names(row.allergens_may_contain):'');
  }
  function html(row,lang='nl',compact=false){
    const en=lang==='en';
    const data={allergens_contains:row?.allergens_contains,allergens_may_contain:row?.allergens_may_contain,allergens_verified_at:row?.allergens_verified_at};
    const text=compact&&!verified(row)?(en?'Not yet verified':'Nog niet gecontroleerd'):describe(row,lang);
    return `<span class="gt-allergen-text" data-gt-allergen="${esc(JSON.stringify(data))}" data-compact="${compact}" style="display:block;font-size:12px;line-height:1.5;margin-top:7px"><strong>${en?'Allergens':'Allergenen'}:</strong> ${esc(text)}${compact?'':` <a href="/order/allergenen.html" target="_blank" rel="noopener" style="color:#ffd177">${en?'Information & contact':'Informatie & contact'}</a>`}</span>`;
  }
  function refresh(){const lang=root.document?.documentElement.lang==='en'?'en':'nl';root.document?.querySelectorAll('[data-gt-allergen]').forEach(el=>{try{const row=JSON.parse(el.dataset.gtAllergen),compact=el.dataset.compact==='true';const text=compact&&!verified(row)?(lang==='en'?'Not yet verified':'Nog niet gecontroleerd'):describe(row,lang);el.innerHTML=`<strong>${lang==='en'?'Allergens':'Allergenen'}:</strong> ${esc(text)}${compact?'':` <a href="/order/allergenen.html" target="_blank" rel="noopener" style="color:#ffd177">${lang==='en'?'Information & contact':'Informatie & contact'}</a>`}`;}catch(_){}});}
  const api={entries,verified,describe,html};root.GTAllergens=api;
  root.addEventListener?.('gt-language-change',refresh);
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
})(typeof window!=='undefined'?window:globalThis);
