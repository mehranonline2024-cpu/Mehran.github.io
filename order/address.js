// Official Oostende suggestions. Delivery eligibility is always checked by the server.
(() => {
  let dispose = () => {};
  let showChoices = () => {};
  const cache = new Map();
  const text = (nl, en) => window.gtText ? window.gtText(nl, en) : nl;

  window.gtInitAddressForm = config => {
    dispose();
    const input = document.getElementById('deliveryAddressInput');
    const list = document.getElementById('addressSuggestions');
    const hint = document.getElementById('addressHint');
    const city = document.querySelector('#checkoutForm [name=city]');
    if (!input || !list || !hint || !city) return;
    let timer, controller, timeout, choices = [], active = -1;
    const normalHint = text('Kies je adres uit de suggesties. Je mag ook een busnummer invullen.', 'Choose your address from the suggestions. You can also enter an apartment number.');
    hint.textContent = normalHint;

    function cancel() {
      clearTimeout(timer); clearTimeout(timeout);
      controller?.abort(); controller = null;
    }
    function close() {
      list.replaceChildren(); list.classList.add('hidden');
      input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      choices = []; active = -1;
    }
    function select(suggestion) {
      cancel(); close();
      input.value = suggestion.address + (suggestion.complete ? '' : ' ');
      city.value = suggestion.city;
      input.removeAttribute('aria-invalid');
      hint.textContent = suggestion.complete ? normalHint : text('Vul nu je huisnummer in.', 'Now enter your house number.');
      input.dispatchEvent(new Event('input', {bubbles:true}));
      city.dispatchEvent(new Event('input', {bubbles:true}));
      cancel(); close();
      input.focus();
    }
    function render(suggestions) {
      close();
      choices = suggestions.filter(s => s && typeof s.address === 'string' && s.city === '8400 Oostende' && typeof s.label === 'string').slice(0,6);
      for (const [index, suggestion] of choices.entries()) {
        const item = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.id = `address-option-${index}`;
        button.setAttribute('role', 'option'); button.setAttribute('aria-selected', 'false');
        button.textContent = suggestion.label;
        button.addEventListener('click', () => select(suggestion));
        item.append(button); list.append(item);
      }
      list.classList.toggle('hidden', !choices.length);
      input.setAttribute('aria-expanded', String(!!choices.length));
    }
    showChoices = suggestions => {
      cancel(); render(suggestions); input.focus();
      hint.textContent = choices.length ? text('Bedoel je één van deze adressen? Kies het juiste adres.', 'Do you mean one of these addresses? Choose the correct address.') : normalHint;
    };
    async function search(value) {
      controller = new AbortController();
      const requestController = controller;
      timeout = setTimeout(() => requestController.abort(), 12000);
      hint.textContent = text('Adressen zoeken…', 'Searching addresses…');
      try {
        const url = new URL(config.url + '/functions/v1/create-checkout');
        url.searchParams.set('action', 'address-suggestions'); url.searchParams.set('q', value);
        const response = await fetch(url, {headers:{apikey:config.key}, signal:requestController.signal});
        const data = await response.json();
        if (!response.ok) throw new Error('Address suggestions unavailable');
        if (requestController.signal.aborted || !input.isConnected || input.value.trim() !== value) return;
        const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];
        if (cache.size >= 50) cache.delete(cache.keys().next().value);
        cache.set(value, suggestions);
        if (document.activeElement === input) render(suggestions);
        hint.textContent = suggestions.length ? normalHint : text('Geen suggestie gevonden. Controleer de schrijfwijze en vul je huisnummer in.', 'No suggestion found. Check the spelling and enter your house number.');
      } catch (error) {
        if (requestController.signal.aborted && controller !== requestController) return;
        if (input.isConnected && input.value.trim() === value) hint.textContent = text('Suggesties zijn even niet beschikbaar. Je kunt je adres zelf invullen en laten controleren.', 'Suggestions are temporarily unavailable. You can enter your address and check it.');
      } finally {
        if (controller === requestController) { clearTimeout(timeout); controller = null; }
      }
    }
    function onInput() {
      cancel(); close(); input.removeAttribute('aria-invalid');
      const value = input.value.trim();
      hint.textContent = normalHint;
      const error = document.getElementById('deliveryError');
      if (error?.dataset.addressError === 'true') { error.className = 'hidden'; error.replaceChildren(); delete error.dataset.addressError; }
      if (value.length < 3) return;
      if (cache.has(value)) { render(cache.get(value)); return; }
      timer = setTimeout(() => search(value), 400);
    }
    function onKeydown(event) {
      if (event.key === 'Escape') { close(); return; }
      if (!choices.length) return;
      if (event.key === 'Enter' && active >= 0) { event.preventDefault(); select(choices[active]); return; }
      if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
      event.preventDefault();
      active = active < 0 ? (event.key === 'ArrowDown' ? 0 : choices.length - 1) : (active + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      [...list.querySelectorAll('[role=option]')].forEach((button, index) => button.setAttribute('aria-selected', String(index === active)));
      input.setAttribute('aria-activedescendant', `address-option-${active}`);
    }
    function onOutside(event) { if (event.target !== input && !list.contains(event.target)) close(); }
    input.addEventListener('input', onInput); input.addEventListener('keydown', onKeydown);
    document.addEventListener('click', onOutside);
    dispose = () => {
      cancel(); close(); showChoices = () => {};
      input.removeEventListener('input', onInput); input.removeEventListener('keydown', onKeydown);
      document.removeEventListener('click', onOutside);
    };
  };
  window.gtShowAddressChoices = suggestions => showChoices(suggestions);
})();
