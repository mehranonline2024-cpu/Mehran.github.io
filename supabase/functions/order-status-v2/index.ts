import { createClient } from 'npm:@supabase/supabase-js@2'

const allowedOrigins = new Set([
  'https://grilltime.be', 'https://www.grilltime.be',
  'http://localhost:4173', 'http://127.0.0.1:4173',
])
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://grilltime.be',
    'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Cache-Control': 'no-store',
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
function message(status: string, paymentStatus: string) {
  if (status === 'pending_payment' && paymentStatus !== 'paid') return 'Betaling wordt gecontroleerd…'
  if (status === 'new' || status === 'pending_payment') return 'Bestelling ontvangen! Wacht even op de bevestiging van Grill Time.'
  if (['accepted', 'preparing', 'ready'].includes(status)) return 'Bestelling bevestigd. Geschatte bezorgtijd: 25–45 minuten.'
  if (status === 'on_way') return 'Je bestelling is onderweg. Smakelijk!'
  if (status === 'completed') return 'Bestelling afgerond. Smakelijk!'
  if (status === 'rejected') return 'De bestelling kon helaas niet worden aangenomen. Neem gerust contact op met Grill Time.'
  if (status === 'cancelled') return 'Deze bestelling werd geannuleerd.'
  return 'Bestelling ontvangen! Wacht even op de bevestiging van Grill Time.'
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405)
  const origin = req.headers.get('origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(req, { error: 'Origin not allowed' }, 403)
  try {
    const token = new URL(req.url).searchParams.get('token') || ''
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) return json(req, { error: 'Ongeldige volgcode.' }, 400)
    const { data: order, error } = await adminClient().from('orders').select('order_number,customer_name,order_type,requested_time,total_cents,payment_status,payment_method,status,delivery_fee_cents,delivery_distance_km,created_at,accepted_at,on_way_at,completed_at').eq('tracking_token', token).maybeSingle()
    if (error) throw error
    if (!order) return json(req, { error: 'Bestelling niet gevonden.' }, 404)
    return json(req, {
      ok: true, orderNumber: order.order_number, customerName: order.customer_name,
      orderType: order.order_type, requestedTime: order.requested_time, totalCents: order.total_cents,
      paymentStatus: order.payment_status, paymentMethod: order.payment_method,
      status: order.status, message: message(order.status, order.payment_status),
      deliveryEstimate: '25–45 minuten', deliveryFeeCents: order.delivery_fee_cents,
      deliveryDistanceKm: order.delivery_distance_km,
      updatedAt: order.completed_at || order.on_way_at || order.accepted_at || order.created_at,
    })
  } catch (error) {
    console.error(error)
    return json(req, { error: 'Bestelstatus kon niet worden geladen.' }, 500)
  }
})
