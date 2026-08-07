// ============================================================
// Penyimpanan (Firestore) — server satu-satunya sumber kebenaran.
// Susunan: users/{uid}/data/{customers|appointments|staff},
// tiap dokumen berisi { rows: [...] } meniru bentuk array lama.
//
// Tiap dokumen ditulis utuh sekali kirim, jadi yang menulis terakhir menang
// dengan membawa seluruh isinya. Selama masih ada salinan lokal yang menetap,
// perangkat yang lama tidak dibuka bisa mengirim array versi lamanya dan
// menghapus semua yang ditambahkan perangkat lain — persis yang menghilangkan
// 24 customer pada 7 Agustus 2026. Karena itu: tidak ada cache yang menetap,
// dan perubahan hanya boleh jalan saat benar-benar tersambung.
// ============================================================
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  initializeFirestore, memoryLocalCache, doc, getDoc,
  setDoc, deleteDoc, onSnapshot,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const KEY_CUSTOMERS = 'customers';       // [{id, name, gender?, genderManual?}]
const KEY_APPOINTMENTS = 'appointments'; // [{id, customerId, date, time}]
// Pegawai cuma dipakai fitur "tandai selesai" yang sedang dinonaktifkan. Datanya
// tetap ikut disinkronkan dan ikut terbawa export/import supaya utuh saat fiturnya
// dinyalakan lagi — begitu juga field done/staff/photos di tiap appointment.
const KEY_STAFF = 'staff';               // ['Nama Pegawai', ...]

const configTerisi =
  window.FIREBASE_CONFIG && !String(window.FIREBASE_CONFIG.apiKey).startsWith('ISI_');
let db = null, auth = null, uid = null;
if (configTerisi) {
  const fbApp = initializeApp(window.FIREBASE_CONFIG);
  // Cache memori saja: begitu tab ditutup tidak ada sisa data maupun antrean
  // tulisan yang bisa terkirim belakangan dan menimpa data yang lebih baru.
  db = initializeFirestore(fbApp, { localCache: memoryLocalCache() });
  auth = getAuth(fbApp);
}

let customers = [];
let appointments = [];
let staff = [];

// Tiap cabang punya data sendiri di users/{uid}/cabang/{id}/data/...
// Daftar cabangnya tersimpan di users/{uid}/data/branches.
let cabangList = []; // [{id, name}]
let cabangId = null; // cabang yang sedang dibuka di perangkat ini

// Status sambungan, dibaca dari metadata snapshot Firestore. Selama snapshot
// masih fromCache, isi layar belum tentu sama dengan isi server.
let tersambung = false;

function setSambung(on) {
  tersambung = on;
  $('offlineBar').hidden = on || !uid;
}

// Gerbang untuk semua perubahan data. Menulis tanpa sambungan berarti mengirim
// seluruh array versi layar ini, yang bisa saja sudah tertinggal — jadi
// perubahannya ditolak di depan, sebelum apa pun ikut berubah di memori.
function bolehUbah() {
  if (tersambung) return true;
  toast('Belum tersambung ke server — perubahan tidak bisa disimpan dulu.', true);
  return false;
}

function save(key, data) {
  if (!tersambung) return; // jaring terakhir; pemanggilnya sudah lewat bolehUbah()
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

// ============================================================
// Gender customer
// Gender disimpan di customer.gender, diisi saat mendaftar. Isiannya
// ketebak sendiri dari sapaan di depan nama ("Ci Lulu" perempuan,
// "Ko Hans" laki-laki) supaya tidak ada yang perlu diketik ulang, dan
// tebakan yang sama dipakai untuk mengisi data lama yang belum punya
// gender. Yang dipilih manual ditandai genderManual — penanda itu yang
// menjaga pilihan operator tidak tertimpa tebakan saat nama diubah
// atau saat data dari file di-import.
// ============================================================
const SAPAAN = new Map([
  ['ci', 'P'], ['cici', 'P'], ['cicinya', 'P'], ['cik', 'P'], ['cece', 'P'],
  ['ce', 'P'], ['cc', 'P'], ['ibu', 'P'], ['ibunya', 'P'], ['bu', 'P'],
  ['mama', 'P'], ['mamanya', 'P'], ['mami', 'P'], ['tante', 'P'], ['tantenya', 'P'],
  ['mbak', 'P'], ['mba', 'P'], ['nyonya', 'P'], ['ny', 'P'], ['nona', 'P'],
  ['istri', 'P'], ['istrinya', 'P'], ['sis', 'P'], ['kakaknya', 'P'],

  ['ko', 'L'], ['koko', 'L'], ['kokonya', 'L'], ['pa', 'L'], ['pak', 'L'],
  ['bapa', 'L'], ['bapak', 'L'], ['om', 'L'], ['omnya', 'L'], ['mas', 'L'],
  ['papa', 'L'], ['papanya', 'L'], ['papi', 'L'], ['tuan', 'L'], ['tn', 'L'],
  ['suami', 'L'], ['suaminya', 'L'], ['abang', 'L'], ['bang', 'L'],
  // "Ps" di data ini singkatan Pastur — jabatannya memang selalu laki-laki.
  // "Pdt" (Pendeta) sengaja tidak ikut: pendeta perempuan itu biasa.
  ['ps', 'L'], ['pastur', 'L'], ['romo', 'L'],

  // Kata yang tidak menunjukkan gender tapi tetap dihitung sebagai sapaan,
  // supaya pembacaan berhenti di situ. Tanpa ini "Anak Ci Kiwi" akan terbaca
  // perempuan padahal "Ci" itu ibunya, bukan orang yang datang treatment.
  ['anak', '?'], ['anaknya', '?'], ['cucu', '?'], ['cucunya', '?'],
  ['ponakan', '?'], ['keponakan', '?'], ['adik', '?'], ['ade', '?'], ['dede', '?'],
  ['kakak', '?'], ['temen', '?'], ['teman', '?'],
  ['pdt', '?'], ['dr', '?'], ['drg', '?'], ['sdr', '?'],
]);

// Sapaan pertama yang dikenali menentukan gendernya — sapaan berikutnya
// biasanya milik orang lain ("Ko Roy Suami Ci Marinee" tetap laki-laki).
function tebakGender(nama) {
  for (const kata of String(nama || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)) {
    const g = SAPAAN.get(kata);
    if (g) return g;
  }
  return '?';
}
const genderCust = (c) => (c && (c.gender || tebakGender(c.name))) || '?';

// Data customer lama dibuat sebelum ada kolom gender. Tiap kali datanya masuk,
// tebakan yang sudah pasti dituliskan sekalian ke Firebase supaya gender jadi
// field beneran — bukan hasil tebak ulang tiap kali dibaca. Yang sapaannya
// tidak dikenali sengaja dibiarkan kosong biar tetap muncul di daftar koreksi.
// Aman dipanggil berulang: setelah tertulis sekali, tidak ada lagi yang berubah
// sehingga snapshot berikutnya tidak memicu tulis ulang.
function lengkapiGender() {
  if (!db || !uid || !cabangId || !tersambung) return;
  let ubah = 0;
  customers.forEach((c) => {
    if (c.gender) return;
    const g = tebakGender(c.name);
    if (g === '?') return;
    c.gender = g;
    ubah++;
  });
  if (ubah) save(KEY_CUSTOMERS, customers);
}
const genderById = (id) => genderCust(customers.find((c) => c.id === id));
const LABEL_G = { P: 'Perempuan', L: 'Laki-laki', '?': 'Belum diketahui' };
const IKON_G = { P: 'perempuan', L: 'lakilaki', '?': 'tanya' };
const URUT_G = ['P', 'L', '?'];

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
  // Nama berubah → sapaannya dibaca ulang, pilihan gender lama tidak berlaku lagi
  genderDipilih = false;
  const q = nameInput.value.trim();
  if (!q) { closeSug(); updateBadge(); perbaruiGender(); return; }

  // Deteksi otomatis: nama persis sama dengan customer lama
  const exact = findCustomerByName(q);
  if (exact) selectCustomer(exact, false);
  else { updateBadge(); perbaruiGender(); }

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
  if (fill) { nameInput.value = c.name; closeSug(); genderDipilih = false; }
  updateBadge();
  perbaruiGender();
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

// ============================================================
// Gender di form — terisi sendiri begitu namanya diketik, jadi operator
// cuma perlu menyentuhnya kalau sapaannya tidak dikenali atau salah.
// ============================================================
const genderSeg = $('formGender'), genderHint = $('genderHint');
let genderForm = null;     // 'P' | 'L' | null kalau belum ketahuan
let genderDipilih = false; // true kalau tombolnya ditekan sendiri, bukan hasil tebakan

function perbaruiGender() {
  const nama = nameInput.value.trim();
  // Selama operator belum menekan tombolnya, isian ikut nama yang diketik
  if (!genderDipilih) {
    const g = selectedCustomer ? genderCust(selectedCustomer) : tebakGender(nama);
    genderForm = g === '?' ? null : g;
  }
  [...genderSeg.children].forEach((b) => {
    const aktif = b.dataset.g === genderForm;
    b.classList.toggle('aktif', aktif);
    b.setAttribute('aria-pressed', aktif ? 'true' : 'false');
  });

  genderHint.className = 'gender-hint';
  if (!nama) { genderHint.textContent = ''; return; }
  if (genderDipilih) genderHint.textContent = 'Dipilih manual.';
  else if (selectedCustomer && selectedCustomer.gender) genderHint.textContent = 'Diambil dari data customer.';
  else if (genderForm) genderHint.textContent = 'Terdeteksi dari sapaan di depan nama.';
  else {
    genderHint.className = 'gender-hint perlu';
    genderHint.textContent = 'Sapaan di depan nama tidak dikenali — pilih gendernya dulu.';
  }
}

genderSeg.addEventListener('click', (e) => {
  const b = e.target.closest('.gen-seg-btn');
  if (!b) return;
  genderForm = b.dataset.g;
  genderDipilih = true;
  perbaruiGender();
});

// Ganti tanggal di form → hitungan kunjungan ikut pindah ke bulan tanggal itu
$('date').addEventListener('change', () => {
  if (!selectedCustomer) return;
  updateBadge();
  showHistory(selectedCustomer.id);
});

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
  if (!bolehUbah()) return;
  const cleanName = nameInput.value.trim().replace(/\s+/g, ' ');
  const date = $('date').value, time = $('time').value;
  if (!cleanName || !date || !time) { toast('Nama, tanggal, dan jam wajib diisi.', true); return; }
  // Hampir selalu sudah terisi sendiri dari sapaannya; yang sampai ke sini
  // cuma nama yang sapaannya tidak dikenali sama sekali.
  if (!genderForm) {
    toast('Pilih gender customer dulu — sapaan di depan namanya tidak dikenali.', true);
    genderSeg.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  // Auto-deteksi: pakai customer lama jika nama sudah ada (abaikan besar/kecil huruf)
  let customer = findCustomerByName(cleanName);
  const isNew = !customer;
  if (isNew) {
    customer = { id: buatId(), name: cleanName, gender: genderForm };
    if (genderDipilih) customer.genderManual = true;
    customers.push(customer);
    save(KEY_CUSTOMERS, customers);
  } else if (customer.gender !== genderForm || (genderDipilih && !customer.genderManual)) {
    // Customer lama yang gendernya diubah di form: sekalian jadi jalan koreksi
    // tercepat, tanpa harus mampir ke tab Analitik.
    customer.gender = genderForm;
    if (genderDipilih) customer.genderManual = true;
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
  genderDipilih = false;
  updateBadge();
  perbaruiGender();
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
  if (!bolehUbah()) return;
  if (!confirm('Hapus ' + selected.size + ' jadwal yang dipilih?')) return;
  appointments.forEach((a) => { if (selected.has(a.id)) hapusFotoJadwal(a); });
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
  $('editName').value = c ? c.name : '';
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
  if (!$('cabangSheet').hidden) closeCabangSheet();
});

$('editSave').addEventListener('click', () => {
  const a = appointments.find((x) => x.id === editingId);
  if (!a) { closeEdit(); return; }
  if (!bolehUbah()) return;
  const date = $('editDate').value, time = $('editTime').value;
  const cleanName = $('editName').value.trim().replace(/\s+/g, ' ');
  if (!cleanName || !date || !time) { toast('Nama, tanggal, dan jam wajib diisi.', true); return; }

  const c = customers.find((x) => x.id === a.customerId);

  // Nama dipakai customer lain? Berarti bukan perbaikan typo, tapi tabrakan nama.
  const bentrok = customers.find((x) =>
    x.id !== a.customerId && x.name.toLowerCase() === cleanName.toLowerCase());
  if (bentrok) {
    toast('Nama "' + bentrok.name + '" sudah dipakai customer lain.', true);
    return;
  }

  const dup = appointments.find((x) =>
    x.id !== a.id && x.customerId === a.customerId && x.date === date && x.time === time);
  if (dup) {
    toast(cleanName + ' sudah punya jadwal di tanggal dan jam yang sama.', true);
    return;
  }

  // Ganti nama berlaku untuk semua jadwal customer ini, karena yang disimpan cuma id-nya.
  const namaBerubah = c && c.name !== cleanName;
  if (namaBerubah) {
    c.name = cleanName;
    // Sapaannya ikut berubah? Gender dibaca ulang — kecuali sudah pernah
    // dipilih manual, karena pilihan itu lebih tahu daripada tebakan.
    if (!c.genderManual) {
      const g = tebakGender(cleanName);
      if (g === '?') delete c.gender; else c.gender = g;
    }
    save(KEY_CUSTOMERS, customers);
  }

  a.date = date;
  a.time = time;
  save(KEY_APPOINTMENTS, appointments);
  closeEdit();
  renderList();
  toast(namaBerubah ? 'Nama dan jadwal berhasil diubah.' : 'Jadwal berhasil diubah.');
});

// ============================================================
// Sisa fitur "tandai selesai"
// ------------------------------------------------------------
// Fitur centang selesai (pegawai + foto hasil treatment) sedang dimatikan
// karena belum diperlukan. Datanya sengaja tidak diapa-apakan: field
// done/staff/photos di appointment, daftar pegawai, dan dokumen foto di
// koleksi photos semuanya tetap di Firestore, jadi fiturnya tinggal
// dipasang lagi tanpa ada yang hilang.
//
// Yang tersisa di sini cuma pembersihnya — foto ikut terhapus kalau jadwal
// induknya dihapus, supaya tidak ada dokumen foto yatim yang tak terjangkau
// dari mana pun.
// ============================================================
const fotoRef = (id) => doc(db, 'users', uid, 'cabang', cabangId, 'photos', id);
const hapusFotoJadwal = (a) =>
  (a.photos || []).forEach((p) => deleteDoc(fotoRef(p.id)).catch(() => {}));

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
      const bg = document.createElement('div');
      bg.className = 'appt-bg';
      bg.textContent = 'Hapus';
      el.appendChild(bg);
      main.innerHTML =
        '<div class="when"><div class="t"></div></div>' +
        '<div class="who"><div class="n"></div><div class="v"></div></div>' +
        '<button class="edit" title="Ubah jadwal">Ubah</button>' +
        '<button class="del" title="Hapus jadwal">Hapus</button>';
      el.appendChild(main);
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
  if (!bolehUbah()) return;
  if (!confirm('Hapus jadwal ' + nameOf(r.customerId) + ' pada ' + hariBulan(r.date) + ' ' + r.time + '?')) return;
  hapusFotoJadwal(r);
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
    lines.push(n + '. ' + r.time + ' — ' + nameOf(r.customerId));
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
  if (!bolehUbah()) return;

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
    // Gender ikut terbawa: koreksi manual dari file menang atas tebakan yang
    // belum dikoreksi, tapi koreksi manual yang sudah ada di sini tidak pernah
    // ditimpa. Tebakan lawan tebakan sama saja hasilnya, jadi tidak diapa-apakan.
    if ((c.gender === 'P' || c.gender === 'L') && !existing.genderManual
        && (!existing.gender || c.genderManual)) {
      existing.gender = c.gender;
      if (c.genderManual) existing.genderManual = true;
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
  setSambung(false); // dianggap belum tersambung sampai server yang bilang lain
  stopCabangList = onSnapshot(
    doc(db, 'users', uid, 'data', 'branches'),
    // includeMetadataChanges: tanpa ini listener diam saja waktu sambungan
    // putus, dan status di layar ikut basi.
    { includeMetadataChanges: true },
    (snap) => {
      // Satu sambungan dipakai bersama seluruh listener, jadi metadata dari
      // dokumen yang selalu aktif ini sudah mewakili status aplikasi.
      setSambung(!snap.metadata.fromCache);
      if (!snap.exists() || !(snap.data().rows || []).length) {
        // Kosong menurut cache belum tentu benar-benar kosong. Kalau ini
        // diteruskan, perangkat yang dibuka tanpa sinyal akan membuat ulang
        // cabang default dan menimpa daftar cabang asli begitu tersambung.
        if (snap.metadata.fromCache) return;
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
    (e) => {
      setSambung(false);
      toast('Gagal memuat daftar cabang: ' + e.message, true);
    }
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
    (e) => {
      setSambung(false);
      toast('Gagal memuat data: ' + e.message, true);
    }
  );
  stopData = [
    pasang(KEY_CUSTOMERS, (rows) => { customers = rows; lengkapiGender(); }),
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
      } catch { /* tidak terbaca: coba localStorage versi lama saja */ }
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
  if (!bolehUbah()) return;
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
      setSambung(false); // palang ikut disembunyikan karena uid sudah kosong
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
  // Dua angka per gender: berapa kali treatment, dan berapa orangnya —
  // satu customer yang datang lima kali tidak boleh terbaca lima orang.
  const treatmentG = { P: 0, L: 0, '?': 0 };
  const custG = { P: new Set(), L: new Set(), '?': new Set() };
  rows.forEach((a) => {
    const g = genderById(a.customerId);
    treatmentG[g]++;
    custG[g].add(a.customerId);
  });
  return {
    rows,
    total: rows.length,
    jumlahCustomer: new Set(rows.map((a) => a.customerId)).size,
    treatmentG,
    custG,
  };
}

// --- Deretan angka utama ---
function renderKpi(kini, lalu) {
  const box = $('kpiRow');
  box.innerHTML = '';
  [
    ['Total treatment', kini.total, lalu.total],
    ['Jumlah customer', kini.jumlahCustomer, lalu.jumlahCustomer],
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

// --- Komposisi gender (batang mendatar, dua kategori + sisa) ---
// Identitas dibawa label baris, bukan warnanya, jadi tetap terbaca kalau
// warnanya tidak bisa dibedakan.
function renderGender(kini, lalu) {
  const box = $('chartGender');
  box.innerHTML = '';
  if (!kini.rows.length) {
    box.innerHTML = '<div class="empty">Belum ada jadwal di bulan ini.</div>';
    renderKoreksi(kini);
    return;
  }
  URUT_G.forEach((g) => {
    const n = kini.treatmentG[g];
    // Perempuan & laki-laki selalu tampil biar barisnya tidak loncat-loncat;
    // baris "belum diketahui" cuma muncul kalau memang masih ada sisanya.
    if (g === '?' && !n) return;
    const orang = kini.custG[g].size;
    const persen = Math.round(n / kini.total * 100);

    const baris = document.createElement('div');
    baris.className = 'gen-row';
    baris.tabIndex = 0;

    const label = document.createElement('div');
    label.className = 'gen-label';
    // Ikon + tulisan: warnanya cuma penguat, identitasnya tetap terbaca tanpa itu
    label.dataset.g = g;
    label.innerHTML = ikon(IKON_G[g]);
    const teksLabel = document.createElement('span');
    teksLabel.textContent = LABEL_G[g];
    label.appendChild(teksLabel);

    const nilai = document.createElement('div');
    nilai.className = 'gen-val';
    nilai.textContent = String(n);
    const pct = document.createElement('span');
    pct.className = 'gen-persen';
    pct.textContent = persen + '%';
    nilai.appendChild(pct);

    // Selisih terhadap bulan lalu — arahnya dibaca dari panah + angka, bukan
    // dari warnanya saja, sama seperti dua angka utama di atas.
    const beda = n - lalu.treatmentG[g];
    const delta = document.createElement('div');
    delta.className = 'gen-delta ' + (beda > 0 ? 'naik' : beda < 0 ? 'turun' : 'datar');
    delta.textContent = beda === 0 ? '±0' : (beda > 0 ? '▲ +' : '▼ −') + Math.abs(beda);

    // Label dan angkanya duduk di atas batang, bukan di sampingnya: batangnya
    // jadi dapat lebar penuh, dan label sepanjang "Belum diketahui" tidak
    // terpotong betapapun sempitnya layar.
    const atas = document.createElement('div');
    atas.className = 'gen-atas';
    atas.append(label, nilai, delta);

    const track = document.createElement('div');
    track.className = 'gen-track';
    const bar = document.createElement('div');
    bar.className = 'gen-bar';
    bar.dataset.g = g;
    // Dibagi total bulan itu, bukan kategori terbesar: panjang batang berarti
    // porsi, jadi ia bicara hal yang sama dengan persen di sebelahnya. Kalau
    // dibagi yang terbesar, kategori teratas selalu tampil penuh — terbaca
    // "semuanya" padahal cuma 59%.
    bar.style.width = (n ? Math.max(2, n / kini.total * 100) : 0) + '%';
    track.appendChild(bar);

    const kataBeda = beda === 0 ? 'sama seperti bulan lalu'
      : (beda > 0 ? 'bertambah ' : 'berkurang ') + Math.abs(beda) + ' dari bulan lalu';
    baris.append(atas, track);
    baris.setAttribute('aria-label', LABEL_G[g] + ': ' + n + ' treatment (' + persen
      + '%) dari ' + orang + ' customer, ' + kataBeda + '.');
    pasangTip(baris, ikon(IKON_G[g]) + '<b>' + n + ' treatment</b> · ' + persen
      + '%<br>dari ' + orang + ' customer<br>' + kataBeda);
    box.appendChild(baris);
  });
  renderKoreksi(kini);
}

// --- Koreksi gender: satu-satunya tempat gender bisa diatur manual ---
// Daftarnya dibatasi customer yang punya jadwal di bulan yang sedang dilihat,
// supaya yang muncul cuma yang memang memengaruhi angka di atas.
let koreksiBuka = false;
function renderKoreksi(kini) {
  const box = $('genKoreksi');
  box.innerHTML = '';
  const ids = [...new Set(kini.rows.map((a) => a.customerId))];
  if (!ids.length) return;
  const belum = ids.filter((id) => genderById(id) === '?').length;

  const tombol = document.createElement('button');
  tombol.type = 'button';
  tombol.className = 'data-btn wide' + (belum ? ' perlu' : '');
  tombol.setAttribute('aria-expanded', koreksiBuka ? 'true' : 'false');
  tombol.textContent = koreksiBuka
    ? 'Tutup koreksi gender'
    : belum
      ? 'Koreksi gender — ' + belum + ' customer belum ketahuan'
      : 'Koreksi gender customer';
  tombol.addEventListener('click', () => { koreksiBuka = !koreksiBuka; renderAnalitik(); });
  box.appendChild(tombol);
  if (!koreksiBuka) return;

  const ket = document.createElement('p');
  ket.className = 'card-sub gen-ket';
  ket.textContent = 'Gender ditebak dari sapaan di depan nama. Kalau tebakannya meleset '
    + 'atau sapaannya tidak dikenali, pilih sendiri di sini — pilihan manual dipakai seterusnya.';
  box.appendChild(ket);

  const daftar = document.createElement('div');
  daftar.className = 'gen-fix';
  // Yang belum ketahuan naik ke atas — itu yang perlu dikerjakan duluan
  ids.map((id) => customers.find((c) => c.id === id)).filter(Boolean)
    .sort((a, b) => {
      const ga = genderCust(a) === '?' ? 0 : 1, gb = genderCust(b) === '?' ? 0 : 1;
      return ga - gb || a.name.localeCompare(b.name, 'id');
    })
    .forEach((c) => {
      const g = genderCust(c);
      const baris = document.createElement('div');
      baris.className = 'gen-fix-row' + (g === '?' ? ' belum' : '');
      const nama = document.createElement('span');
      nama.className = 'gen-fix-nama';
      // Tanda tanya cuma di baris yang belum ketahuan — itu yang perlu dikerjakan
      if (g === '?') nama.innerHTML = ikon('tanya');
      const teksNama = document.createElement('span');
      teksNama.textContent = c.name;
      nama.appendChild(teksNama);
      const grup = document.createElement('div');
      grup.className = 'gen-seg';
      grup.setAttribute('role', 'group');
      grup.setAttribute('aria-label', 'Gender ' + c.name);
      // Cuma ikonnya — nama customer di sebelahnya sering panjang, dan urutan
      // ♀ lalu ♂ sudah dijelaskan grafik tepat di atasnya. Namanya tetap
      // terbaca pembaca layar lewat aria-label.
      ['P', 'L'].forEach((pilih) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'gen-seg-btn ikon-saja' + (g === pilih ? ' aktif' : '');
        b.dataset.g = pilih;
        b.innerHTML = ikon(IKON_G[pilih]);
        b.title = LABEL_G[pilih];
        b.setAttribute('aria-label', LABEL_G[pilih]);
        b.setAttribute('aria-pressed', g === pilih ? 'true' : 'false');
        b.addEventListener('click', () => setGender(c.id, pilih));
        grup.appendChild(b);
      });
      baris.append(nama, grup);
      daftar.appendChild(baris);
    });
  box.appendChild(daftar);
}

function setGender(customerId, g) {
  const c = customers.find((x) => x.id === customerId);
  if (!c || (c.gender === g && c.genderManual)) return;
  if (!bolehUbah()) return;
  c.gender = g;
  c.genderManual = true;
  save(KEY_CUSTOMERS, customers);
  renderAnalitik();
  toast(c.name + ' diatur sebagai ' + LABEL_G[g].toLowerCase() + '.');
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
function renderTabel(kini, lalu) {
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

  const bedaTeks = (n) => (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n);
  tambah('Per gender', ['Gender', 'Treatment', 'Customer', 'vs bulan lalu'],
    URUT_G.filter((g) => g !== '?' || kini.treatmentG[g])
      .map((g) => [LABEL_G[g], kini.treatmentG[g], kini.custG[g].size,
        bedaTeks(kini.treatmentG[g] - lalu.treatmentG[g])]),
    'Belum ada jadwal di bulan ini.');

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
  renderGender(kini, lalu);
  renderHeat(kini);
  renderJam(kini);
  if (!$('tabelWrap').hidden) renderTabel(kini, lalu);
}

// ============================================================
// Salin analitik sebagai gambar
// ------------------------------------------------------------
// Kartunya digambar ulang di canvas, bukan dijepret dari DOM. html2canvas
// perlu pustaka luar (aplikasi ini sengaja tanpa build dan harus jalan offline),
// sedangkan trik SVG foreignObject rapuh — font dan CSS-nya sering tidak ikut.
// Angkanya toh sudah ada di tangan, jadi menggambar sendiri malah lebih ringan
// sekaligus membebaskan tata letaknya ditata khusus untuk dikirim: potret,
// teksnya lebih besar, tanpa tombol dan tanpa panel koreksi gender.
// ============================================================
const VIZ_W = 720;    // lebar gambar dalam satuannya sendiri
const VIZ_PAD = 40;
const VIZ_SKALA = 2;  // digambar 2x supaya tetap tajam saat di-zoom di HP
const VIZ_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

// Warnanya diambil dari CSS biar gambarnya ikut berubah kalau paletnya diganti
function warnaViz() {
  const s = getComputedStyle(document.documentElement);
  const w = (n) => s.getPropertyValue(n).trim();
  return {
    bg: w('--bg'), card: w('--card'), border: w('--border'), field: w('--field'),
    text: w('--text'), text2: w('--text-2'), muted: w('--muted'),
    accent: w('--accent'), naik: w('--naik'), turun: w('--turun'),
    h: [w('--h0'), w('--h1'), w('--h2'), w('--h3'), w('--h4')],
    gen: { P: w('--gen-p'), L: w('--gen-l'), '?': w('--gen-x') },
  };
}

function vizFont(ctx, ukuran, tebal) {
  ctx.font = (tebal || 400) + ' ' + ukuran + 'px ' + VIZ_FONT;
}
function vizTeks(ctx, s, x, y, o) {
  vizFont(ctx, o.ukuran || 14, o.tebal);
  ctx.fillStyle = o.warna;
  ctx.textAlign = o.rata || 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(s, x, y);
}
function vizLebar(ctx, s, ukuran, tebal) {
  vizFont(ctx, ukuran, tebal);
  return ctx.measureText(s).width;
}
function vizKotak(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
}
function vizPanel(ctx, C, x, y, w, h) {
  ctx.fillStyle = C.card;
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 1;
  vizKotak(ctx, x, y, w, h, 18);
  ctx.fill();
  ctx.stroke();
}
const vizDelta = (n) => n === 0 ? '±0' : (n > 0 ? '▲ +' : '▼ −') + Math.abs(n);
const vizWarnaDelta = (C, n) => n > 0 ? C.naik : n < 0 ? C.turun : C.muted;

// Digambar dua kali: sekali di canvas buangan untuk tahu tinggi totalnya,
// sekali lagi di canvas sungguhan yang sudah pas ukurannya.
function lukisAnalitik(ctx, kini, lalu, tinggiTotal) {
  const C = warnaViz();
  const L = VIZ_PAD, W = VIZ_W - VIZ_PAD * 2;
  if (tinggiTotal) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, VIZ_W, tinggiTotal);
  }

  // --- Kepala ---
  const cabang = cabangList.find((c) => c.id === cabangId);
  ctx.letterSpacing = '2.5px'; // diabaikan browser lama — cuma soal rapi
  vizTeks(ctx, 'RINGKASAN BULANAN', L, 56, { ukuran: 12.5, tebal: 700, warna: C.accent });
  ctx.letterSpacing = '0px';
  vizTeks(ctx, new Date(bln.y, bln.m, 1).toLocaleDateString('id-ID', { month: 'long', year: 'numeric' }),
    L, 100, { ukuran: 33, tebal: 700, warna: C.text });
  vizTeks(ctx, cabang ? cabang.name : 'Jadwal Treatment',
    L, 126, { ukuran: 14, warna: C.text2 });
  let y = 154;

  // --- Dua angka utama ---
  const kpiH = 112, sela = 16, kpiW = (W - sela) / 2;
  [
    ['Total treatment', kini.total, lalu.total],
    ['Jumlah customer', kini.jumlahCustomer, lalu.jumlahCustomer],
  ].forEach(([label, nilai, sebelum], i) => {
    const x = L + i * (kpiW + sela);
    vizPanel(ctx, C, x, y, kpiW, kpiH);
    vizTeks(ctx, label, x + 20, y + 33, { ukuran: 13, tebal: 600, warna: C.muted });
    vizTeks(ctx, String(nilai), x + 20, y + 78, { ukuran: 38, tebal: 700, warna: C.text });
    const beda = nilai - sebelum;
    vizTeks(ctx, beda === 0 ? 'sama seperti bulan lalu' : vizDelta(beda) + ' vs bulan lalu',
      x + 20, y + 99, { ukuran: 12, tebal: 600, warna: vizWarnaDelta(C, beda) });
  });
  y += kpiH + 18;

  // --- Komposisi gender ---
  const barisG = URUT_G.filter((g) => g !== '?' || kini.treatmentG[g]);
  const tinggiG = 62 + (kini.total ? barisG.length * 56 : 40) + 14;
  vizPanel(ctx, C, L, y, W, tinggiG);
  vizTeks(ctx, 'Komposisi Gender', L + 22, y + 40, { ukuran: 17.5, tebal: 700, warna: C.text });
  let gy = y + 64;
  if (!kini.total) {
    vizTeks(ctx, 'Belum ada jadwal di bulan ini.', L + 22, gy + 18, { ukuran: 14, warna: C.muted });
  } else barisG.forEach((g) => {
    const n = kini.treatmentG[g];
    const persen = Math.round(n / kini.total * 100);
    const beda = n - lalu.treatmentG[g];
    vizTeks(ctx, LABEL_G[g], L + 22, gy + 14, { ukuran: 14.5, tebal: 600, warna: C.text });
    vizTeks(ctx, vizDelta(beda), L + 22 + vizLebar(ctx, LABEL_G[g], 14.5, 600) + 10, gy + 14,
      { ukuran: 12, tebal: 600, warna: vizWarnaDelta(C, beda) });
    // Jumlah dan persen dipisah kurung dan beda bobot — "41 · 57%" terbaca
    // seperti satu bilangan desimal. Persennya turunan, jadi ia yang mengalah.
    const teksPersen = '(' + persen + '%)';
    vizTeks(ctx, teksPersen, L + W - 22, gy + 14, { ukuran: 12, tebal: 600, warna: C.muted, rata: 'right' });
    vizTeks(ctx, String(n), L + W - 22 - vizLebar(ctx, teksPersen, 12, 600) - 7, gy + 14,
      { ukuran: 14.5, tebal: 700, warna: C.text, rata: 'right' });
    // Panjang batang = porsi dari total bulan itu, sama seperti di layar
    const jalur = W - 44;
    ctx.fillStyle = C.field;
    vizKotak(ctx, L + 22, gy + 27, jalur, 11, 6);
    ctx.fill();
    if (n) {
      ctx.fillStyle = C.gen[g];
      vizKotak(ctx, L + 22, gy + 27, Math.max(8, jalur * n / kini.total), 11, 6);
      ctx.fill();
    }
    gy += 56;
  });
  y += tinggiG + 18;

  // --- Kepadatan harian (kalender sebulan) ---
  const perHari = new Map();
  kini.rows.forEach((a) => perHari.set(a.date, (perHari.get(a.date) || 0) + 1));
  const maksHari = perHari.size ? Math.max(...perHari.values()) : 0;
  const jmlHari = new Date(bln.y, bln.m + 1, 0).getDate();
  const geser = (new Date(bln.y, bln.m, 1).getDay() + 6) % 7; // 0 = Senin
  const minggu = Math.ceil((geser + jmlHari) / 7);
  const selSela = 7, selH = 44;
  const selW = (W - 44 - selSela * 6) / 7;
  const tinggiK = 98 + minggu * (selH + selSela) - selSela + 40;
  vizPanel(ctx, C, L, y, W, tinggiK);
  vizTeks(ctx, 'Kepadatan Harian', L + 22, y + 40, { ukuran: 17.5, tebal: 700, warna: C.text });
  vizTeks(ctx, 'Makin pekat warnanya, makin banyak treatment hari itu.',
    L + 22, y + 62, { ukuran: 12.5, warna: C.muted });
  ['Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab', 'Min'].forEach((h, i) => {
    vizTeks(ctx, h, L + 22 + i * (selW + selSela) + selW / 2, y + 86,
      { ukuran: 11.5, tebal: 600, warna: C.muted, rata: 'center' });
  });
  for (let t = 1; t <= jmlHari; t++) {
    const kotak = geser + t - 1;
    const x = L + 22 + (kotak % 7) * (selW + selSela);
    const ky = y + 98 + Math.floor(kotak / 7) * (selH + selSela);
    const iso = kunciBulan(bln.y, bln.m) + '-' + String(t).padStart(2, '0');
    const tingkat = tingkatWarna(perHari.get(iso) || 0, maksHari);
    ctx.fillStyle = C.h[tingkat];
    vizKotak(ctx, x, ky, selW, selH, 10);
    ctx.fill();
    // Dua langkah tergelap pakai tinta putih supaya angkanya tetap terbaca
    vizTeks(ctx, String(t), x + selW / 2, ky + selH / 2 + 5,
      { ukuran: 13, tebal: 600, warna: tingkat >= 3 ? '#ffffff' : C.text2, rata: 'center' });
  }
  const ly = y + tinggiK - 18;
  vizTeks(ctx, 'Sepi', L + 22, ly + 4, { ukuran: 11.5, warna: C.muted });
  let lx = L + 22 + vizLebar(ctx, 'Sepi', 11.5) + 8;
  for (let l = 0; l <= 4; l++) {
    ctx.fillStyle = C.h[l];
    vizKotak(ctx, lx, ly - 8, 20, 12, 4);
    ctx.fill();
    lx += 24;
  }
  vizTeks(ctx, 'Ramai', lx + 2, ly + 4, { ukuran: 11.5, warna: C.muted });
  if (maksHari) {
    vizTeks(ctx, 'Terpadat ' + maksHari + ' treatment/hari', L + W - 22, ly + 4,
      { ukuran: 11.5, warna: C.muted, rata: 'right' });
  }
  y += tinggiK + 18;

  // --- Jam tersibuk ---
  const perJam = new Map();
  kini.rows.forEach((a) => {
    const j = a.time.slice(0, 2);
    perJam.set(j, (perJam.get(j) || 0) + 1);
  });
  const plotH = 132;
  const tinggiJ = kini.total ? 84 + plotH + 42 : 84 + 34;
  vizPanel(ctx, C, L, y, W, tinggiJ);
  vizTeks(ctx, 'Jam Tersibuk', L + 22, y + 40, { ukuran: 17.5, tebal: 700, warna: C.text });
  vizTeks(ctx, 'Jumlah treatment per jam mulai, sepanjang bulan ini.',
    L + 22, y + 62, { ukuran: 12.5, warna: C.muted });
  if (!kini.total) {
    vizTeks(ctx, 'Belum ada jadwal di bulan ini.', L + 22, y + 90, { ukuran: 14, warna: C.muted });
  } else {
    const jam = [...perJam.keys()].map(Number).sort((a, b) => a - b);
    const dari = jam[0], sampai = jam[jam.length - 1];
    const maksJam = Math.max(...perJam.values());
    const jmlKolom = sampai - dari + 1;
    const kolomW = (W - 44) / jmlKolom;
    const barW = Math.min(kolomW - 8, 34);
    const dasar = y + 84 + plotH;
    ctx.strokeStyle = C.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(L + 22, dasar + .5);
    ctx.lineTo(L + W - 22, dasar + .5);
    ctx.stroke();
    for (let j = dari; j <= sampai; j++) {
      const kunciJ = String(j).padStart(2, '0');
      const n = perJam.get(kunciJ) || 0;
      const tengah = L + 22 + (j - dari) * kolomW + kolomW / 2;
      if (n) {
        const h = Math.max(4, Math.round(n / maksJam * (plotH - 22)));
        ctx.fillStyle = C.accent;
        vizKotak(ctx, tengah - barW / 2, dasar - h, barW, h, 6);
        ctx.fill();
        // Angkanya dilabeli langsung hanya di jam terpadat, sama seperti di layar
        if (n === maksJam) {
          vizTeks(ctx, String(n), tengah, dasar - h - 8,
            { ukuran: 12.5, tebal: 700, warna: C.text, rata: 'center' });
        }
      }
      // Kalau kolomnya banyak, labelnya selang-seling biar tidak berdempetan
      if (!(jmlKolom > 10 && (j - dari) % 2)) {
        vizTeks(ctx, kunciJ, tengah, dasar + 20, { ukuran: 11.5, warna: C.muted, rata: 'center' });
      }
    }
  }
  y += tinggiJ + 16;

  vizTeks(ctx, 'Dibuat ' + hariBulan(today()), VIZ_W / 2, y + 20,
    { ukuran: 11.5, warna: C.muted, rata: 'center' });
  return y + 42;
}

function buatBlobAnalitik() {
  const kunci = kunciBulan(bln.y, bln.m);
  const kini = ringkasBulan(kunci);
  const bulanLalu = new Date(bln.y, bln.m - 1, 1);
  const lalu = ringkasBulan(kunciBulan(bulanLalu.getFullYear(), bulanLalu.getMonth()));

  const tinggi = Math.round(lukisAnalitik(
    document.createElement('canvas').getContext('2d'), kini, lalu));
  const c = document.createElement('canvas');
  c.width = VIZ_W * VIZ_SKALA;
  c.height = tinggi * VIZ_SKALA;
  const ctx = c.getContext('2d');
  ctx.scale(VIZ_SKALA, VIZ_SKALA);
  lukisAnalitik(ctx, kini, lalu, tinggi);
  return new Promise((resolve, reject) => {
    c.toBlob((b) => b ? resolve(b) : reject(new Error('canvas gagal jadi gambar')), 'image/png');
  });
}

$('salinViz').addEventListener('click', () => {
  const btn = $('salinViz');
  if (btn.disabled) return;
  btn.disabled = true;
  const namaFile = 'analitik-' + kunciBulan(bln.y, bln.m) + '.png';
  // Blob-nya sengaja tidak di-await dulu: Safari mencabut "izin dari ketukan
  // user" begitu ada await sebelum clipboard.write, jadi janjinya yang
  // diserahkan ke ClipboardItem, bukan hasilnya.
  const janjiBlob = buatBlobAnalitik();
  janjiBlob.catch(() => {}); // ditangani di bawah — ini cuma peredam unhandled rejection

  const cadangan = async () => {
    const blob = await janjiBlob;
    const file = new File([blob], namaFile, { type: 'image/png' });
    // Di HP, share sheet biasanya lebih berguna daripada clipboard
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file] }); } catch { /* dibatalkan user */ }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = namaFile;
    a.click();
    URL.revokeObjectURL(url);
    toast('Browser ini tidak bisa menyalin gambar — filenya diunduh.');
  };

  (async () => {
    try {
      if (!navigator.clipboard || !window.ClipboardItem) throw new Error('tanpa clipboard gambar');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': janjiBlob })]);
      toast('Gambar analitik tersalin — tinggal paste.');
    } catch {
      try { await cadangan(); }
      catch (e) { toast('Gagal membuat gambar: ' + e.message, true); }
    } finally {
      btn.disabled = false;
    }
  })();
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
