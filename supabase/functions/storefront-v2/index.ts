import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const allowedOrigins = new Set([
  'https://grilltime.be',
  'https://www.grilltime.be',
  'http://localhost:4173',
  'http://127.0.0.1:4173',
])
// Official Flemish Geolocation API position for Albert I-Promenade 9
// (the current register resolves this historical entrance beside no. 8).
const RESTAURANT_LAT = 51.234848445475095
const RESTAURANT_LON = 2.9202298934891577
const OUTSIDE_MESSAGE = 'Helaas leveren we momenteel alleen binnen 4 km in Oostende. Je kunt je bestelling wel bij Grill Time afhalen.'

function clean(value: unknown, max = 250) { return String(value ?? '').trim().slice(0, max) }
function normalize(value: unknown) {
  return clean(value, 160).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')
}
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://grilltime.be'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
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
function zonedParts(date: Date, timeZone = 'Europe/Brussels') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
  }).formatToParts(date)
  return Object.fromEntries(parts.map(p => [p.type, p.value])) as Record<string, string>
}
function offsetMs(date: Date, timeZone: string) {
  const p = zonedParts(date, timeZone)
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - date.getTime()
}
function localToUtc(y: number, m: number, d: number, h: number, min: number, timeZone: string) {
  const wall = Date.UTC(y, m - 1, d, h, min, 0)
  let guess = new Date(wall)
  guess = new Date(wall - offsetMs(guess, timeZone))
  guess = new Date(wall - offsetMs(guess, timeZone))
  return guess
}
function dateLabel(date: Date, timeZone: string, withTime = true) {
  return new Intl.DateTimeFormat('nl-BE', {
    timeZone, weekday: 'short', day: '2-digit', month: '2-digit',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date)
}
function makeSlots(settings: any) {
  const timeZone = settings.timezone || 'Europe/Brussels'
  const now = new Date()
  const nowLocal = zonedParts(now, timeZone)
  const baseNoonUtc = localToUtc(+nowLocal.year, +nowLocal.month, +nowLocal.day, 12, 0, timeZone)
  const opens = clean(settings.opens_at || '12:00', 5).split(':').map(Number)
  const closes = clean(settings.closes_at || '23:00', 5).split(':').map(Number)
  const startMinutes = opens[0] * 60 + opens[1]
  const endMinutes = closes[0] * 60 + closes[1]
  const leadMs = Number(settings.preparation_lead_minutes || 30) * 60_000
  const slots: Array<Record<string, unknown>> = []

  for (let dayOffset = 0; dayOffset < Number(settings.preorder_days || 7); dayOffset++) {
    const dayProbe = new Date(baseNoonUtc.getTime() + dayOffset * 86_400_000)
    const dp = zonedParts(dayProbe, timeZone)
    for (let minutes = startMinutes; minutes <= endMinutes; minutes += 15) {
      const start = localToUtc(+dp.year, +dp.month, +dp.day, Math.floor(minutes / 60), minutes % 60, timeZone)
      if (start.getTime() < now.getTime() + leadMs) continue
      const end = new Date(start.getTime() + 15 * 60_000)
      slots.push({
        startAt: start.toISOString(),
        endAt: end.toISOString(),
        timeLabel: new Intl.DateTimeFormat('nl-BE', { timeZone, hour: '2-digit', minute: '2-digit' }).format(start),
        windowLabel: `${new Intl.DateTimeFormat('nl-BE', { timeZone, hour: '2-digit', minute: '2-digit' }).format(start)}–${new Intl.DateTimeFormat('nl-BE', { timeZone, hour: '2-digit', minute: '2-digit' }).format(end)}`,
        dayLabel: dateLabel(start, timeZone, false),
      })
    }
  }
  const nowMinutes = +nowLocal.hour * 60 + +nowLocal.minute
  const openNow = nowMinutes >= startMinutes && nowMinutes <= endMinutes
  return { slots, openNow }
}
async function resetExpiredDailyStatuses(sb: ReturnType<typeof adminClient>, timeZone: string) {
  const today = `${zonedParts(new Date(), timeZone).year}-${zonedParts(new Date(), timeZone).month}-${zonedParts(new Date(), timeZone).day}`
  await Promise.all([
    sb.from('products').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
    sb.from('option_values').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
    sb.from('ingredients').update({ availability_status: 'available', sold_out_on: null }).eq('availability_status', 'sold_out_today').lt('sold_out_on', today),
  ])
}
async function searchAddresses(query: string) {
  const url = new URL('https://geo.api.vlaanderen.be/geolocation/v4/Suggestion')
  url.searchParams.set('q', `${query}, 8400 Oostende`)
  url.searchParams.set('c', '8')
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if (!response.ok) throw new Error('Adressuggesties zijn tijdelijk niet beschikbaar.')
  const data = await response.json()
  const rows = Array.isArray(data?.SuggestionResult) ? data.SuggestionResult : []
  return rows.map((label: unknown) => clean(label, 240)).filter((label: string) => /,\s*8400\s+Oostende$/i.test(label)).map((label: string) => {
    const match = label.match(/^(.+?)\s+(\d+[A-Za-z]?(?:\s+bus\s+[^,]+)?),\s*8400\s+Oostende$/i)
    if (!match) return null
    const numberParts = match[2].split(/\s+bus\s+/i)
    return { id: label, label, street: match[1], houseNumber: numberParts[0], bus: numberParts[1] || '', postcode: '8400', city: 'Oostende' }
  }).filter(Boolean)
}
async function geocodeSelectedAddress(street: string, houseNumber: string) {
  const url = new URL('https://geo.api.vlaanderen.be/geolocation/v4/Location')
  url.searchParams.set('q', `${street} ${houseNumber}, 8400 Oostende`)
  url.searchParams.set('c', '5')
  const response = await fetch(url, { headers: { 'Accept': 'application/json' } })
  if (!response.ok) throw new Error('Adrescontrole is tijdelijk niet beschikbaar.')
  const data = await response.json()
  const rows = Array.isArray(data?.LocationResult) ? data.LocationResult : []
  const exact = rows.find((r: any) => normalize(r.Municipality) === 'oostende' && String(r.Zipcode) === '8400' && normalize(r.Thoroughfarename) === normalize(street) && clean(r.Housenumber, 20).toLowerCase() === houseNumber.toLowerCase())
  const r = exact || rows.find((x: any) => normalize(x.Municipality) === 'oostende' && String(x.Zipcode) === '8400')
  const lat = Number(r?.Location?.Lat_WGS84), lon = Number(r?.Location?.Lon_WGS84)
  if (!r || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  return { id: String(r.ID || ''), label: clean(r.FormattedAddress, 240), street: clean(r.Thoroughfarename, 120), houseNumber: clean(r.Housenumber, 20), postcode: '8400', city: 'Oostende', lat, lon }
}
async function routeDistanceKm(lat: number, lon: number) {
  const coords = `${RESTAURANT_LON},${RESTAURANT_LAT};${lon},${lat}`
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coords}`)
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
  const origin = req.headers.get('origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(req, { error: 'Origin not allowed' }, 403)
  try {
    const sb = adminClient()
    const url = new URL(req.url)
    const action = url.searchParams.get('action') || 'config'
    if (req.method === 'GET' && action === 'config') {
      const { data: settings, error } = await sb.from('store_settings').select('*').eq('id', 'main').single()
      if (error) throw error
      await resetExpiredDailyStatuses(sb, settings.timezone)
      const generated = makeSlots(settings)
      return json(req, {
        ok: true,
        openingHours: '12:00–23:00',
        deliveryEstimate: `${settings.delivery_estimate_min}–${settings.delivery_estimate_max} minuten`,
        deliveryMinimumCents: settings.delivery_min_cents,
        innerDistanceKm: Number(settings.inner_distance_km), maxDistanceKm: Number(settings.max_distance_km),
        innerFeeCents: settings.inner_fee_cents, outerFeeCents: settings.outer_fee_cents,
        deliveryPaused: settings.delivery_paused,
        storeTemporarilyClosed: settings.store_temporarily_closed,
        acceptingImmediatePickup: generated.openNow && !settings.store_temporarily_closed,
        acceptingImmediateDelivery: generated.openNow && !settings.store_temporarily_closed && !settings.delivery_paused,
        pickupSlots: generated.slots.map(({ startAt, timeLabel, dayLabel }) => ({ startAt, timeLabel, dayLabel })),
        deliverySlots: generated.slots,
        outsideMessage: OUTSIDE_MESSAGE,
      })
    }
    if (req.method === 'GET' && action === 'address') {
      const q = clean(url.searchParams.get('q'), 120)
      if (q.length < 3) return json(req, { ok: true, suggestions: [] })
      return json(req, { ok: true, suggestions: await searchAddresses(q) })
    }
    if (req.method === 'POST' && action === 'quote') {
      const body = await req.json()
      const street = clean(body.street, 120), houseNumber = clean(body.houseNumber, 20)
      if (!street || !houseNumber || clean(body.postcode, 10) !== '8400' || !normalize(body.city).includes('oostende')) {
        return json(req, { ok: false, deliverable: false, error: OUTSIDE_MESSAGE }, 400)
      }
      const place = await geocodeSelectedAddress(street, houseNumber)
      if (!place) return json(req, { ok: false, deliverable: false, error: 'Selecteer een geldig adres uit de adressuggesties.' }, 400)
      const distanceKm = await routeDistanceKm(place.lat, place.lon)
      const { data: settings, error } = await sb.from('store_settings').select('*').eq('id', 'main').single()
      if (error) throw error
      if (distanceKm > Number(settings.max_distance_km)) return json(req, { ok: true, deliverable: false, distanceKm: Number(distanceKm.toFixed(2)), error: OUTSIDE_MESSAGE })
      const feeCents = distanceKm <= Number(settings.inner_distance_km) ? settings.inner_fee_cents : settings.outer_fee_cents
      return json(req, { ok: true, deliverable: true, distanceKm: Number(distanceKm.toFixed(2)), feeCents, matchedAddress: place })
    }
    return json(req, { error: 'Method not allowed' }, 405)
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : 'De service is tijdelijk niet beschikbaar.' }, 500)
  }
})
