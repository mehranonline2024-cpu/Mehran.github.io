(function(){
  'use strict';
  let rows=[],loaded=false,current=null;
  const panel=document.getElementById('allergenManager'),body=document.getElementById('allergenManagerBody');
  const fields='id,allergens_contains,allergens_may_contain,allergens_verified_at';
  const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function message(s){document.getElementById('allergenSaveStatus').textContent=s;}
  async function load(){
    body.innerHTML='<p>Gerechten en opties laden…</p>';
    try{
      const [p,v,g]=await Promise.all([sb.from('products').select(fields+',name,category').order('sort_order'),sb.from('option_values').select(fields+',label,group_id').order('sort_order'),sb.from('option_groups').select('id,title')]);
      if(p.error||v.error||g.error)throw new Error('Laden mislukt. Controleer je adminlogin en vernieuw de pagina.');
      const groupNames=Object.fromEntries((g.data||[]).map(x=>[x.id,x.title]));
      rows=[...(p.data||[]).map(x=>({...x,table:'products',title:x.category+' · '+x.name})),...(v.data||[]).map(x=>({...x,table:'option_values',title:'Optie · '+(groupNames[x.group_id]||x.group_id)+' · '+x.label}))];
      loaded=true;render();
    }catch(e){body.textContent=e.message;}
  }
  function render(){
    body.innerHTML=`<p>Controleer receptuur én leveranciersetiketten, inclusief sauzen en mogelijke sporen. Er worden geen allergenen uit namen of foto's afgeleid. Graan- en notensoorten staan afzonderlijk. Bij een gewijzigde receptuur moet je dit opnieuw controleren.</p><p id="allergenProgress"></p><label for="allergenItem">Gerecht of optie</label><select id="allergenItem" style="width:100%;padding:12px;margin:8px 0;background:#202020;color:white;border:1px solid #555;border-radius:8px">${rows.map((r,i)=>`<option value="${i}">${escape(r.title)}</option>`).join('')}</select><div id="allergenEditor"></div><p id="allergenSaveStatus" role="status"></p>`;
    document.getElementById('allergenItem').onchange=e=>edit(Number(e.target.value));
    edit(0);progress();
  }
  function progress(){document.getElementById('allergenProgress').textContent=`${rows.filter(GTAllergens.verified).length} van ${rows.length} gerechten en opties gecontroleerd.`;}
  function edit(i){
    current=i;const row=rows[i];if(!row)return;
    const boxes=(key,title)=>`<fieldset style="border:1px solid #555;margin:12px 0;padding:12px"><legend>${title}</legend><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:10px">${GTAllergens.entries.map(([code,label])=>`<label><input type="checkbox" name="${key}" value="${code}" ${(row[key]||[]).includes(code)?'checked':''}> ${escape(label)}</label>`).join('')}</div></fieldset>`;
    document.getElementById('allergenEditor').innerHTML=`<form id="allergenForm">${boxes('allergens_contains','Bevat (ingrediënten)')}${boxes('allergens_may_contain','Kan bevatten (etiket / vastgesteld kruiscontact)')}<label style="display:block;margin:15px 0"><input id="allergenVerified" type="checkbox" ${GTAllergens.verified(row)?'checked':''}> Ik heb de volledige receptuur en actuele etiketten gecontroleerd. Deze informatie mag gepubliceerd worden.</label><p>Vink de bevestiging uit om dit weer als “Nog niet gecontroleerd” te tonen. Een lege lijst is geen garantie dat een gerecht allergievrij is.</p><button class="btn gold" type="submit">Allergenen opslaan</button></form>`;
    document.getElementById('allergenForm').onsubmit=save;message('');
  }
  async function save(e){
    e.preventDefault();const row=rows[current],form=e.target,btn=e.submitter;btn.disabled=true;message('Opslaan…');
    const selected=key=>Array.from(form.querySelectorAll(`input[name="${key}"]:checked`)).map(x=>x.value);
    const update={allergens_contains:selected('allergens_contains'),allergens_may_contain:selected('allergens_may_contain'),allergens_verified_at:document.getElementById('allergenVerified').checked?new Date().toISOString():null};
    try{
      let q=sb.from(row.table).update(update).eq('id',row.id);
      q=row.allergens_verified_at?q.eq('allergens_verified_at',row.allergens_verified_at):q.is('allergens_verified_at',null);
      const {data,error}=await q.select(fields).maybeSingle();
      if(error||!data)throw new Error('Niet opgeslagen. Mogelijk is dit artikel elders gewijzigd of je login verlopen. Vernieuw de pagina.');
      Object.assign(row,data);progress();message(data.allergens_verified_at?'Opgeslagen. Deze informatie staat nu op de website.':'Opgeslagen als nog niet gecontroleerd; de website toont geen definitieve lijst.');
    }catch(err){message(err.message);}finally{btn.disabled=false;}
  }
  panel.addEventListener('toggle',()=>{if(panel.open&&!loaded)void load();});
})();
