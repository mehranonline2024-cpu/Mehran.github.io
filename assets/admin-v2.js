Object.assign(statusLabel, {
  new: 'Ontvangen', accepted: 'Bevestigd', preparing: 'In bereiding', ready: 'Klaar',
  on_way: 'Onderweg', completed: 'Afgerond', rejected: 'Geweigerd',
})
let storeSettings = null, availabilityOpen = false, availabilityData = { products: [], options: [], ingredients: [] }

function todayBrusselsAdmin() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Brussels', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}`
}
function notifyButton() {
  const b = document.getElementById('notifyBtn'); if (!b) return
  if (!('Notification' in window)) { b.textContent = '📱 Niet ondersteund'; b.disabled = true; return }
  b.textContent = Notification.permission === 'granted' ? '📱 Meldingen aan' : '📱 Meldingen aanzetten'
  b.className = `btn ${Notification.permission === 'granted' ? 'sound-on' : 'dark'}`
}
async function enablePhoneNotifications() {
  if (!('Notification' in window)) return alert('Dit toestel ondersteunt geen browsermeldingen.')
  const permission = await Notification.requestPermission(); notifyButton()
  if (permission === 'granted') new Notification('Grill Time', { body: 'Telefoonmeldingen zijn geactiveerd.' })
  else alert('Meldingen zijn niet toegestaan op dit toestel.')
}
window.enablePhoneNotifications = enablePhoneNotifications
function sendOrderNotification(order) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return
  const code = `GT-${String(order.order_number).padStart(5, '0')}`
  const n = new Notification(`Nieuwe bestelling ${code}`, { body: `${order.order_type === 'delivery' ? 'Bezorgen' : 'Afhalen'} · ${euroCents(order.total_cents)}`, tag: `grill-time-${order.id}`, requireInteraction: true })
  n.onclick = () => { window.focus(); n.close(); document.querySelector(`[data-order-id="${order.id}"]`)?.scrollIntoView({ behavior: 'smooth' }) }
}

isAlertOrder = o => o.status === 'new' && (o.payment_status === 'paid' || ['cash', 'terminal'].includes(o.payment_method))
detectFresh = function (next) {
  const alertOrders = next.filter(isAlertOrder), current = new Set(alertOrders.map(o => o.id))
  if (firstOrderLoad) { knownAlertIds = current; firstOrderLoad = false; return false }
  const fresh = alertOrders.filter(o => !knownAlertIds.has(o.id)); knownAlertIds = current
  if (fresh.length) { showNewOrderAlert(); fresh.forEach(sendOrderNotification) }
  return fresh.length > 0
}

async function adminAction(action, extra = {}) {
  const { data: { session } } = await sb.auth.getSession()
  if (!session?.access_token) throw new Error('Log opnieuw in.')
  const response = await fetch(cfg.SUPABASE_URL + '/functions/v1/admin-order-action-v2', {
    method: 'POST', headers: { apikey: cfg.SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  })
  const data = await response.json()
  if (!response.ok) { const error = new Error(data.error || 'Actie mislukt'); error.data = data; throw error }
  return data
}
async function loadSettings() {
  const { data, error } = await sb.from('store_settings').select('*').eq('id', 'main').single()
  if (error) return
  storeSettings = data; renderOps()
}
function renderOps() {
  const el = document.getElementById('opsPanel'); if (!el || !storeSettings) return
  el.innerHTML = `<div class="ops-bar"><button class="${storeSettings.delivery_paused ? 'ops-good' : 'ops-warn'}" onclick="toggleDeliveries()">${storeSettings.delivery_paused ? '▶ Leveringen hervatten' : '⏸ Leveringen pauzeren'}</button><button class="${storeSettings.store_temporarily_closed ? 'ops-good' : 'ops-danger'}" onclick="toggleStore()">${storeSettings.store_temporarily_closed ? '🔓 Winkel openen' : '🔒 Winkel tijdelijk sluiten'}</button><button class="ops-info" onclick="checkDeliveryHealth()">🛵 Levertijd controleren</button><button class="dark" onclick="toggleAvailability()">📦 Producten & opties</button><span class="live"><span class="dot"></span> 25–45 min.</span></div>${availabilityOpen ? availabilityHtml() : ''}`
}
async function toggleDeliveries() {
  if (!confirm(storeSettings.delivery_paused ? 'Nieuwe leveringen hervatten?' : 'Nieuwe directe leveringen pauzeren? Afhalen en latere vooruitbestellingen blijven actief.')) return
  try { const d = await adminAction('settings', { deliveryPaused: !storeSettings.delivery_paused }); storeSettings = d.settings; renderOps() } catch (e) { alert(e.message) }
}
async function toggleStore() {
  if (!confirm(storeSettings.store_temporarily_closed ? 'Winkel opnieuw openen voor directe bestellingen?' : 'Winkel tijdelijk sluiten voor directe bestellingen? Vooruitbestellingen blijven mogelijk.')) return
  try { const d = await adminAction('settings', { storeTemporarilyClosed: !storeSettings.store_temporarily_closed }); storeSettings = d.settings; renderOps() } catch (e) { alert(e.message) }
}
async function checkDeliveryHealth() {
  try { const d = await adminAction('delivery_health'); alert(`Routecontrole is ${d.routeService}. Geschatte bezorgtijd staat op ${d.estimate}.`) } catch (e) { alert(`Controle mislukt: ${e.message}`) }
}
async function toggleAvailability() {
  availabilityOpen = !availabilityOpen
  if (availabilityOpen) await loadAvailability(); else renderOps()
}
async function loadAvailability() {
  const [p, o, i] = await Promise.all([
    sb.from('products').select('id,name,active,availability_status').eq('active', true).order('sort_order'),
    sb.from('option_values').select('id,label,group_id,active,availability_status').eq('active', true).order('group_id').order('sort_order'),
    sb.from('ingredients').select('code,label,availability_status').order('sort_order'),
  ])
  if (p.error || o.error || i.error) { alert('Beschikbaarheid kon niet worden geladen.'); return }
  availabilityData = { products: p.data || [], options: o.data || [], ingredients: i.data || [] }; renderOps()
}
function availabilitySelect(kind, id, status) {
  return `<select onchange="setAvailability('${kind}','${String(id).replace(/'/g, '')}',this.value)"><option value="available" ${status === 'available' ? 'selected' : ''}>Beschikbaar</option><option value="sold_out_today" ${status === 'sold_out_today' ? 'selected' : ''}>Vandaag uitverkocht</option><option value="hidden" ${status === 'hidden' ? 'selected' : ''}>Verborgen</option></select>`
}
function availabilityHtml() {
  const groups = [
    ['Ingrediënten', availabilityData.ingredients.map(x => ({ kind: 'ingredient', id: x.code, label: x.label, status: x.availability_status }))],
    ['Producten', availabilityData.products.map(x => ({ kind: 'product', id: x.id, label: x.name, status: x.availability_status }))],
    ['Opties', availabilityData.options.map(x => ({ kind: 'option', id: x.id, label: `${x.label} · ${x.group_id}`, status: x.availability_status }))],
  ]
  return `<div class="availability"><h3>Beschikbaarheid</h3><div class="msg warn">“Vandaag uitverkocht” wordt bij de volgende openingsdag automatisch weer beschikbaar. Een uitgeschakeld ingrediënt blokkeert gekoppelde producten en opties.</div>${groups.map(([title, rows]) => `<h4>${title}</h4><div class="availability-grid">${rows.map(x => `<div class="availability-row"><label>${esc(x.label)}</label>${availabilitySelect(x.kind, x.id, x.status)}</div>`).join('')}</div>`).join('')}</div>`
}
async function setAvailability(kind, id, status) {
  const table = kind === 'product' ? 'products' : kind === 'option' ? 'option_values' : 'ingredients'
  const key = kind === 'product' ? 'id' : kind === 'option' ? 'id' : 'code'
  const patch = { availability_status: status, sold_out_on: status === 'sold_out_today' ? todayBrusselsAdmin() : null }
  const { error } = await sb.from(table).update(patch).eq(key, kind === 'option' ? Number(id) : id)
  if (error) alert('Wijziging geweigerd. Controleer je MFA-login.'); else await loadAvailability()
}
Object.assign(window, { toggleDeliveries, toggleStore, checkDeliveryHealth, toggleAvailability, setAvailability })

enterDashboard = async function (admin) {
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel()
  if (aal?.currentLevel !== 'aal2') { await requireMfa(admin); return }
  show('loginView', false); show('mfaView', false); show('dashboardView', true)
  document.getElementById('subtitle').textContent = `Ingelogd als ${admin.display_name} · MFA beveiligd`
  notifyButton(); await Promise.all([loadOrders(), loadSettings()]); subscribeRealtime()
  if (!pollTimer) pollTimer = setInterval(loadOrders, 5000)
}
loadOrders = async function () {
  if (loadInFlight) return; loadInFlight = true
  try {
    const { data, error } = await sb.from('orders').select('*,order_items(id,quantity,product_name,line_total_cents,details,item_note)').order('created_at', { ascending: false }).limit(150)
    if (error) { document.getElementById('orders').innerHTML = '<div class="msg bad">Toegang geweigerd of orders konden niet worden geladen.</div>'; return }
    const fresh = detectFresh(data || []); orders = data || []; render(); updateTabTitle(); syncAlarmReminder(fresh)
  } finally { loadInFlight = false }
}
subscribeRealtime = function () {
  if (realtimeChannel) return
  realtimeChannel = sb.channel('restaurant-operations-v2')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, () => setTimeout(loadOrders, 180))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'order_items' }, () => setTimeout(loadOrders, 150))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'store_settings' }, () => setTimeout(loadSettings, 150))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ingredients' }, () => availabilityOpen && setTimeout(loadAvailability, 150))
    .subscribe()
}
filterList = () => [
  { id: 'active', label: 'Actief' }, { id: 'new', label: 'Ontvangen' }, { id: 'accepted', label: 'Bevestigd' },
  { id: 'preparing', label: 'In bereiding' }, { id: 'ready', label: 'Klaar' }, { id: 'on_way', label: 'Onderweg' },
  { id: 'completed', label: 'Afgerond' }, { id: 'rejected', label: 'Geweigerd' }, { id: 'all', label: 'Alles' },
]
render = function () {
  const today = new Date(), todayOrders = orders.filter(o => new Date(o.created_at).toDateString() === today.toDateString())
  const todayPaid = orders.filter(o => o.payment_status === 'paid' && new Date(o.paid_at || o.created_at).toDateString() === today.toDateString())
  const revenue = todayPaid.reduce((s, o) => s + Number(o.total_cents || 0), 0), avg = todayPaid.length ? revenue / todayPaid.length : 0
  const active = orders.filter(o => ['pending_payment', 'new', 'accepted', 'preparing', 'ready', 'on_way'].includes(o.status))
  document.getElementById('stats').innerHTML = `<div class="stat"><small>Orders vandaag</small><strong>${todayOrders.length}</strong></div><div class="stat"><small>Betaalde omzet vandaag</small><strong>${euroCents(revenue)}</strong></div><div class="stat"><small>Gem. betaalde order</small><strong>${euroCents(avg)}</strong></div><div class="stat"><small>Actieve orders</small><strong>${active.length}</strong></div>`
  document.getElementById('filters').innerHTML = filterList().map(f => `<button class="filter ${f.id === currentFilter ? 'active' : ''}" onclick="setFilter('${f.id}')">${f.label}</button>`).join('')
  const list = currentFilter === 'all' ? orders : currentFilter === 'active' ? active : orders.filter(o => o.status === currentFilter)
  document.getElementById('orders').innerHTML = list.length ? list.map(orderHtml).join('') : '<div class="empty">Geen bestellingen in deze categorie.</div>'
}
function actionButtons(o) {
  if (o.status === 'new') return `<button class="accept-btn" onclick="handleOrderAction('${o.id}','accept',${o.first_cash_phone_warning ? 'true' : 'false'})">✓ Accepteren</button><button class="reject-btn" onclick="handleOrderAction('${o.id}','reject')">✕ Weigeren</button>`
  if (o.status === 'accepted') return `<button class="progress-btn" onclick="handleOrderAction('${o.id}','preparing')">🔥 In bereiding</button><button class="progress-btn" onclick="handleOrderAction('${o.id}','ready')">✓ Klaar</button>${o.order_type === 'delivery' ? `<button class="complete-btn" onclick="handleOrderAction('${o.id}','on_way')">🛵 Bestelling onderweg</button>` : ''}<button class="complete-btn" onclick="handleOrderAction('${o.id}','completed')">Afgerond</button><button class="print-btn" onclick="handleOrderAction('${o.id}','reprint')">🖨 Herdruk</button>`
  if (o.status === 'preparing') return `<button class="progress-btn" onclick="handleOrderAction('${o.id}','ready')">✓ Klaar</button>${o.order_type === 'delivery' ? `<button class="complete-btn" onclick="handleOrderAction('${o.id}','on_way')">🛵 Bestelling onderweg</button>` : ''}<button class="complete-btn" onclick="handleOrderAction('${o.id}','completed')">Afgerond</button><button class="print-btn" onclick="handleOrderAction('${o.id}','reprint')">🖨 Herdruk</button>`
  if (o.status === 'ready') return `${o.order_type === 'delivery' ? `<button class="complete-btn" onclick="handleOrderAction('${o.id}','on_way')">🛵 Bestelling onderweg</button>` : ''}<button class="complete-btn" onclick="handleOrderAction('${o.id}','completed')">Afgerond</button><button class="print-btn" onclick="handleOrderAction('${o.id}','reprint')">🖨 Herdruk</button>`
  if (o.status === 'on_way') return `<button class="complete-btn" onclick="handleOrderAction('${o.id}','completed')">Afgerond</button><button class="print-btn" onclick="handleOrderAction('${o.id}','reprint')">🖨 Herdruk</button>`
  return o.status === 'completed' ? `<button class="print-btn" onclick="handleOrderAction('${o.id}','reprint')">🖨 Herdruk</button>` : ''
}
orderHtml = function (o) {
  const dt = new Date(o.created_at).toLocaleString('nl-BE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  const code = `GT-${String(o.order_number).padStart(5, '0')}`, type = o.order_type === 'pickup' ? 'Afhalen' : 'Bezorgen'
  const address = o.order_type === 'delivery' ? [o.address_line, o.address_extra, o.postal_code, o.city].filter(Boolean).join(', ') : 'Afhalen in restaurant'
  const isCash = o.payment_method === 'cash', isTerminal = o.payment_method === 'terminal', isNew = o.status === 'new'
  const payText = o.payment_status === 'refunded' ? 'Terugbetaald' : o.payment_status === 'paid' ? (isCash ? 'Cash ontvangen' : 'Online betaald') : isTerminal ? 'Terminal in de zaak' : isCash ? 'Cash te ontvangen' : 'Niet betaald'
  const payClass = o.payment_status === 'paid' ? 'pay-paid' : (isCash || isTerminal) ? 'pay-cash' : 'pay-unpaid'
  const distance = o.order_type === 'delivery' && o.delivery_distance_km != null ? `${Number(o.delivery_distance_km).toFixed(2).replace('.', ',')} km rijafstand` : '—'
  const fee = o.order_type === 'delivery' ? euroCents(o.delivery_fee_cents || 0) : '—', discount = Number(o.discount_cents || 0)
  return `<article class="order ${isNew ? 'new' : ''}" data-order-id="${o.id}">${isNew ? '<div class="new-order-strip"><span class="pulse-dot"></span>BESTELLING ONTVANGEN · REAGEER BINNEN 2 MINUTEN</div>' : ''}<div class="order-top"><div><div class="order-title-row"><span class="order-code">${code}</span><span class="status-badge status-${esc(o.status)}">${esc(statusLabel[o.status] || o.status)}</span><span class="type-badge">${type}</span><span class="pay-badge ${payClass}">${esc(payText)}</span>${discount > 0 ? '<span class="discount-badge">WELCOME10</span>' : ''}</div></div><div class="price">${euroCents(o.total_cents)}</div></div><div class="meta-grid"><div class="meta-box"><div class="meta-label">Tijd</div><div class="meta-value">Ontvangen ${dt}<br><strong>${esc(o.requested_time || 'Zo snel mogelijk')}</strong></div></div><div class="meta-box"><div class="meta-label">Klant</div><div class="meta-value"><strong>${esc(o.customer_name)}</strong><br><a href="tel:${esc(o.customer_phone)}">${esc(o.customer_phone)}</a></div></div><div class="meta-box"><div class="meta-label">${type}</div><div class="meta-value">${esc(address)}${o.order_type === 'delivery' ? `<br><strong>${distance} · ${fee} bezorging</strong>` : ''}</div></div><div class="meta-box"><div class="meta-label">Betaling</div><div class="meta-value">${isCash ? '💶 Cash' : isTerminal ? '🏧 Terminal in zaak' : '💳 Online'}<br>${esc(payText)}</div></div></div><div class="items"><div class="items-title">Bestelling</div>${(o.order_items || []).map(i => `<div class="row"><span><span class="item-name">${i.quantity}× ${esc(i.product_name)}</span>${Array.isArray(i.details) && i.details.length ? `<small>${i.details.map(esc).join(' · ')}</small>` : ''}${i.item_note ? `<span class="item-note-admin"><strong>Opmerking gerecht:</strong> ${esc(i.item_note)}</span>` : ''}</span><strong>${euroCents(i.line_total_cents)}</strong></div>`).join('')}</div><div class="totals-admin"><div class="total-line"><span>Producten</span><span>${euroCents(o.subtotal_cents)}</span></div>${discount > 0 ? `<div class="total-line" style="color:#aef6cf"><span>Welkomstkorting 10%</span><span>− ${euroCents(discount)}</span></div>` : ''}${o.order_type === 'delivery' ? `<div class="total-line"><span>Bezorging</span><span>${fee}</span></div>` : ''}<div class="total-line grand"><span>Totaal</span><span>${euroCents(o.total_cents)}</span></div></div>${o.notes ? `<div class="msg warn"><strong>Opmerking bestelling:</strong> ${esc(o.notes)}</div>` : ''}${o.first_cash_phone_warning && o.status === 'new' ? '<div class="phone-warning">⚠ Telefonisch bevestigen vóór bereiding.</div>' : ''}${isCash && o.payment_status !== 'paid' ? `<div class="cash-action"><button onclick="handleOrderAction('${o.id}','cash_paid')">💶 Cash ontvangen · ${euroCents(o.total_cents)}</button><span style="color:#aaa;font-size:12px">Klik pas nadat het geld is ontvangen.</span></div>` : ''}<div class="order-actions">${actionButtons(o)}</div></article>`
}
async function handleOrderAction(id, action, phoneWarning = false) {
  let extra = { orderId: id }
  if (action === 'accept' && phoneWarning) {
    if (!confirm('Telefonisch bevestigen vóór bereiding. Heb je de klant nu telefonisch gesproken en de bestelling bevestigd?')) return
    extra.phoneConfirmed = true
  }
  if (action === 'reject') { const reason = prompt('Reden voor weigering (optioneel):', ''); if (reason === null) return; extra.reason = reason }
  if (action === 'completed' && !confirm('Bestelling als afgerond markeren?')) return
  try {
    const d = await adminAction(action, extra)
    if (d.refunded) alert('Bestelling geweigerd en online betaling terugbetaald.')
    if (d.printJob?.payload) printReceipt(d.printJob.payload)
    await loadOrders()
  } catch (e) { alert(e.message) }
}
function printReceipt(p) {
  const frame = document.createElement('iframe'); frame.style.position = 'fixed'; frame.style.right = '0'; frame.style.bottom = '0'; frame.style.width = '1px'; frame.style.height = '1px'; frame.style.border = '0'
  document.body.appendChild(frame)
  const doc = frame.contentDocument
  doc.open(); doc.write(`<!doctype html><html><head><title>GT-${String(p.order_number).padStart(5, '0')}</title><style>@page{size:80mm auto;margin:3mm}body{font:12px/1.35 monospace;color:#000;width:72mm;margin:0}h1{text-align:center;font-size:19px;margin:0 0 5px}.big{font-size:16px;font-weight:bold}.line{border-top:1px dashed #000;margin:7px 0}.item{margin:7px 0}.right{float:right}.note{border:2px solid #000;padding:5px;font-weight:bold}.total{font-size:17px;font-weight:bold}</style></head><body><h1>GRILL TIME</h1><div class="big">GT-${String(p.order_number).padStart(5, '0')} · ${esc(p.order_type === 'delivery' ? 'BEZORGING' : 'AFHALEN')}</div><div>${esc(p.requested_time || 'Zo snel mogelijk')}</div><div class="line"></div>${(p.items || []).map(i => `<div class="item"><strong>${i.quantity}× ${esc(i.name)}</strong>${Array.isArray(i.details) && i.details.length ? `<br>${i.details.map(esc).join(' · ')}` : ''}${i.item_note ? `<div class="note">${esc(i.item_note)}</div>` : ''}</div>`).join('')}<div class="line"></div>${p.notes ? `<div class="note">OPMERKING: ${esc(p.notes)}</div>` : ''}${p.address ? `<div><strong>ADRES</strong><br>${esc(p.address)}<br>${esc(p.phone || '')}</div><div class="line"></div>` : ''}<div>${esc(p.payment || '')}</div><div class="total">TOTAAL <span class="right">${euroCents(p.total_cents)}</span></div></body></html>`); doc.close()
  setTimeout(() => { frame.contentWindow.focus(); frame.contentWindow.print(); setTimeout(() => frame.remove(), 1500) }, 250)
}
setStatus = (id, status) => handleOrderAction(id, status)
markCashPaid = id => handleOrderAction(id, 'cash_paid')
Object.assign(window, { handleOrderAction })

setTimeout(async () => {
  const dashboard = document.getElementById('dashboardView')
  if (dashboard && !dashboard.classList.contains('hidden')) {
    if (realtimeChannel) { await sb.removeChannel(realtimeChannel); realtimeChannel = null }
    notifyButton(); await Promise.all([loadOrders(), loadSettings()]); subscribeRealtime()
  }
}, 500)
