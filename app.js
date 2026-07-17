// ============================================================
// Penyimpanan (localStorage)
// ============================================================
const KEY_CUSTOMERS = 'jt_customers';       // [{id, name}]
const KEY_APPOINTMENTS = 'jt_appointments'; // [{id, customerId, date, time, done?, staff?}]
const KEY_STAFF = 'jt_staff';               // ['Nama Pegawai', ...]

function load(key) {
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}
function save(key, data) { localStorage.setItem(key, JSON.stringify(data)); }

let customers = load(KEY_CUSTOMERS);
let appointments = load(KEY_APPOINTMENTS);
let staff = load(KEY_STAFF);
const nextId = (arr) => arr.reduce((m, x) => Math.max(m, x.id), 0) + 1;

function addStaff(name) {
  const q = name.trim().toLowerCase();
  if (!q) return;
  if (!staff.some((s) => s.toLowerCase() === q)) {
    staff.push(name.trim());
    staff.sort((a, b) => a.localeCompare(b, 'id'));
    save(KEY_STAFF, staff);
  }
}

const visitCount = (customerId) =>
  appointments.filter((a) => a.customerId === customerId).length;

function findCustomerByName(name) {
  const q = name.trim().toLowerCase();
  return customers.find((c) => c.name.toLowerCase() === q) || null;
}

function searchCustomerList(q) {
  q = q.trim().toLowerCase();
  if (!q) return [];
  return customers
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'id'))
    .slice(0, 8)
    .map((c) => ({ ...c, visits: visitCount(c.id) }));
}

// ============================================================
// Elemen & util tampilan
// ============================================================
const $ = (id) => document.getElementById(id);
const nameInput = $('name'), sug = $('sug'), badge = $('badge');
const historyBox = $('history'), historyList = $('historyList');
let selectedCustomer = null; // {id, name, visits} jika cocok dengan customer lama
let activeIdx = -1;

const hariBulan = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('id-ID',
  { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD
const hariGeser = (n) => { // n hari dari hari ini, format YYYY-MM-DD
  const d = new Date(); d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
};
const tglSingkat = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('id-ID',
  { day: 'numeric', month: 'short', year: 'numeric' });
const nameOf = (id) => (customers.find((c) => c.id === id) || { name: '?' }).name;

function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.className = 'toast', 3000);
}

// ============================================================
// Autocomplete nama customer
// ============================================================
nameInput.addEventListener('input', () => {
  selectedCustomer = null;
  const q = nameInput.value.trim();
  if (!q) { closeSug(); updateBadge(); return; }

  // Deteksi otomatis: nama persis sama dengan customer lama
  const exact = findCustomerByName(q);
  if (exact) selectCustomer({ ...exact, visits: visitCount(exact.id) }, false);
  else updateBadge();

  renderSug(searchCustomerList(q).filter((r) => !exact || r.id !== exact.id));
});

function renderSug(rows) {
  sug.innerHTML = '';
  activeIdx = -1;
  if (!rows.length) { closeSug(); return; }
  rows.forEach((r) => {
    const d = document.createElement('div');
    d.innerHTML = '<span></span><span class="meta"></span>';
    d.firstChild.textContent = r.name;
    d.lastChild.textContent = r.visits + 'x kunjungan';
    d.onmousedown = (e) => { e.preventDefault(); selectCustomer(r, true); };
    sug.appendChild(d);
  });
  sug.classList.add('open');
}

function closeSug() { sug.classList.remove('open'); sug.innerHTML = ''; activeIdx = -1; }

nameInput.addEventListener('keydown', (e) => {
  const items = [...sug.children];
  if (!items.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items.forEach((el, i) => el.classList.toggle('active', i === activeIdx));
  } else if (e.key === 'Enter' && activeIdx >= 0) {
    e.preventDefault();
    items[activeIdx].dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') closeSug();
});
nameInput.addEventListener('blur', () => setTimeout(closeSug, 120));

function selectCustomer(c, fill) {
  selectedCustomer = c;
  if (fill) { nameInput.value = c.name; closeSug(); }
  updateBadge();
  showHistory(c.id);
}

function updateBadge() {
  historyBox.classList.remove('show');
  if (selectedCustomer) {
    badge.className = 'badge known';
    badge.textContent = '✓ Customer terdeteksi: ' + selectedCustomer.name +
      ' (' + selectedCustomer.visits + 'x kunjungan)';
  } else if (nameInput.value.trim().length >= 2) {
    badge.className = 'badge new';
    badge.textContent = 'Customer baru — akan otomatis tersimpan.';
  } else {
    badge.className = 'badge';
  }
}

function showHistory(customerId) {
  const rows = appointments
    .filter((a) => a.customerId === customerId)
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .slice(0, 5);
  if (!rows.length) return;
  historyList.innerHTML = '';
  rows.forEach((r) => {
    const li = document.createElement('li');
    li.textContent = hariBulan(r.date) + ' — ' + r.time;
    historyList.appendChild(li);
  });
  historyBox.classList.add('show');
}

// ============================================================
// Simpan jadwal
// ============================================================
$('form').addEventListener('submit', (e) => {
  e.preventDefault();
  const cleanName = nameInput.value.trim().replace(/\s+/g, ' ');
  const date = $('date').value, time = $('time').value;
  if (!cleanName || !date || !time) { toast('Nama, tanggal, dan jam wajib diisi.', true); return; }

  // Auto-deteksi: pakai customer lama jika nama sudah ada (abaikan besar/kecil huruf)
  let customer = findCustomerByName(cleanName);
  const isNew = !customer;
  if (isNew) {
    customer = { id: nextId(customers), name: cleanName };
    customers.push(customer);
    save(KEY_CUSTOMERS, customers);
  }

  const dup = appointments.find((a) =>
    a.customerId === customer.id && a.date === date && a.time === time);
  if (dup) { toast(customer.name + ' sudah punya jadwal di tanggal dan jam yang sama.', true); return; }

  const newId = nextId(appointments);
  appointments.push({ id: newId, customerId: customer.id, date, time });
  save(KEY_APPOINTMENTS, appointments);

  let msg = isNew
    ? 'Jadwal tersimpan. ' + customer.name + ' terdaftar sebagai customer baru.'
    : 'Jadwal tersimpan untuk ' + customer.name + ' (customer lama).';
  if (!filteredRows().some((a) => a.id === newId)) {
    msg += ' Pilih "Semua" untuk melihatnya.';
  }
  toast(msg);
  nameInput.value = ''; $('time').value = '';
  selectedCustomer = null;
  updateBadge();
  renderList();
  nameInput.focus();
});

// ============================================================
// Filter daftar jadwal
// ============================================================
let filterMode = 'today'; // 'today' | 'pastweek' | 'nextweek' | 'day' | 'week' | 'all' | 'date'

function thisWeekRange() { // Senin s.d. Minggu pekan berjalan
  const d = new Date();
  const offset = (d.getDay() + 6) % 7; // 0 = Senin
  const mon = new Date(d); mon.setDate(d.getDate() - offset);
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const iso = (x) => x.toLocaleDateString('sv-SE');
  return [iso(mon), iso(sun)];
}

function filteredRows() {
  let rows = appointments.slice();
  if (filterMode === 'today') {
    rows = rows.filter((a) => a.date === today());
  } else if (filterMode === 'pastweek') { // 7 hari terakhir, termasuk hari ini
    const start = hariGeser(-7);
    rows = rows.filter((a) => a.date >= start && a.date <= today());
  } else if (filterMode === 'nextweek') { // hari ini s.d. 7 hari ke depan
    const end = hariGeser(7);
    rows = rows.filter((a) => a.date >= today() && a.date <= end);
  } else if (filterMode === 'day') {
    rows = rows.filter((a) => a.date === $('filterDate').value);
  } else if (filterMode === 'week') {
    const [mon, sun] = thisWeekRange();
    rows = rows.filter((a) => a.date >= mon && a.date <= sun);
  } else if (filterMode === 'date') {
    const start = $('filterStart').value, end = $('filterEnd').value;
    rows = rows.filter((a) => (!start || a.date >= start) && (!end || a.date <= end));
  }
  return rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

function setFilter(mode) {
  filterMode = mode;
  document.querySelectorAll('.chip[data-f]').forEach((c) => c.classList.toggle('active', c.dataset.f === mode));
  $('pickDateBtn').classList.toggle('active', mode === 'day');
  if (mode !== 'day') {
    $('filterDate').value = '';
    $('pickDateBtn').textContent = '📅 Pilih Tanggal';
  }
  const range = mode === 'date';
  $('filterStart').classList.toggle('active', range);
  $('filterEnd').classList.toggle('active', range);
  if (!range) { $('filterStart').value = ''; $('filterEnd').value = ''; }
  renderList();
}

document.querySelectorAll('.chip[data-f]').forEach((c) =>
  c.addEventListener('click', () => setFilter(c.dataset.f)));
['filterStart', 'filterEnd'].forEach((id) =>
  $(id).addEventListener('change', () => {
    if ($('filterStart').value || $('filterEnd').value) setFilter('date');
    else setFilter('today');
  }));
// Desktop: klik di mana pun pada field langsung buka kalender
// (di HP picker sudah terbuka sendiri saat field di-tap).
// Tombol ikut diikat untuk pengguna keyboard (Enter/Spasi).
['filterDate', 'pickDateBtn'].forEach((id) =>
  $(id).addEventListener('click', () => {
    try { $('filterDate').showPicker(); } catch { /* browser lama: fokus saja */ }
  }));
$('filterDate').addEventListener('change', () => {
  const v = $('filterDate').value;
  if (!v) { setFilter('today'); return; }
  setFilter('day');
  $('pickDateBtn').textContent = '📅 ' + tglSingkat(v);
});

// ============================================================
// Mode pilih: hapus banyak jadwal sekaligus
// ============================================================
let selectMode = false;
const selected = new Set();

function updateSelectBar() {
  $('selCount').textContent = selected.size + ' dipilih';
  $('selDelete').disabled = selected.size === 0;
  const visible = filteredRows();
  $('selAll').textContent =
    visible.length && visible.every((r) => selected.has(r.id)) ? 'Batal Semua' : 'Pilih Semua';
}

function setSelectMode(on) {
  selectMode = on;
  selected.clear();
  $('selectBtn').classList.toggle('on', on);
  $('selectBar').hidden = !on;
  renderList();
  if (on) updateSelectBar();
}

$('selectBtn').addEventListener('click', () => setSelectMode(!selectMode));
$('selCancel').addEventListener('click', () => setSelectMode(false));

$('selAll').addEventListener('click', () => {
  const visible = filteredRows();
  const allSelected = visible.length && visible.every((r) => selected.has(r.id));
  selected.clear();
  if (!allSelected) visible.forEach((r) => selected.add(r.id));
  renderList();
  updateSelectBar();
});

$('selDelete').addEventListener('click', () => {
  if (!selected.size) return;
  if (!confirm('Hapus ' + selected.size + ' jadwal yang dipilih?')) return;
  appointments = appointments.filter((a) => !selected.has(a.id));
  save(KEY_APPOINTMENTS, appointments);
  const n = selected.size;
  setSelectMode(false);
  toast(n + ' jadwal dihapus.');
});

// ============================================================
// Ubah jadwal
// ============================================================
let editingId = null;

function openEdit(apptId) {
  const a = appointments.find((x) => x.id === apptId);
  if (!a) return;
  editingId = apptId;
  const c = customers.find((x) => x.id === a.customerId);
  $('editName').textContent = c ? c.name : '?';
  $('editDate').value = a.date;
  $('editTime').value = a.time;
  $('editSheet').hidden = false;
}

function closeEdit() {
  editingId = null;
  $('editSheet').hidden = true;
}

$('editCancel').addEventListener('click', closeEdit);
$('editSheet').addEventListener('click', (e) => {
  if (e.target === $('editSheet')) closeEdit();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!$('editSheet').hidden) closeEdit();
  if (!$('doneSheet').hidden) closeDone();
});

$('editSave').addEventListener('click', () => {
  const a = appointments.find((x) => x.id === editingId);
  if (!a) { closeEdit(); return; }
  const date = $('editDate').value, time = $('editTime').value;
  if (!date || !time) { toast('Tanggal dan jam wajib diisi.', true); return; }

  const dup = appointments.find((x) =>
    x.id !== a.id && x.customerId === a.customerId && x.date === date && x.time === time);
  if (dup) {
    const c = customers.find((x) => x.id === a.customerId);
    toast((c ? c.name : 'Customer') + ' sudah punya jadwal di tanggal dan jam yang sama.', true);
    return;
  }

  a.date = date;
  a.time = time;
  save(KEY_APPOINTMENTS, appointments);
  closeEdit();
  renderList();
  toast('Jadwal berhasil diubah.');
});

// ============================================================
// Tandai selesai (treatment sudah dilakukan + pegawai yang menangani)
// ============================================================
let doneId = null;

function renderStaffChips() {
  const box = $('staffChips');
  box.innerHTML = '';
  const current = $('staffInput').value.trim().toLowerCase();
  staff.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'staff-chip' + (s.toLowerCase() === current ? ' active' : '');
    b.textContent = s;
    b.onclick = () => { $('staffInput').value = s; renderStaffChips(); };
    box.appendChild(b);
  });
}

$('staffInput').addEventListener('input', renderStaffChips);

function openDone(apptId) {
  const a = appointments.find((x) => x.id === apptId);
  if (!a) return;
  doneId = apptId;
  $('doneName').textContent = nameOf(a.customerId) + ' — ' + hariBulan(a.date) + ' ' + a.time;
  $('staffInput').value = a.staff || '';
  $('doneUndo').hidden = !a.done;
  renderStaffChips();
  $('doneSheet').hidden = false;
  // Fokus ke input hanya saat belum ada daftar pegawai (pertama kali harus ketik manual);
  // selebihnya cukup tap chip tanpa keyboard muncul.
  if (!a.done && !staff.length) $('staffInput').focus();
}

function closeDone() {
  doneId = null;
  $('doneSheet').hidden = true;
}

$('doneCancel').addEventListener('click', closeDone);
$('doneSheet').addEventListener('click', (e) => {
  if (e.target === $('doneSheet')) closeDone();
});

$('doneSave').addEventListener('click', () => {
  const a = appointments.find((x) => x.id === doneId);
  if (!a) { closeDone(); return; }
  const name = $('staffInput').value.trim().replace(/\s+/g, ' ');
  a.done = true;
  if (name) { a.staff = name; addStaff(name); }
  else delete a.staff;
  save(KEY_APPOINTMENTS, appointments);
  closeDone();
  renderList();
  toast(name ? 'Ditandai selesai — oleh ' + name + '.' : 'Ditandai selesai.');
});

$('doneUndo').addEventListener('click', () => {
  const a = appointments.find((x) => x.id === doneId);
  if (!a) { closeDone(); return; }
  delete a.done;
  delete a.staff;
  save(KEY_APPOINTMENTS, appointments);
  closeDone();
  renderList();
  toast('Tanda selesai dibatalkan.');
});

// ============================================================
// Daftar jadwal (render)
// ============================================================
function renderList() {
  const list = $('list');
  list.innerHTML = '';
  const rows = filteredRows();
  if (selectMode) {
    // Lepas pilihan pada jadwal yang tidak lagi tampil karena ganti filter
    const visibleIds = new Set(rows.map((r) => r.id));
    [...selected].forEach((id) => { if (!visibleIds.has(id)) selected.delete(id); });
    updateSelectBar();
  }
  if (!rows.length) {
    const msg = filterMode === 'today' ? 'Tidak ada jadwal hari ini.'
      : filterMode === 'pastweek' ? 'Tidak ada jadwal seminggu ke belakang.'
      : filterMode === 'nextweek' ? 'Tidak ada jadwal seminggu ke depan.'
      : filterMode === 'day' ? 'Tidak ada jadwal pada tanggal tersebut.'
      : filterMode === 'week' ? 'Tidak ada jadwal minggu ini.'
      : filterMode === 'date' ? 'Tidak ada jadwal pada rentang tanggal tersebut.'
      : 'Belum ada jadwal. Tambahkan lewat form di samping.';
    list.innerHTML = '<div class="empty">' + msg + '</div>';
    return;
  }
  let lastDate = null;
  rows.forEach((r) => {
    if (r.date !== lastDate) {
      const h = document.createElement('div');
      h.className = 'day-head';
      h.textContent = hariBulan(r.date);
      list.appendChild(h);
      lastDate = r.date;
    }
    const visits = visitCount(r.customerId);
    const el = document.createElement('div');
    el.className = 'appt';
    const main = document.createElement('div');
    main.className = 'appt-main';
    if (selectMode) {
      el.classList.add('selectable');
      if (selected.has(r.id)) el.classList.add('selected');
      main.innerHTML =
        '<span class="check">✓</span>' +
        '<div class="when"><div class="t"></div></div>' +
        '<div class="who"><div class="n"></div><div class="v"></div></div>';
      el.appendChild(main);
      el.onclick = () => {
        if (selected.has(r.id)) selected.delete(r.id); else selected.add(r.id);
        el.classList.toggle('selected', selected.has(r.id));
        updateSelectBar();
      };
    } else {
      if (r.done) el.classList.add('done');
      const bg = document.createElement('div');
      bg.className = 'appt-bg';
      bg.textContent = 'Hapus';
      el.appendChild(bg);
      main.innerHTML =
        '<button class="chk" title="Tandai treatment selesai">✓</button>' +
        '<div class="when"><div class="t"></div></div>' +
        '<div class="who"><div class="n"></div><div class="v"></div></div>' +
        '<button class="edit" title="Ubah jadwal">Ubah</button>' +
        '<button class="del" title="Hapus jadwal">Hapus</button>';
      el.appendChild(main);
      if (r.done) {
        const d = document.createElement('div');
        d.className = 'd';
        d.textContent = '✓ Selesai' + (r.staff ? ' · ' + r.staff : '');
        el.querySelector('.who').appendChild(d);
      }
      el.querySelector('.chk').onclick = () => openDone(r.id);
      el.querySelector('.edit').onclick = () => openEdit(r.id);
      el.querySelector('.del').onclick = () => confirmDelete(r);
      attachRowGestures(main, r);
    }
    el.querySelector('.t').textContent = r.time;
    el.querySelector('.n').textContent = nameOf(r.customerId);
    el.querySelector('.v').textContent = visits > 1 ? 'customer lama · ' + visits + 'x kunjungan' : 'customer baru';
    list.appendChild(el);
  });
}

function confirmDelete(r) {
  if (!confirm('Hapus jadwal ' + nameOf(r.customerId) + ' pada ' + hariBulan(r.date) + ' ' + r.time + '?')) return;
  appointments = appointments.filter((a) => a.id !== r.id);
  save(KEY_APPOINTMENTS, appointments);
  toast('Jadwal dihapus.');
  renderList();
}

// Gestur layar sentuh: geser kiri untuk hapus, tekan lama untuk ubah jadwal
function attachRowGestures(main, r) {
  let startX = 0, startY = 0, dx = 0;
  let mode = null; // null = belum tahu | 'swipe' | 'cancel' (scroll vertikal / long-press terpakai)
  let pressTimer = null;

  const clearPress = () => { clearTimeout(pressTimer); pressTimer = null; };
  const reset = () => {
    clearPress();
    main.style.transition = '';
    main.style.transform = '';
    mode = null;
  };

  main.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    startX = t.clientX; startY = t.clientY; dx = 0; mode = null;
    if (!e.target.closest('button')) {
      pressTimer = setTimeout(() => {
        pressTimer = null;
        mode = 'cancel';
        if (navigator.vibrate) navigator.vibrate(15);
        openEdit(r.id);
      }, 500);
    }
  }, { passive: true });

  main.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    const mx = t.clientX - startX, my = t.clientY - startY;
    if (Math.abs(mx) > 10 || Math.abs(my) > 10) clearPress();
    if (mode === null) {
      if (mx < -10 && Math.abs(mx) > Math.abs(my)) mode = 'swipe';
      else if (Math.abs(my) > 10) mode = 'cancel';
    }
    if (mode !== 'swipe') return;
    dx = Math.min(0, mx);
    main.style.transition = 'none';
    main.style.transform = 'translateX(' + dx + 'px)';
  }, { passive: true });

  main.addEventListener('touchend', () => {
    const wasSwipe = mode === 'swipe' && dx < -70;
    reset();
    if (wasSwipe) confirmDelete(r);
  });
  main.addEventListener('touchcancel', reset);
  main.addEventListener('contextmenu', (e) => {
    if (matchMedia('(pointer: coarse)').matches) e.preventDefault();
  });
}

// ============================================================
// Salin jadwal dalam format WhatsApp
// ============================================================
function buildWhatsAppText() {
  const rows = filteredRows();
  if (!rows.length) return null;
  let lines = ['*JADWAL TREATMENT* 💆'];
  let lastDate = null;
  let n = 0;
  rows.forEach((r) => {
    if (r.date !== lastDate) {
      lines.push('', '📅 *' + hariBulan(r.date) + '*');
      lastDate = r.date;
      n = 0;
    }
    n++;
    let line = n + '. ' + r.time + ' — ' + nameOf(r.customerId);
    if (r.done) line += ' ✅' + (r.staff ? ' (' + r.staff + ')' : '');
    lines.push(line);
  });
  return lines.join('\n');
}

$('waBtn').addEventListener('click', async () => {
  const text = buildWhatsAppText();
  if (!text) { toast('Belum ada jadwal untuk disalin.', true); return; }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback untuk browser/konteks tanpa Clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Jadwal tersalin — tinggal paste di WhatsApp.');
});

// ============================================================
// Export & Import data
// ============================================================
$('exportBtn').addEventListener('click', () => {
  if (!customers.length && !appointments.length) { toast('Belum ada data untuk di-export.', true); return; }
  const payload = {
    app: 'jadwal-treatment', version: 2, exportedAt: new Date().toISOString(),
    customers, appointments, staff,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'jadwal-treatment-' + today() + '.json';
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Data ter-export sebagai file JSON.');
});

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('File tidak bisa dibaca — bukan JSON valid.', true); return; }
  if (!Array.isArray(data.customers) || !Array.isArray(data.appointments)) {
    toast('Format file tidak dikenali.', true); return;
  }

  // Gabungkan: customer dicocokkan berdasarkan nama, jadwal duplikat dilewati
  let newCust = 0, newAppt = 0;
  const idMap = new Map(); // id di file -> id di penyimpanan ini
  data.customers.forEach((c) => {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return;
    const name = c.name.trim().replace(/\s+/g, ' ');
    let existing = findCustomerByName(name);
    if (!existing) {
      existing = { id: nextId(customers), name };
      customers.push(existing);
      newCust++;
    }
    idMap.set(c.id, existing.id);
  });
  data.appointments.forEach((a) => {
    if (!a || !idMap.has(a.customerId)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '') || !/^\d{2}:\d{2}$/.test(a.time || '')) return;
    const cid = idMap.get(a.customerId);
    if (appointments.some((x) => x.customerId === cid && x.date === a.date && x.time === a.time)) return;
    const appt = { id: nextId(appointments), customerId: cid, date: a.date, time: a.time };
    if (a.done === true) appt.done = true;
    if (typeof a.staff === 'string' && a.staff.trim()) {
      appt.staff = a.staff.trim().replace(/\s+/g, ' ');
      addStaff(appt.staff);
    }
    appointments.push(appt);
    newAppt++;
  });
  if (Array.isArray(data.staff)) {
    data.staff.forEach((s) => { if (typeof s === 'string') addStaff(s); });
  }
  save(KEY_CUSTOMERS, customers);
  save(KEY_APPOINTMENTS, appointments);
  renderList();
  toast('Import selesai: ' + newCust + ' customer baru, ' + newAppt + ' jadwal ditambahkan.');
});

// ============================================================
// PWA & inisialisasi awal
// ============================================================
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

$('date').value = today(); // hari ini, format YYYY-MM-DD
renderList();

if (new URLSearchParams(location.search).get('action') === 'add') {
  nameInput.focus();
  nameInput.scrollIntoView({ block: 'center' });
}
