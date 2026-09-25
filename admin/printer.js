(function (root) {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function money(cents) {
    return new Intl.NumberFormat('nl-BE', { style: 'currency', currency: 'EUR' })
      .format((Number(cents) || 0) / 100);
  }

  function detailLabel(detail) {
    if (typeof detail === 'string' || typeof detail === 'number') return String(detail);
    if (!detail || typeof detail !== 'object') return '';
    return [detail.label, detail.name, detail.value].filter(Boolean).join(': ');
  }

  function receiptHtml(payload, test = false) {
    payload = payload || {};
    const orderNumber = test ? 'TEST' : String(payload.order_number || '').padStart(5, '0');
    const type = payload.order_type === 'delivery' ? 'BEZORGING' : 'AFHALEN';
    const requestedTime = payload.requested_time || 'Zo snel mogelijk';
    const items = Array.isArray(payload.items) ? payload.items : [];
    const itemRows = items.map(item => {
      const quantity = Math.max(0, Number(item.quantity) || 0);
      const name = escapeHtml(item.name || item.product_name || 'Artikel');
      const details = Array.isArray(item.details) ? item.details.map(detailLabel).filter(Boolean) : [];
      const options = details.length ? `<div class="detail">${details.map(escapeHtml).join(' · ')}</div>` : '';
      const note = item.item_note ? `<div class="note">Opmerking: ${escapeHtml(item.item_note)}</div>` : '';
      const price = item.line_total_cents == null ? '' : `<span>${money(item.line_total_cents)}</span>`;
      return `<div class="item"><div class="itemtop"><strong>${quantity} × ${name}</strong>${price}</div>${options}${note}</div>`;
    }).join('');
    const isDelivery = payload.order_type === 'delivery';
    const address = isDelivery && payload.address ? `<div><b>ADRES</b><br>${escapeHtml(payload.address)}</div>` : '';
    const phone = payload.phone ? `<div><b>TELEFOON</b><br>${escapeHtml(payload.phone)}</div>` : '';
    const customer = payload.customer_name ? `<div><b>KLANT</b><br>${escapeHtml(payload.customer_name)}</div>` : '';
    const notes = payload.notes ? `<section class="notice"><b>OPMERKING BESTELLING</b><br>${escapeHtml(payload.notes)}</section>` : '';
    const printedAt = new Date().toLocaleString('nl-BE', { dateStyle: 'short', timeStyle: 'short' });

    return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Grill Time bon ${orderNumber}</title><style>
      @page{size:80mm auto;margin:3mm}*{box-sizing:border-box}html,body{width:74mm;margin:0;padding:0;color:#000;background:#fff;font-family:Arial,sans-serif;font-size:10pt}body{padding:1mm}.center{text-align:center}.brand{font-size:15pt;font-weight:900;letter-spacing:.4px}.subtitle{font-size:9pt;margin-top:2px}.rule{border:0;border-top:1px dashed #000;margin:8px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:5px 8px;margin:7px 0}.meta b,.contact b{font-size:8pt}.contact{display:grid;gap:7px;margin:7px 0}.item{padding:6px 0;border-bottom:1px dotted #777}.itemtop{display:flex;justify-content:space-between;gap:6px}.itemtop strong{flex:1}.detail,.note{font-size:9pt;margin:3px 0 0 12px;line-height:1.35}.note,.notice{font-weight:600}.notice{border:1px solid #000;padding:6px;margin-top:8px;line-height:1.4}.total{display:flex;justify-content:space-between;font-weight:900;font-size:13pt;margin-top:8px}.foot{font-size:8pt;text-align:center;margin-top:12px}
    </style></head><body>
      <header class="center"><div class="brand">GRILL TIME</div><div class="subtitle">${test ? 'PRINTERTEST' : 'KEUKENBON'}</div></header>
      <hr class="rule"><div class="meta"><div><b>BESTELNUMMER</b><br>GT-${escapeHtml(orderNumber)}</div><div><b>${type}</b><br>${escapeHtml(requestedTime)}</div></div>
      <div class="subtitle">Afgedrukt: ${escapeHtml(printedAt)}</div><hr class="rule">
      ${customer || address || phone ? `<section class="contact">${customer}${address}${phone}</section><hr class="rule">` : ''}
      <section><b>BESTELLING</b>${itemRows || '<div class="item">Geen artikelen</div>'}</section>
      ${notes}<hr class="rule"><div><b>BETALING</b><br>${escapeHtml(payload.payment || '—')}</div>
      ${payload.total_cents == null ? '' : `<div class="total"><span>TOTAAL</span><span>${money(payload.total_cents)}</span></div>`}
      <div class="foot">Grill Time · Oostende</div>
    </body></html>`;
  }

  function printMarkup(markup) {
    if (!root.document) return Promise.reject(new Error('Afdrukken is alleen beschikbaar in het dashboard.'));
    return new Promise((resolve, reject) => {
      const frame = root.document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.title = 'Keukenbon';
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:80mm;height:1px;border:0;';
      root.document.body.appendChild(frame);
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      let settled = false;
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        setTimeout(() => frame.remove(), 1000);
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error('De browser heeft de afdruk niet bevestigd. Controleer de printer en probeer opnieuw.')), 90000);
      win.addEventListener('afterprint', () => finish(), { once: true });
      try {
        doc.open();
        doc.write(markup);
        doc.close();
        setTimeout(() => {
          try { win.focus(); win.print(); }
          catch (error) { finish(error); }
        }, 300);
      } catch (error) { finish(error); }
    });
  }

  const api = {
    receiptHtml,
    printReceipt(payload) { return printMarkup(receiptHtml(payload)); },
    printTestReceipt() { return printMarkup(receiptHtml({}, true)); },
  };
  root.GTPrinter = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
