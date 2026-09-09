const CFG = { url: 'https://qpaycwrhohunpfjqmlga.supabase.co', key: 'sb_publishable_lEAgOU350gcdQdI_zYVDAQ_6p7uNeYM' }
const H = { apikey: CFG.key, 'Content-Type': 'application/json' }
const CAT_ORDER = ['Online Deals', 'Pizza', 'Grill Time Classics', 'Sides', 'Drinks']
const CAT_META = {
  'Online Deals': ['🔥', 'Online Deals'], Pizza: ['🍕', 'Pizza'],
  'Grill Time Classics': ['🌯', 'Grill Time Classics'], Sides: ['🍟', 'Sides'], Drinks: ['🥤', 'Drinks'],
}
const DELIVERY_MIN = 15
let products = [], groups = {}, links = {}, ingredients = {}, productDeps = {}, optionDeps = {}
let cart = JSON.parse(localStorage.getItem('gt-cart-v4') || '[]')
let selected = null, currentQty = 1, activeCategory = 'Alles', orderType = 'pickup', paymentMethod = 'online'
let checkoutDraft = {}, storeConfig = null, selectedAddress = null, addressSuggestions = [], deliveryQuote = null
let addressTimer = null, trackingTimer = null
let checkoutRequestIdentity = null
const CHECKOUT_REQUEST_KEY = 'gt-checkout-request-v2'

const euro = n => new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' }).format(Number(n || 0))
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]))
const toast = m => { const t = document.getElementById('toast'); t.textContent = m; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2600) }
function toggle(id, on) { document.getElementById(id).classList.toggle('open', on) }
function save() { localStorage.setItem('gt-cart-v4', JSON.stringify(cart)); renderCartBar() }
function newRequestId() {
  if (crypto.randomUUID) return crypto.randomUUID()
  const bytes = crypto.getRandomValues(new Uint8Array(16)); bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(x => x.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
function requestIdFor(orderPayload) {
  const fingerprint = JSON.stringify(orderPayload)
  try { checkoutRequestIdentity = JSON.parse(sessionStorage.getItem(CHECKOUT_REQUEST_KEY) || 'null') } catch (_) { checkoutRequestIdentity = null }
  if (!checkoutRequestIdentity || checkoutRequestIdentity.fingerprint !== fingerprint || !/^[0-9a-f-]{36}$/i.test(checkoutRequestIdentity.id || '')) {
    checkoutRequestIdentity = { id: newRequestId(), fingerprint }
    try { sessionStorage.setItem(CHECKOUT_REQUEST_KEY, JSON.stringify(checkoutRequestIdentity)) } catch (_) {}
  }
  return checkoutRequestIdentity.id
}
function clearRequestId() {
  checkoutRequestIdentity = null
  try { sessionStorage.removeItem(CHECKOUT_REQUEST_KEY) } catch (_) {}
}
async function get(path) {
  const r = await fetch(CFG.url + path, { headers: H })
  const b = await r.json()
  if (!r.ok) throw new Error(b?.message || b?.error || `HTTP ${r.status}`)
  return b
}
function todayBrussels() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
function statusUnavailable(row) {
  if (!row || row.active === false || row.availability_status === 'hidden') return true
  return row.availability_status === 'sold_out_today' && (!row.sold_out_on || String(row.sold_out_on) >= todayBrussels())
}
function ingredientUnavailable(code) { return statusUnavailable(ingredients[code]) }
function productUnavailable(product) { return statusUnavailable(product) || (productDeps[product.id] || []).some(ingredientUnavailable) }
function optionUnavailable(option) { return statusUnavailable(option) || (optionDeps[Number(option.id)] || []).some(ingredientUnavailable) }
function imageFor(p) {
  let x = p.image_path || ''
  if (!x) return ''
  if (x.startsWith('../assets/images/')) x = '../' + x.split('/').pop()
  return x
}
function visualFor(p) {
  if (p.category === 'Online Deals') return ['🔥', 'Voordeel voor online bestellers']
  if (p.category === 'Pizza') return [p.id === 'build-your-own-pizza' ? '👨‍🍳' : '🍕', p.id === 'build-your-own-pizza' ? 'Maak jouw favoriet' : 'Vers bereid']
  if (p.category === 'Grill Time Classics') return [p.id === 'kapsalon' ? '🥙' : '🌯', 'Grill Time favoriet']
  if (p.category === 'Sides') return ['🍟', 'Lekker erbij']
  if (p.category === 'Drinks') return ['🥤', 'Koud geserveerd']
  return ['🍽️', 'Grill Time']
}

async function loadMenu() {
  try {
    const [ps, ls, gs, vs, ins, pds, ods, cfg] = await Promise.all([
      get('/rest/v1/products?select=id,category,name,description,price_cents,image_path,active,availability_status,sold_out_on,sort_order&active=eq.true&order=sort_order.asc'),
      get('/rest/v1/product_option_groups?select=product_id,group_id,sort_order&order=sort_order.asc'),
      get('/rest/v1/option_groups?select=id,title,subtitle,input_type,required,max_select,display_prefix,sort_order&order=sort_order.asc'),
      get('/rest/v1/option_values?select=id,group_id,label,price_delta_cents,active,availability_status,sold_out_on,sort_order&active=eq.true&order=sort_order.asc'),
      get('/rest/v1/ingredients?select=code,label,availability_status,sold_out_on&order=sort_order.asc'),
      get('/rest/v1/product_ingredient_dependencies?select=product_id,ingredient_code'),
      get('/rest/v1/option_value_ingredient_dependencies?select=option_value_id,ingredient_code'),
      get('/functions/v1/storefront-v2?action=config'),
    ])
    ingredients = Object.fromEntries(ins.map(i => [i.code, i]))
    productDeps = {}; pds.forEach(d => (productDeps[d.product_id] ??= []).push(d.ingredient_code))
    optionDeps = {}; ods.forEach(d => (optionDeps[Number(d.option_value_id)] ??= []).push(d.ingredient_code))
    const valuesBy = {}; vs.forEach(v => (valuesBy[v.group_id] ??= []).push(v))
    groups = {}; gs.forEach(g => groups[g.id] = { ...g, values: valuesBy[g.id] || [] })
    links = {}; ls.forEach(l => (links[l.product_id] ??= []).push(l.group_id))
    products = ps.map(p => ({ ...p, price: p.price_cents / 100, image: imageFor(p), options: links[p.id] || [] }))
    storeConfig = cfg
    const valid = new Set(products.filter(p => !productUnavailable(p)).map(p => p.id))
    cart = cart.filter(l => valid.has(l.productId))
    save()
    document.getElementById('status').textContent = cfg.storeTemporarilyClosed ? '● Tijdelijk gesloten · vooruitbestellen kan' : '● Online · dagelijks 12:00–23:00'
    renderCategories(); renderMenu()
  } catch (e) {
    console.error(e)
    document.getElementById('status').textContent = '● Fout'
    document.getElementById('menu').innerHTML = '<div class="empty">Menu kon niet geladen worden. Vernieuw de pagina.</div>'
  }
}
function renderCategories() {
  const present = new Set(products.map(p => p.category))
  const cats = ['Alles', ...CAT_ORDER.filter(c => present.has(c))]
  document.getElementById('categories').innerHTML = cats.map(c => `<button class="cat ${c === activeCategory ? 'active' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('')
  document.querySelectorAll('.cat').forEach(b => b.onclick = () => { activeCategory = b.dataset.cat; renderCategories(); renderMenu() })
}
function renderMenu() {
  const q = document.getElementById('search').value.trim().toLowerCase()
  const list = products.filter(p => (activeCategory === 'Alles' || p.category === activeCategory) && (!q || `${p.name} ${p.description || ''} ${p.category}`.toLowerCase().includes(q)))
  if (!list.length) { document.getElementById('menu').innerHTML = '<div class="empty">Geen gerechten gevonden.</div>'; return }
  const cats = CAT_ORDER.filter(c => list.some(p => p.category === c))
  document.getElementById('menu').innerHTML = cats.map(c => {
    const ps = list.filter(p => p.category === c), m = CAT_META[c] || ['•', c]
    return `<section><div class="section-title"><div class="section-name"><span class="section-icon">${m[0]}</span><h3>${esc(m[1])}</h3></div><span>${ps.length} keuzes</span></div><div class="grid">${ps.map(card).join('')}</div></section>`
  }).join('')
  document.querySelectorAll('[data-product]').forEach(b => b.onclick = () => openProduct(b.dataset.product))
}
function card(p) {
  const deal = p.category === 'Online Deals', bestseller = ['loaded-doner-pizza', 'scampi-pizza'].includes(p.id), custom = p.id === 'build-your-own-pizza'
  const fitImage = ['margherita', 'family-deal', 'pizza-menu', 'build-your-own-pizza'].includes(p.id), unavailable = productUnavailable(p), v = visualFor(p)
  const visual = p.image ? `<img class="photo${fitImage ? ' photo-contain' : ''}" src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy">` : `<div class="product-visual"><span class="visual-emoji">${v[0]}</span><span class="visual-label">${esc(v[1])}</span></div>`
  const tag = unavailable ? '<span class="sold-label">Vandaag tijdelijk uitverkocht</span>' : deal ? '<span class="deal-tag">ONLINE DEAL</span>' : bestseller ? '<span class="best">⭐ Bestseller</span>' : custom ? '<span class="custom-tag">✨ Zelf samenstellen</span>' : ''
  const button = unavailable ? 'Uitverkocht' : p.options.length ? 'Kies opties' : 'Toevoegen'
  return `<article class="card ${deal ? 'deal-card' : ''} ${unavailable ? 'sold-out' : ''}">${visual}<div class="card-body"><div class="meta-row"><span class="category-mini">${esc(p.category)}</span>${tag}</div><h4>${esc(p.name)}</h4><p class="desc">${unavailable ? 'Vandaag tijdelijk uitverkocht.' : esc(p.description || '')}</p><div class="card-bottom"><div>${deal ? '<span class="from">Vanaf</span>' : ''}<span class="price">${euro(p.price)}</span></div><button class="add ${unavailable ? 'sold' : ''}" ${unavailable ? 'disabled' : ''} data-product="${esc(p.id)}">${button}</button></div></div></article>`
}
function renderOption(key, idx) {
  const g = groups[key]
  if (!g) return ''
  const type = g.input_type === 'radio' ? 'radio' : 'checkbox'
  const hint = g.subtitle || (!g.required && g.max_select ? `Kies maximaal ${g.max_select}.` : '')
  return `<div class="option-group" data-group="${esc(key)}"><h4>${esc(g.title)} ${g.required ? '<span style="color:#ffb0b0">*</span>' : ''}</h4>${hint ? `<div class="details">${esc(hint)}</div>` : ''}<div class="option-list">${g.values.map(v => { const off = optionUnavailable(v); return `<div class="choice ${off ? 'unavailable' : ''}"><label><input type="${type}" name="o-${idx}-${esc(key)}" value="${esc(v.label)}" data-price="${Number(v.price_delta_cents || 0) / 100}" ${off ? 'disabled' : ''}><span>${esc(g.display_prefix || '')}${esc(v.label)}${off ? ' · tijdelijk uitverkocht' : ''}</span></label><span>${v.price_delta_cents ? `+ ${euro(v.price_delta_cents / 100)}` : ''}</span></div>` }).join('')}</div></div>`
}
function openProduct(id) {
  selected = products.find(p => p.id === id); currentQty = 1
  if (!selected) return
  if (productUnavailable(selected)) { toast('Vandaag tijdelijk uitverkocht.'); return }
  document.getElementById('productSheet').innerHTML = `<div class="sheet-head"><div><div class="category-mini" style="margin-bottom:5px">${esc(selected.category)}</div><h3>${esc(selected.name)}</h3><div class="price" id="modalPrice">${euro(selected.price)}</div></div><button class="close" onclick="toggle('productOverlay',false)">×</button></div><p class="details">${esc(selected.description || '')}</p><div id="optionArea">${selected.options.map((k, i) => renderOption(k, i)).join('')}</div><div class="item-note"><label>Opmerking voor dit gerecht <span style="color:#81786d;font-weight:500">(optioneel)</span></label><textarea id="itemNote" maxlength="150" placeholder="Bijv. saus apart, goed gebakken…"></textarea><small>Maximaal 150 tekens.</small></div><div class="qtyrow"><strong>Aantal</strong><div class="stepper"><button type="button" onclick="qty(-1)">−</button><strong id="qty">1</strong><button type="button" onclick="qty(1)">+</button></div></div><button id="addSelected" class="primary" onclick="addSelected()">Toevoegen · ${euro(selected.price)}</button>`
  document.querySelectorAll('#optionArea input').forEach(i => i.onchange = () => { enforceMax(i); updateModalPrice() })
  toggle('productOverlay', true)
}
function enforceMax(input) { const w = input.closest('[data-group]'), g = groups[w?.dataset.group]; if (!g?.max_select || !input.checked) return; const checked = [...w.querySelectorAll('input:checked')]; if (checked.length > g.max_select) { input.checked = false; toast(`Maximaal ${g.max_select} kiezen`) } }
function currentSelections() { const out = []; document.querySelectorAll('#optionArea [data-group]').forEach(w => { const key = w.dataset.group, g = groups[key], chosen = [...w.querySelectorAll('input:checked')].map(i => ({ raw: i.value, label: (g.display_prefix || '') + i.value, extra: Number(i.dataset.price || 0) })); out.push({ key, title: g.title, chosen }) }); return out }
function extra() { return currentSelections().flatMap(g => g.chosen).reduce((s, x) => s + x.extra, 0) }
function qty(d) { currentQty = Math.max(1, currentQty + d); document.getElementById('qty').textContent = currentQty; updateModalPrice() }
function updateModalPrice() { const v = (selected.price + extra()) * currentQty; document.getElementById('modalPrice').textContent = euro(v); document.getElementById('addSelected').textContent = `Toevoegen · ${euro(v)}` }
function addSelected() {
  const sels = currentSelections()
  for (const key of selected.options) { const g = groups[key]; if (g?.required && !sels.find(x => x.key === key)?.chosen.length) { toast(`Kies eerst: ${g.title}`); return } }
  const itemNote = String(document.getElementById('itemNote')?.value || '').trim().slice(0, 150)
  cart.push({ lineId: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, productId: selected.id, name: selected.name, qty: currentQty, selections: sels, itemNote, unitPrice: selected.price + extra() })
  save(); toggle('productOverlay', false); toast(`${selected.name} toegevoegd`)
}
function cartTotal() { return cart.reduce((s, l) => s + l.unitPrice * l.qty, 0) }
function renderCartBar() { const count = cart.reduce((s, l) => s + l.qty, 0); document.getElementById('cartCount').textContent = count; document.getElementById('cartTotal').textContent = euro(cartTotal()) }
function lineDetails(l) { const parts = l.selections.filter(g => g.chosen.length).map(g => `${esc(g.title)}: ${g.chosen.map(x => esc(x.label)).join(', ')}`); if (l.itemNote) parts.push(`<strong>Opmerking:</strong> ${esc(l.itemNote)}`); return parts.join('<br>') || 'Standaard' }
function openCart() {
  const s = document.getElementById('cartSheet')
  if (!cart.length) { s.innerHTML = `<div class="sheet-head"><div><h3>Winkelmandje</h3><div class="details">Nog niets gekozen</div></div><button class="close" onclick="toggle('cartOverlay',false)">×</button></div><div class="empty">Je winkelmandje is nog leeg.<br><small>Kies iets lekkers uit het menu.</small></div>`; toggle('cartOverlay', true); return }
  s.innerHTML = `<div class="sheet-head"><div><h3>Winkelmandje</h3><div class="details">Controleer je bestelling</div></div><button class="close" onclick="toggle('cartOverlay',false)">×</button></div>${cart.map((l, i) => `<div class="cart-item"><div class="cart-item-top"><div><strong>${l.qty}× ${esc(l.name)}</strong><div class="details" style="margin-top:4px">${lineDetails(l)}</div></div><strong>${euro(l.qty * l.unitPrice)}</strong></div><div class="cart-actions"><button class="remove" onclick="removeLine(${i})">Verwijderen</button><div class="mini-step"><button onclick="lineQty(${i},-1)">−</button><strong>${l.qty}</strong><button onclick="lineQty(${i},1)">+</button></div></div></div>`).join('')}<div class="grand"><span>Subtotaal eten</span><span>${euro(cartTotal())}</span></div><div class="estimate">Geschatte bezorgtijd: 25–45 minuten.</div><div class="discount-chip">🎁 Eerste betaalde bestelling? 10% korting automatisch</div><div class="notice warning"><strong>🛵 Bezorging in Oostende</strong><br>Minimum €15 aan eten · €2,99 t/m 2,5 km · €3,99 boven 2,5 t/m 4 km · echte rijafstand.</div><button class="primary" onclick="openCheckout()">Verder naar afhalen of bezorgen →</button>`
  toggle('cartOverlay', true)
}
function removeLine(i) { cart.splice(i, 1); save(); openCart() }
function lineQty(i, d) { cart[i].qty += d; if (cart[i].qty <= 0) cart.splice(i, 1); save(); openCart() }
function openCheckout() { toggle('cartOverlay', false); renderCheckout(); toggle('checkoutOverlay', true) }

function captureCheckoutDraft() {
  const form = document.getElementById('checkoutForm'); if (!form) return
  const f = new FormData(form)
  checkoutDraft = {
    firstName: String(f.get('firstName') || ''), phone: String(f.get('phone') || ''),
    addressSearch: String(f.get('addressSearch') || ''), addressExtra: String(f.get('addressExtra') || ''),
    requestedChoice: String(f.get('requestedChoice') || ''), email: String(f.get('email') || ''), notes: String(f.get('notes') || ''),
    termsAccepted: f.get('termsAccepted') === 'on', marketingConsent: f.get('marketingConsent') === 'on',
  }
}
function draftValue(k) { return esc(checkoutDraft[k] || '') }
function setType(t) { captureCheckoutDraft(); orderType = t; if (orderType === 'delivery' && paymentMethod === 'terminal') paymentMethod = 'online'; renderCheckout() }
function setPaymentMethod(m) { captureCheckoutDraft(); paymentMethod = m; renderCheckout() }
function deliveryInfo() {
  const subtotal = cartTotal()
  if (orderType !== 'delivery') return '<div class="notice"><strong>🛍️ Afhalen</strong><br>Kies zelf je afhaaltijd. Betalen kan online, cash of met de terminal in de zaak.</div>'
  if (subtotal < DELIVERY_MIN) return `<div class="notice badnotice"><strong>Nog ${euro(DELIVERY_MIN - subtotal)} eten toevoegen voor bezorging.</strong><br>Minimum bestelling aan eten is €15, exclusief bezorgkosten.</div>`
  if (storeConfig?.deliveryPaused) return '<div class="notice warning"><strong>Leveringen zijn tijdelijk gepauzeerd.</strong><br>Afhalen en later vooruitbestellen blijven mogelijk.</div>'
  return '<div class="notice warning"><strong>🛵 Bezorgkosten na controle van de echte rijafstand.</strong><br>€2,99 t/m 2,5 km · €3,99 boven 2,5 t/m 4 km · alleen Oostende.</div>'
}
function timeOptions() {
  if (!storeConfig) return '<option>Momenten laden…</option>'
  const immediate = orderType === 'delivery' ? storeConfig.acceptingImmediateDelivery : storeConfig.acceptingImmediatePickup
  const slots = orderType === 'delivery' ? storeConfig.deliverySlots : storeConfig.pickupSlots
  const choices = []
  if (immediate) choices.push({ value: 'asap', label: orderType === 'delivery' ? 'Zo snel mogelijk · 25–45 min.' : 'Zo snel mogelijk' })
  let lastDay = ''
  for (const slot of slots) {
    if (slot.dayLabel !== lastDay) { if (lastDay) choices.push({ close: true }); choices.push({ group: slot.dayLabel }); lastDay = slot.dayLabel }
    choices.push({ value: slot.startAt, label: orderType === 'delivery' ? slot.windowLabel : slot.timeLabel })
  }
  if (lastDay) choices.push({ close: true })
  const values = choices.filter(x => x.value).map(x => x.value)
  let chosen = checkoutDraft.requestedChoice
  if (!values.includes(chosen)) chosen = values[0] || ''
  checkoutDraft.requestedChoice = chosen
  if (!values.length) return '<option value="">Geen moment beschikbaar</option>'
  return choices.map(x => x.group ? `<optgroup label="${esc(x.group)}">` : x.close ? '</optgroup>' : `<option value="${esc(x.value)}" ${x.value === chosen ? 'selected' : ''}>${esc(x.label)}</option>`).join('')
}
function paymentButtons() {
  const options = orderType === 'delivery' ? [
    ['online', '💳', 'Online Bancontact of Visa/Mastercard'], ['cash', '💶', 'Cash bij levering'],
  ] : [
    ['online', '💳', 'Online betalen'], ['cash', '💶', 'Cash in de zaak'], ['terminal', '🏧', 'Betaalterminal in de zaak'],
  ]
  return `<div class="seg payment-seg ${options.length === 3 ? 'three' : ''}" style="grid-template-columns:${options.length === 3 ? 'repeat(3,1fr)' : '1fr 1fr'}">${options.map(([id, icon, label]) => `<button type="button" class="${paymentMethod === id ? 'active' : ''}" onclick="setPaymentMethod('${id}')"><span class="seg-icon">${icon}</span><span class="seg-copy">${label}<small>${id === 'online' ? 'Veilig via Stripe' : 'Ter plaatse'}</small></span></button>`).join('')}</div>`
}
function quoteMarkup() {
  if (orderType !== 'delivery' || !selectedAddress) return ''
  if (deliveryQuote?.loading) return '<div class="notice"><span class="spinner"></span> Echte rijafstand wordt berekend…</div>'
  if (deliveryQuote?.deliverable) return `<div class="notice address-ok"><strong>✓ Levering mogelijk</strong><br>${Number(deliveryQuote.distanceKm).toFixed(2).replace('.', ',')} km rijafstand · ${euro(deliveryQuote.feeCents / 100)} bezorgkosten.</div>`
  if (deliveryQuote && !deliveryQuote.deliverable) return `<div class="notice badnotice"><strong>${esc(deliveryQuote.error || storeConfig?.outsideMessage)}</strong><br><button class="pickup-offer" type="button" onclick="setType('pickup')">Kies afhalen</button></div>`
  return ''
}
function renderCheckout() {
  const subtotal = cartTotal(), deliveryBlocked = orderType === 'delivery' && (subtotal < DELIVERY_MIN || !deliveryQuote?.deliverable)
  const paymentNote = paymentMethod === 'online' ? 'Betaal online met Bancontact, Visa of Mastercard.' : paymentMethod === 'terminal' ? 'Betaal met de betaalterminal in de zaak.' : orderType === 'delivery' ? 'Betaal cash aan de bezorger. Er is geen betaalterminal bij levering.' : 'Betaal cash in de zaak.'
  const buttonLabel = deliveryBlocked ? subtotal < DELIVERY_MIN ? 'Minimum €15 eten voor bezorging' : 'Selecteer en controleer je bezorgadres' : paymentMethod === 'online' ? `Veilig online betalen · ${euro(subtotal + (deliveryQuote?.feeCents || 0) / 100)}` : 'Bestelling plaatsen'
  const deliveryFields = orderType === 'delivery' ? `<div class="checkout-grid two" style="margin-top:12px"><div class="field suggest-wrap"><label>Adres in Oostende *</label><input name="addressSearch" id="addressSearch" value="${draftValue('addressSearch')}" autocomplete="off" placeholder="Begin straat en huisnummer te typen" required><div id="addressSuggestions" class="suggestions hidden"></div><span class="field-hint">Kies één van de automatische adressuggesties.</span></div><div class="field"><label>Bus / verdieping <span style="color:#7d756b">(optioneel)</span></label><input name="addressExtra" value="${draftValue('addressExtra')}" placeholder="Bijv. bus 3, verdieping 2"></div></div>${quoteMarkup()}` : ''
  const optionalDelivery = orderType === 'delivery' ? `<div class="checkout-grid two" style="margin-top:12px"><div class="field"><label>E-mail <span style="color:#7d756b">(optioneel)</span></label><input name="email" value="${draftValue('email')}" type="email" autocomplete="email"></div><div class="field"><label>Opmerking of deurcode <span style="color:#7d756b">(optioneel)</span></label><input name="notes" value="${draftValue('notes')}" maxlength="500" placeholder="Bijv. bel even bij aankomst"></div></div><div class="checks"><label class="check"><input name="termsAccepted" type="checkbox" ${checkoutDraft.termsAccepted ? 'checked' : ''} required><span>Ik ga akkoord met de <a href="../legal/voorwaarden.html" target="_blank">voorwaarden</a> en het <a href="../legal/privacy.html" target="_blank">privacybeleid</a>. *</span></label><label class="check"><input name="marketingConsent" type="checkbox" ${checkoutDraft.marketingConsent ? 'checked' : ''}><span>Ik wil aanbiedingen van Grill Time ontvangen via e-mail of WhatsApp.</span></label></div>` : '<div class="muted-line" style="margin:12px 0">Geen account nodig. Alleen je voornaam en mobiel nummer zijn nodig.</div>'
  document.getElementById('checkoutSheet').innerHTML = `<div class="sheet-head"><div><div class="category-mini" style="margin-bottom:5px">Bijna klaar</div><h3>Bestelling afronden</h3><div class="details">Dagelijks afhalen en bezorgen van 12:00 tot 23:00. Vooruitbestellen kan 24/7.</div></div><button class="close" onclick="toggle('checkoutOverlay',false)">×</button></div><div class="estimate">Geschatte bezorgtijd: 25–45 minuten.</div><div class="checkout-step"><div class="checkout-step-title"><span class="step-no">1</span> Afhalen of bezorgen?</div><div class="seg"><button type="button" class="${orderType === 'pickup' ? 'active' : ''}" onclick="setType('pickup')"><span class="seg-icon">🛍️</span><span class="seg-copy">Afhalen<small>Kies gewenst tijdstip</small></span></button><button type="button" class="${orderType === 'delivery' ? 'active' : ''}" onclick="setType('delivery')"><span class="seg-icon">🛵</span><span class="seg-copy">Bezorgen<small>Oostende · max. 4 km</small></span></button></div>${deliveryInfo()}</div><div class="checkout-step"><div class="checkout-step-title"><span class="step-no">2</span> Betaalmethode</div>${paymentButtons()}<div class="muted-line" style="margin-top:7px">${esc(paymentNote)}</div></div><div class="checkout-step"><div class="checkout-step-title"><span class="step-no">3</span> Jouw gegevens en moment</div><form id="checkoutForm" onsubmit="submitOrder(event)"><div class="checkout-grid two"><div class="field"><label>Voornaam *</label><input name="firstName" value="${draftValue('firstName')}" required autocomplete="given-name" placeholder="Jouw voornaam"></div><div class="field"><label>Mobiel nummer *</label><input name="phone" value="${draftValue('phone')}" required autocomplete="tel" inputmode="tel" placeholder="Bijv. 0490 12 34 56"></div></div>${deliveryFields}<div class="field" style="margin-top:12px"><label>${orderType === 'delivery' ? 'Gewenst bezorgvenster van 15 minuten *' : 'Gewenste afhaaltijd *'}</label><select name="requestedChoice" required style="width:100%;background:#1d1b18;border:1px solid #39342e;border-radius:13px;color:#f5efe4;padding:13px 14px">${timeOptions()}</select><span class="field-hint">Voor 12:00 moet uiterlijk om 11:30 worden besteld.</span></div>${optionalDelivery}<div class="order-summary"><div class="summary-title">Jouw bestelling</div>${cart.map(l => `<div class="summary-row"><span>${l.qty}× ${esc(l.name)}</span><strong>${euro(l.qty * l.unitPrice)}</strong></div>`).join('')}<div class="summary-row summary-total"><strong>Subtotaal eten</strong><strong>${euro(subtotal)}</strong></div>${orderType === 'delivery' ? `<div class="summary-row"><span>Bezorgkosten</span><strong>${deliveryQuote?.deliverable ? euro(deliveryQuote.feeCents / 100) : 'na adrescontrole'}</strong></div>` : ''}<div class="summary-row"><span>Betaalmethode</span><strong>${paymentMethod === 'online' ? 'Online' : paymentMethod === 'terminal' ? 'Terminal in zaak' : 'Cash'}</strong></div></div><div class="estimate">Geschatte bezorgtijd: 25–45 minuten.</div><div class="notice">Het definitieve totaal, de beschikbaarheid, eventuele welkomstkorting en bezorgkosten worden opnieuw veilig gecontroleerd.</div><button id="checkoutSubmit" class="primary" type="submit" ${deliveryBlocked ? 'disabled' : ''}>${buttonLabel}</button></form></div>`
  const search = document.getElementById('addressSearch')
  if (search) search.addEventListener('input', onAddressInput)
}
function onAddressInput(e) {
  checkoutDraft.addressSearch = e.target.value
  if (!selectedAddress || e.target.value !== selectedAddress.label) { selectedAddress = null; deliveryQuote = null }
  clearTimeout(addressTimer)
  const q = e.target.value.trim(), box = document.getElementById('addressSuggestions')
  if (q.length < 3) { box?.classList.add('hidden'); return }
  addressTimer = setTimeout(async () => {
    try {
      const d = await get('/functions/v1/storefront-v2?action=address&q=' + encodeURIComponent(q))
      addressSuggestions = d.suggestions || []
      if (!box) return
      box.innerHTML = addressSuggestions.length ? addressSuggestions.map((x, i) => `<button type="button" onclick="selectAddress(${i})">${esc(x.label)}</button>`).join('') : '<div class="muted-line" style="padding:12px">Geen adres in 8400 Oostende gevonden.</div>'
      box.classList.remove('hidden')
    } catch (err) { toast(err.message) }
  }, 350)
}
function selectAddress(i) {
  selectedAddress = addressSuggestions[i]
  if (!selectedAddress) return
  checkoutDraft.addressSearch = selectedAddress.label
  const input = document.getElementById('addressSearch'); if (input) input.value = selectedAddress.label
  document.getElementById('addressSuggestions')?.classList.add('hidden')
  quoteDelivery()
}
async function quoteDelivery() {
  if (!selectedAddress) return
  captureCheckoutDraft(); deliveryQuote = { loading: true }; renderCheckout()
  try {
    const r = await fetch(CFG.url + '/functions/v1/storefront-v2?action=quote', { method: 'POST', headers: H, body: JSON.stringify(selectedAddress) })
    const d = await r.json()
    deliveryQuote = d.deliverable ? d : { deliverable: false, error: d.error || storeConfig?.outsideMessage }
  } catch (_) { deliveryQuote = { deliverable: false, error: 'De routecontrole is tijdelijk niet beschikbaar. Kies afhalen of probeer opnieuw.' } }
  renderCheckout()
}
function payload() {
  const f = new FormData(document.getElementById('checkoutForm'))
  const requestedChoice = String(f.get('requestedChoice') || '')
  return {
    customer: { firstName: String(f.get('firstName') || '').trim(), phone: String(f.get('phone') || '').trim(), email: orderType === 'delivery' ? String(f.get('email') || '').trim() || null : null },
    orderType, paymentMethod,
    address: orderType === 'delivery' && selectedAddress ? { ...selectedAddress, extra: String(f.get('addressExtra') || '').trim() || (selectedAddress.bus ? `bus ${selectedAddress.bus}` : null) } : null,
    requested: requestedChoice === 'asap' ? { mode: 'asap' } : { mode: 'scheduled', startAt: requestedChoice },
    notes: orderType === 'delivery' ? String(f.get('notes') || '').trim() || null : null,
    termsAccepted: orderType === 'delivery' ? f.get('termsAccepted') === 'on' : false,
    marketingConsent: orderType === 'delivery' && f.get('marketingConsent') === 'on',
    items: cart.map(l => ({ productId: l.productId, qty: l.qty, itemNote: l.itemNote || null, selectedOptions: Object.fromEntries(l.selections.map(g => [g.key, g.chosen.map(x => x.raw)])) })),
  }
}
function statusStep(status, orderTypeValue) {
  if (['rejected', 'cancelled'].includes(status)) return 0
  if (status === 'completed') return 4
  if (status === 'on_way') return 3
  if (['accepted', 'preparing', 'ready'].includes(status)) return orderTypeValue === 'pickup' && status === 'ready' ? 3 : 2
  return 1
}
function renderTracking(o) {
  const step = statusStep(o.status, o.orderType)
  const code = `GT-${String(o.orderNumber).padStart(5, '0')}`
  const payment = o.paymentMethod === 'online' ? (o.paymentStatus === 'paid' ? 'Online betaald' : o.paymentStatus === 'refunded' ? 'Terugbetaald' : 'Online betaling wordt verwerkt') : o.paymentMethod === 'terminal' ? 'Betaalterminal in de zaak' : 'Cash'
  document.getElementById('successSheet').innerHTML = `<div class="success"><div class="success-icon">${['rejected', 'cancelled'].includes(o.status) ? '!' : o.status === 'completed' ? '✓' : '⌛'}</div><div class="status-card"><div><div class="category-mini">Bestelstatus</div><div class="order-no">${code}</div></div><div class="status-message">${esc(o.message)}</div><div class="status-steps">${[1, 2, 3, 4].map(i => `<span class="status-step ${i <= step ? 'done' : ''}"></span>`).join('')}</div><div class="details">${o.orderType === 'delivery' ? 'Bezorgen' : 'Afhalen'} · ${esc(o.requestedTime || 'Zo snel mogelijk')} · ${euro((o.totalCents || 0) / 100)}</div><div class="estimate">Geschatte bezorgtijd: 25–45 minuten.</div><div class="notice">${esc(payment)}. Je hoeft geen account aan te maken. Laat dit scherm gerust open; de status wordt automatisch bijgewerkt.</div><button class="primary" onclick="closeTracking()">Sluiten</button></div></div>`
  toggle('successOverlay', true)
}
async function pollTracking(token) {
  clearTimeout(trackingTimer)
  try {
    const o = await get('/functions/v1/order-status-v2?token=' + encodeURIComponent(token))
    if (o.paymentStatus === 'paid') { cart = []; checkoutDraft = {}; clearRequestId(); save() }
    renderTracking(o)
    if (!['completed', 'rejected', 'cancelled'].includes(o.status)) trackingTimer = setTimeout(() => pollTracking(token), 5000)
  } catch (err) {
    document.getElementById('successSheet').innerHTML = `<div class="success"><div class="success-icon">!</div><h3>Status tijdelijk niet beschikbaar</h3><p class="details">${esc(err.message)}</p><button class="primary" onclick="pollTracking('${esc(token)}')">Opnieuw proberen</button></div>`
    toggle('successOverlay', true)
  }
}
function startTracking(token, initial) {
  localStorage.setItem('gt-last-order-token', token)
  if (initial) renderTracking({ ...initial, status: 'new', message: 'Bestelling ontvangen! Wacht even op de bevestiging van Grill Time.', orderType, requestedTime: checkoutDraft.requestedChoice === 'asap' ? 'Zo snel mogelijk' : '', paymentStatus: initial.paymentMethod === 'online' ? 'unpaid' : 'unpaid' })
  pollTracking(token)
}
function closeTracking() { clearTimeout(trackingTimer); trackingTimer = null; toggle('successOverlay', false) }
async function submitOrder(e) {
  e.preventDefault(); if (!cart.length) return
  if (orderType === 'delivery' && cartTotal() < DELIVERY_MIN) { toast('Minimum bestelling aan eten voor bezorging is €15'); return }
  if (orderType === 'delivery' && (!selectedAddress || !deliveryQuote?.deliverable)) { toast('Selecteer eerst een geldig bezorgadres uit de suggesties'); return }
  captureCheckoutDraft()
  const b = document.getElementById('checkoutSubmit'); b.disabled = true; b.textContent = paymentMethod === 'online' ? 'Beschikbaarheid en betaling controleren…' : 'Bestelling plaatsen…'
  try {
    const orderPayload = payload()
    orderPayload.requestId = requestIdFor(orderPayload)
    const r = await fetch(CFG.url + '/functions/v1/create-order-v2', { method: 'POST', headers: H, body: JSON.stringify(orderPayload) })
    const d = await r.json()
    if (!r.ok) {
      if (d.newRequestRequired) clearRequestId()
      if (d.offerPickup) { deliveryQuote = { deliverable: false, error: d.error }; renderCheckout() }
      throw new Error(d.error || 'Bestelling mislukt')
    }
    if (d.offlineOrder) { cart = []; clearRequestId(); save(); toggle('checkoutOverlay', false); startTracking(d.trackingToken, d); return }
    if (!d.checkoutUrl) throw new Error('Online betaling kon niet worden gestart')
    localStorage.setItem('gt-pending-order-token', d.trackingToken)
    location.assign(d.checkoutUrl)
  } catch (err) { console.error(err); toast(err.message || 'Bestelling kon niet worden geplaatst'); const btn = document.getElementById('checkoutSubmit'); if (btn) { btn.disabled = false; btn.textContent = 'Opnieuw proberen' } }
}
function handlePaymentReturn() {
  const q = new URLSearchParams(location.search), state = q.get('payment')
  if (state === 'cancelled') { toast('Betaling geannuleerd · winkelmandje is bewaard'); history.replaceState({}, '', location.pathname); return }
  if (state !== 'success') return
  const token = q.get('track') || localStorage.getItem('gt-pending-order-token')
  if (!token) return
  history.replaceState({}, '', location.pathname)
  startTracking(token)
}

window.toggle = toggle; window.qty = qty; window.addSelected = addSelected; window.removeLine = removeLine; window.lineQty = lineQty
window.openCheckout = openCheckout; window.setType = setType; window.setPaymentMethod = setPaymentMethod; window.selectAddress = selectAddress
window.submitOrder = submitOrder; window.pollTracking = pollTracking; window.closeTracking = closeTracking
;['productOverlay', 'cartOverlay', 'checkoutOverlay', 'successOverlay'].forEach(id => document.getElementById(id).onclick = e => { if (e.target.id === id) toggle(id, false) })
document.getElementById('openCart').onclick = openCart
document.getElementById('search').oninput = renderMenu
renderCartBar(); loadMenu(); handlePaymentReturn()
