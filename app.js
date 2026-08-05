// ============================================================
// Penyimpanan (Firestore) — data tersinkron antar perangkat.
// Susunan: users/{uid}/data/{customers|appointments|staff},
// tiap dokumen berisi { rows: [...] } meniru bentuk array lama.
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, doc, getDoc, getDocFromCache,
  setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const KEY_CUSTOMERS = 'customers';       // [{id, name}]
const KEY_APPOINTMENTS = 'appointments'; // [{id, customerId, date, time, done?, staff?}]
const KEY_STAFF = 'staff';               // ['Nama Pegawai', ...]

const configTerisi =
  window.FIREBASE_CONFIG && !String(window.FIREBASE_CONFIG.apiKey).startsWith('ISI_');
let db = null, auth = null, uid = null;
if (configTerisi) {
  const fbApp = initializeApp(window.FIREBASE_CONFIG);
  // Cache lokal: aplikasi tetap bisa dibuka dan diubah saat offline,
  // perubahan otomatis terkirim begitu online lagi.
  db = initializeFirestore(fbApp, { localCache: persistentLocalCache() });
  auth = getAuth(fbApp);
}

let customers = [];
let appointments = [];
let staff = [];

// Tiap cabang punya data sendiri di users/{uid}/cabang/{id}/data/...
// Daftar cabangnya tersimpan di users/{uid}/data/branches.
let cabangList = []; // [{id, name}]
let cabangId = null; // cabang yang sedang dibuka di perangkat ini

function save(key, data) {
  setDoc(doc(db, 'users', uid, 'cabang', cabangId, 'data', key), { rows: data })
    .catch((e) => toast('Gagal menyimpan ke cloud: ' + e.message, true));
}

// Id acak, bukan berurutan: dua perangkat yang offline bersamaan
// tidak mungkin membuat id kembar
const buatId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

function addStaff(name) {
  const q = name.trim().toLowerCase();
  if (!q) return;
  if (!staff.some((s) => s.toLowerCase() === q)) {
    staff.push(name.trim());
    staff.sort((a, b) => a.localeCompare(b, 'id'));
    save(KEY_STAFF, staff);
  }
}

// Kunci bulan = 'YYYY-MM', dipotong langsung dari tanggal ISO.
const kunciDari = (iso) => iso.slice(0, 7);
const kunciKini = () => {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
};
const tglKunci = (kunci) => new Date(+kunci.slice(0, 4), +kunci.slice(5, 7) - 1, 1);
// 'bulan ini' kalau memang bulan berjalan, selain itu sebut bulannya
const labelBulan = (kunci) => (kunci === kunciKini()
  ? 'bulan ini'
  : tglKunci(kunci).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }));
const labelBulanSingkat = (kunci) => (kunci === kunciKini()
  ? 'bulan ini'
  : tglKunci(kunci).toLocaleDateString('id-ID', { month: 'short', year: 'numeric' }));

// Tanpa `kunci`: total seumur hidup — dipakai untuk membedakan customer lama vs baru.
// Dengan `kunci` ('YYYY-MM'): cuma kunjungan di bulan itu.
const visitCount = (customerId, kunci) =>
  appointments.filter((a) =>
    a.customerId === customerId && (!kunci || kunciDari(a.date) === kunci)).length;

// Badge & saran nama mengikuti bulan tanggal yang sedang diisi di form;
// kalau tanggalnya belum dipilih, pakai bulan berjalan.
const kunciForm = () => ($('date').value ? kunciDari($('date').value) : kunciKini());

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
    .map((c) => ({ ...c, visits: visitCount(c.id, kunciForm()) }));
}

// ============================================================
// Elemen & util tampilan
// ============================================================
const $ = (id) => document.getElementById(id);
// Ikon garis dari sprite di index.html — menggantikan emoji supaya bentuknya
// sama di semua perangkat dan ikut warna teks di sekitarnya.
const ikon = (nama) =>
  '<svg class="ico" aria-hidden="true"><use href="#i-' + nama + '"/></svg>';
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
  if (exact) selectCustomer(exact, false);
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
    d.lastChild.textContent = r.visits + 'x ' + labelBulanSingkat(kunciForm());
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
    const kunci = kunciForm(); // dihitung ulang tiap render, biar ikut tanggal yang dipilih
    badge.className = 'badge known';
    badge.textContent = '✓ Customer terdeteksi: ' + selectedCustomer.name +
      ' (' + visitCount(selectedCustomer.id, kunci) + 'x kunjungan ' + labelBulan(kunci) + ')';
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
    customer = { id: buatId(), name: cleanName };
    customers.push(customer);
    save(KEY_CUSTOMERS, customers);
  }

  const dup = appointments.find((a) =>
    a.customerId === customer.id && a.date === date && a.time === time);
  if (dup) { toast(customer.name + ' sudah punya jadwal di tanggal dan jam yang sama.', true); return; }

  const newId = buatId();
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
    $('pickDateLabel').textContent = 'Pilih Tanggal';
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
  $('pickDateLabel').textContent = tglSingkat(v);
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
  appointments.forEach((a) => {
    if (selected.has(a.id)) (a.photos || []).forEach((p) => deleteDoc(fotoRef(p.id)).catch(() => {}));
  });
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
  if (!$('cabangSheet').hidden) closeCabangSheet();
  if (!$('fotoViewer').hidden) tutupFotoViewer();
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

// --- Foto hasil treatment ---
// Tiap foto utuh (terkompres ±1080px) jadi dokumen sendiri di koleksi photos;
// appointment hanya membawa daftar thumbnail mini (photos: [{id, thumb}])
// supaya daftar jadwal tetap ringan. Foto utuh baru diunduh saat dilihat,
// lalu tersimpan di cache Firestore — pola yang sama seperti WhatsApp.
const fotoRef = (id) => doc(db, 'users', uid, 'cabang', cabangId, 'photos', id);
let fotoTetap = []; // [{id, thumb}] — foto tersimpan yang tidak dihapus user
let fotoBaru = [];  // [{full, thumb}] — foto baru yang belum disimpan

// Foto utuh yang sudah ada di perangkat ini (pernah diunduh / baru di-upload).
// Dipakai supaya thumbnail tampil tajam tanpa mengunduh apa pun.
const fotoUtuh = new Map(); // photoId -> dataURL foto utuh

async function pasangFotoMini(img, p) {
  if (fotoUtuh.has(p.id)) { img.src = fotoUtuh.get(p.id); return; }
  img.src = p.thumb; // buram dulu; ganti tajam kalau ternyata ada di cache
  try {
    const snap = await getDocFromCache(fotoRef(p.id));
    if (snap.exists()) {
      fotoUtuh.set(p.id, snap.data().data);
      img.src = fotoUtuh.get(p.id);
    }
  } catch { /* belum pernah diunduh — biarkan thumbnail buram */ }
}

function bacaGambar(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bukan gambar')); };
    img.src = url;
  });
}

async function kompresFoto(file) {
  const img = await bacaGambar(file);
  const kecilkan = (maxSisi, mutu) => {
    const skala = Math.min(1, maxSisi / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * skala));
    c.height = Math.max(1, Math.round(img.naturalHeight * skala));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', mutu);
  };
  return { full: kecilkan(1080, 0.75), thumb: kecilkan(24, 0.4) };
}

function renderFotoRow() {
  const box = $('fotoRow');
  box.innerHTML = '';
  const pasang = (src, hapus) => {
    const wrap = document.createElement('div');
    wrap.className = 'foto-item';
    const img = document.createElement('img');
    img.className = 'foto-preview';
    img.src = src;
    img.alt = 'Foto treatment';
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'foto-x';
    x.title = 'Hapus foto ini';
    x.setAttribute('aria-label', 'Hapus foto ini');
    x.innerHTML = ikon('silang');
    x.onclick = hapus;
    wrap.append(img, x);
    box.appendChild(wrap);
  };
  fotoTetap.forEach((p, i) =>
    pasang(fotoUtuh.get(p.id) || p.thumb, () => { fotoTetap.splice(i, 1); renderFotoRow(); }));
  fotoBaru.forEach((p, i) => pasang(p.full, () => { fotoBaru.splice(i, 1); renderFotoRow(); }));
  const tambah = document.createElement('button');
  tambah.type = 'button';
  tambah.className = 'foto-btn';
  tambah.innerHTML = ikon('kamera') + 'Tambah Foto';
  tambah.onclick = () => $('fotoFile').click();
  box.appendChild(tambah);
}

$('fotoFile').addEventListener('change', async () => {
  const files = [...$('fotoFile').files];
  $('fotoFile').value = '';
  if (!files.length) return;
  let gagal = 0;
  for (const file of files) {
    try { fotoBaru.push(await kompresFoto(file)); }
    catch { gagal++; }
  }
  renderFotoRow();
  if (gagal) toast(gagal + ' file bukan gambar — dilewati.', true);
});

function openDone(apptId) {
  const a = appointments.find((x) => x.id === apptId);
  if (!a) return;
  doneId = apptId;
  $('doneName').textContent = nameOf(a.customerId) + ' — ' + hariBulan(a.date) + ' ' + a.time;
  $('staffInput').value = a.staff || '';
  $('doneUndo').hidden = !a.done;
  fotoTetap = (a.photos || []).slice();
  fotoBaru = [];
  renderStaffChips();
  renderFotoRow();
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
  // Foto yang dibuang user: hapus dokumennya di cloud
  (a.photos || []).forEach((p) => {
    if (!fotoTetap.some((t) => t.id === p.id)) deleteDoc(fotoRef(p.id)).catch(() => {});
  });
  fotoBaru.forEach((p) => {
    const idFoto = buatId();
    setDoc(fotoRef(idFoto), { data: p.full })
      .catch((e) => toast('Gagal menyimpan foto: ' + e.message, true));
    fotoUtuh.set(idFoto, p.full); // perangkat peng-upload langsung tajam
    fotoTetap.push({ id: idFoto, thumb: p.thumb });
  });
  if (fotoTetap.length) a.photos = fotoTetap;
  else delete a.photos;
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
  (a.photos || []).forEach((p) => deleteDoc(fotoRef(p.id)).catch(() => {}));
  delete a.photos;
  save(KEY_APPOINTMENTS, appointments);
  closeDone();
  renderList();
  toast('Tanda selesai dibatalkan.');
});

// ============================================================
// Viewer foto — thumbnail buram dulu, foto utuh diunduh saat dibuka
// lalu tersimpan di cache Firestore (tidak diunduh ulang lain kali)
// ============================================================
let muatFotoKe = 0;  // penanda: hasil unduhan lama tidak boleh menimpa viewer
let viewerFotos = []; // daftar {id, thumb} milik appointment yang sedang dilihat
let viewerIdx = 0;
let viewerDate = '';

function bukaFotoViewer(r, idx) {
  viewerFotos = r.photos || [];
  viewerDate = r.date;
  $('fotoViewer').hidden = false;
  tampilkanFoto(idx);
}

async function tampilkanFoto(idx) {
  viewerIdx = idx;
  const token = ++muatFotoKe;
  const p = viewerFotos[idx];
  const img = $('fotoViewerImg');
  $('fotoPrev').hidden = idx <= 0;
  $('fotoNext').hidden = idx >= viewerFotos.length - 1;
  $('fotoCounter').textContent = (idx + 1) + ' / ' + viewerFotos.length;
  $('fotoCounter').hidden = viewerFotos.length < 2;
  if (!fotoUtuh.has(p.id)) { // belum ada di perangkat: buram dulu, unduh
    img.src = p.thumb;
    img.className = 'memuat';
    $('fotoViewerSpin').hidden = false;
    $('fotoDownload').hidden = true;
    const ref = fotoRef(p.id);
    try {
      let snap;
      try { snap = await getDocFromCache(ref); } // ada di cache Firestore?
      catch { snap = await getDoc(ref); }        // belum — ambil dari cloud
      if (token !== muatFotoKe) return;          // keburu ditutup / pindah foto
      if (!snap.exists()) throw new Error('foto tidak ditemukan di cloud');
      fotoUtuh.set(p.id, snap.data().data);
    } catch (e) {
      if (token !== muatFotoKe) return;
      tutupFotoViewer();
      toast('Gagal memuat foto: ' + e.message, true);
      return;
    }
  }
  img.src = fotoUtuh.get(p.id);
  img.className = '';
  $('fotoViewerSpin').hidden = true;
  const unduh = $('fotoDownload');
  unduh.href = img.src;
  unduh.download = 'treatment-' + viewerDate + '-' + (idx + 1) + '.jpg';
  unduh.hidden = false;
}

function tutupFotoViewer() {
  muatFotoKe++;
  $('fotoViewer').hidden = true;
  $('fotoViewerImg').src = '';
  renderList(); // thumbnail foto yang baru diunduh ikut jadi tajam
}

$('fotoViewerClose').addEventListener('click', tutupFotoViewer);
$('fotoViewer').addEventListener('click', (e) => {
  if (e.target === $('fotoViewer')) tutupFotoViewer();
});
$('fotoPrev').addEventListener('click', () => tampilkanFoto(viewerIdx - 1));
$('fotoNext').addEventListener('click', () => tampilkanFoto(viewerIdx + 1));
document.addEventListener('keydown', (e) => {
  if ($('fotoViewer').hidden) return;
  if (e.key === 'ArrowLeft' && viewerIdx > 0) tampilkanFoto(viewerIdx - 1);
  if (e.key === 'ArrowRight' && viewerIdx < viewerFotos.length - 1) tampilkanFoto(viewerIdx + 1);
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
    // Lama/baru tetap dilihat dari seluruh riwayat; angkanya yang per bulan.
    const totalVisits = visitCount(r.customerId);
    const visitsBulan = visitCount(r.customerId, kunciDari(r.date));
    const el = document.createElement('div');
    el.className = 'appt';
    const main = document.createElement('div');
    main.className = 'appt-main';
    if (selectMode) {
      el.classList.add('selectable');
      if (selected.has(r.id)) el.classList.add('selected');
      main.innerHTML =
        '<span class="check">' + ikon('cek') + '</span>' +
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
        '<button class="chk" title="Tandai treatment selesai" ' +
        'aria-label="Tandai treatment selesai">' + ikon('cek') + '</button>' +
        '<div class="when"><div class="t"></div></div>' +
        '<div class="who"><div class="n"></div><div class="v"></div></div>' +
        '<button class="edit" title="Ubah jadwal">Ubah</button>' +
        '<button class="del" title="Hapus jadwal">Hapus</button>';
      el.appendChild(main);
      if (r.done) {
        const d = document.createElement('div');
        d.className = 'd';
        d.innerHTML = ikon('cek');
        d.append('Selesai' + (r.staff ? ' · ' + r.staff : ''));
        el.querySelector('.who').appendChild(d);
        if (r.photos && r.photos.length) {
          const rowFoto = document.createElement('div');
          rowFoto.className = 'foto-mini-row';
          r.photos.forEach((p, i) => {
            const f = document.createElement('img');
            f.className = 'foto-mini';
            f.alt = 'Foto treatment — tap untuk melihat';
            pasangFotoMini(f, p);
            f.onclick = () => bukaFotoViewer(r, i);
            rowFoto.appendChild(f);
          });
          el.querySelector('.who').appendChild(rowFoto);
        }
      }
      el.querySelector('.chk').onclick = () => openDone(r.id);
      el.querySelector('.edit').onclick = () => openEdit(r.id);
      el.querySelector('.del').onclick = () => confirmDelete(r);
      attachRowGestures(main, r);
    }
    el.querySelector('.t').textContent = r.time;
    el.querySelector('.n').textContent = nameOf(r.customerId);
    el.querySelector('.v').textContent = totalVisits > 1
      ? 'customer lama · ' + visitsBulan + 'x ' + labelBulanSingkat(kunciDari(r.date))
      : 'customer baru';
    list.appendChild(el);
  });
  jadwalkanAnalitik();
}

function confirmDelete(r) {
  if (!confirm('Hapus jadwal ' + nameOf(r.customerId) + ' pada ' + hariBulan(r.date) + ' ' + r.time + '?')) return;
  (r.photos || []).forEach((p) => deleteDoc(fotoRef(p.id)).catch(() => {}));
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
    if (!e.target.closest('button, .foto-mini')) {
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
  // Kalau cabang lebih dari satu, cantumkan nama cabang di judul
  const cabang = cabangList.find((c) => c.id === cabangId);
  const judulCabang = cabangList.length > 1 && cabang ? ' ' + cabang.name.toUpperCase() : '';
  let lines = ['*JADWAL TREATMENT' + judulCabang + '* 💆'];
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
      existing = { id: buatId(), name };
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
    const appt = { id: buatId(), customerId: cid, date: a.date, time: a.time };
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
// Login & sinkronisasi Firestore
// ============================================================
function ambilLokalLama(key) { // data versi lama (localStorage), untuk migrasi
  try { return JSON.parse(localStorage.getItem(key)) || []; }
  catch { return []; }
}

let stopCabangList = null;
let stopData = [];

function mulaiSync() {
  stopCabangList = onSnapshot(
    doc(db, 'users', uid, 'data', 'branches'),
    (snap) => {
      if (!snap.exists() || !(snap.data().rows || []).length) {
        buatCabangDefault();
        return;
      }
      cabangList = snap.data().rows;
      // Cabang aktif: yang terakhir dipakai di perangkat ini, atau cabang pertama
      if (!cabangList.some((c) => c.id === cabangId)) cabangId = null;
      if (!cabangId) {
        const tersimpan = localStorage.getItem('jt_cabang');
        cabangId = (cabangList.some((c) => c.id === tersimpan) ? tersimpan : cabangList[0].id);
        mulaiSyncData();
      }
      renderCabangBar();
    },
    (e) => toast('Gagal memuat daftar cabang: ' + e.message, true)
  );
}

function mulaiSyncData() {
  stopData.forEach((lepas) => lepas());
  const pasang = (key, terapkan) => onSnapshot(
    doc(db, 'users', uid, 'cabang', cabangId, 'data', key),
    (snap) => {
      terapkan(snap.exists() ? (snap.data().rows || []) : []);
      renderList();
    },
    (e) => toast('Gagal memuat data: ' + e.message, true)
  );
  stopData = [
    pasang(KEY_CUSTOMERS, (rows) => { customers = rows; }),
    pasang(KEY_APPOINTMENTS, (rows) => { appointments = rows; }),
    pasang(KEY_STAFF, (rows) => { staff = rows; }),
  ];
}

// Login pertama: siapkan cabang default dan angkat data lama ke cabang
// pertama — dari lokasi cloud versi sebelum-cabang kalau ada, atau localStorage.
const CABANG_DEFAULT = ['Puri', 'Kemayoran', 'Bandung'];
let migrasiJalan = false;
async function buatCabangDefault() {
  if (migrasiJalan) return;
  migrasiJalan = true;
  try {
    const daftar = CABANG_DEFAULT.map((name) => ({ id: buatId(), name }));
    for (const key of [KEY_CUSTOMERS, KEY_APPOINTMENTS, KEY_STAFF]) {
      let rows = [];
      try {
        const lamaCloud = await getDoc(doc(db, 'users', uid, 'data', key));
        if (lamaCloud.exists()) rows = lamaCloud.data().rows || [];
      } catch { /* offline: lewati, coba localStorage saja */ }
      if (!rows.length) rows = ambilLokalLama('jt_' + key);
      if (rows.length) {
        await setDoc(doc(db, 'users', uid, 'cabang', daftar[0].id, 'data', key), { rows });
      }
    }
    await setDoc(doc(db, 'users', uid, 'data', 'branches'), { rows: daftar });
  } catch (e) {
    toast('Gagal menyiapkan cabang: ' + e.message, true);
  }
  migrasiJalan = false;
}

// ============================================================
// Pilih & tambah cabang
// ============================================================
function renderCabangBar() {
  const bar = $('cabangBar');
  bar.innerHTML = '';
  cabangList.forEach((c) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip' + (c.id === cabangId ? ' active' : '');
    b.innerHTML = ikon('lokasi');
    b.append(c.name);
    b.addEventListener('click', () => pilihCabang(c.id));
    bar.appendChild(b);
  });
  const tambah = document.createElement('button');
  tambah.type = 'button';
  tambah.className = 'chip chip-tambah';
  tambah.title = 'Tambah cabang baru';
  tambah.innerHTML = ikon('plus') + 'Cabang';
  tambah.addEventListener('click', () => {
    $('cabangName').value = '';
    $('cabangSheet').hidden = false;
    $('cabangName').focus();
  });
  bar.appendChild(tambah);
}

function pilihCabang(id) {
  if (id === cabangId) return;
  cabangId = id;
  localStorage.setItem('jt_cabang', id);
  customers = []; appointments = []; staff = [];
  if (selectMode) setSelectMode(false);
  mulaiSyncData();
  renderCabangBar();
  renderList();
}

function closeCabangSheet() { $('cabangSheet').hidden = true; }
$('cabangCancel').addEventListener('click', closeCabangSheet);
$('cabangSheet').addEventListener('click', (e) => {
  if (e.target === $('cabangSheet')) closeCabangSheet();
});
$('cabangSave').addEventListener('click', () => {
  const name = $('cabangName').value.trim().replace(/\s+/g, ' ');
  if (!name) { toast('Nama cabang wajib diisi.', true); return; }
  if (cabangList.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    toast('Cabang "' + name + '" sudah ada.', true);
    return;
  }
  const cabang = { id: buatId(), name };
  cabangList.push(cabang);
  setDoc(doc(db, 'users', uid, 'data', 'branches'), { rows: cabangList })
    .catch((e) => toast('Gagal menyimpan cabang: ' + e.message, true));
  closeCabangSheet();
  pilihCabang(cabang.id);
  toast('Cabang "' + name + '" dibuat.');
});

if (!configTerisi) {
  $('splashScreen').hidden = true;
  $('loginScreen').hidden = false;
  $('loginSetup').hidden = false;
  $('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    toast('Isi dulu firebase-config.js — lihat README.', true);
  });
} else {
  onAuthStateChanged(auth, (user) => {
    $('splashScreen').hidden = true; // sesi sudah dicek — baru tentukan layar
    if (user) {
      uid = user.uid;
      $('loginScreen').hidden = true;
      mulaiSync();
    } else {
      uid = null;
      if (stopCabangList) { stopCabangList(); stopCabangList = null; }
      stopData.forEach((lepas) => lepas());
      stopData = [];
      customers = []; appointments = []; staff = [];
      cabangList = []; cabangId = null;
      $('cabangBar').innerHTML = '';
      renderList();
      $('loginScreen').hidden = false;
    }
  });

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'Masuk…';
    try {
      await signInWithEmailAndPassword(auth, $('loginEmail').value.trim(), $('loginPass').value);
      $('loginPass').value = '';
    } catch (err) {
      const salahKredensial = ['auth/invalid-credential', 'auth/wrong-password',
        'auth/user-not-found', 'auth/invalid-email'].includes(err.code);
      toast(salahKredensial ? 'Email atau password salah.' : 'Gagal masuk: ' + (err.code || err.message), true);
    }
    btn.disabled = false; btn.textContent = 'Masuk';
  });

  $('logoutBtn').addEventListener('click', () => signOut(auth));
}

// ============================================================
// Tab Jadwal / Analitik
// ============================================================
function pilihTab(nama) {
  document.querySelectorAll('.tab').forEach((t) => {
    const aktif = t.dataset.tab === nama;
    t.classList.toggle('active', aktif);
    t.setAttribute('aria-selected', aktif ? 'true' : 'false');
  });
  $('panelJadwal').hidden = nama !== 'jadwal';
  $('panelAnalitik').hidden = nama !== 'analitik';
  // Mode pilih hanya berlaku di daftar jadwal — bar-nya mengambang di bawah
  if (nama !== 'jadwal' && selectMode) setSelectMode(false);
  tipSembunyi();
  if (nama === 'analitik') renderAnalitik();
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => pilihTab(t.dataset.tab)));

// ============================================================
// Analitik — ringkasan satu bulan untuk cabang yang sedang dibuka.
// Semua grafik memakai satu skala warna turunan --accent; angka yang
// tidak dilabeli langsung tetap terbaca lewat tooltip dan tabel di bawah.
// ============================================================
const hariSingkat = (iso) => new Date(iso + 'T00:00:00')
  .toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long' });
const kunciBulan = (y, m) => y + '-' + String(m + 1).padStart(2, '0');
const bulanSekarang = () => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; };
let bln = bulanSekarang();

// Analitik ikut ter-refresh setiap data berubah, tapi hanya kalau tabnya terbuka
function jadwalkanAnalitik() {
  if (!$('panelAnalitik').hidden) renderAnalitik();
}

function geserBulan(n) {
  const d = new Date(bln.y, bln.m + n, 1);
  bln = { y: d.getFullYear(), m: d.getMonth() };
  renderAnalitik();
}
$('bulanPrev').addEventListener('click', () => geserBulan(-1));
$('bulanNext').addEventListener('click', () => geserBulan(1));
$('bulanKini').addEventListener('click', () => { bln = bulanSekarang(); renderAnalitik(); });

// --- Tooltip bersama untuk semua grafik ---
function tipTampil(el, html) {
  const tip = $('vizTip');
  tip.innerHTML = html;
  tip.hidden = false;
  const r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
  const kiri = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8));
  const atas = r.top - t.height - 8;
  tip.style.left = kiri + 'px';
  tip.style.top = (atas < 8 ? r.bottom + 8 : atas) + 'px';
}
function tipSembunyi() { $('vizTip').hidden = true; }
function pasangTip(el, html) {
  const buka = () => tipTampil(el, html);
  el.addEventListener('mouseenter', buka);
  el.addEventListener('focus', buka);
  el.addEventListener('mouseleave', tipSembunyi);
  el.addEventListener('blur', tipSembunyi);
}
addEventListener('scroll', tipSembunyi, { passive: true });

// --- Perhitungan ---
function ringkasBulan(kunci) {
  const rows = appointments.filter((a) => a.date.slice(0, 7) === kunci);
  return {
    rows,
    total: rows.length,
    unik: new Set(rows.map((a) => a.customerId)).size,
  };
}

// --- Deretan angka utama ---
function renderKpi(kini, lalu) {
  const box = $('kpiRow');
  box.innerHTML = '';
  [
    ['Total treatment', kini.total, lalu.total],
    ['Customer dilayani', kini.unik, lalu.unik],
  ].forEach(([label, nilai, sebelum]) => {
    const kartu = document.createElement('div');
    kartu.className = 'kpi';
    const l = document.createElement('div');
    l.className = 'kpi-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'kpi-val';
    v.textContent = String(nilai);
    const beda = nilai - sebelum;
    const d = document.createElement('div');
    // Arah dibaca dari panah + angka, bukan dari warnanya saja
    d.className = 'kpi-delta ' + (beda > 0 ? 'naik' : beda < 0 ? 'turun' : 'datar');
    d.textContent = beda === 0
      ? 'sama seperti bulan lalu'
      : (beda > 0 ? '▲ +' : '▼ −') + Math.abs(beda) + ' vs bulan lalu';
    kartu.append(l, v, d);
    box.appendChild(kartu);
  });
}

// --- Heatmap kepadatan harian (kalender sebulan) ---
const tingkatWarna = (n, maks) => {
  if (!n) return 0;
  if (maks <= 4) return Math.min(n, 4);
  return Math.min(4, Math.ceil(n / (maks / 4)));
};

function renderHeat(kini) {
  const box = $('heat');
  box.innerHTML = '';
  ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].forEach((h) => {
    const d = document.createElement('div');
    d.className = 'heat-dow';
    d.textContent = h;
    box.appendChild(d);
  });

  const perHari = new Map();
  kini.rows.forEach((a) => perHari.set(a.date, (perHari.get(a.date) || 0) + 1));
  const maks = perHari.size ? Math.max(...perHari.values()) : 0;

  const jmlHari = new Date(bln.y, bln.m + 1, 0).getDate();
  const geser = (new Date(bln.y, bln.m, 1).getDay() + 6) % 7; // 0 = Senin
  for (let i = 0; i < geser; i++) {
    const kosong = document.createElement('div');
    kosong.className = 'heat-sel luar';
    box.appendChild(kosong);
  }
  for (let t = 1; t <= jmlHari; t++) {
    const iso = kunciBulan(bln.y, bln.m) + '-' + String(t).padStart(2, '0');
    const n = perHari.get(iso) || 0;
    const sel = document.createElement('button');
    sel.type = 'button';
    sel.className = 'heat-sel' + (iso === today() ? ' kini' : '');
    sel.dataset.l = String(tingkatWarna(n, maks));
    sel.textContent = String(t);
    const teks = n ? n + ' treatment' : 'Tidak ada jadwal';
    sel.setAttribute('aria-label', teks + ' — ' + hariSingkat(iso) + '. Buka di daftar jadwal.');
    pasangTip(sel, '<b>' + teks + '</b><br>' + hariSingkat(iso));
    sel.addEventListener('click', () => bukaTanggal(iso));
    box.appendChild(sel);
  }

  const legenda = $('heatLegend');
  legenda.innerHTML = '';
  const sepi = document.createElement('span');
  sepi.textContent = 'Sepi';
  legenda.appendChild(sepi);
  for (let l = 0; l <= 4; l++) {
    const k = document.createElement('i');
    k.className = 'heat-key';
    k.style.background = 'var(--h' + l + ')';
    legenda.appendChild(k);
  }
  const ramai = document.createElement('span');
  ramai.textContent = 'Ramai';
  legenda.appendChild(ramai);
  if (maks) {
    const sisa = document.createElement('span');
    sisa.className = 'sisa';
    sisa.textContent = 'Terpadat ' + maks + ' treatment/hari';
    legenda.appendChild(sisa);
  }
}

// Klik satu kotak → langsung lihat jadwal hari itu di tab Jadwal
function bukaTanggal(iso) {
  $('filterDate').value = iso;
  setFilter('day');
  $('pickDateLabel').textContent = tglSingkat(iso);
  pilihTab('jadwal');
  scrollTo({ top: 0, behavior: 'smooth' });
}

// --- Jam tersibuk (kolom, satu seri) ---
function renderJam(kini) {
  const box = $('chartJam');
  box.innerHTML = '';
  if (!kini.rows.length) {
    box.innerHTML = '<div class="empty">Belum ada jadwal di bulan ini.</div>';
    return;
  }
  const per = new Map();
  kini.rows.forEach((a) => {
    const j = a.time.slice(0, 2);
    per.set(j, (per.get(j) || 0) + 1);
  });
  const jam = [...per.keys()].map(Number).sort((a, b) => a - b);
  const dari = jam[0], sampai = jam[jam.length - 1];
  const nilaiMaks = Math.max(...per.values());
  const jmlKolom = sampai - dari + 1;

  const plot = document.createElement('div');
  plot.className = 'jam-plot';
  const sumbu = document.createElement('div');
  sumbu.className = 'jam-axis';
  for (let j = dari; j <= sampai; j++) {
    const kunci = String(j).padStart(2, '0');
    const n = per.get(kunci) || 0;
    const kolom = document.createElement('div');
    kolom.className = 'jam-col';
    kolom.tabIndex = 0;
    // Label langsung hanya di jam terpadat — sisanya lewat tooltip & tabel
    if (n && n === nilaiMaks) {
      const v = document.createElement('span');
      v.className = 'jam-nilai';
      v.textContent = String(n);
      kolom.appendChild(v);
    }
    const bar = document.createElement('div');
    bar.className = 'jam-bar';
    bar.style.height = (n ? Math.max(3, Math.round(n / nilaiMaks * 108)) : 0) + 'px';
    kolom.appendChild(bar);
    kolom.setAttribute('aria-label', n + ' treatment pada jam ' + kunci + '.00');
    pasangTip(kolom, '<b>' + n + ' treatment</b><br>jam ' + kunci + '.00');
    plot.appendChild(kolom);

    const tick = document.createElement('div');
    tick.className = 'jam-tick';
    // Kalau kolomnya banyak, cukup label selang-seling biar tidak berdempetan
    tick.textContent = (jmlKolom > 10 && (j - dari) % 2) ? '' : kunci;
    sumbu.appendChild(tick);
  }
  box.append(plot, sumbu);
}

// --- Tabel: padanan angka untuk tiap grafik ---
function renderTabel(kini) {
  const box = $('tabelWrap');
  box.innerHTML = '';
  const tambah = (judul, kepala, baris, kosong) => {
    const h = document.createElement('h3');
    h.textContent = judul;
    box.appendChild(h);
    if (!baris.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = kosong;
      box.appendChild(p);
      return;
    }
    const tabel = document.createElement('table');
    const kepalaBaris = document.createElement('tr');
    kepala.forEach((k, i) => {
      const th = document.createElement('th');
      th.textContent = k;
      if (i) th.className = 'num';
      kepalaBaris.appendChild(th);
    });
    const thead = document.createElement('thead');
    thead.appendChild(kepalaBaris);
    const tbody = document.createElement('tbody');
    baris.forEach((r) => {
      const tr = document.createElement('tr');
      r.forEach((sel, i) => {
        const td = document.createElement('td');
        td.textContent = String(sel);
        if (i) td.className = 'num';
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tabel.append(thead, tbody);
    box.appendChild(tabel);
  };

  const perHari = new Map();
  kini.rows.forEach((a) => perHari.set(a.date, (perHari.get(a.date) || 0) + 1));
  tambah('Per hari', ['Tanggal', 'Treatment'],
    [...perHari.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([iso, n]) => [tglSingkat(iso), n]),
    'Belum ada jadwal di bulan ini.');

  const perJam = new Map();
  kini.rows.forEach((a) => {
    const j = a.time.slice(0, 2);
    perJam.set(j, (perJam.get(j) || 0) + 1);
  });
  tambah('Per jam', ['Jam', 'Treatment'],
    [...perJam.entries()].sort((a, b) => a[0].localeCompare(b[0]))
      .map(([j, n]) => [j + '.00', n]),
    'Belum ada jadwal di bulan ini.');
}

$('tabelToggle').addEventListener('click', () => {
  const wrap = $('tabelWrap');
  const buka = wrap.hidden;
  wrap.hidden = !buka;
  $('tabelToggle').setAttribute('aria-expanded', buka ? 'true' : 'false');
  $('tabelToggle').textContent = buka ? 'Sembunyikan tabel' : 'Lihat angka dalam tabel';
  if (buka) renderAnalitik();
});

function renderAnalitik() {
  const kunci = kunciBulan(bln.y, bln.m);
  $('bulanLabel').textContent = new Date(bln.y, bln.m, 1)
    .toLocaleDateString('id-ID', { month: 'long', year: 'numeric' });
  const ini = bulanSekarang();
  $('bulanKini').hidden = bln.y === ini.y && bln.m === ini.m;

  const kini = ringkasBulan(kunci);
  const bulanLalu = new Date(bln.y, bln.m - 1, 1);
  const lalu = ringkasBulan(kunciBulan(bulanLalu.getFullYear(), bulanLalu.getMonth()));

  renderKpi(kini, lalu);
  renderHeat(kini);
  renderJam(kini);
  if (!$('tabelWrap').hidden) renderTabel(kini);
}

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
