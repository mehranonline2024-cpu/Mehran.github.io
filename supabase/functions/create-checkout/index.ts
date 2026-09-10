import Stripe from 'npm:stripe@^22'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripeKey = (Deno.env.get('STRIPE_SECRET_KEY') || '').trim()
const stripe = new Stripe(stripeKey)
const allowedOrigins = new Set(['https://grilltime.be','https://www.grilltime.be'])

const RESTAURANT_LAT = 51.2330
const RESTAURANT_LON = 2.9185
const DELIVERY_MIN_CENTS = 1500
const FREE_DELIVERY_CENTS = 5000
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
  let s = clean(value, 180)
  s = s.replace(/^oude\s*molen\s*straat\b/i, 'Oude Molenstraat')
  return s
}
function extractPostcode(value: string) {
  const m = clean(value, 120).match(/\b(\d{4})\b/)
  return m ? m[1] : null
}
function expectedPlace(value: string) {
  return normalizeText(clean(value,120).replace(/\b\d{4}\b/g,'').replace(/belgi[eë]|belgium/gi,''))
}
function candidatePlace(address:any) {
  return normalizeText(address?.city || address?.town || address?.municipality || address?.village || address?.hamlet || '')
}
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://grilltime.be'
  return {'Access-Control-Allow-Origin':allowOrigin,'Vary':'Origin','Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store'}
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
async function geocodeDeliveryAddress(addressLine:string, city:string) {
  const normalizedStreet = normalizeDeliveryStreet(addressLine)
  const q = `${normalizedStreet}, ${city}, Belgium`
  const expectedPc = extractPostcode(city)
  const expectedCity = expectedPlace(city)
  const url = new URL('https://nominatim.openstreetmap.org/search')
  url.searchParams.set('format','jsonv2'); url.searchParams.set('limit','8'); url.searchParams.set('countrycodes','be'); url.searchParams.set('addressdetails','1'); url.searchParams.set('q',q)
  const response = await fetch(url,{headers:{'Accept':'application/json','Accept-Language':'nl-BE,nl;q=0.9','User-Agent':'GrillTimeOostende/1.5 (https://grilltime.be)'}})
  if (!response.ok) throw new Error('Adrescontrole tijdelijk niet beschikbaar')
  const results = await response.json()
  if (!Array.isArray(results) || !results.length) return null
  const candidates = results.filter((r:any)=>{
    const a = r?.address || {}
    if (String(a.country_code || '').toLowerCase() !== 'be') return false
    if (expectedPc && String(a.postcode || '').trim() && String(a.postcode).trim() !== expectedPc) return false
    if (expectedCity) {
      const place = candidatePlace(a)
      if (place && !place.includes(expectedCity) && !expectedCity.includes(place)) return false
    }
    return true
  })
  const first = candidates[0] || null
  if (!first?.lat || !first?.lon) return null
  const lat=Number(first.lat), lon=Number(first.lon); if(!Number.isFinite(lat)||!Number.isFinite(lon)) return null
  return {lat,lon,displayName:clean(first.display_name,300),normalizedStreet}
}
async function drivingDistanceKm(lat:number, lon:number) {
  const coords = `${RESTAURANT_LON},${RESTAURANT_LAT};${lon},${lat}`
  const url = new URL(`https://router.project-osrm.org/route/v1/driving/${coords}`)
  url.searchParams.set('overview','false'); url.searchParams.set('steps','false'); url.searchParams.set('alternatives','false')
  const response = await fetch(url,{headers:{'Accept':'application/json','User-Agent':'GrillTimeOostende/1.5 (https://grilltime.be)'}})
  if(!response.ok) throw new Error('Routecontrole tijdelijk niet beschikbaar. Probeer opnieuw.')
  const data = await response.json(); const meters = Number(data?.routes?.[0]?.distance)
  if(!Number.isFinite(meters)||meters<=0) throw new Error('We konden geen geldige route naar dit adres berekenen.')
  return meters/1000
}

Deno.serve(async (req)=>{
  if(req.method==='OPTIONS') {
    const origin=req.headers.get('origin')||''
    if(origin&&!allowedOrigins.has(origin)) return new Response('Forbidden origin',{status:403,headers:cors(req)})
    return new Response('ok',{headers:cors(req)})
  }
  if(req.method!=='POST') return json(req,{error:'Method not allowed'},405)
  const origin=req.headers.get('origin')||''
  if(origin&&!allowedOrigins.has(origin)) return json(req,{error:'Origin not allowed'},403)
  if(Number(req.headers.get('content-length')||0)>100_000) return json(req,{error:'Request te groot'},413)

  try {
    const body = await req.json()
    const paymentMethod = body.paymentMethod === 'cash' ? 'cash' : 'online'
    if(paymentMethod==='online' && !stripeKey) throw new Error('Stripe secret ontbreekt')
    const items = Array.isArray(body.items)?body.items as CartItem[]:[]
    if(!items.length||items.length>40) return json(req,{error:'Ongeldig winkelmandje'},400)

    const customer={name:clean(body.customer?.name,100),phone:clean(body.customer?.phone,40),email:clean(body.customer?.email,160)||null}
    const phoneNormalized=normalizePhone(customer.phone)
    if(!customer.name||!customer.phone||phoneNormalized.length<8) return json(req,{error:'Naam en geldig telefoonnummer zijn verplicht'},400)
    const orderType=body.orderType==='delivery'?'delivery':'pickup'
    const addressLine=clean(body.address,180)||null, city=clean(body.city,120)||null
    if(orderType==='delivery'&&(!addressLine||!city)) return json(req,{error:'Bezorgadres ontbreekt'},400)

    const productIds=[...new Set(items.map(i=>clean(i.productId,80)).filter(Boolean))]
    if(!productIds.length) return json(req,{error:'Ongeldig winkelmandje'},400)
    const supabase=getAdminClient()

    const tenMinutesAgo=new Date(Date.now()-10*60*1000).toISOString()
    const {count:recentOrders,error:recentError}=await supabase.from('orders').select('id',{count:'exact',head:true}).eq('customer_phone',customer.phone).gte('created_at',tenMinutesAgo)
    if(recentError) throw recentError
    if((recentOrders||0)>=6) return json(req,{error:'Te veel recente bestelpogingen. Probeer later opnieuw.'},429)

    const {data:products,error:productError}=await supabase.from('products').select('id,name,price_cents,active').in('id',productIds).eq('active',true)
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

    const checkedItems:any[]=[]; let subtotalCents=0
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

    let deliveryFeeCents=0; let deliveryDistanceKm:number|null=null
    if(orderType==='delivery'){
      if(subtotalCents<DELIVERY_MIN_CENTS) return json(req,{error:'Minimum bestelling voor bezorging is €15,00'},400)
      const geo=await geocodeDeliveryAddress(addressLine!,city!); if(!geo) return json(req,{error:'We konden dit adres niet betrouwbaar koppelen aan de opgegeven postcode/gemeente. Controleer de straatnaam, huisnummer, postcode en gemeente.'},400)
      deliveryDistanceKm=await drivingDistanceKm(geo.lat,geo.lon)
      if(deliveryDistanceKm>MAX_DISTANCE_KM) return json(req,{error:`Dit adres ligt buiten ons bezorggebied van ${MAX_DISTANCE_KM} km rijafstand.`},400)
      if(subtotalCents>=FREE_DELIVERY_CENTS) deliveryFeeCents=0
      else deliveryFeeCents=deliveryDistanceKm<=INNER_DISTANCE_KM?INNER_FEE_CENTS:OUTER_FEE_CENTS
    }
    const totalCents=subtotalCents-discountCents+deliveryFeeCents

    let customerId:string; const existingCustomer=(matchingCustomers||[])[0] as any
    if(existingCustomer?.id){const {data:updated,error}=await supabase.from('customers').update({name:customer.name,phone:customer.phone,email:customer.email,phone_normalized:phoneNormalized}).eq('id',existingCustomer.id).select('id').single();if(error)throw error;customerId=updated.id}
    else {const {data:inserted,error}=await supabase.from('customers').insert({name:customer.name,phone:customer.phone,email:customer.email,phone_normalized:phoneNormalized}).select('id').single();if(error)throw error;customerId=inserted.id}

    const requestedTime=clean(body.requestedTime??body.time,80)||'Zo snel mogelijk'
    const {data:order,error:orderError}=await supabase.from('orders').insert({
      customer_id:customerId,customer_name:customer.name,customer_phone:customer.phone,customer_email:customer.email,
      order_type:orderType,requested_time:requestedTime,address_line:addressLine,city,notes:clean(body.notes,500)||null,
      status:paymentMethod==='cash'?'new':'pending_payment',payment_status:'unpaid',payment_method:paymentMethod,
      subtotal_cents:subtotalCents,discount_cents:discountCents,discount_code:discountCode,
      delivery_fee_cents:deliveryFeeCents,delivery_distance_km:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),delivery_distance_method:orderType==='delivery'?'driving':null,
      total_cents:totalCents,currency:'eur'
    }).select('id,order_number,total_cents').single()
    if(orderError) throw orderError

    const {error:itemError}=await supabase.from('order_items').insert(checkedItems.map(i=>({order_id:order.id,product_id:i.productId,product_name:i.name,quantity:i.qty,unit_price_cents:i.unitPriceCents,line_total_cents:i.lineTotalCents,selected_options:i.selectedOptions,details:i.details,item_note:i.itemNote})))
    if(itemError) throw itemError

    if(paymentMethod==='cash'){
      return json(req,{ok:true,cashOrder:true,orderNumber:order.order_number,subtotalCents,discountCents,discountCode,welcomeDiscountApplied:discountCents>0,deliveryFeeCents,deliveryDistanceKm:deliveryDistanceKm===null?null:Number(deliveryDistanceKm.toFixed(2)),totalCents:order.total_cents})
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
  }catch(error){console.error(error);return json(req,{error:error instanceof Error?error.message:'Checkout kon niet worden gestart. Probeer opnieuw.'},500)}
})
