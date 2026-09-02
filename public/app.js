const state = {
  devices: [],
  subnets: [],
  scanning: false,
  waking: new Set(),
  recentIds: new Set(),
  showDiscovered: false,
};

// quantos dispositivos aparecem na barra de "mais usados"
const RECENT_LIMIT = 4;

/**
 * Um dispositivo entra na SUA lista quando voce realmente o usa: adicionado
 * manualmente, fixado (pinned), ja acordado ao menos uma vez, ou e a propria
 * maquina. Todo o resto que a varredura acha fica na secao "Descobertos".
 */
function isTracked(d) {
  return Boolean(d.manual || d.self || d.pinned || (d.wakeCount || 0) > 0);
}

/**
 * Ordena os dispositivos pelo quanto sao usados (numero de vezes que foram
 * acordados, desempatando pelo uso mais recente) e devolve os primeiros.
 * E isso que alimenta a secao "Mais usados" automaticamente.
 */
function mostUsed(devices) {
  return devices
    .filter((d) => (d.wakeCount || 0) > 0)
    .sort((a, b) =>
      (b.wakeCount || 0) - (a.wakeCount || 0) ||
      new Date(b.lastWokenAt || 0) - new Date(a.lastWokenAt || 0))
    .slice(0, RECENT_LIMIT);
}

const app = document.getElementById('app');

// ---------------- API ----------------

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const body = isJson ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    throw new Error(body?.error || `Erro ${res.status}`);
  }
  return body;
}

async function loadDevices() {
  state.devices = await api('/api/devices');
  render();
}

async function loadNetwork() {
  try {
    const data = await api('/api/network');
    state.subnets = data.subnets;
  } catch {
    state.subnets = [];
  }
  render();
}

async function scanNetwork() {
  if (state.scanning) return;
  state.scanning = true;
  render();
  try {
    const data = await api('/api/scan', { method: 'POST' });
    state.devices = data.devices;
    state.subnets = data.subnets;
    const discovered = state.devices.filter((d) => !isTracked(d)).length;
    toast(
      `Varredura concluida: ${data.found} responderam.` +
      (discovered ? ` ${discovered} em "Descobertos na rede".` : ''),
      'success',
    );
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.scanning = false;
    render();
  }
}

async function wakeDevice(device) {
  state.waking.add(device.id);
  render();
  try {
    const res = await api(`/api/wake/${device.id}`, { method: 'POST' });
    if (res?.device) Object.assign(device, res.device);
    toast(`Magic packet enviado para ${device.name} (${device.mac}).`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    state.waking.delete(device.id);
    render();
  }
}

async function renameDevice(device, name) {
  if (!name || name === device.name) return;
  try {
    const updated = await api(`/api/devices/${device.id}`, {
      method: 'PUT',
      body: JSON.stringify({ name }),
    });
    Object.assign(device, updated);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteDevice(device) {
  if (!confirm(`Remover "${device.name}" da lista?`)) return;
  try {
    await api(`/api/devices/${device.id}`, { method: 'DELETE' });
    state.devices = state.devices.filter((d) => d.id !== device.id);
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function addManualDevice({ name, mac, ip }) {
  const device = await api('/api/devices', {
    method: 'POST',
    body: JSON.stringify({ name, mac, ip }),
  });
  state.devices.push(device);
  render();
}

async function setPinned(device, pinned) {
  try {
    const updated = await api(`/api/devices/${device.id}`, {
      method: 'PUT',
      body: JSON.stringify({ pinned }),
    });
    Object.assign(device, updated);
    if (pinned) toast(`"${device.name}" salvo nos seus dispositivos.`, 'success');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function pruneDiscovered() {
  if (!confirm('Remover da lista todos os dispositivos descobertos que voce nunca usou?\n\nOs que voce adicionou, fixou ou ja acordou permanecem.')) return;
  try {
    const data = await api('/api/devices/prune', { method: 'POST' });
    state.devices = data.devices;
    toast(`${data.removed} dispositivo(s) descoberto(s) removido(s).`, 'success');
    render();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// ---------------- UI helpers ----------------

function toast(message, kind = 'info') {
  let wrap = document.querySelector('.toast-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'toast-wrap';
    document.body.appendChild(wrap);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  wrap.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function timeAgo(iso) {
  if (!iso) return 'nunca';
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `${min} min atras`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h atras`;
  return `${Math.floor(h / 24)} d atras`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined) continue;
    node.append(child instanceof Node ? child : document.createTextNode(child));
  }
  return node;
}

// ---------------- render ----------------

function sortDevices(a, b) {
  return (
    Number(state.recentIds.has(b.id)) - Number(state.recentIds.has(a.id)) ||
    Number(b.online) - Number(a.online) ||
    a.name.localeCompare(b.name)
  );
}

function render() {
  app.innerHTML = '';
  app.append(renderHeader(), renderInfoBanner(), renderToolbar());

  const tracked = state.devices.filter(isTracked);
  const discovered = state.devices.filter((d) => !isTracked(d));

  const recent = mostUsed(tracked);
  state.recentIds = new Set(recent.map((d) => d.id));

  if (state.devices.length === 0) {
    app.append(renderEmpty());
  } else {
    // barra de atalho so aparece quando a lista e grande o suficiente pra valer
    if (tracked.length > RECENT_LIMIT && recent.length > 0) app.append(renderRecent(recent));

    if (tracked.length > 0) {
      app.append(el('div', { class: 'grid' }, tracked.slice().sort(sortDevices).map(renderCard)));
    } else {
      app.append(el('div', { class: 'empty' }, [
        el('div', {}, 'Sua lista esta vazia.'),
        el('div', { class: 'subtitle' }, 'Escaneie a rede e clique em "＋ Salvar" nos dispositivos que quiser manter, ou adicione um manualmente.'),
      ]));
    }

    if (discovered.length > 0) app.append(renderDiscovered(discovered));
  }

  app.append(renderFooter());
}

function renderDiscovered(devices) {
  const open = state.showDiscovered;
  const children = [
    el('button', {
      class: 'disc-toggle',
      onclick: () => { state.showDiscovered = !open; render(); },
    }, [
      el('span', { class: 'disc-caret' }, open ? '▾' : '▸'),
      el('strong', {}, `Descobertos na rede (${devices.length})`),
      el('span', { class: 'hint' }, 'vistos na varredura, ainda nao salvos'),
    ]),
  ];

  if (open) {
    children.push(el('div', { class: 'disc-actions' }, [
      el('button', { class: 'btn ghost small', onclick: pruneDiscovered }, ['🧹 Limpar todos']),
    ]));
    children.push(el('div', { class: 'disc-list' }, devices
      .slice()
      .sort((a, b) => Number(b.online) - Number(a.online) || (a.ip || '').localeCompare(b.ip || ''))
      .map(renderDiscoveredRow)));
  }

  return el('div', { class: 'discovered' }, children);
}

function renderDiscoveredRow(device) {
  const isWaking = state.waking.has(device.id);
  return el('div', { class: 'disc-row' }, [
    el('span', { class: `status-dot ${device.online ? 'online' : ''}`, title: device.online ? 'Online' : 'Offline' }),
    el('div', { class: 'disc-id' }, [
      el('span', { class: 'disc-name' }, device.name),
      el('code', {}, `${device.mac}${device.ip ? ` · ${device.ip}` : ''}`),
    ]),
    el('div', { class: 'disc-row-actions' }, [
      el('button', {
        class: 'btn small',
        disabled: isWaking ? 'true' : null,
        onclick: () => wakeDevice(device),
      }, [isWaking ? el('span', { class: 'spinner' }) : '⚡', 'Acordar']),
      el('button', { class: 'btn small primary', onclick: () => setPinned(device, true) }, '＋ Salvar'),
      el('button', { class: 'btn small danger', onclick: () => deleteDevice(device) }, '🗑'),
    ]),
  ]);
}

function renderRecent(devices) {
  return el('div', { class: 'recent' }, [
    el('div', { class: 'section-title' }, [
      '⭐ Mais usados',
      el('span', { class: 'hint' }, 'atualizado automaticamente conforme voce acorda os dispositivos'),
    ]),
    el('div', { class: 'recent-row' }, devices.map((device) => {
      const isWaking = state.waking.has(device.id);
      return el('button', {
        class: 'chip',
        disabled: (isWaking || device.self) ? 'true' : null,
        title: device.self
          ? 'Este e o dispositivo onde o app esta rodando'
          : `Acordar ${device.name} — usado ${device.wakeCount}x`,
        onclick: () => wakeDevice(device),
      }, [
        isWaking ? el('span', { class: 'spinner' }) : '⚡',
        el('span', { class: 'chip-name' }, device.name),
        el('span', { class: 'chip-count' }, `${device.wakeCount}x`),
      ]);
    })),
  ]);
}

function renderHeader() {
  return el('header', { class: 'top' }, [
    el('div', {}, [
      el('h1', {}, '🔌 WoL Auto'),
      el('div', { class: 'subtitle' }, 'Descoberta automatica de dispositivos e Wake on LAN na sua rede local'),
    ]),
  ]);
}

function renderInfoBanner() {
  const subnetTxt = state.subnets.length
    ? state.subnets.map((s) => s.cidr).join(', ')
    : 'nenhuma interface detectada';
  return el('div', { class: 'info-banner' }, [
    el('div', {}, [
      el('strong', {}, 'Como funciona: '),
      'clique em "Escanear rede" para varrer a sub-rede local e descobrir dispositivos ligados no momento (isso captura o MAC address de cada um). ',
      'Uma vez capturado, o MAC fica salvo e voce pode enviar o pacote magico (Wake on LAN) mesmo com o aparelho desligado — desde que o "Wake on LAN" esteja habilitado na placa de rede / BIOS do dispositivo.',
    ]),
    el('div', { style: 'margin-top:6px' }, [el('strong', {}, 'Sub-rede local: '), subnetTxt]),
  ]);
}

function renderToolbar() {
  return el('div', { class: 'toolbar' }, [
    el('button', {
      class: 'btn primary',
      disabled: state.scanning ? 'true' : null,
      onclick: scanNetwork,
    }, [
      state.scanning ? el('span', { class: 'spinner' }) : '🔍',
      state.scanning ? 'Escaneando...' : 'Escanear rede',
    ]),
    el('button', { class: 'btn', onclick: openAddModal }, ['➕ Adicionar manualmente']),
    el('button', { class: 'btn ghost', onclick: loadDevices }, ['↻ Atualizar lista']),
  ]);
}

function renderEmpty() {
  return el('div', { class: 'empty' }, [
    el('div', {}, '📡 Nenhum dispositivo cadastrado ainda.'),
    el('div', { class: 'subtitle' }, 'Clique em "Escanear rede" para descobrir os dispositivos ligados na sua LAN agora.'),
    el('button', { class: 'btn primary', onclick: scanNetwork }, ['🔍 Escanear rede agora']),
  ]);
}

function renderCard(device) {
  const isWaking = state.waking.has(device.id);

  const nameInput = el('input', {
    class: 'device-name',
    value: device.name,
    onblur: (e) => renameDevice(device, e.target.value.trim()),
    onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); },
  });
  nameInput.value = device.name;

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-head' }, [
      el('div', { style: 'display:flex;gap:8px;align-items:flex-start;flex:1;min-width:0' }, [
        el('span', { class: `status-dot ${device.online ? 'online' : ''}`, title: device.online ? 'Online' : 'Offline' }),
        nameInput,
      ]),
    ]),
    el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
      el('span', { class: `badge ${device.online ? 'online' : ''}` }, device.online ? 'Online' : 'Offline'),
      device.manual ? el('span', { class: 'badge manual' }, 'Manual') : null,
      device.self ? el('span', { class: 'badge self' }, '💻 Este dispositivo') : null,
      state.recentIds.has(device.id) ? el('span', { class: 'badge recent' }, '⭐ Mais usado') : null,
    ]),
    el('div', { class: 'meta' }, [
      el('div', {}, ['MAC: ', el('code', {}, device.mac)]),
      el('div', {}, ['IP: ', el('code', {}, device.ip || '—')]),
      device.hostname ? el('div', {}, ['Hostname: ', el('code', {}, device.hostname)]) : null,
      el('div', {}, `Visto por ultimo: ${timeAgo(device.lastSeen)}`),
      device.wakeCount
        ? el('div', {}, `Acordado ${device.wakeCount}x · ultima vez ${timeAgo(device.lastWokenAt)}`)
        : null,
    ]),
    el('div', { class: 'card-actions' }, [
      el('button', {
        class: 'btn primary small',
        disabled: (isWaking || device.self) ? 'true' : null,
        title: device.self ? 'Este e o dispositivo onde o app esta rodando' : null,
        onclick: () => wakeDevice(device),
      }, [isWaking ? el('span', { class: 'spinner' }) : '⚡', isWaking ? 'Enviando...' : 'Acordar']),
      el('button', {
        class: 'btn small danger',
        disabled: device.self ? 'true' : null,
        title: device.self ? 'Este dispositivo e re-adicionado automaticamente' : null,
        onclick: () => deleteDevice(device),
      }, '🗑'),
    ]),
  ]);
}

function renderFooter() {
  const tracked = state.devices.filter(isTracked);
  const online = tracked.filter((d) => d.online).length;
  const discovered = state.devices.length - tracked.length;
  return el('footer', { class: 'stats' }, [
    el('span', {}, `${tracked.length} na sua lista`),
    el('span', {}, `${online} online agora`),
    discovered ? el('span', {}, `${discovered} descoberto(s) na rede`) : null,
  ]);
}

// ---------------- modal: adicionar manualmente ----------------

function openAddModal() {
  const backdrop = el('div', { class: 'modal-backdrop', onclick: (e) => { if (e.target === backdrop) backdrop.remove(); } });
  const errorText = el('div', { class: 'error-text' });

  const nameField = el('input', { placeholder: 'Ex: PC do escritorio' });
  const macField = el('input', { placeholder: 'AA:BB:CC:DD:EE:FF' });
  const ipField = el('input', { placeholder: '192.168.1.50 (opcional)' });

  const modal = el('div', { class: 'modal' }, [
    el('h3', {}, 'Adicionar dispositivo manualmente'),
    el('div', { class: 'subtitle' }, 'Util para dispositivos que estao desligados e nao aparecem na varredura automatica.'),
    el('div', { class: 'row' }, [el('label', {}, 'Nome'), nameField]),
    el('div', { class: 'row' }, [el('label', {}, 'MAC Address'), macField]),
    el('div', { class: 'row' }, [el('label', {}, 'IP (opcional)'), ipField]),
    errorText,
    el('div', { class: 'actions' }, [
      el('button', { class: 'btn ghost', onclick: () => backdrop.remove() }, 'Cancelar'),
      el('button', {
        class: 'btn primary',
        onclick: async () => {
          errorText.textContent = '';
          try {
            await addManualDevice({
              name: nameField.value.trim(),
              mac: macField.value.trim(),
              ip: ipField.value.trim() || null,
            });
            backdrop.remove();
            toast('Dispositivo adicionado.', 'success');
          } catch (err) {
            errorText.textContent = err.message;
          }
        },
      }, 'Adicionar'),
    ]),
  ]);

  backdrop.append(modal);
  document.body.append(backdrop);
  macField.focus();
}

// ---------------- boot ----------------

loadDevices();
loadNetwork();
