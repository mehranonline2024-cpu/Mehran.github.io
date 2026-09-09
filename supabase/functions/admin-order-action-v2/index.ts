import Stripe from 'npm:stripe@22.4.0'
import { createClient } from 'npm:@supabase/supabase-js@2.116.0'

const stripeKey = (Deno.env.get('STRIPE_SECRET_KEY') || '').trim()
const stripe = new Stripe(stripeKey)
const allowedOrigins = new Set([
  'https://grilltime.be', 'https://www.grilltime.be',
  'http://localhost:4173', 'http://127.0.0.1:4173',
])
function cors(req: Request) {
  const origin = req.headers.get('origin') || ''
  return {
    'Access-Control-Allow-Origin': allowedOrigins.has(origin) ? origin : 'https://grilltime.be',
    'Vary': 'Origin', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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
function jwtClaims(token: string) {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')))
  } catch (_) { return {} }
}
async function requireAdmin(req: Request, sb: ReturnType<typeof adminClient>) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '')
  if (!token || jwtClaims(token).aal !== 'aal2') return null
  const { data, error } = await sb.auth.getUser(token)
  if (error || !data.user) return null
  const { data: admin } = await sb.from('restaurant_admins').select('user_id').eq('user_id', data.user.id).maybeSingle()
  return admin ? data.user : null
}
async function findOrder(sb: ReturnType<typeof adminClient>, id: string) {
  const { data, error } = await sb.from('orders').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) })
  if (req.method !== 'POST') return json(req, { error: 'Method not allowed' }, 405)
  const origin = req.headers.get('origin') || ''
  if (origin && !allowedOrigins.has(origin)) return json(req, { error: 'Origin not allowed' }, 403)
  try {
    const sb = adminClient()
    const user = await requireAdmin(req, sb)
    if (!user) return json(req, { error: 'MFA-beveiligde beheerlogin vereist.' }, 401)
    const body = await req.json()
    const action = String(body.action || '')

    if (action === 'settings') {
      const patch: Record<string, boolean> = {}
      if (typeof body.deliveryPaused === 'boolean') patch.delivery_paused = body.deliveryPaused
      if (typeof body.storeTemporarilyClosed === 'boolean') patch.store_temporarily_closed = body.storeTemporarilyClosed
      if (!Object.keys(patch).length) return json(req, { error: 'Geen geldige instelling ontvangen.' }, 400)
      const { data, error } = await sb.from('store_settings').update({ ...patch, updated_by: user.id }).eq('id', 'main').select('*').single()
      if (error) throw error
      return json(req, { ok: true, settings: data })
    }

    if (action === 'delivery_health') {
      const url = new URL(`https://router.project-osrm.org/route/v1/driving/2.9202298934891577,51.234848445475095;2.8925769885001751,51.217443100495871`)
      url.searchParams.set('overview', 'false')
      const response = await fetch(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'GrillTimeOostende/2.0 (https://grilltime.be)' } })
      const data = response.ok ? await response.json() : null
      const ok = response.ok && Number.isFinite(Number(data?.routes?.[0]?.distance))
      return json(req, { ok, estimate: '25–45 minuten', routeService: ok ? 'online' : 'storing' }, ok ? 200 : 503)
    }

    const id = String(body.orderId || '')
    if (!/^[0-9a-f-]{36}$/i.test(id)) return json(req, { error: 'Ongeldige bestelling.' }, 400)
    const order = await findOrder(sb, id)
    if (!order) return json(req, { error: 'Bestelling niet gevonden.' }, 404)

    if (action === 'accept') {
      if (order.status !== 'new') return json(req, { error: 'Deze bestelling is niet meer nieuw.' }, 409)
      if (order.payment_method === 'online' && order.payment_status !== 'paid') return json(req, { error: 'Online betaling is nog niet bevestigd.' }, 409)
      if (order.first_cash_phone_warning && body.phoneConfirmed !== true) return json(req, { error: 'Telefonisch bevestigen vóór bereiding.', phoneConfirmationRequired: true }, 409)
      const { error } = await sb.from('orders').update({ status: 'accepted', accepted_at: new Date().toISOString(), accepted_by: user.id }).eq('id', id).eq('status', 'new')
      if (error) throw error
      const { data: printJob } = await sb.from('printer_jobs').select('id,payload,status').eq('order_id', id).maybeSingle()
      return json(req, { ok: true, status: 'accepted', printJob })
    }

    if (action === 'reject') {
      if (!['new', 'pending_payment'].includes(order.status)) return json(req, { error: 'Deze bestelling kan niet meer worden geweigerd.' }, 409)
      let refundId: string | null = null
      if (order.payment_method === 'online' && order.payment_status === 'paid') {
        if (!stripeKey) return json(req, { error: 'Terugbetaling kan nu niet veilig worden uitgevoerd.' }, 503)
        let paymentIntent = order.stripe_payment_intent_id
        if (!paymentIntent && order.stripe_checkout_session_id) {
          const session = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id)
          paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : null
        }
        if (!paymentIntent) return json(req, { error: 'Betaling gevonden, maar de terugbetaling kon niet worden gekoppeld.' }, 409)
        const refund = await stripe.refunds.create({ payment_intent: paymentIntent }, { idempotencyKey: `grill-time-reject-${id}` })
        refundId = refund.id
      } else if (order.stripe_checkout_session_id && order.payment_status !== 'paid') {
        try { await stripe.checkout.sessions.expire(order.stripe_checkout_session_id) } catch (_) {}
      }
      const { error } = await sb.from('orders').update({
        status: 'rejected', rejected_at: new Date().toISOString(), accepted_by: user.id,
        rejection_reason: String(body.reason || '').trim().slice(0, 250) || null,
        ...(refundId ? { payment_status: 'refunded', stripe_refund_id: refundId } : {}),
      }).eq('id', id)
      if (error) throw error
      return json(req, { ok: true, status: 'rejected', refunded: Boolean(refundId) })
    }

    if (action === 'on_way') {
      if (order.order_type !== 'delivery' || !['accepted', 'preparing', 'ready'].includes(order.status)) return json(req, { error: 'Deze bestelling kan nu niet op onderweg worden gezet.' }, 409)
      const { error } = await sb.from('orders').update({ status: 'on_way', on_way_at: new Date().toISOString(), accepted_by: user.id }).eq('id', id)
      if (error) throw error
      return json(req, { ok: true, status: 'on_way' })
    }

    if (action === 'completed') {
      if (!['accepted', 'preparing', 'ready', 'on_way'].includes(order.status)) return json(req, { error: 'Deze bestelling kan nu niet worden afgerond.' }, 409)
      const { error } = await sb.from('orders').update({ status: 'completed', completed_at: new Date().toISOString(), accepted_by: user.id }).eq('id', id)
      if (error) throw error
      return json(req, { ok: true, status: 'completed' })
    }

    if (action === 'preparing' || action === 'ready') {
      if (!['accepted', 'preparing'].includes(order.status)) return json(req, { error: 'Ongeldige statusovergang.' }, 409)
      const { error } = await sb.from('orders').update({ status: action, accepted_by: user.id }).eq('id', id)
      if (error) throw error
      return json(req, { ok: true, status: action })
    }

    if (action === 'cash_paid') {
      if (order.payment_method !== 'cash') return json(req, { error: 'Dit is geen cashbestelling.' }, 409)
      const { error } = await sb.rpc('service_mark_cash_paid', { p_order_id: id })
      if (error) throw error
      return json(req, { ok: true, paymentStatus: 'paid' })
    }

    if (action === 'reprint') {
      const { data, error } = await sb.from('printer_jobs').update({ status: 'queued', last_error: null, printed_at: null }).eq('order_id', id).select('id,payload,status').maybeSingle()
      if (error) throw error
      if (!data) return json(req, { error: 'Er is nog geen printbon voor deze bestelling.' }, 404)
      return json(req, { ok: true, printJob: data })
    }
    return json(req, { error: 'Onbekende beheeractie.' }, 400)
  } catch (error) {
    console.error(error)
    return json(req, { error: error instanceof Error ? error.message : 'Beheeractie mislukt.' }, 500)
  }
})
