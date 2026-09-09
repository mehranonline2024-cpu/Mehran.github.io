import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const edge = fs.readFileSync(new URL('../supabase/functions/create-order-v2/index.ts', import.meta.url), 'utf8')
const browser = fs.readFileSync(new URL('../assets/order-v2.js', import.meta.url), 'utf8')
const migration = fs.readFileSync(new URL('../supabase/migrations/20260908_order_operations_v2.sql', import.meta.url), 'utf8')

test('database request id is unique and order creation is service-only', () => {
  assert.match(migration, /unique index if not exists orders_client_request_id_key/i)
  assert.match(migration, /service_create_order_v2\(uuid,text,jsonb,jsonb,jsonb\).*from public,anon,authenticated/is)
  assert.match(migration, /grant execute on function public\.service_create_order_v2\(uuid,text,jsonb,jsonb,jsonb\) to service_role/i)
})

test('browser reuses one request id for an unchanged retry', () => {
  assert.match(browser, /sessionStorage\.getItem\(CHECKOUT_REQUEST_KEY\)/)
  assert.match(browser, /orderPayload\.requestId = requestIdFor\(orderPayload\)/)
  assert.match(browser, /checkoutRequestIdentity\.fingerprint !== fingerprint/)
})

test('Stripe coupon and Checkout creation are idempotent', () => {
  assert.match(edge, /idempotencyKey: `grilltime-coupon-\$\{requestId\}`/)
  assert.match(edge, /idempotencyKey: `grilltime-checkout-\$\{requestId\}`/)
  assert.match(edge, /stripeCheckoutSessionId/)
})

test('customer, order and items are written through one atomic RPC', () => {
  assert.match(edge, /\.rpc\('service_create_order_v2'/)
  assert.doesNotMatch(edge, /from\('orders'\)\.insert/)
  assert.doesNotMatch(edge, /from\('order_items'\)\.insert/)
})
