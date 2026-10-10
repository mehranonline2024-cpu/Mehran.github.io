import Stripe from 'npm:stripe@^22'
import { createClient } from 'npm:@supabase/supabase-js@2'
import proj4 from 'npm:proj4@2.20.7'

const stripeKey = (Deno.env.get('STRIPE_SECRET_KEY') || '').trim()
const stripe = new Stripe(stripeKey)
const allowedOrigins = new Set(['https://grilltime.be','https://www.grilltime.be'])

// Grill Time, Albert I-promenade 9: verified business-map location.
// The previous rounded point was on Brabantstraat, away from the restaurant.
const RESTAURANT_LAT = 51.2348621
const RESTAURANT_LON = 2.9202485
const DELIVERY_MIN_CENTS = 1500
const OUTSIDE_DELIVERY_MESSAGE = 'Helaas leveren we momenteel alleen binnen 4 km in Oostende. Je kunt je bestelling wel bij Grill Time afhalen.'
const INNER_DISTANCE_KM = 2.5
const MAX_DISTANCE_KM = 4
const INNER_FEE_CENTS = 299
const OUTER_FEE_CENTS = 399
const WELCOME_DISCOUNT_PERCENT = 10

function clean(value: unknown, max = 250) { return String(value ?? '').trim().slice(0, max) }
function normalizePhone(value: unknown) {
  let digits = clean(value, 40).replace(/\D/g, '')
  if (digits.startsWith('0032')) digits = '0' + digits.slice(4)
  else if (digits.startsWith('32') && digits.length === 11) digits = '0' + digits.slice(2)
  return digits
}
function normalizeText(value: unknown) {
  return clean(value, 200).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'')
}
function normalizeDeliveryStreet(value: string) {
  let s = clean(value, 180).replace(/\s+/g, ' ')
  // Accept a pasted full local address without sending the locality twice.
  s = s.replace(/,?\s+8400\s*(?:Oostende|Ostende|Ostend)(?:,?\s+(?:Belgium|Belgi[eë]))?\s*$/i, '').trim()
  s = s.replace(/,\s*(?=\d)/, ' ')
  s = s.replace(/^oude\s*molen\s*straat\b/i, 'Oude Molenstraat')
  // In Oostende, "Vrijheidsstraat" is commonly entered for the official "Vrijheidstraat".
  s = s.replace(/^vrijheidsstraat\b/i, 'Vrijheidstraat')
  return s
}
function extractPostcode(value: string) {
  const m = clean(value, 120).match(/(?:^|\D)(\d{4})(?!\d)/)
  return m ? m[1] : null
}
function expectedPlace(value: string) {
  return normalizeText(clean(value,120).replace(/\d{4}/g,'').replace(/belgi[eë]|belgium/gi,''))
}
function isOostende(value: unknown) {
  return ['oostende', 'ostende', 'ostend'].includes(normalizeText(value))
}
function normalizeDeliveryPlace(value: string) {
  const postcode=extractPostcode(value),place=expectedPlace(value)
  if(!postcode&&!place)return null
  // In this one-city service area a known city name or its postcode is enough.
  // The geocoder still verifies the actual street, house number and locality.
  if((!postcode||postcode==='8400')&&(isOostende(place)||(!place&&postcode==='8400')))return '8400 Oostende'
  return false
}
function isOostendeAddress(address:any) {
  return String(address?.country_code || '').toLowerCase() === 'be'
    && String(address?.postcode || '').trim() === '8400'
    && [address?.city, address?.town, address?.municipality, address?.village].some(isOostende)
}
function outsideDelivery(req: Request) {
  return json(req, {error:OUTSIDE_DELIVERY_MESSAGE,code:'outside_delivery_area',pickupAvailable:true}, 400)
}
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://grilltime.be'
  return {'Access-Control-Allow-Origin':allowOrigin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'GET, POST, OPTIONS','Cache-Control':'no-store'}
}
function json(req: Request, body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type':'application/json; charset=utf-8' } }) }
function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''
  if (!key) { const raw = Deno.env.get('SUPABASE_SECRET_KEYS'); if (raw) { try { const keys = JSON.parse(raw); key = keys.default || Object.values(keys)[0] || '' } catch (_) {} } }
  if (!url || !key) throw new Error('Supabase server configuration ontbreekt')
  return createClient(url, String(key), { auth:{persistSession:false,autoRefreshToken:false} })
}

type SelectionGroup = { key?: string; chosen?: Array<{ raw?: string; label?: string } | string> }
type CartItem = { productId: string; qty: number; itemNote?: string; selectedOptions?: Record<string,string[]>; selections?: SelectionGroup[] }
function normalizeSelectedOptions(raw: CartItem): Record<string,string[]> {
  if (raw.selectedOptions && typeof raw.selectedOptions === 'object' && !Array.isArray(raw.selectedOptions)) {
    const out: Record<string,string[]> = {}
    for (const [key,values] of Object.entries(raw.selectedOptions)) if (Array.isArray(values)) out[clean(key,80)] = values.map(v=>clean(v,100)).filter(Boolean)
    return out
  }
  const out: Record<string,string[]> = {}
  if (!Array.isArray(raw.selections)) return out
  for (const group of raw.selections) {
    const key = clean(group?.key,80)
    if (!key || !Array.isArray(group?.chosen)) continue
    out[key] = group.chosen.map(choice=>typeof choice==='string'?clean(choice,100):clean(choice?.raw||choice?.label,100)).filter(Boolean)
  }
  return out
}
class AddressLookupUnavailable extends Error {
  constructor() { super('Adrescontrole tijdelijk niet beschikbaar') }
}
// Official address-register geometry uses Belgian Lambert 72, not WGS84.
// Include the datum shift; treating these coordinates as GPS changes the route.
const BELGIAN_LAMBERT_72 = '+proj=lcc +lat_1=51.1666672333333 +lat_2=49.8333339 +lat_0=90 +lon_0=4.36748666666667 +x_0=150000.013 +y_0=5400088.438 +ellps=intl +towgs84=-106.8686,52.2978,-103.7239,0.3366,-0.457,1.8422,-1.2747 +units=m +no_defs'
function registerCoordinates(geometry:any) {
  const gml=String(geometry?.gml || '')
  if(geometry?.type!=='Point'||!gml.includes('/EPSG/0/31370'))return null
  const point=gml.match(/<(?:\w+:)?pos>\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s*<\/(?:\w+:)?pos>/)
  if(!point)return null
  const xy=[Number(point[1]),Number(point[2])]
  if(!xy.every(Number.isFinite))return null
  const [lon,lat]=proj4(BELGIAN_LAMBERT_72,'EPSG:4326',xy)
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||lat<50||lat>52||lon<2||lon>7)return null
  return {lat,lon}
}
async function addressLookup(url:URL, provider:string) {
  try {
    const response=await fetch(url,{headers:{'Accept':'application/json','Accept-Language':'nl-BE,nl;q=0.9','User-Agent':'GrillTimeOostende/1.6 (https://grilltime.be)'},signal:AbortSignal.timeout(10000)})
    if(!response.ok){console.warn('Address lookup rejected',{provider,status:response.status});return undefined}
    return await response.json()
  }catch(error){console.warn('Address lookup failed',{provider,reason:error instanceof Error?error.name:'unknown'});return undefined}
}
async function geocodeDeliveryAddress(addressLine:string, city:string) {
  const normalizedStreet = normalizeDeliveryStreet(addressLine)
  // The Flemish address register resolves house numbers directly and remains
  // available when the public Nominatim service throttles or rejects requests.
  const exact = normalizedStreet.match(/^(.+?)\s+(\d+[a-zA-Z]?)(?:\s*\/\s*\w+)?$/)
  if(!exact)return null
  let officialLookupSucceeded=false
  if (exact) {
    try {
      const lookup = new URL('https://geo.api.vlaanderen.be/geolocation/v4/Location')
      lookup.searchParams.set('q', `${normalizedStreet}, 8400 Oostende`)
      lookup.searchParams.set('type', 'Housenumber')
      lookup.searchParams.set('c', '5')
      const data=await addressLookup(lookup,'geolocation')
      if (Array.isArray(data?.LocationResult)) {
        officialLookupSucceeded=true
        const match = data.LocationResult.find((r:any) =>
          String(r?.Zipcode || '') === '8400' && isOostende(r?.Municipality)
          && normalizeText(r?.Thoroughfarename) === normalizeText(exact[1])
          && normalizeText(r?.Housenumber) === normalizeText(exact[2])
          && Number.isFinite(Number(r?.Location?.Lat_WGS84)) && Number.isFinite(Number(r?.Location?.Lon_WGS84)))
        if (match) return {outsideArea:false as const,lat:Number(match.Location.Lat_WGS84),lon:Number(match.Location.Lon_WGS84),displayName:clean(match.FormattedAddress,300),normalizedStreet}
      }
    } catch (error) { console.warn('Flemish address lookup unavailable', error) }
  }
  // An independent, structured official lookup keeps valid addresses working
  // when free-text geocoding fails or public Nominatim rejects server requests.
  const register=new URL('https://api.basisregisters.vlaanderen.be/v2/adresmatch')
  register.searchParams.set('gemeentenaam','Oostende');register.searchParams.set('postcode','8400')
  register.searchParams.set('straatnaam',exact[1]);register.searchParams.set('huisnummer',exact[2]);register.searchParams.set('status','inGebruik')
  const registry=await addressLookup(register,'address-register')
  if(Array.isArray(registry?.adresMatches)) {
    officialLookupSucceeded=true
    for(const match of registry.adresMatches) {
      if(match?.adresStatus!=='inGebruik'||String(match?.postinfo?.objectId)!=='8400'
        ||!isOostende(match?.gemeente?.gemeentenaam?.geografischeNaam?.spelling)
        ||normalizeText(match?.straatnaam?.straatnaam?.geografischeNaam?.spelling)!==normalizeText(exact[1])
        ||normalizeText(match?.huisnummer)!==normalizeText(exact[2])||match?.busnummer)continue
      const point=registerCoordinates(match?.adresPositie?.geometrie)
      if(point)return {outsideArea:false as const,...point,displayName:clean(match?.volledigAdres?.geografischeNaam?.spelling,300),normalizedStreet}
    }
  }
  const q = `${normalizedStreet}, ${city}, Belgium`
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format','jsonv2'); url.searchParams.set('limit','8'); url.searchParams.set('countrycodes','be'); url.searchParams.set('addressdetails','1'); url.searchParams.set('q',q)
  const results=await addressLookup(url,'nominatim')
  // A working official lookup with no exact match means an unrecognized
  // address, even if Nominatim is blocked. It is not a service-wide outage.
  if(!Array.isArray(results)){if(officialLookupSucceeded)return null;throw new AddressLookupUnavailable()}
  if(!results.length)return null
  const candidates = results.filter((r:any) => isOostendeAddress(r?.address)
    && normalizeText(r.address.road||r.address.pedestrian||r.address.residential||r.address.street)===normalizeText(exact[1])
    && normalizeText(r.address.house_number)===normalizeText(exact[2]))
  // A failed or approximate address match is not evidence of being outside 4 km.
  if (!candidates.length) return null
  const first = candidates[0] || null
  if (!first?.lat || !first?.lon) return null
  const lat=Number(first.lat), lon=Number(first.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null
  return {outsideArea:false as const,lat,lon,displayName:clean(first.display_name,300),normalizedStreet}
}
async function drivingDistanceKm(lat:number, lon:number) {
  const coords = `${RESTAURANT_LON},${RESTAURANT_LAT};${lon},${lat}`
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coords}`)
  url.searchParams.set('overview','false'); url.searchParams.set('steps','false'); url.searchParams.set('alternatives','false')
  const response = await fetch(url,{headers:{'Accept':'application/json','User-Agent':'GrillTimeOostende/1.5 (https://grilltime.be)'},signal:AbortSignal.timeout(8000)})
  if(!response.ok) throw new Error('Routecontrole tijdelijk niet beschikbaar. Probeer opnieuw.')
  const data = await response.json(); const meters = data?.routes?.[0]?.distance
  if(typeof meters!=='number'||!Number.isFinite(meters)||meters<0) throw new Error('We konden geen geldige route naar dit adres berekenen.')
  return meters/1000
}

async function readDeliveryPaused(supabase: ReturnType<typeof getAdminClient>) {
  const {data,error}=await supabase.from('store_settings').select('delivery_paused').eq('id','main').single()
  if(error||typeof data?.delivery_paused!=='boolean')throw new Error('Bezorgstatus tijdelijk niet beschikbaar. Probeer opnieuw of kies afhalen.')
  return data.delivery_paused
}
const STORE_SETTINGS_COLUMNS='timezone,opens_at,closes_at,preorder_days,preparation_lead_minutes,delivery_estimate_min,delivery_estimate_max,delivery_paused'
function zonedParts(date:Date,timezone:string) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(date).map(x=>[x.type,x.value])) as Record<string,string>
}
function timeMinutes(value:string) {
  const m=String(value||'').match(/^(\d{2}):(\d{2})/)
  if(!m)return NaN
  const h=Number(m[1]),minute=Number(m[2])
  return h<=23&&minute<=59?h*60+minute:NaN
}
function validateRequestedSlot(body:any,settings:any,now=new Date()) {
  const requestedAt=new Date(String(body.requestedAt||''))
  if(!Number.isFinite(requestedAt.getTime()))return {error:'Kies een geldig bestel- of bezorgmoment.'}
  const timezone=String(settings?.timezone||'Europe/Brussels')
  const opens=timeMinutes(settings?.opens_at),closes=timeMinutes(settings?.closes_at)
  const lead=Number(settings?.preparation_lead_minutes)
  const preorderDays=Number(settings?.preorder_days)
  if(!Number.isFinite(opens)||!Number.isFinite(closes)||closes<=opens||!Number.isFinite(lead)||lead<0||!Number.isFinite(preorderDays)||preorderDays<0)return {error:'Tijdinstellingen zijn tijdelijk niet beschikbaar. Probeer opnieuw.'}
  if(requestedAt.getTime()<now.getTime()+lead*60_000)return {error:`Kies een tijdstip minstens ${lead} minuten later.`}
  const requested=zonedParts(requestedAt,timezone),today=zonedParts(now,timezone)
  const dayNumber=(p:Record<string,string>)=>Date.UTC(Number(p.year),Number(p.month)-1,Number(p.day))/86_400_000
  const dayOffset=dayNumber(requested)-dayNumber(today)
  if(dayOffset<0||dayOffset>preorderDays)return {error:`Je kunt maximaal ${preorderDays} dagen vooruitbestellen.`}
  const minute=Number(requested.hour)*60+Number(requested.minute)
  if(minute%15!==0||minute<opens||minute>closes)return {error:'Kies een tijdstip tussen 12:00 en 23:00 in stappen van 15 minuten.'}
  let requestedWindowEnd:string|null=null
  if(body.orderType==='delivery'){
    const suppliedEnd=new Date(String(body.requestedWindowEnd||''))
    const expectedEnd=requestedAt.getTime()+15*60_000
    if(!Number.isFinite(suppliedEnd.getTime())||Math.abs(suppliedEnd.getTime()-expectedEnd)>1_000||minute+15>closes)return {error:'Kies een geldig bezorgvenster van 15 minuten.'}
    requestedWindowEnd=suppliedEnd.toISOString()
  }else if(body.requestedWindowEnd)return {error:'Ongeldige afhaaltijd.'}
  const requestedTime=body.orderType==='delivery'?`${requested.year}-${requested.month}-${requested.day} ${requested.hour}:${requested.minute}–${zonedParts(new Date(requestedAt.getTime()+15*60_000),timezone).hour}:${zonedParts(new Date(requestedAt.getTime()+15*60_000),timezone).minute}`:`${requested.year}-${requested.month}-${requested.day} ${requested.hour}:${requested.minute}`
  return {requestedAt:requestedAt.toISOString(),requestedWindowEnd,requestedTime}
}
function pausedDelivery(req: Request) {
  return json(req,{error:'Bezorgen is tijdelijk gepauzeerd wegens drukte. Je kunt je bestelling wel afhalen.',code:'delivery_paused',pickupAvailable:true},409)
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') {
    const origin=req.headers.get('origin')||''
    if(origin&&!allowedOrigins.has(origin)) return new Response('Forbidden origin',{status:403,headers:cors(req)})
    return new Response('ok',{headers:cors(req)})
  }
  if(req.method==='GET'){
    const origin=req.headers.get('origin')||''
    if(origin&&!allowedOrigins.has(origin))return json(req,{error:'Origin not allowed'},403)
    try{
      const {data,error}=await getAdminClient().from('store_settings').select(STORE_SETTINGS_COLUMNS).eq('id','main').single()
      if(error||typeof data?.delivery_paused!=='boolean')throw new Error('Settings unavailable')
      return json(req,{deliveryPaused:data.delivery_paused,settings:{timezone:data.timezone,opensAt:String(data.opens_at).slice(0,5),closesAt:String(data.closes_at).slice(0,5),preorderDays:data.preorder_days,preparationLeadMinutes:data.preparation_lead_minutes,deliveryEstimateMin:data.delivery_estimate_min,deliveryEstimateMax:data.delivery_estimate_max}})
    }
    catch(_){return json(req,{error:'Bezorgstatus tijdelijk niet beschikbaar'},503)}
  }
  if(req.method!=='POST') return json(req,{error:'Method not allowed'},405)
  const origin=req.headers.get('origin')||''
  if(origin&&!allowedOrigins.has(origin)) return json(req,{error:'Origin not allowed'},403)
  if(Number(req.headers.get('content-length')||0)>100_000) return json(req,{error:'Request te groot'},413)

  try {
    const body = await req.json()
    const quoteOnly = body.quoteOnly === true
    // Keep already-open checkout pages working while GitHub Pages deploys the new form.
    const legacyClient = !quoteOnly && body.expectedPrice === undefined && body.termsAccepted === undefined
    const paymentMethod = body.paymentMethod === 'cash' ? 'cash' : 'online'
    if(paymentMethod==='online' && !stripeKey) throw new Error('Stripe secret ontbreekt')
    const items = Array.isArray(body.items)?body.items as CartItem[]:[]
    if(!items.length||items.length>40) return json(req,{error:'Ongeldig winkelmandje'},400)

    const customer={name:clean(body.customer?.name,100),phone:clean(body.customer?.phone,40),email:clean(body.customer?.email,160)||null}
    const phoneNormalized=normalizePhone(customer.phone)
    if(!customer.name||!customer.phone||phoneNormalized.length<8) return json(req,{error:'Naam en geldig telefoonnummer zijn verplicht'},400)
    const orderType=body.orderType==='delivery'?'delivery':'pickup'
    const addressLine=normalizeDeliveryStreet(clean(body.address,180))||null
    const city=orderType==='delivery'?normalizeDeliveryPlace(clean(body.city,120)):null
    if(orderType==='delivery'&&(!addressLine||city===null)) return json(req,{error:'Vul je straat, huisnummer en postcode/gemeente in.',code:'incomplete_delivery_address'},400)
    if(orderType==='delivery'&&city===false)return outsideDelivery(req)

    const productIds=[...new Set(items.map(i=>clean(i.productId,80)).filter(Boolean))]
    if(!productIds.length) return json(req,{error:'Ongeldig winkelmandje'},400)
    const supabase=getAdminClient()
    const {data:storeSettings,error:settingsError}=await supabase.from('store_settings').select(STORE_SETTINGS_COLUMNS).eq('id','main').single()
    if(settingsError||!storeSettings)return json(req,{error:'Tijdinstellingen zijn tijdelijk niet beschikbaar. Probeer opnieuw.'},503)
    if(orderType==='delivery' && storeSettings.delivery_paused)return pausedDelivery(req)
    const slot=validateRequestedSlot({...body,orderType},storeSettings)
    if('error' in slot)return json(req,{error:slot.error},400)

    if(!quoteOnly){
      const tenMinutesAgo=new Date(Date.now()-10*60*1000).toISOString()
      const {count:recentOrders,error:recentError}=await supabase.from('orders').select('id',{count:'exact',head:true}).eq('customer_phone',customer.phone).gte('created_at',tenMinutesAgo)
      if(recentError) throw recentError
      if((recentOrders||0)>=6) return json(req,{error:'Te veel recente bestelpogingen. Probeer later opnieuw.'},429)
      if(!legacyClient && body.termsAccepted!==true)return json(req,{error:'Bevestig eerst de voorwaarden en het privacybeleid.'},400)
    }

    const {data:products,error:productError}=await supabase.from('products').select('id,name,category,price_cents,active').in('id',productIds).eq('active',true)
    if(productError) throw productError
    const productMap=new Map((products||[]).map((p:any)=>[p.id,p]))
    if(productMap.size!==productIds.length) return json(req,{error:'Een product is niet meer beschikbaar'},400)

    const {data:links,error:linkError}=await supabase.from('product_option_groups').select('product_id,group_id').in('product_id',productIds)
    if(linkError) throw linkError
    const groupIds=[...new Set((links||[]).map((x:any)=>x.group_id))]
    const [{data:groups,error:groupError},{data:values,error:valueError}]=await Promise.all([
      groupIds.length?supabase.from('option_groups').select('*').in('id',groupIds):Promise.resolve({data:[],error:null} as any),
      groupIds.length?supabase.from('option_values').select('*').in('group_id',groupIds).eq('active',true):Promise.resolve({data:[],error:null} as any)
    ])
    if(groupError) throw groupError; if(valueError) throw valueError
    const groupMap=new Map((groups||[]).map((g:any)=>[g.id,g])); const valuesByGroup=new Map<string,any[]>(); const groupsByProduct=new Map<string,string[]>()
    for(const value of values||[]){const arr=valuesByGroup.get((value as any).group_id)||[];arr.push(value);valuesByGroup.set((value as any).group_id,arr)}
    for(const link of links||[]){const x=link as any;const arr=groupsByProduct.get(x.product_id)||[];arr.push(x.group_id);groupsByProduct.set(x.product_id,arr)}

    const checkedItems:any[]=[]; let subtotalCents=0; let foodSubtotalCents=0
    for(const raw of items){
      const product=productMap.get(clean(raw.productId,80)) as any; if(!product) return json(req,{error:'Ongeldig product'},400)
      const qty=Number(raw.qty); if(!Number.isInteger(qty)||qty<1||qty>20) return json(req,{error:'Ongeldig aantal'},400)
      const itemNote=clean(raw.itemNote,150)||null; const selected=normalizeSelectedOptions(raw); const linkedGroupIds=groupsByProduct.get(product.id)||[]; const linkedSet=new Set(linkedGroupIds)
      for(const suppliedGroup of Object.keys(selected)) if(!linkedSet.has(suppliedGroup)) return json(req,{error:'Ongeldige optiegroep voor dit product'},400)
      let unitPriceCents=Number(product.price_cents); const details:string[]=[]; const normalized:Record<string,string[]>={}
      for(const groupId of linkedGroupIds){
        const group=groupMap.get(groupId) as any; if(!group) continue
        const chosen=[...new Set(Array.isArray(selected[groupId])?selected[groupId].map(v=>clean(v,100)).filter(Boolean):[])]
        if(group.required&&chosen.length===0) return json(req,{error:`Maak een keuze bij ${group.title}`},400)
        if(group.input_type==='radio'&&chosen.length>1) return json(req,{error:`Ongeldige keuze bij ${group.title}`},400)
        if(group.max_select&&chosen.length>Number(group.max_select)) return json(req,{error:`Te veel keuzes bij ${group.title}`},400)
        const allowed=valuesByGroup.get(groupId)||[]; const allowedByLabel=new Map(allowed.map((v:any)=>[v.label,v])); normalized[groupId]=[]
        for(const label of chosen){const value=allowedByLabel.get(label) as any;if(!value)return json(req,{error:`Ongeldige optie: ${label}`},400);unitPriceCents+=Number(value.price_delta_cents||0);normalized[groupId].push(label);details.push(`${group.display_prefix||''}${label}`)}
      }
      const lineTotalCents=unitPriceCents*qty; subtotalCents+=lineTotalCents
      if(product.category !== 'Drinks') foodSubtotalCents+=lineTotalCents
      if(subtotalCents>200_000) return json(req,{error:'Bestelbedrag is te hoog'},400)
      checkedItems.push({productId:product.id,name:product.name,qty,unitPriceCents,lineTotalCents,selectedOptions:normalized,details,itemNote})
    }
    if(subtotalCents<50) return json(req,{error:'Bestelbedrag is te laag'},400)

    const {data:matchingCustomers,error:matchingError}=await supabase.from('customers').select('id,order_count').eq('phone_normalized',phoneNormalized)
    if(matchingError) throw matchingError
    const priorPaidOrders=(matchingCustomers||[]).reduce((sum:number,c:any)=>sum+Number(c.order_count||0),0)
    const isWelcomeCustomer=priorPaidOrders===0
    const discountCents=isWelcomeCustomer?Math.round(subtotalCents*WELCOME_DISCOUNT_PERCENT/100):0
    const discountCode=discountCents>0?'WELCOME10':null

    let deliveryFeeCents=0; let deliveryDistanceKm:number|null=null; let deliveryAddress:string|null=null
    if(orderType==='delivery'){
      if(foodSubtotalCents<DELIVERY_MIN_CENTS) return json(req,{error:'Minimum bestelling aan eten is €15,00, exclusief losse dranken en bezorgkosten.'},400)
      const geo=await geocodeDeliveryAddress(addressLine!,String(city)); if(!geo) return json(req,{error:'Adres niet gevonden. Controleer de straatnaam en het huisnummer in 8400 Oostende.',code:'address_not_found'},400)
      deliveryAddress=geo.displayName||`${addressLine}, ${city}`
      deliveryDistanceKm=await drivingDistanceKm(geo.lat,geo.lon)
      if(deliveryDistanceKm>MAX_DISTANCE_KM) return outsideDelivery(req)
      deliveryFeeCents=deliveryDistanceKm<=INNER_DISTANCE_KM?INNER_FEE_CENTS:OUTER_FEE_CENTS
    }
    const totalCents=subtotalCents-discountCents+deliveryFeeCents

    // Recheck after address/route lookups, before creating a customer or order.
    if(orderType==='delivery' && await readDeliveryPaused(supabase))return pausedDelivery(req)
    const finalSlot=validateRequestedSlot({...body,orderType},storeSettings)
    if('error' in finalSlot)return json(req,{error:finalSlot.error},400)

    const priceBreakdown={subtotalCents,discountCents,discountCode,deliveryFeeCents,totalCents}
    if(quoteOnly)return json(req,{ok:true,quote:true,...priceBreakdown,deliveryAddress,deliveryDistanceKm:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),requestedTime:finalSlot.requestedTime})
    const expected=body.expectedPrice
    if(!legacyClient && (!expected||!Object.entries(priceBreakdown).every(([key,value])=>expected[key]===value)))return json(req,{error:'Het totaal is gewijzigd. Controleer de nieuwe prijs voordat je bestelt.',code:'price_changed'},409)

    let customerId:string; const existingCustomer=(matchingCustomers||[])[0] as any
    if(existingCustomer?.id){const {data:updated,error}=await supabase.from('customers').update({name:customer.name,phone:customer.phone,email:customer.email,phone_normalized:phoneNormalized}).eq('id',existingCustomer.id).select('id').single();if(error)throw error;customerId=updated.id}
    else {const {data:inserted,error}=await supabase.from('customers').insert({name:customer.name,phone:customer.phone,email:customer.email,phone_normalized:phoneNormalized}).select('id').single();if(error)throw error;customerId=inserted.id}

    const {data:order,error:orderError}=await supabase.from('orders').insert({
      customer_id:customerId,customer_name:customer.name,customer_phone:customer.phone,customer_email:customer.email,
      order_type:orderType,requested_time:finalSlot.requestedTime,requested_at:finalSlot.requestedAt,requested_window_end:finalSlot.requestedWindowEnd,address_line:addressLine,city,notes:clean(body.notes,500)||null,
      status:paymentMethod==='cash'?'new':'pending_payment',payment_status:'unpaid',payment_method:paymentMethod,
      subtotal_cents:subtotalCents,discount_cents:discountCents,discount_code:discountCode,
      delivery_fee_cents:deliveryFeeCents,delivery_distance_km:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),delivery_distance_method:orderType==='delivery'?'driving':null,
      total_cents:totalCents,currency:'eur'
      ,terms_accepted_at:body.termsAccepted===true?new Date().toISOString():null,marketing_consent:body.marketingConsent===true
    }).select('id,order_number,total_cents,tracking_token').single()
    if(orderError) throw orderError

    const {error:itemError}=await supabase.from('order_items').insert(checkedItems.map(i=>({order_id:order.id,product_id:i.productId,product_name:i.name,quantity:i.qty,unit_price_cents:i.unitPriceCents,line_total_cents:i.lineTotalCents,selected_options:i.selectedOptions,details:i.details,item_note:i.itemNote})))
    if(itemError) throw itemError

    if(paymentMethod==='cash'){
      return json(req,{ok:true,cashOrder:true,trackingToken:order.tracking_token,orderNumber:order.order_number,requestedTime:finalSlot.requestedTime,subtotalCents,discountCents,discountCode,welcomeDiscountApplied:discountCents>0,deliveryFeeCents,deliveryDistanceKm:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),totalCents:order.total_cents})
    }

    const siteUrl=(Deno.env.get('SITE_URL')||'https://grilltime.be').replace(/\/$/,'')
    try{
      const lineItems:Stripe.Checkout.SessionCreateParams.LineItem[]=checkedItems.map(i=>({quantity:i.qty,price_data:{currency:'eur',unit_amount:i.unitPriceCents,product_data:{name:i.name,description:[...i.details,...(i.itemNote?[`Opmerking: ${i.itemNote}`]:[])].join(' · ').slice(0,450)||undefined}}}))
      if(deliveryFeeCents>0) lineItems.push({quantity:1,price_data:{currency:'eur',unit_amount:deliveryFeeCents,product_data:{name:'Bezorgkosten'}}})
      let discounts:Stripe.Checkout.SessionCreateParams.Discount[]|undefined
      if(discountCents>0){const coupon=await stripe.coupons.create({amount_off:discountCents,currency:'eur',duration:'once',name:'Welkomstkorting 10%'});discounts=[{coupon:coupon.id}]}
      const session=await stripe.checkout.sessions.create({mode:'payment',line_items:lineItems,discounts,customer_email:customer.email||undefined,client_reference_id:order.id,success_url:`${siteUrl}/order/?payment=success&session_id={CHECKOUT_SESSION_ID}`,cancel_url:`${siteUrl}/order/?payment=cancelled`,metadata:{order_id:order.id,order_number:String(order.order_number),delivery_fee_cents:String(deliveryFeeCents),delivery_distance_km:deliveryDistanceKm===null?'':deliveryDistanceKm.toFixed(2),discount_code:discountCode||'',discount_cents:String(discountCents)},locale:'nl'})
      const {error:updateError}=await supabase.from('orders').update({stripe_checkout_session_id:session.id}).eq('id',order.id);if(updateError)throw updateError
      return json(req,{ok:true,checkoutUrl:session.url,orderNumber:order.order_number,subtotalCents,discountCents,discountCode,welcomeDiscountApplied:discountCents>0,deliveryFeeCents,deliveryDistanceKm:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),totalCents:order.total_cents,mode:stripeKey.includes('_test_')?'test':'live'})
    }catch(stripeError){await supabase.from('orders').update({status:'cancelled',payment_status:'failed'}).eq('id',order.id);throw stripeError}
  }catch(error){console.error(error);if(error instanceof AddressLookupUnavailable)return json(req,{error:error.message,code:'address_lookup_unavailable',pickupAvailable:true},503);return json(req,{error:error instanceof Error?error.message:'Checkout kon niet worden gestart. Probeer opnieuw.'},500)}
})
