import Stripe from 'npm:stripe@22.4.0'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const stripeKey = (Deno.env.get('STRIPE_SECRET_KEY') || '').trim()
const stripePaymentMethodConfiguration = (Deno.env.get('STRIPE_PAYMENT_METHOD_CONFIGURATION_ID') || '').trim()
const stripe = new Stripe(stripeKey)
const allowedOrigins = new Set([
  'https://grilltime.be', 'https://www.grilltime.be',
  'https://grilltime-v2-test.snug-bud-2681.chatgpt.site',
  'https://grilltime-v2-test.mehran-belgie.chatgpt.site',
  'http://localhost:4173', 'http://127.0.0.1:4173',
])
const RESTAURANT_LAT = 51.234848445475095
const RESTAURANT_LON = 2.9202298934891577
const OUTSIDE_MESSAGE = 'Helaas leveren we momenteel alleen binnen 4 km in Oostende. Je kunt je bestelling wel bij Grill Time afhalen.'

type SelectionGroup = { key?: string; chosen?: Array<{ raw?: string; label?: string } | string> }
type CartItem = { productId: string; qty: number; itemNote?: string; selectedOptions?: Record<string, string[]>; selections?: SelectionGroup[] }

function clean(value: unknown, max = 250) { return String(value ?? '').trim().slice(0, max) }
function normalize(value: unknown) {
  return clean(value, 180).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
function normalizePhone(value: unknown) {
  let digits = clean(value, 40).replace(/\D/g, '')
  if (digits.startsWith('0032')) digits = '0' + digits.slice(4)
  else if (digits.startsWith('32') && digits.length >= 10) digits = '0' + digits.slice(2)
  return digits
}
async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://grilltime.be'
  return {
    'Access-Control-Allow-Origin': allowOrigin, 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Cache-Control': 'no-store',
  }
}
function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8' } })
}
function adminClient() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''
  if (!url || !key) throw new Error('Supabase server configuration ontbreekt')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}
function selectedOptions(raw: CartItem): Record<string, string[]> {
  if (raw.selectedOptions && typeof raw.selectedOptions === 'object' && !Array.isArray(raw.selectedOptions)) {
    return Object.fromEntries(Object.entries(raw.selectedOptions).map(([key, values]) => [clean(key, 80), Array.isArray(values) ? values.map(v => clean(v, 100)).filter(Boolean) : []]))
  }
  const out: Record<string, string[]> = {}
  for (const group of Array.isArray(raw.selections) ? raw.selections : []) {
    const key = clean(group?.key, 80)
    if (key && Array.isArray(group?.chosen)) out[key] = group.chosen.map(v => typeof v === 'string' ? clean(v, 100) : clean(v?.raw || v?.label, 100)).filter(Boolean)
  }
  return out
}
function zonedParts(date: Date, timeZone = 'Europe/Brussels') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date)
  return Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>
}
function localDate(timeZone: string) {
  const p = zonedParts(new Date(), timeZone)
  return `${p.year}-${p.month}-${p.day}`
}
function minutes(value: unknown, fallback: string) {
  const [h, m] = clean(value || fallback, 8).split(':').map(Number)
  return h * 60 + m
}
function statusUnavailable(row: any, today: string) {
  if (!row?.active) return true
  if (row.availability_status === 'hidden') return true
  return row.availability_status === 'sold_out_today' && (!row.sold_out_on || String(row.sold_out_on) >= today)
}
async function resetExpiredDailyStatuses(sb: ReturnType<typeof adminClient>, today: string) {
  await Promise.all([
    sb.from('products').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
    sb.from('option_values').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
    sb.from('ingredients').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
  ])
}
function validateRequested(body: any, settings: any) {
  const now = new Date()
  const tz = settings.timezone || 'Europe/Brussels'
  const openMinutes = minutes(settings.opens_at, '12:00')
  const closeMinutes = minutes(settings.closes_at, '23:00')
  const nowParts = zonedParts(now, tz)
  const nowMinutes = +nowParts.hour * 60 + +nowParts.minute
  const mode = body.requested?.mode === 'asap' ? 'asap' : 'scheduled'
  const orderType = body.orderType === 'delivery' ? 'delivery' : 'pickup'
  if (mode === 'asap') {
    if (settings.store_temporarily_closed) return { error: 'Grill Time is tijdelijk gesloten. Kies een later tijdstip om vooruit te bestellen.' }
    if (nowMinutes < openMinutes || nowMinutes > closeMinutes) return { error: 'Buiten de openingsuren kun je alleen een later tijdstip kiezen.' }
    if (orderType === 'delivery' && settings.delivery_paused) return { error: 'Nieuwe leveringen zijn tijdelijk gepauzeerd. Kies afhalen of bestel voor een later tijdstip.' }
    return { mode, startAt: null, endAt: null, label: 'Zo snel mogelijk' }
  }
  const start = new Date(clean(body.requested?.startAt, 80))
  if (!Number.isFinite(start.getTime())) return { error: 'Kies een geldig gewenst tijdstip.' }
  const leadMs = Number(settings.preparation_lead_minutes || 30) * 60_000
  if (start.getTime() < now.getTime() + leadMs) return { error: 'Kies een tijdstip dat minstens 30 minuten in de toekomst ligt.' }
  if (start.getTime() > now.getTime() + Number(settings.preorder_days || 7) * 86_400_000) return { error: 'Dit tijdstip ligt te ver in de toekomst.' }
  const p = zonedParts(start, tz)
  const slotMinutes = +p.hour * 60 + +p.minute
  if (slotMinutes < openMinutes || slotMinutes > closeMinutes || +p.minute % 15 !== 0) return { error: 'Kies een tijdstip tussen 12:00 en 23:00 in stappen van 15 minuten.' }
  const end = orderType === 'delivery' ? new Date(start.getTime() + 15 * 60_000) : null
  const day = new Intl.DateTimeFormat('nl-BE', { timeZone: tz, day: '2-digit', month: '2-digit', year: 'numeric' }).format(start)
  const st = new Intl.DateTimeFormat('nl-BE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(start)
  const en = end ? new Intl.DateTimeFormat('nl-BE', { timeZone: tz, hour: '2-digit', minute: '2-digit' }).format(end) : ''
  return { mode, startAt: start.toISOString(), endAt: end?.toISOString() || null, label: orderType === 'delivery' ? `${day} ${st}–${en}` : `${day} ${st}` }
}
async function geocodeAddress(street: string, houseNumber: string) {
  const url = new URL('https://geo.api.vlaanderen.be/geolocation/v4/Location')
  url.searchParams.set('q', `${street} ${houseNumber}, 8400 Oostende`)
  url.searchParams.set('c', '5')
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if (!response.ok) throw new Error('Adrescontrole is tijdelijk niet beschikbaar.')
  const data = await response.json()
  const rows = Array.isArray(data?.LocationResult) ? data.LocationResult : []
  const exact = rows.find((r: any) => normalize(r.Municipality) === 'oostende' && String(r.Zipcode) === '8400' && normalize(r.Thoroughfarename) === normalize(street) && clean(r.Housenumber, 20).toLowerCase() === houseNumber.toLowerCase())
  const lat = Number(exact?.Location?.Lat_WGS84), lon = Number(exact?.Location?.Lon_WGS84)
  if (!exact || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { street: clean(exact.Thoroughfarename, 120), houseNumber: clean(exact.Housenumber, 20), postcode: '8400', city: 'Oostende', label: clean(exact.FormattedAddress, 240), lat, lon }
}
async function drivingDistanceKm(lat: number, lon: number) {
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${RESTAURANT_LON},${RESTAURANT_LAT};${lon},${lat}`)
  url.searchParams.set('overview', 'false')
  url.searchParams.set('steps', 'false')
  const response = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'GrillTimeOostende/2.0 (https://grilltime.be)' } })
  if (!response.ok) throw new Error('Routecontrole is tijdelijk niet beschikbaar.')
  const data = await response.json()
  const meters = Number(data?.routes?.[0]?.distance)
  if (!Number.isFinite(meters) || meters <= 0) throw new Error('We konden geen geldige rijroute berekenen.')
  return meters / 1000
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405)
  const origin = req.headers.get('origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(req, { error: 'Origin not allowed' }, 403)
  if (Number(req.headers.get('content-length') || 0) > 120_000) return json(req, { error: 'Request te groot' }, 413)

  try {
    const body = await req.json()
    const requestId = clean(body.requestId, 36)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) return json(req, { error: 'Ongeldige of ontbrekende aanvraagcode.' }, 400)
    const fingerprintBody = { ...body }
    delete fingerprintBody.requestId
    const requestFingerprint = await sha256Hex(JSON.stringify(fingerprintBody))
    const sb = adminClient()
    const { data: settings, error: settingsError } = await sb.from('store_settings').select('*').eq('id', 'main').single()
    if (settingsError) throw settingsError
    const today = localDate(settings.timezone)
    await resetExpiredDailyStatuses(sb, today)

    const orderType = body.orderType === 'delivery' ? 'delivery' : 'pickup'
    const paymentMethod = ['online', 'cash', 'terminal'].includes(body.paymentMethod) ? body.paymentMethod : 'online'
    if (orderType === 'delivery' && paymentMethod === 'terminal') return json(req, { error: 'Een betaalterminal is niet beschikbaar bij levering.' }, 400)
    if (origin.endsWith('.chatgpt.site') && paymentMethod === 'online') return json(req, { error: 'Online betalen is uitgeschakeld in de testversie.' }, 400)
    if (paymentMethod === 'online' && !stripeKey) return json(req, { error: 'Online betalen is tijdelijk niet beschikbaar.' }, 503)

    const customer = {
      name: clean(body.customer?.firstName || body.customer?.name, 100),
      phone: clean(body.customer?.phone, 40),
      email: clean(body.customer?.email, 160) || null,
    }
    const phoneNormalized = normalizePhone(customer.phone)
    if (!customer.name || phoneNormalized.length < 8) return json(req, { error: 'Voornaam en een geldig mobiel telefoonnummer zijn verplicht.' }, 400)
    if (orderType === 'delivery' && body.termsAccepted !== true) return json(req, { error: 'Je moet akkoord gaan met de voorwaarden en het privacybeleid.' }, 400)

    const requested = validateRequested(body, settings)
    if ('error' in requested) return json(req, { error: requested.error }, 400)

    let address: any = null
    let distanceKm: number | null = null
    let deliveryFeeCents = 0
    if (orderType === 'delivery') {
      const raw = body.address || {}
      const street = clean(raw.street, 120), houseNumber = clean(raw.houseNumber, 20)
      if (!street || !houseNumber || clean(raw.postcode, 10) !== '8400' || normalize(raw.city) !== 'oostende') return json(req, { error: OUTSIDE_MESSAGE, offerPickup: true }, 400)
      address = await geocodeAddress(street, houseNumber)
      if (!address) return json(req, { error: 'Selecteer een geldig adres uit de adressuggesties.', offerPickup: true }, 400)
      distanceKm = await drivingDistanceKm(address.lat, address.lon)
      if (distanceKm > Number(settings.max_distance_km)) return json(req, { error: OUTSIDE_MESSAGE, offerPickup: true, distanceKm: Number(distanceKm.toFixed(2)) }, 400)
      deliveryFeeCents = distanceKm <= Number(settings.inner_distance_km) ? settings.inner_fee_cents : settings.outer_fee_cents
    }

    const items = Array.isArray(body.items) ? body.items as CartItem[] : []
    if (!items.length || items.length > 40) return json(req, { error: 'Ongeldig winkelmandje.' }, 400)
    const productIds = [...new Set(items.map(i => clean(i.productId, 80)).filter(Boolean))]
    if (!productIds.length) return json(req, { error: 'Ongeldig winkelmandje.' }, 400)

    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString()
    const { count: recentOrders, error: recentError } = await sb.from('orders').select('id', { count: 'exact', head: true }).eq('customer_phone', customer.phone).gte('created_at', tenMinutesAgo)
    if (recentError) throw recentError
    if ((recentOrders || 0) >= 6) return json(req, { error: 'Te veel recente bestelpogingen. Probeer later opnieuw.' }, 429)

    const [productResult, linkResult, ingredientResult, productDepResult, optionDepResult] = await Promise.all([
      sb.from('products').select('id,name,price_cents,active,availability_status,sold_out_on').in('id', productIds),
      sb.from('product_option_groups').select('product_id,group_id,sort_order').in('product_id', productIds).order('sort_order'),
      sb.from('ingredients').select('code,availability_status,sold_out_on'),
      sb.from('product_ingredient_dependencies').select('product_id,ingredient_code').in('product_id', productIds),
      sb.from('option_value_ingredient_dependencies').select('option_value_id,ingredient_code'),
    ])
    for (const result of [productResult, linkResult, ingredientResult, productDepResult, optionDepResult]) if (result.error) throw result.error
    const products = productResult.data || []
    const productMap = new Map(products.map((p: any) => [p.id, p]))
    if (productMap.size !== productIds.length) return json(req, { error: 'Een product is niet meer beschikbaar.' }, 400)

    const ingredientMap = new Map((ingredientResult.data || []).map((i: any) => [i.code, i]))
    const ingredientAvailable = (code: string) => {
      const i: any = ingredientMap.get(code)
      return i && i.availability_status !== 'hidden' && !(i.availability_status === 'sold_out_today' && (!i.sold_out_on || String(i.sold_out_on) >= today))
    }
    const productDeps = new Map<string, string[]>()
    for (const d of productDepResult.data || []) productDeps.set(d.product_id, [...(productDeps.get(d.product_id) || []), d.ingredient_code])
    for (const p of products as any[]) {
      if (statusUnavailable(p, today) || (productDeps.get(p.id) || []).some(code => !ingredientAvailable(code))) return json(req, { error: `${p.name} is vandaag tijdelijk uitverkocht.` }, 400)
    }

    const groupIds = [...new Set((linkResult.data || []).map((x: any) => x.group_id))]
    const [groupResult, valueResult] = await Promise.all([
      groupIds.length ? sb.from('option_groups').select('*').in('id', groupIds) : Promise.resolve({ data: [], error: null } as any),
      groupIds.length ? sb.from('option_values').select('*').in('group_id', groupIds) : Promise.resolve({ data: [], error: null } as any),
    ])
    if (groupResult.error) throw groupResult.error
    if (valueResult.error) throw valueResult.error
    const optionDeps = new Map<number, string[]>()
    for (const d of optionDepResult.data || []) optionDeps.set(Number(d.option_value_id), [...(optionDeps.get(Number(d.option_value_id)) || []), d.ingredient_code])
    const optionAvailable = (v: any) => !statusUnavailable(v, today) && !(optionDeps.get(Number(v.id)) || []).some(code => !ingredientAvailable(code))
    const groupMap = new Map((groupResult.data || []).map((g: any) => [g.id, g]))
    const valuesByGroup = new Map<string, any[]>()
    for (const v of valueResult.data || []) valuesByGroup.set(v.group_id, [...(valuesByGroup.get(v.group_id) || []), v])
    const groupsByProduct = new Map<string, string[]>()
    for (const l of linkResult.data || []) groupsByProduct.set(l.product_id, [...(groupsByProduct.get(l.product_id) || []), l.group_id])

    const checkedItems: any[] = []
    let subtotalCents = 0
    for (const raw of items) {
      const product: any = productMap.get(clean(raw.productId, 80))
      const qty = Number(raw.qty)
      if (!product || !Number.isInteger(qty) || qty < 1 || qty > 20) return json(req, { error: 'Ongeldig product of aantal.' }, 400)
      const selected = selectedOptions(raw)
      const linkedGroups = groupsByProduct.get(product.id) || []
      for (const supplied of Object.keys(selected)) if (!linkedGroups.includes(supplied)) return json(req, { error: 'Ongeldige optiekeuze.' }, 400)
      let unitPriceCents = Number(product.price_cents)
      const details: string[] = []
      const normalizedOptions: Record<string, string[]> = {}
      for (const groupId of linkedGroups) {
        const group: any = groupMap.get(groupId)
        if (!group) continue
        const chosen = [...new Set((selected[groupId] || []).map(v => clean(v, 100)).filter(Boolean))]
        if (group.required && !chosen.length) return json(req, { error: `Maak een keuze bij ${group.title}.` }, 400)
        if (group.input_type === 'radio' && chosen.length > 1) return json(req, { error: `Ongeldige keuze bij ${group.title}.` }, 400)
        if (group.max_select && chosen.length > Number(group.max_select)) return json(req, { error: `Te veel keuzes bij ${group.title}.` }, 400)
        const allowed = valuesByGroup.get(groupId) || []
        const byLabel = new Map(allowed.map(v => [v.label, v]))
        normalizedOptions[groupId] = []
        for (const label of chosen) {
          const option: any = byLabel.get(label)
          if (!option || !optionAvailable(option)) return json(req, { error: `${label} is vandaag tijdelijk uitverkocht.` }, 400)
          unitPriceCents += Number(option.price_delta_cents || 0)
          normalizedOptions[groupId].push(label)
          details.push(`${group.display_prefix || ''}${label}`)
        }
      }
      const lineTotalCents = unitPriceCents * qty
      subtotalCents += lineTotalCents
      if (subtotalCents > 200_000) return json(req, { error: 'Bestelbedrag is te hoog.' }, 400)
      checkedItems.push({ productId: product.id, name: product.name, qty, unitPriceCents, lineTotalCents, selectedOptions: normalizedOptions, details, itemNote: clean(raw.itemNote, 150) || null })
    }
    if (subtotalCents < 50) return json(req, { error: 'Bestelbedrag is te laag.' }, 400)
    if (orderType === 'delivery' && subtotalCents < Number(settings.delivery_min_cents)) return json(req, { error: 'Minimum bestelling aan eten voor bezorging is €15,00, exclusief bezorgkosten.' }, 400)

    const addressExtra = orderType === 'delivery' ? clean(body.address?.extra, 120) || null : null
    const { data: order, error: orderError } = await sb.rpc('service_create_order_v2', {
      p_request_id: requestId,
      p_request_fingerprint: requestFingerprint,
      p_customer: { name: customer.name, phone: customer.phone, email: customer.email, phone_normalized: phoneNormalized },
      p_order: {
        order_type: orderType, payment_method: paymentMethod, requested_time: requested.label,
        requested_at: requested.startAt, requested_window_end: requested.endAt,
        address_line: address ? `${address.street} ${address.houseNumber}` : null,
        address_extra: addressExtra, postal_code: address?.postcode || null, city: address?.city || null,
        notes: clean(body.notes, 500) || null, subtotal_cents: subtotalCents,
        delivery_fee_cents: deliveryFeeCents,
        delivery_distance_km: distanceKm === null ? null : Number(distanceKm.toFixed(2)),
        delivery_distance_method: orderType === 'delivery' ? 'driving' : null,
        terms_accepted: body.termsAccepted === true, marketing_consent: body.marketingConsent === true,
      },
      p_items: checkedItems.map(i => ({
        product_id: i.productId, product_name: i.name, quantity: i.qty,
        unit_price_cents: i.unitPriceCents, line_total_cents: i.lineTotalCents,
        selected_options: i.selectedOptions, details: i.details, item_note: i.itemNote,
      })),
    })
    if (orderError) {
      if (String(orderError.message || '').includes('different order data')) return json(req, { error: 'Deze aanvraagcode hoort bij een andere bestelling. Probeer opnieuw.', newRequestRequired: true }, 409)
      throw orderError
    }
    if (!order?.orderId) throw new Error('Bestelling werd niet correct opgeslagen.')

    const discountCents = Number(order.discountCents || 0)
    const discountCode = order.discountCode || null
    const totalCents = Number(order.totalCents)
    const firstCashPhoneWarning = Boolean(order.firstCashPhoneWarning)

    const result = {
      ok: true, orderNumber: order.orderNumber, trackingToken: order.trackingToken,
      subtotalCents: Number(order.subtotalCents), discountCents, discountCode,
      deliveryFeeCents: Number(order.deliveryFeeCents || 0),
      deliveryDistanceKm: order.deliveryDistanceKm === null ? null : Number(order.deliveryDistanceKm), totalCents,
      firstCashPhoneWarning,
    }
    if (paymentMethod !== 'online') return json(req, { ...result, offlineOrder: true, paymentMethod })
    if (!stripePaymentMethodConfiguration) {
      await sb.from('orders').update({ status: 'cancelled', payment_status: 'failed' }).eq('id', order.orderId)
      return json(req, { error: 'Online betalen wordt nog veilig geconfigureerd. Kies voorlopig cash of terminal in de zaak.', newRequestRequired: true }, 503)
    }

    const siteUrl = (Deno.env.get('SITE_URL') || 'https://grilltime.be').replace(/\/$/, '')
    try {
      const { data: storedItems, error: storedItemsError } = await sb.from('order_items').select('product_name,quantity,unit_price_cents,details,item_note').eq('order_id', order.orderId).order('created_at')
      if (storedItemsError) throw storedItemsError
      const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = (storedItems || []).map((i: any) => ({
        quantity: i.quantity,
        price_data: { currency: 'eur', unit_amount: i.unit_price_cents, product_data: { name: i.product_name, description: [...(Array.isArray(i.details) ? i.details : []), ...(i.item_note ? [`Opmerking: ${i.item_note}`] : [])].join(' · ').slice(0, 450) || undefined } },
      }))
      if (!lineItems.length) throw new Error('Bestelregels ontbreken.')
      if (result.deliveryFeeCents > 0) lineItems.push({ quantity: 1, price_data: { currency: 'eur', unit_amount: result.deliveryFeeCents, product_data: { name: 'Bezorgkosten' } } })
      let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined
      if (discountCents > 0) {
        const coupon = await stripe.coupons.create(
          { amount_off: discountCents, currency: 'eur', duration: 'once', name: 'Welkomstkorting 10%' },
          { idempotencyKey: `grilltime-coupon-${requestId}` },
        )
        discounts = [{ coupon: coupon.id }]
      }
      if (order.stripeCheckoutSessionId) {
        const existingSession = await stripe.checkout.sessions.retrieve(order.stripeCheckoutSessionId)
        if (existingSession.payment_status === 'paid') return json(req, { ...result, offlineOrder: true, paymentMethod, alreadyPaid: true })
        if (existingSession.status === 'open' && existingSession.url) return json(req, { ...result, checkoutUrl: existingSession.url, mode: stripeKey.includes('_test_') ? 'test' : 'live', replayed: true })
        return json(req, { error: 'De vorige betaalpagina is verlopen. Start de bestelling opnieuw.', newRequestRequired: true }, 409)
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment', payment_method_configuration: stripePaymentMethodConfiguration, line_items: lineItems, discounts,
        customer_email: customer.email || undefined, client_reference_id: order.orderId,
        success_url: `${siteUrl}/order/?payment=success&track=${order.trackingToken}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${siteUrl}/order/?payment=cancelled`,
        metadata: { order_id: order.orderId, order_number: String(order.orderNumber), tracking_token: order.trackingToken, client_request_id: requestId },
        locale: body.locale === 'en' ? 'en' : 'nl',
      }, { idempotencyKey: `grilltime-checkout-${requestId}` })
      const { error: updateError } = await sb.from('orders').update({ stripe_checkout_session_id: session.id }).eq('id', order.orderId).eq('client_request_id', requestId)
      if (updateError) throw updateError
      return json(req, { ...result, checkoutUrl: session.url, mode: stripeKey.includes('_test_') ? 'test' : 'live' })
    } catch (stripeError) {
      throw stripeError
    }
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : 'Bestelling kon niet worden geplaatst.' }, 500)
  }
})
