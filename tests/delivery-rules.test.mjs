// Run with Node 24+: npm ci --prefix tests && node --test tests/delivery-rules.test.mjs
// All database, routing and Stripe calls below are in-memory fakes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import vm from 'node:vm';
import proj4 from 'proj4';

const source = readFileSync(new URL('../supabase/functions/create-checkout/index.ts', import.meta.url), 'utf8');
const serverCode = stripTypeScriptTypes(source.replace(/^import .*\n/gm, ''));
const html = readFileSync(new URL('../order/index.html', import.meta.url), 'utf8');
const browserCode = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const outsideMessage = 'Helaas leveren we momenteel alleen binnen 4 km in Oostende. Je kunt je bestelling wel bij Grill Time afhalen.';
function brusselsTime(dayOffset,hour,minute){
  const f=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const parts=d=>Object.fromEntries(f.formatToParts(d).map(x=>[x.type,x.value]));
  const base=parts(new Date(Date.now()+dayOffset*86400000));
  const guess=Date.UTC(Number(base.year),Number(base.month)-1,Number(base.day),hour,minute);
  const local=parts(new Date(guess));
  const offset=Date.UTC(Number(local.year),Number(local.month)-1,Number(local.day),Number(local.hour),Number(local.minute))-guess;
  return new Date(guess-offset);
}

async function checkout({ food = 1500, drink = 0, meters = 2500, city = '8400 Oostende', place = 'Oostende', postcode = '8400', country = 'be', type = 'delivery', payment = 'cash', firstOrder = false, routeDown = false, noGeocode = false, officialResult = false, nominatimDown = false, geolocationDown = false, registryDown = false, registryResult = false, registryHouse, registryStreet, registryStatus = 'inGebruik', registryBus, registryGml, address = 'Example street 1', wrongHouse = false, requestedAt, requestedWindowEnd, quoteOnly, expectedPrice, termsAccepted } = {}) {
  const writes = [], routes = [], sessions = [], coupons = [], geocodeQueries = [], registryQueries = [];
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
        if (this.table === 'store_settings') return {data:{timezone:'Europe/Brussels',opens_at:'12:00:00',closes_at:'23:00:00',preorder_days:7,preparation_lead_minutes:30,delivery_estimate_min:25,delivery_estimate_max:45,delivery_paused:false}, error:null};
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
  const context = vm.createContext({Request, Response, URL, AbortSignal, proj4,
    console:{error() {},warn() {}}, Stripe:StripeMock, createClient:() => ({from:table => new Query(table)}),
    Deno:{env:{get:key => ({STRIPE_SECRET_KEY:'local-mock-key', SUPABASE_URL:'https://database.example.test', SUPABASE_SERVICE_ROLE_KEY:'local-mock-key'}[key])}, serve:fn => {handler = fn;}},
    fetch:async url => {
      if (url.hostname === 'geo.api.vlaanderen.be') return geolocationDown ? new Response('unavailable',{status:503}) : Response.json({LocationResult:officialResult ? [{Zipcode:'8400',Municipality:'Oostende',Thoroughfarename:address.replace(/\s+\d+\w*$/, ''),Housenumber:address.match(/\d+\w*$/)?.[0],Location:{Lat_WGS84:51.22,Lon_WGS84:2.92},FormattedAddress:`${address}, 8400 Oostende`}] : []});
      if(url.hostname === 'api.basisregisters.vlaanderen.be') {
        registryQueries.push(String(url));
        return registryDown ? new Response('unavailable',{status:503}) : Response.json({adresMatches:registryResult ? [{postinfo:{objectId:postcode},gemeente:{gemeentenaam:{geografischeNaam:{spelling:place}}},straatnaam:{straatnaam:{geografischeNaam:{spelling:registryStreet||url.searchParams.get('straatnaam')}}},huisnummer:registryHouse||url.searchParams.get('huisnummer'),busnummer:registryBus,adresStatus:registryStatus,volledigAdres:{geografischeNaam:{spelling:'Oude Molenstraat 1, 8400 Oostende'}},adresPositie:{geometrie:{type:'Point',gml:registryGml||'<gml:Point srsName="https://www.opengis.net/def/crs/EPSG/0/31370"><gml:pos>48008.12 213467.96</gml:pos></gml:Point>'}}}] : []});
      }
      if (url.hostname === 'nominatim.openstreetmap.org') {geocodeQueries.push(url.searchParams.get('q')); return nominatimDown ? new Response('unavailable',{status:503}) : Response.json(noGeocode ? [] : [{lat:'51.22', lon:'2.92', address:{country_code:country, postcode, city:place, road:url.searchParams.get('q').split(',')[0].replace(/\s+\d+\w*$/, ''), house_number:wrongHouse?'999':url.searchParams.get('q').split(',')[0].match(/\d+\w*$/)?.[0]}}]);}
      assert.equal(url.hostname, 'router.project-osrm.org');
      assert.match(url.pathname, /^\/route\/v1\/driving\//);
      routes.push(String(url));
      return routeDown ? new Response('unavailable', {status:503}) : Response.json({routes:[{distance:meters}]});
    }
  });
  vm.runInContext(serverCode, context);
  const response = await handler(new Request('https://checkout.example.test', {method:'POST', headers:{origin:'https://grilltime.be', 'content-type':'application/json'}, body:JSON.stringify({customer:{name:'Local test', phone:'0400000000'}, orderType:type, paymentMethod:payment, address:type === 'delivery' ? address : null, city:type === 'delivery' ? city : null, requestedAt:requestedAt===undefined?brusselsTime(2,12,0).toISOString():requestedAt, requestedWindowEnd:requestedWindowEnd===undefined?(type==='delivery'?brusselsTime(2,12,15).toISOString():null):requestedWindowEnd, items, quoteOnly, expectedPrice, termsAccepted})}));
  return {status:response.status, body:await response.json(), writes, routes, sessions, coupons, geocodeQueries, registryQueries};
}

test('A 12:00 slot requires the agreed 30-minute preparation lead', async () => {
  const validatorContext=vm.createContext({Date,Intl,Stripe:class{},createClient(){},Deno:{env:{get:()=>''},serve(){}}});
  vm.runInContext(serverCode,validatorContext);
  const slot=brusselsTime(1,12,0),end=brusselsTime(1,12,15),cutoff=brusselsTime(1,11,30);
  const settings={timezone:'Europe/Brussels',opens_at:'12:00:00',closes_at:'23:00:00',preorder_days:7,preparation_lead_minutes:30};
  const request={orderType:'delivery',requestedAt:slot.toISOString(),requestedWindowEnd:end.toISOString()};
  const onCutoff=validatorContext.validateRequestedSlot(request,settings,cutoff);
  assert.equal(onCutoff.requestedAt,slot.toISOString());
  assert.equal(onCutoff.requestedTime,`${new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Brussels',year:'numeric',month:'2-digit',day:'2-digit'}).format(slot)} 12:00–12:15`);
  assert.match(validatorContext.validateRequestedSlot(request,settings,new Date(cutoff.getTime()+1000)).error,/minstens 30 minuten later/i);
});

test('Checkout validates chosen times, delivery windows, and opening hours', async () => {
  const valid=await checkout();
  assert.equal(valid.status,200,JSON.stringify(valid.body));
  const missing=await checkout({requestedAt:''});
  assert.equal(missing.status,400);
  assert.match(missing.body.error,/moment/i);
  const invalidWindow=await checkout({requestedWindowEnd:brusselsTime(2,12,30).toISOString()});
  assert.equal(invalidWindow.status,400);
  assert.match(invalidWindow.body.error,/15 minuten/i);
  const outsideHours=await checkout({type:'pickup',requestedAt:brusselsTime(2,8,0).toISOString()});
  assert.equal(outsideHours.status,400);
  assert.match(outsideHours.body.error,/12:00 en 23:00/i);
});

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

test('Common misspelling of Vrijheidstraat is corrected before address geocoding', async () => {
  const result = await checkout({address:'Vrijheidsstraat 31', meters:2400});
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.geocodeQueries[0], 'Vrijheidstraat 31, 8400 Oostende, Belgium');
  assert.equal(result.body.deliveryDistanceKm, 2.4);
  assert.equal(result.body.deliveryFeeCents, 299);
  assert.equal(result.body.totalCents, 1799);
});

test('Official Flemish house-number lookup works when Nominatim is unavailable', async () => {
  const result = await checkout({address:'Bronstraat 17',officialResult:true,nominatimDown:true,quoteOnly:true,meters:3190});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.deliveryDistanceKm,3.19);
  assert.equal(result.body.deliveryFeeCents,399);
  assert.equal(result.geocodeQueries.length,0);
  assert.equal(result.writes.length,0);
});

test('Structured official register recovers a failed geocoder without relying on Nominatim', async () => {
  for(const geolocationDown of [false,true]) {
    const result=await checkout({address:'Oude Molenstraat 1',registryResult:true,geolocationDown,nominatimDown:true,quoteOnly:true,meters:1827.3});
    assert.equal(result.status,200,JSON.stringify(result.body));
    assert.equal(result.body.deliveryFeeCents,299);
    assert.equal(result.body.deliveryDistanceKm,1.83);
    assert.equal(result.body.deliveryAddress,'Oude Molenstraat 1, 8400 Oostende');
    assert.equal(result.geocodeQueries.length,0);
    const query=new URL(result.registryQueries[0]);
    assert.equal(query.searchParams.get('straatnaam'),'Oude Molenstraat');
    assert.equal(query.searchParams.get('huisnummer'),'1');
    const destination=new URL(result.routes[0]).pathname.split(';')[1].split(',').map(Number);
    // Compare Lambert 72 conversion against this address's official GPS point.
    assert.ok(Math.abs(destination[0]-2.908786635417898)<0.00001,JSON.stringify(destination));
    assert.ok(Math.abs(destination[1]-51.22213919005766)<0.00001,JSON.stringify(destination));
    assert.equal(result.writes.length,0);
    assert.equal(result.sessions.length,0);
  }
});

test('A rejected public fallback does not turn an unrecognized address into a service outage', async () => {
  const result=await checkout({noGeocode:true,nominatimDown:true,quoteOnly:true});
  assert.equal(result.status,400);
  assert.equal(result.body.code,'address_not_found');
  assert.equal(result.routes.length,0);
  assert.equal(result.writes.length,0);
});

test('If every address service fails, checkout offers pickup and creates no order or payment', async () => {
  const result=await checkout({geolocationDown:true,registryDown:true,nominatimDown:true,quoteOnly:true});
  assert.equal(result.status,503);
  assert.equal(result.body.code,'address_lookup_unavailable');
  assert.equal(result.body.pickupAvailable,true);
  assert.equal(result.routes.length,0);
  assert.equal(result.writes.length,0);
  assert.equal(result.sessions.length,0);
});

test('Official register cannot authorize a wrong house, street, town, status or bus-only match', async () => {
  for(const options of [{registryHouse:'999'},{registryStreet:'Different street'},{place:'Bredene'},{postcode:'8450'},{registryStatus:'gehistoreerd'},{registryBus:'0102'},{registryGml:'<gml:Point srsName="EPSG:4326"><gml:pos>48008 213468</gml:pos></gml:Point>'}]) {
    const result=await checkout({...options,registryResult:true,nominatimDown:true,quoteOnly:true});
    assert.equal(result.status,400,JSON.stringify(result.body));
    assert.equal(result.body.code,'address_not_found');
    assert.equal(result.routes.length,0);
    assert.equal(result.writes.length,0);
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
  for (const options of [{meters:4000.1}, {city:'8450 Bredene'}, {city:'8400 Brugge'}, {city:'8450 Oostende'}]) {
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
  const context = vm.createContext({console, URLSearchParams, Intl, gtIsEnglish:()=>false, gtText:nl=>nl, window:{gtIsEnglish:()=>false,addEventListener() {}},
    localStorage:{getItem:() => null, setItem() {}}, document:{getElementById:element, addEventListener() {}}, location:{search:''}, setInterval:() => 0,
    fetch:() => new Promise(() => {}), setTimeout:() => 0,
    FormData:class { get(key) {return {name:'Local test', phone:'0400000000'}[key] || null;} has() {return false;} }
  });
  vm.runInContext(browserCode, context);
  vm.runInContext("deliveryPaused=false;products=[{id:'food',category:'Pizza'},{id:'drink',category:'Drinks'}];cart=[{productId:'food',name:'Meal',qty:1,unitPrice:12,selections:[]},{productId:'drink',name:'Drink',qty:1,unitPrice:3,selections:[]}];orderType='delivery';renderCheckout()", context);
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
  assert.match(html,/name=\"requestedSlot\"/);
  assert.match(element('checkoutSheet').innerHTML,/name="city" value="8400 Oostende"/);
  assert.match(html,/deliveryEstimateMin/);
  assert.match(html,/languageToggle/);
  assert.match(readFileSync(new URL('../order/i18n.js',import.meta.url),'utf8'),/Estimated delivery time: 25–45 minutes/);
});

test('Price preview has no order side effect and an altered total cannot be submitted', async () => {
  const preview=await checkout({quoteOnly:true,firstOrder:true,meters:3100});
  assert.equal(preview.status,200);
  assert.equal(preview.body.quote,true);
  assert.equal(preview.body.subtotalCents,1500);
  assert.equal(preview.body.discountCents,150);
  assert.equal(preview.body.deliveryFeeCents,399);
  assert.equal(preview.body.totalCents,1749);
  assert.equal(preview.writes.length,0);
  assert.equal(preview.sessions.length,0);

  const changed=await checkout({firstOrder:true,meters:3100,termsAccepted:true,expectedPrice:{subtotalCents:1500,discountCents:150,discountCode:'WELCOME10',deliveryFeeCents:299,totalCents:1649}});
  assert.equal(changed.status,409);
  assert.equal(changed.body.code,'price_changed');
  assert.equal(changed.writes.length,0);

  const confirmed=await checkout({firstOrder:true,meters:3100,termsAccepted:true,expectedPrice:{subtotalCents:1500,discountCents:150,discountCode:'WELCOME10',deliveryFeeCents:399,totalCents:1749}});
  assert.equal(confirmed.status,200);
  assert.equal(confirmed.body.totalCents,1749);
  assert.equal(confirmed.writes.some(w=>w.table==='orders'),true);
});


test('City-only, postcode-only and compact local spellings use the same verified delivery address', async () => {
  for (const city of ['Oostende','8400','8400Oostende','8400 Oostende','8400, Oostende','Ostend','Oostende, België']) {
    const result=await checkout({address:'oudemolenstraat 1',city,quoteOnly:true,meters:1827.3});
    assert.equal(result.status,200,JSON.stringify({city,...result.body}));
    assert.equal(result.body.deliveryFeeCents,299);
    assert.equal(result.body.deliveryDistanceKm,1.83);
    assert.equal(result.geocodeQueries[0],'Oude Molenstraat 1, 8400 Oostende, Belgium');
    assert.match(result.routes[0],/2\.9202485,51\.2348621/);
    assert.equal(result.writes.length,0);
  }
  const saved=await checkout({city:'Oostende'});
  assert.equal(saved.writes.find(w=>w.table==='orders').value.city,'8400 Oostende');
});

test('Pasted complete local address is normalized and a missing locality gets a specific validation error', async () => {
  const result=await checkout({address:'Oudemolenstraat 1, 8400 Oostende',city:'8400',quoteOnly:true});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.geocodeQueries[0],'Oude Molenstraat 1, 8400 Oostende, Belgium');
  const missing=await checkout({city:''});
  assert.equal(missing.body.code,'incomplete_delivery_address');
  assert.equal(missing.writes.length,0);
});

test('Wrong or approximate geocoder matches are not classified as outside the distance zone', async () => {
  for (const options of [{place:'Bredene'},{postcode:'8450'},{country:'nl'},{wrongHouse:true},{address:'Oude Molenstraat'}]) {
    const result=await checkout({...options,quoteOnly:true});
    assert.equal(result.status,400);
    assert.equal(result.body.code,'address_not_found',JSON.stringify(result.body));
    assert.equal(result.routes.length,0);
    assert.equal(result.writes.length,0);
  }
});
