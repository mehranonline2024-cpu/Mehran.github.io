const assert = require('node:assert/strict');
const { receiptHtml } = require('../admin/printer.js');

const delivery = receiptHtml({
  order_number: 38,
  order_type: 'delivery',
  requested_time: '12:00–12:15',
  address: 'Troonstraat 5, 8400 Oostende',
  phone: '0490000001',
  payment: 'Cash',
  items: [{
    quantity: 2,
    name: 'Pizza Margherita',
    details: ['Mayo', 'Extra kaas'],
    item_note: 'Geen ui',
    line_total_cents: 2198,
  }],
  notes: 'Bel aan de achterdeur',
  total_cents: 2497,
});
assert.match(delivery, /GT-00038/);
assert.match(delivery, /BEZORGING/);
assert.match(delivery, /12:00–12:15/);
assert.match(delivery, /Troonstraat 5, 8400 Oostende/);
assert.match(delivery, /0490000001/);
assert.match(delivery, /Mayo · Extra kaas/);
assert.match(delivery, /Geen ui/);
assert.match(delivery, /Bel aan de achterdeur/);
assert.match(delivery, /€\s?24,97/);

const escaped = receiptHtml({
  order_number: 39,
  order_type: 'pickup',
  phone: '0490000002',
  address: 'Should not print for pickup',
  items: [{ quantity: 1, name: '<script>alert(1)</script>', details: ['<img src=x>'] }],
});
assert.match(escaped, /AFHALEN/);
assert.doesNotMatch(escaped, /Should not print for pickup/);
assert.match(escaped, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
assert.match(escaped, /&lt;img src=x&gt;/);

const testReceipt = receiptHtml({}, true);
assert.match(testReceipt, /PRINTERTEST/);
assert.match(testReceipt, /GT-TEST/);
console.log('Printer receipt tests passed');
