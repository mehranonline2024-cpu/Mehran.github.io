// Run with Node 24+: node --test tests/delivery-rules.test.mjs
// All database, routing and Stripe calls below are in-memory fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../supabase/functions/create-checkout/index.ts', import.meta.url), 'utf8');
const serverCode = stripTypeScriptTypes(source.replace(/^import .*\n/gm, ''));
const html = readFileSync(new URL('../order/index.html', import.meta.url), 'utf8');
const browserCode = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const outsideMessage = 'Helaas leveren we momenteel alleen binnen 4 km in Oostende. Je kunt je bestelling wel bij Grill Time afhalen.';

async function checkout({ food = 1500, drink = 0, meters = 2500, city = '8400 Oostende', place = 'Oostende', postcode = '8400', country = 'be', type = 'delivery', payment = 'cash', firstOrder = false, routeDown = false, noGeocode = false } = {}) {
  const writes = [], routes = [], sessions = [], coupons = [];
  const products = [{id:'food', name:'Meal', category:'Pizza', price_cents:food, active:true}, {id:'drink', name:'Drink', category:'Drinks', price_cents:drink, active:true}];
  const items = [{productId:'food', qty:1}, ...(drink ? [{productId:'drink', qty:1}] : [])];
  class Query {
    constructor(table) { this.table = table; this.action = 'read'; this.filters = {}; }
    select(columns) { this.columns = columns; return this; }
    eq(key, value) { this.filters[key] = value; return this; }
    in(key, value) { this.filters[key] = value; return this; }
    gte() { return this; }
    single() { return this; }
    insert(value) { this.action = 'insert'; this.value = value; return this; }
    update(value) { this.action = 'update'; this.value = value; return this; }
    then(resolve, reject) {
      return Promise.resolve().then(() => {
        if (this.action !== 'read') {
          writes.push({table:this.table, action:this.action, value:this.value});
          return {data:{...this.value, id:'local-id', order_number:123}, error:null};
        }
        if (this.table === 'orders') return {count:0, error:null};
        if (this.table === 'products') {
          assert.ok(this.columns.split(',').includes('category'));
          return {data:products.filter(p => this.filters.id.includes(p.id)), error:null};
        }
        if (this.table === 'customers') return {data:firstOrder ? [] : [{id:'local-customer', order_count:1}], error:null};
        if (this.table === 'product_option_groups') return {data:[], error:null};
        throw new Error(`Unexpected table ${this.table}`);
      }).then(resolve, reject);
    }
  }
  let handler;
  class StripeMock {
    coupons = {create:async args => {coupons.push(args); return {id:'local-coupon'};}};
    checkout = {sessions:{create:async args => {sessions.push(args); return {id:'local-session', url:'https://checkout.example.test/session'};}}};
  }
  const context = vm.createContext({Request, Response, URL,
    console:{error() {}}, Stripe:StripeMock, createClient:() => ({from:table => new Query(table)}),
    Deno:{env:{get:key => ({STRIPE_SECRET_KEY:'local-mock-key', SUPABASE_URL:'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY:'local-mock-key'}[key])}, serve:fn => {handler = fn;}},
    fetch:async url => {
      if (url.hostname === 'nominatim.openstreetmap.org') return Response.json(noGeocode ? [] : [{lat:'51.22', lon:'2.92', address:{country_code:country, postcode, city:place}}]);
      assert.equal(url.hostname, 'router.project-osrm.org');
      assert.match(url.pathname, /^\/route\/v1\/driving\//);
      routes.push(String(url));
      return routeDown ? new Response('unavailable', {status:503}) : Response.json({routes:[{distance:meters}]});
    }
  });
  vm.runInContext(serverCode, context);
  const response = await handler(new Request('https://checkout.example.test', {method:'POST', headers:{origin:'https://grilltime.be', 'content-type':'application/json'}, body:JSON.stringify({customer:{name:'Local test', phone:'0400000000'}, orderType:type, paymentMethod:payment, address:type === 'delivery' ? 'Example street 1' : null, city:type === 'delivery' ? city : null, items})}));
  return {status:response.status, body:await response.json(), writes, routes, sessions, coupons};
}

test('Driving-distance boundaries select the correct fee without rounding first', async () => {
  for (const [meters, fee] of [[0,299], [1,299], [2500,299], [2500.1,399], [4000,399]]) {
    const result = await checkout({meters});
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.deliveryFeeCents, fee);
    assert.equal(result.body.totalCents, 1500 + fee);
    assert.equal(result.routes.length, 1);
    const order = result.writes.find(w => w.table === 'orders').value;
    assert.equal(order.delivery_fee_cents, fee);
    assert.equal(order.delivery_distance_method, 'driving');
  }
});

test('Orders of €50 and €100 still pay delivery fees', async () => {
  for (const [food, meters, fee] of [[5000,2500,299], [10000,3000,399]]) {
    const result = await checkout({food, meters});
    assert.equal(result.status, 200);
    assert.equal(result.body.totalCents, food + fee);
  }
});

test('Outside the distance or municipality offers pickup and creates no order', async () => {
  for (const options of [{meters:4000.1}, {city:'8450 Bredene'}, {place:'Bredene'}, {postcode:'8450'}, {country:'nl'}]) {
    const result = await checkout(options);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, outsideMessage);
    assert.equal(result.body.pickupAvailable, true);
    assert.equal(result.writes.length, 0);
    assert.equal(result.sessions.length, 0);
  }
});

test('Food minimum excludes standalone drinks and delivery fees', async () => {
  for (const [food, drink] of [[1499,0], [1200,300], [0,1500]]) {
    const result = await checkout({food, drink});
    assert.equal(result.status, 400);
    assert.match(result.body.error, /Minimum bestelling aan eten/);
    assert.equal(result.writes.length, 0);
    assert.equal(result.routes.length, 0);
  }
  const result = await checkout({food:1500, drink:300});
  assert.equal(result.status, 200);
  assert.equal(result.body.totalCents, 2099);
});

test('Welcome discount is preserved and does not discount delivery', async () => {
  const result = await checkout({firstOrder:true});
  assert.equal(result.status, 200);
  assert.equal(result.body.discountCents, 150);
  assert.equal(result.body.deliveryFeeCents, 299);
  assert.equal(result.body.totalCents, 1649);
});

test('Pickup remains available without an address or delivery minimum', async () => {
  const result = await checkout({type:'pickup', food:300});
  assert.equal(result.status, 200);
  assert.equal(result.body.totalCents, 300);
  assert.equal(result.body.deliveryFeeCents, 0);
  assert.equal(result.routes.length, 0);
});

test('Missing geocode or failed route cannot fall back to straight-line delivery', async () => {
  for (const options of [{routeDown:true}, {noGeocode:true}, {meters:null}, {meters:-1}]) {
    const result = await checkout(options);
    assert.notEqual(result.status, 200);
    assert.equal(result.writes.length, 0);
    assert.equal(result.sessions.length, 0);
  }
});

test('Online payment receives the same fee and totals as the database', async () => {
  for (const [meters, fee] of [[2500,299], [3000,399]]) {
    const result = await checkout({food:5000, meters, payment:'online', firstOrder:true});
    assert.equal(result.status, 200);
    const session = result.sessions[0];
    const delivery = session.line_items.find(item => item.price_data.product_data.name === 'Bezorgkosten');
    assert.equal(delivery.price_data.unit_amount, fee);
    const chargedTotal = session.line_items.reduce((sum, item) => sum + item.quantity * item.price_data.unit_amount, 0) - result.coupons[0].amount_off;
    assert.equal(chargedTotal, result.body.totalCents);
    assert.equal(session.success_url, 'https://grilltime.be/order/?payment=success&session_id={CHECKOUT_SESSION_ID}');
  }
});

test('Customer form enforces food minimum and preserves cart when offering pickup', () => {
  const elements = new Map();
  const element = id => {if (!elements.has(id)) elements.set(id, {innerHTML:'', textContent:'', value:'', classList:{toggle() {}, add() {}, remove() {}}, scrollIntoView() {}}); return elements.get(id);};
  const context = vm.createContext({console, URLSearchParams, Intl,
    localStorage:{getItem:() => null}, document:{getElementById:element}, location:{search:''},
    fetch:() => new Promise(() => {}), setTimeout:() => 0,
    FormData:class { get(key) {return {name:'Local test', phone:'0400000000'}[key] || null;} }
  });
  vm.runInContext(browserCode, context);
  vm.runInContext("products=[{id:'food',category:'Pizza'},{id:'drink',category:'Drinks'}];cart=[{productId:'food',name:'Meal',qty:1,unitPrice:12,selections:[]},{productId:'drink',name:'Drink',qty:1,unitPrice:3,selections:[]}];orderType='delivery';renderCheckout()", context);
  assert.equal(vm.runInContext('cartFoodTotal()', context), 12);
  assert.match(element('checkoutSheet').innerHTML, /type="submit" disabled/);
  vm.runInContext("cart[0].unitPrice=15;renderCheckout()", context);
  assert.doesNotMatch(element('checkoutSheet').innerHTML, /type="submit" disabled/);
  vm.runInContext("offerPickup('<img src=x onerror=alert(1)>')", context);
  assert.match(element('deliveryError').innerHTML, /&lt;img/);
  assert.match(element('deliveryError').innerHTML, /Kies afhalen/);
  vm.runInContext("setType('pickup')", context);
  assert.equal(vm.runInContext('cart.length', context), 2);
  assert.equal(vm.runInContext('checkoutDraft.name', context), 'Local test');
  assert.match(element('checkoutSheet').innerHTML, /Geen minimum bestelbedrag en geen bezorgkosten/);
  assert.doesNotMatch(html, /FREE_DELIVERY|gratis vanaf €50|GRATIS<\/strong> vanaf €50/i);
});
