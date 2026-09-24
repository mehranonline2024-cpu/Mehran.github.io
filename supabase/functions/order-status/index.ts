import Stripe from 'npm:stripe@^22'
import { createClient } from 'npm:@supabase/supabase-js@2'

const stripeKey = (Deno.env.get('STRIPE_SECRET_KEY') || '').trim()
const stripe = new Stripe(stripeKey)
const allowedOrigins = new Set(['https://grilltime.be','https://www.grilltime.be'])

function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowOrigin = allowedOrigins.has(origin) ? origin : 'https://grilltime.be'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Cache-Control': 'no-store',
  }
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8' },
  })
}

function getAdminClient() {
  const url = Deno.env.get('SUPABASE_URL') || ''
  let key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SECRET_KEY') || ''
  if (!key) {
    const raw = Deno.env.get('SUPABASE_SECRET_KEYS')
    if (raw) {
      try {
        const keys = JSON.parse(raw)
        key = keys.default || Object.values(keys)[0] || ''
      } catch (_) {}
    }
  }
  if (!url || !key) throw new Error('Supabase server configuration ontbreekt')
  return createClient(url, String(key), { auth: { persistSession: false, autoRefreshToken: false } })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    const origin = req.headers.get('origin') || ''
    if (origin && !allowedOrigins.has(origin)) return new Response('Forbidden origin', { status: 403, headers: cors(req) })
    return new Response('ok', { headers: cors(req) })
  }

  if (req.method !== 'GET') return json(req, { error: 'Method not allowed' }, 405)
  const origin = req.headers.get('origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(req, { error: 'Origin not allowed' }, 403)
  if (!stripeKey) return json(req, { error: 'Betalingscontrole tijdelijk niet beschikbaar.' }, 503)

  try {
    const url = new URL(req.url)
    const sessionId = url.searchParams.get('session_id') || ''
    if (!sessionId.startsWith('cs_') || sessionId.length > 200) return json(req, { error: 'Ongeldige Stripe session' }, 400)

    const session = await stripe.checkout.sessions.retrieve(sessionId)
    const supabase = getAdminClient()

    let { data: order, error } = await supabase
      .from('orders')
      .select('id,order_number,customer_name,order_type,total_cents,payment_status,status,stripe_checkout_session_id,requested_time')
      .eq('stripe_checkout_session_id', sessionId)
      .maybeSingle()

    if (error) throw error
    if (!order) return json(req, { error: 'Bestelling niet gevonden' }, 404)

    const boundOrderId = typeof session.client_reference_id === 'string' ? session.client_reference_id : ''
    const metadataOrderId = typeof session.metadata?.order_id === 'string' ? session.metadata.order_id : ''
    if ((boundOrderId && boundOrderId !== order.id) || (metadataOrderId && metadataOrderId !== order.id)) {
      console.error('Stripe/order binding mismatch', { sessionId, orderId: order.id })
      return json(req, { error: 'Betalingscontrole mislukt.' }, 409)
    }

    if (session.payment_status === 'paid' && order.payment_status !== 'paid') {
      const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : null
      const { error: paidError } = await supabase.rpc('mark_order_paid', {
        p_session_id: sessionId,
        p_payment_intent_id: paymentIntentId,
      })
      if (paidError) throw paidError

      const refreshed = await supabase
        .from('orders')
        .select('id,order_number,customer_name,order_type,total_cents,payment_status,status,requested_time')
        .eq('id', order.id)
        .single()
      if (refreshed.error) throw refreshed.error
      order = refreshed.data
    }

    return json(req, {
      ok: true,
      orderNumber: order.order_number,
      customerName: order.customer_name,
      orderType: order.order_type,
      requestedTime: order.requested_time,
      totalCents: order.total_cents,
      paymentStatus: order.payment_status,
      status: order.status,
    })
  } catch (error) {
    console.error('order-status failed', error)
    return json(req, { error: 'Controle van betaling mislukt. Probeer opnieuw.' }, 500)
  }
})
