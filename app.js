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
  initializeFirestore, memoryLocalCache, doc, getDoc, getDocFromServer,
  setDoc, deleteDoc, onSnapshot, runTransaction,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const KEY_CUSTOMERS = 'customers';       // [{id, name, gender?, genderManual?, sudahLama?}]
const KEY_APPOINTMENTS = 'appointments'; // [{id, customerId, date, time, treatments?}]
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

// Tersambung belum berarti siap menulis. Status di atas dibaca dari snapshot
// daftar cabang, yang datang lebih dulu daripada isi cabangnya — jadi ada jeda
// saat aplikasi merasa sudah tersambung padahal customers/appointments/staff
// masih array kosong bawaan. Menyimpan di jeda itu mengirim array yang cuma
// berisi baris baru dan menimpa seluruh isi dokumen di server: itu yang
// menghabiskan data Puri dan Kemayoran pada 22 Agustus 2026.
//
// Penandanya per dokumen, dan baru true setelah snapshot pertamanya benar-benar
// sampai. "Sampai tapi isinya kosong" tetap dihitung siap — di situlah bedanya
// kosong karena memang dikosongkan operator dengan kosong karena belum dimuat.
const KEYS_DATA = [KEY_CUSTOMERS, KEY_APPOINTMENTS, KEY_STAFF];
let dataSiap = {};
const resetDataSiap = () => { dataSiap = {}; };
const semuaDataSiap = () => !!cabangId && KEYS_DATA.every((k) => dataSiap[k]);

// Daftar cabang punya jendela yang sama: `cabangList` masih [] sampai snapshot
// pertamanya datang dari server, dan dokumennya juga ditulis utuh sekali kirim.
let cabangSiap = false;

// Palangnya ditahan dulu sebentar sebelum muncul. Snapshot pertama dari
// Firestore hampir selalu fromCache — jawaban server baru menyusul sepersekian
// detik kemudian — jadi tanpa jeda ini palang merah berkedip tiap kali aplikasi
// dibuka dan tiap kali sinyal tersendat sekejap, padahal tidak ada yang salah.
//
// Yang ditahan cuma tampilannya. Nilai `tersambung` tetap berubah saat itu juga,
// jadi bolehUbah() dan save() tidak ikut melunak: selama jeda ini pun perubahan
// data tetap ditolak kalau memang belum tersambung.
const JEDA_PALANG = 3000;
let timerPalang = null;

function setSambung(on) {
  tersambung = on;
  const palang = $('offlineBar');
  if (on || !uid) {
    clearTimeout(timerPalang);
    timerPalang = null;
    palang.hidden = true;
    return;
  }
  // Hitungan mundurnya dimulai di sinyal putus yang pertama dan tidak diulang
  // oleh sinyal putus berikutnya. Kalau diulang, perangkat yang benar-benar
  // offline justru tidak pernah dapat palangnya — tiap snapshot cache yang
  // masuk akan menunda kemunculannya lagi dari nol.
  if (!palang.hidden || timerPalang) return;
  timerPalang = setTimeout(() => {
    timerPalang = null;
    palang.hidden = false;
  }, JEDA_PALANG);
}

// Gerbang untuk semua perubahan data. Menulis tanpa sambungan berarti mengirim
// seluruh array versi layar ini, yang bisa saja sudah tertinggal — jadi
// perubahannya ditolak di depan, sebelum apa pun ikut berubah di memori.
function bolehUbah() {
  if (!tersambung) {
    toast('Belum tersambung ke server — perubahan tidak bisa disimpan dulu.', true);
    return false;
  }
  // Sebabnya beda dengan di atas — sambungannya ada, isinya yang belum lengkap
  // di layar ini — jadi yang dibaca operator juga dibedakan.
  if (!semuaDataSiap()) {
    toast('Data cabang ini masih dimuat — tunggu sebentar sebelum menyimpan.', true);
    return false;
  }
  return true;
}

// Gerbang untuk dokumen daftar cabang. Yang ditimpa di sana bukan data cabang
// yang sedang dibuka, jadi kesiapan yang diperiksa juga bukan yang itu.
function bolehUbahCabang() {
  if (!tersambung) {
    toast('Belum tersambung ke server — perubahan tidak bisa disimpan dulu.', true);
    return false;
  }
  if (!cabangSiap) {
    toast('Daftar cabang masih dimuat — tunggu sebentar sebelum menambah cabang.', true);
    return false;
  }
  return true;
}

function save(key, data) {
  // Jaring terakhir; pemanggilnya sudah lewat bolehUbah(). Kesiapan diperiksa
  // per key supaya penyimpanan yang dipicu snapshot itu sendiri — lengkapiGender()
  // — tetap jalan begitu dokumennya siap, tanpa menunggu dua dokumen lainnya.
  if (!tersambung || !cabangId || !dataSiap[key]) return;
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

// "Customer lama" tidak selalu terbaca dari jumlah kunjungan: ada yang sudah
// bertahun-tahun datang tapi baru hari ini masuk sistem. Penanda sudahLama
// dijawab operator sendiri di sheet konfirmasi saat namanya pertama disimpan.
const sudahLamaDatang = (customerId, totalVisits) => {
  const c = customers.find((x) => x.id === customerId);
  return (totalVisits != null ? totalVisits : visitCount(customerId)) > 1
    || !!(c && c.sudahLama);
};

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
const hariPendek = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('id-ID',
  { weekday: 'short', day: 'numeric', month: 'short' });
const isoGeser = (iso, n) => { // n hari dari sebuah tanggal, format YYYY-MM-DD
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
};
const nameOf = (id) => (customers.find((c) => c.id === id) || { name: '?' }).name;

// ============================================================
// Jenis treatment
// ------------------------------------------------------------
// Disimpan di appointment.treatments sebagai array kode. Boleh kosong: jadwal
// yang jenisnya belum ditanyakan tetap sah, dan seluruh jadwal lama memang
// tidak punya field ini sama sekali.
//
// Ketiganya berdiri sendiri-sendiri: boleh dicentang satu, dua, atau ketiganya,
// dan tidak ada yang mensyaratkan yang lain. Rambut cuma istimewa waktu ditulis
// (lihat tandaTreatment), bukan waktu dipilih.
// ============================================================
const TREATMENT = [
  { kode: 'rambut', label: 'Rambut' },
  { kode: 'exo', label: 'Exo' },
  { kode: 'muka', label: 'Muka' },
];
const URUT_T = TREATMENT.map((t) => t.kode);
const labelT = (kode) => (TREATMENT.find((t) => t.kode === kode) || { label: kode }).label;

// Urutannya selalu dikembalikan mengikuti URUT_T supaya kombinasi yang sama
// tidak pernah terhitung sebagai dua kombinasi berbeda di ringkasan.
function rapikanTreatment(list) {
  const set = new Set(Array.isArray(list) ? list : []);
  return URUT_T.filter((k) => set.has(k));
}

// Tanda yang menempel di belakang nama, di daftar maupun di salinan WA.
// Rambut adalah dasarnya, jadi tidak ikut ditulis — yang perlu terbaca cuma
// tambahannya ("+Exo"). Kalau justru rambutnya yang tidak ada, itu yang harus
// disebut utuh ("Exo Only", "Muka Only"), karena di situ bedanya.
//
// Tambahan lebih dari satu disambung "&", bukan dirangkai plus sendiri-sendiri:
// "+Exo +Muka" terbaca seperti dua tanda yang kebetulan berdempetan, sedangkan
// "+Exo & Muka" jelas satu tanda berisi dua hal.
function tandaTreatment(list) {
  const t = rapikanTreatment(list);
  if (!t.length) return '';
  if (!t.includes('rambut')) return t.map(labelT).join(' & ') + ' Only';
  const tambahan = t.filter((k) => k !== 'rambut');
  return tambahan.length ? '+' + tambahan.map(labelT).join(' & ') : '';
}

// Nama kombinasi versi panjang — dipakai di ringkasan, tempat "Rambut" justru
// perlu disebut supaya barisnya bisa dibaca berdiri sendiri.
const namaKombinasi = (t) => (t.length ? t.map(labelT).join(' + ') : 'Belum diisi');

// [{t: [...kode], n: jumlah}] — kombinasi terbanyak di atas, dan jadwal yang
// jenisnya belum diisi selalu di baris paling bawah.
function ringkasTreatment(rows) {
  const peta = new Map();
  rows.forEach((r) => {
    const t = rapikanTreatment(r.treatments);
    const kunci = t.join('+');
    const item = peta.get(kunci) || { t, n: 0 };
    item.n++;
    peta.set(kunci, item);
  });
  return [...peta.values()].sort((a, b) =>
    Number(!a.t.length) - Number(!b.t.length) || b.n - a.n
    || namaKombinasi(a.t).localeCompare(namaKombinasi(b.t), 'id'));
}

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
}

function updateBadge() {
  if (selectedCustomer) {
    const kunci = kunciForm(); // dihitung ulang tiap render, biar ikut tanggal yang dipilih
    badge.className = 'badge known';
    badge.textContent = '✓ Customer terdeteksi: ' + selectedCustomer.name +
      ' (' + visitCount(selectedCustomer.id, kunci) + 'x kunjungan ' + labelBulan(kunci) + ')';
  } else if (nameInput.value.trim().length >= 2) {
    badge.className = 'badge new';
    badge.textContent = 'Belum ada di sistem — dipastikan dulu waktu disimpan.';
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

// ============================================================
// Pilihan jenis treatment — dipakai di form tambah dan di sheet ubah.
// Satu pemasang untuk keduanya, jadi perilakunya cuma ditulis sekali dan
// tidak mungkin beda di dua tempat.
// ============================================================
function pasangTreatSeg(segId, hintId) {
  const seg = $(segId), hint = $(hintId);
  let pilih = new Set();

  function gambar() {
    [...seg.children].forEach((b) => {
      const aktif = pilih.has(b.dataset.t);
      b.classList.toggle('aktif', aktif);
      b.setAttribute('aria-pressed', aktif ? 'true' : 'false');
    });
    // Keterangannya menunjukkan hasil jadinya, bukan aturannya — operator
    // langsung tahu bentuk tulisan yang nanti masuk ke salinan WA.
    const tanda = tandaTreatment([...pilih]);
    hint.textContent = !pilih.size
      ? 'Boleh dikosongkan kalau jenisnya belum ditanyakan.'
      : tanda
        ? 'Ditulis: Nama (' + tanda + ')'
        : 'Rambut saja — tidak ditulis apa-apa di belakang nama.';
  }

  seg.addEventListener('click', (e) => {
    const b = e.target.closest('.treat-btn');
    if (!b) return;
    const kode = b.dataset.t;
    if (pilih.has(kode)) pilih.delete(kode); else pilih.add(kode);
    gambar();
  });

  return {
    get: () => rapikanTreatment([...pilih]),
    set: (list) => { pilih = new Set(rapikanTreatment(list)); gambar(); },
  };
}
const treatForm = pasangTreatSeg('formTreat', 'treatHint');
const treatEdit = pasangTreatSeg('editTreat', 'editTreatHint');
const TREAT_BAWAAN = ['rambut']; // yang paling sering, jadi sudah tercentang
treatForm.set(TREAT_BAWAAN);

// Ganti tanggal di form → hitungan kunjungan ikut pindah ke bulan tanggal itu
$('date').addEventListener('change', () => {
  if (!selectedCustomer) return;
  updateBadge();
});

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

  // Auto-deteksi: pakai customer lama jika nama sudah ada (abaikan besar/kecil huruf).
  // Kalau namanya belum ada, jadwalnya belum langsung disimpan — operator
  // dipastikan dulu lewat sheet konfirmasi.
  const customer = findCustomerByName(cleanName);
  if (customer) simpanJadwal(customer, cleanName, date, time, null);
  else bukaKonfirmasiBaru(cleanName, date, time);
});

// status: null (customer memang sudah terdaftar) | 'baru' | 'lama'
function simpanJadwal(customer, cleanName, date, time, status) {
  if (!bolehUbah()) return;
  const isNew = !customer;
  if (isNew) {
    customer = { id: buatId(), name: cleanName, gender: genderForm };
    if (genderDipilih) customer.genderManual = true;
    // Jawaban operator di sheet konfirmasi. Tanpa penanda ini orangnya akan
    // terbaca "customer baru" di daftar jadwal sampai kunjungan keduanya,
    // padahal sebenarnya sudah lama datang — cuma belum pernah dicatat.
    if (status === 'lama') customer.sudahLama = true;
    customers.push(customer);
    save(KEY_CUSTOMERS, customers);
  } else if (customer.name.toLowerCase() === cleanName.toLowerCase()
      && (customer.gender !== genderForm || (genderDipilih && !customer.genderManual))) {
    // Customer lama yang gendernya diubah di form: sekalian jadi jalan koreksi
    // tercepat, tanpa harus mampir ke tab Analitik. Cuma berlaku kalau nama di
    // form memang nama customer itu — pilihan gender di layar dibaca dari
    // sapaan nama yang diketik, jadi ia tidak berhak menimpa orang lain yang
    // dipilih dari daftar "nama mirip".
    customer.gender = genderForm;
    if (genderDipilih) customer.genderManual = true;
    save(KEY_CUSTOMERS, customers);
  }

  const dup = appointments.find((a) =>
    a.customerId === customer.id && a.date === date && a.time === time);
  if (dup) { toast(customer.name + ' sudah punya jadwal di tanggal dan jam yang sama.', true); return; }

  const newId = buatId();
  const appt = { id: newId, customerId: customer.id, date, time };
  // Field-nya cuma ditulis kalau memang ada isinya, jadi jadwal tanpa jenis
  // treatment tetap sebentuk dengan seluruh jadwal lama.
  const jenis = treatForm.get();
  if (jenis.length) appt.treatments = jenis;
  appointments.push(appt);
  save(KEY_APPOINTMENTS, appointments);

  let msg = !isNew
    ? 'Jadwal tersimpan untuk ' + customer.name + ' (customer lama).'
    : status === 'lama'
      ? 'Jadwal tersimpan. ' + customer.name + ' dicatat sebagai customer lama yang baru masuk sistem.'
      : 'Jadwal tersimpan. ' + customer.name + ' terdaftar sebagai customer baru.';
  if (!filteredRows().some((a) => a.id === newId)) {
    msg += ' Pilih "Semua" untuk melihatnya.';
  }
  toast(msg);
  nameInput.value = ''; $('time').value = '';
  selectedCustomer = null;
  genderDipilih = false;
  treatForm.set(TREAT_BAWAAN);
  closeSug();
  updateBadge();
  perbaruiGender();
  renderList();
  nameInput.focus();
}

// ============================================================
// Konfirmasi customer baru
// ------------------------------------------------------------
// Nama yang belum ada di sistem belum tentu orang baru: banyak customer lama
// yang selama ini cuma tercatat di buku. Bedanya penting — label "customer
// baru" di daftar jadwal jadi tidak ada artinya kalau semua nama yang baru
// diketik ikut terhitung baru.
//
// Sekalian ditampilkan nama yang mirip. Salah ketik satu huruf atau sapaan
// yang beda ("Ci Lulu" vs "Cici Lulu") diam-diam melahirkan customer kembar,
// dan riwayat kunjungannya ikut terbelah dua. Dari sini jadwalnya bisa
// langsung ditempelkan ke customer yang sudah ada.
// ============================================================
let pendingJadwal = null; // {nama, date, time} yang menunggu jawaban konfirmasi

// Nama dilucuti jadi bagian intinya: huruf kecil, tanpa tanda baca, tanpa
// sapaan — supaya "Ci Lulu" dan "Cici Lulu" terbaca sebagai orang yang sama.
// Yang dibuang cuma sapaan bergender dan gelar netral. Kata hubungan seperti
// "Anak"/"Cucu" justru bagian dari identitasnya: tanpa itu "Anak Ci Kiwi"
// jadi persis sama dengan "Ci Kiwi", padahal itu ibunya.
const GELAR = new Set(['pdt', 'dr', 'drg', 'sdr']);
const intiNama = (s) => String(s).toLowerCase()
  .replace(/[^a-z0-9\s]/g, ' ')
  .split(/\s+/)
  .filter((k) => k && !GELAR.has(k) && SAPAAN.get(k) !== 'P' && SAPAAN.get(k) !== 'L')
  .join(' ');

// Jarak edit (Levenshtein) satu baris — cukup untuk menangkap salah ketik
// sepanjang nama orang, tanpa perlu matriks penuh.
function jarakEdit(a, b) {
  if (a === b) return 0;
  const baris = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let pojok = baris[0];
    baris[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const simpan = baris[j];
      baris[j] = Math.min(baris[j] + 1, baris[j - 1] + 1,
        pojok + (a[i - 1] === b[j - 1] ? 0 : 1));
      pojok = simpan;
    }
  }
  return baris[b.length];
}

function cariMirip(nama) {
  const inti = intiNama(nama);
  if (!inti) return [];
  const kata = new Set(inti.split(' ').filter((k) => k.length >= 3));
  return customers
    .map((c) => {
      const lain = intiNama(c.name);
      if (!lain) return null;
      // Satu memuat yang lain — "Lulu" vs "Lulu Wijaya". Paling sering benar,
      // jadi ia yang naik paling atas.
      if (lain.includes(inti) || inti.includes(lain)) return { c, skor: 0 };
      // Ada kata yang sama persis: nama depannya sama, sisanya beda tulis.
      if (lain.split(' ').some((k) => kata.has(k))) return { c, skor: 1 };
      // Salah ketik: beda satu-dua huruf saja. Nama pendek dibatasi lebih
      // ketat — pada nama 4 huruf, beda 2 huruf sudah orang lain.
      const jarak = jarakEdit(inti, lain);
      return jarak <= (inti.length <= 5 ? 1 : 2) ? { c, skor: 2 + jarak } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.skor - b.skor || a.c.name.localeCompare(b.c.name, 'id'))
    .slice(0, 5)
    .map((x) => x.c);
}

function bukaKonfirmasiBaru(nama, date, time) {
  pendingJadwal = { nama, date, time };
  $('newCustName').textContent = nama;

  const daftar = $('newCustMiripList');
  daftar.innerHTML = '';
  const mirip = cariMirip(nama);
  $('newCustMirip').hidden = !mirip.length;
  mirip.forEach((c) => {
    const baris = document.createElement('div');
    baris.className = 'mirip-row';
    const nm = document.createElement('div');
    nm.className = 'mirip-nama';
    nm.textContent = c.name;
    const meta = document.createElement('span');
    meta.className = 'meta';
    const n = visitCount(c.id);
    meta.textContent = n ? n + 'x kunjungan tercatat' : 'belum ada kunjungan tercatat';
    nm.appendChild(meta);
    const pakai = document.createElement('button');
    pakai.type = 'button';
    pakai.className = 'mirip-pakai';
    pakai.textContent = 'Ini orangnya';
    pakai.addEventListener('click', () => pilihMirip(c));
    baris.append(nm, pakai);
    daftar.appendChild(baris);
  });

  $('newCustSheet').hidden = false;
}

function tutupKonfirmasiBaru() {
  pendingJadwal = null;
  $('newCustSheet').hidden = true;
}

function jawabKonfirmasi(status) {
  const p = pendingJadwal;
  if (!p) return;
  tutupKonfirmasiBaru();
  // Perangkat lain bisa saja mendaftarkan nama yang sama selagi sheet terbuka —
  // pakai yang sudah ada daripada membuat kembar.
  simpanJadwal(findCustomerByName(p.nama), p.nama, p.date, p.time, status);
}

// Ternyata orangnya sudah terdaftar, cuma beda tulis: jadwalnya menempel ke
// customer yang lama dan nama di form tidak jadi didaftarkan.
function pilihMirip(c) {
  const p = pendingJadwal;
  if (!p) return;
  tutupKonfirmasiBaru();
  simpanJadwal(c, c.name, p.date, p.time, null);
}

$('newCustBaru').addEventListener('click', () => jawabKonfirmasi('baru'));
$('newCustLama').addEventListener('click', () => jawabKonfirmasi('lama'));
$('newCustBatal').addEventListener('click', tutupKonfirmasiBaru);
$('newCustSheet').addEventListener('click', (e) => {
  if (e.target === $('newCustSheet')) tutupKonfirmasiBaru();
});

// ============================================================
// Filter daftar jadwal
// ============================================================
let filterMode = 'today'; // 'today' | 'pastweek' | 'nextweek' | 'day' | 'week' | 'all' | 'date' | 'cust'
let custCari = null;      // mode 'cust': customer yang riwayatnya sedang dibuka

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
  } else if (filterMode === 'cust') {
    // Satu-satunya mode yang tidak dibatasi tanggal: yang dicari justru seluruh
    // riwayatnya. Selama namanya belum dipilih, daftarnya sengaja kosong.
    rows = custCari ? rows.filter((a) => a.customerId === custCari) : [];
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
  const cari = mode === 'cust';
  $('cariBtn').classList.toggle('active', cari);
  $('cariField').hidden = !cari;
  // Pindah ke filter tanggal mana pun = keluar dari mode riwayat; nama yang
  // tertinggal di kotaknya cuma akan membingungkan waktu kotaknya muncul lagi.
  if (!cari) { custCari = null; $('filterCust').value = ''; }
  tutupSugCust();
  perbaruiGeserHari();
  renderList();
}

// Tanggal yang sedang tampil, kalau memang cuma satu hari. null berarti
// filternya menjangkau banyak hari, jadi tidak ada yang bisa digeser.
function hariTampil() {
  if (filterMode === 'today') return today();
  if (filterMode === 'day') return $('filterDate').value || null;
  return null;
}

function perbaruiGeserHari() {
  const hari = hariTampil();
  $('hariBar').hidden = !hari;
  if (!hari) return;
  const kemarin = isoGeser(hari, -1), besok = isoGeser(hari, 1);
  $('hariPrevLabel').textContent = hariPendek(kemarin);
  $('hariNextLabel').textContent = hariPendek(besok);
  $('hariPrev').title = 'Lihat jadwal ' + hariBulan(kemarin);
  $('hariNext').title = 'Lihat jadwal ' + hariBulan(besok);
}

// Satu-satunya jalan untuk menampilkan satu tanggal tertentu. Tanggal hari ini
// sengaja dikembalikan ke mode 'today' supaya chip "Hari Ini" yang menyala —
// bukan tombol tanggal dengan tanggal hari ini yang tertulis di situ.
function pilihTanggal(iso) {
  if (iso === today()) { setFilter('today'); return; }
  $('filterDate').value = iso;
  setFilter('day');
  $('pickDateLabel').textContent = tglSingkat(iso);
}

const geserHari = (n) => pilihTanggal(isoGeser(hariTampil(), n));
$('hariPrev').addEventListener('click', () => geserHari(-1));
$('hariNext').addEventListener('click', () => geserHari(1));
perbaruiGeserHari(); // filter awal "Hari Ini" — palangnya langsung terisi

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
  if (!v) setFilter('today');
  else pilihTanggal(v);
});

// ============================================================
// Cari nama: riwayat kunjungan satu customer
// ------------------------------------------------------------
// Tampilannya menumpang daftar jadwal apa adanya — tiap barisnya sudah menulis
// "customer lama · Nx <bulan>", jadi riwayatnya terbaca tanpa layar baru.
// ============================================================
const sugCust = $('sugCust');
const tutupSugCust = () => { sugCust.classList.remove('open'); sugCust.innerHTML = ''; };

// Saran nama memakai pencarian yang sama dengan form, tapi angkanya total
// seumur hidup: yang dicari di sini riwayat, bukan kunjungan bulan tertentu.
function renderSugCust(q) {
  sugCust.innerHTML = '';
  const rows = searchCustomerList(q);
  if (!rows.length) { tutupSugCust(); return; }
  rows.forEach((r) => {
    const d = document.createElement('div');
    d.innerHTML = '<span></span><span class="meta"></span>';
    d.firstChild.textContent = r.name;
    const n = visitCount(r.id);
    d.lastChild.textContent = n ? n + 'x kunjungan' : 'belum ada kunjungan';
    d.onmousedown = (e) => { e.preventDefault(); cariCustomer(r.id); };
    sugCust.appendChild(d);
  });
  sugCust.classList.add('open');
}

// isiNama=false dipakai waktu namanya memang sedang diketik sendiri — menimpa
// isi kotaknya di tengah pengetikan cuma akan melempar kursor ke ujung.
function cariCustomer(id, isiNama = true) {
  custCari = id;
  setFilter('cust');
  if (isiNama) $('filterCust').value = nameOf(id);
}

$('cariBtn').addEventListener('click', () => {
  // Tombolnya sekaligus jalan keluar: ditekan lagi, kembali ke jadwal hari ini
  if (filterMode === 'cust') { setFilter('today'); return; }
  setFilter('cust');
  $('filterCust').focus();
});

$('filterCust').addEventListener('input', () => {
  const q = $('filterCust').value.trim();
  const persis = findCustomerByName(q);
  if (persis) cariCustomer(persis.id, false);
  else if (custCari) { custCari = null; renderList(); } // nama diubah → riwayat lama tidak berlaku lagi
  renderSugCust(q);
});
$('filterCust').addEventListener('keydown', (e) => {
  // Enter mengambil saran teratas — nama yang diketik lengkap sudah tertangkap
  // sendiri oleh pencocokan persis di atas.
  if (e.key === 'Enter') {
    e.preventDefault();
    if (sugCust.firstChild) sugCust.firstChild.dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    if (sugCust.classList.contains('open')) tutupSugCust();
    else setFilter('today');
  }
});
$('filterCust').addEventListener('blur', () => setTimeout(tutupSugCust, 120));

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
  // Jadwal lama belum punya field ini — di sheet ia tampil kosong, bukan
  // ikut bawaan Rambut, supaya yang belum pernah diisi tidak diam-diam terisi.
  treatEdit.set(a.treatments);
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
  if (!$('newCustSheet').hidden) tutupKonfirmasiBaru();
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
  const jenis = treatEdit.get();
  if (jenis.length) a.treatments = jenis; else delete a.treatments;
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
  setRingkasList(rows);
  setRingkasTreat(rows);
  if (!rows.length) {
    const msg = filterMode === 'today' ? 'Tidak ada jadwal hari ini.'
      : filterMode === 'pastweek' ? 'Tidak ada jadwal seminggu ke belakang.'
      : filterMode === 'nextweek' ? 'Tidak ada jadwal seminggu ke depan.'
      : filterMode === 'day' ? 'Tidak ada jadwal pada tanggal tersebut.'
      : filterMode === 'week' ? 'Tidak ada jadwal minggu ini.'
      : filterMode === 'date' ? 'Tidak ada jadwal pada rentang tanggal tersebut.'
      : filterMode === 'cust' ? (custCari
        ? 'Belum ada kunjungan tercatat untuk ' + nameOf(custCari) + '.'
        : 'Ketik nama customer untuk melihat seluruh riwayat kunjungannya.')
      : 'Belum ada jadwal. Tambahkan lewat form di samping.';
    list.innerHTML = '<div class="empty">' + msg + '</div>';
    return;
  }
  // Jumlah per tanggal dihitung sekali di depan supaya bisa dicetak di judul hari
  const perHari = new Map();
  rows.forEach((r) => perHari.set(r.date, (perHari.get(r.date) || 0) + 1));
  let lastDate = null;
  let urut = 0;
  rows.forEach((r) => {
    if (r.date !== lastDate) {
      const h = document.createElement('div');
      h.className = 'day-head';
      h.textContent = hariBulan(r.date);
      // Di mode riwayat yang terhitung cuma baris satu orang, jadi tiap hari
      // akan selalu berbunyi "1 jadwal" — angka yang tidak menerangkan apa pun.
      if (filterMode !== 'cust') {
        const jml = document.createElement('span');
        jml.className = 'day-jml';
        jml.textContent = perHari.get(r.date) + ' jadwal';
        h.appendChild(jml);
      }
      list.appendChild(h);
      lastDate = r.date;
      // Nomornya tidak diulang dari 1 di mode riwayat: di situ ia justru jadi
      // nomor kunjungan — baris paling bawah menunjukkan sudah keberapa kali.
      if (filterMode !== 'cust') urut = 0;
    }
    urut++;
    // Lama/baru dilihat dari seluruh riwayat, bukan dari bulan yang tampil
    const totalVisits = visitCount(r.customerId);
    const el = document.createElement('div');
    el.className = 'appt';
    const main = document.createElement('div');
    main.className = 'appt-main';
    const bg = document.createElement('div');
    bg.className = 'appt-bg';
    bg.textContent = 'Hapus';
    el.appendChild(bg);
    // Nomor antrian hari itu — ikut di baris supaya tidak perlu dihitung manual
    // Namanya <button>, bukan <span>: selain jadi pintu ke riwayat, bentuk
    // tombol membuat tekan-lama di atasnya tidak ikut membuka sheet ubah
    // jadwal — attachRowGestures memang melewati apa pun yang berupa tombol.
    main.innerHTML =
      '<div class="urut"></div>' +
      '<div class="when"><div class="t"></div></div>' +
      '<div class="who"><div class="n"><button type="button" class="nama"></button></div></div>' +
      '<button class="edit" title="Ubah jadwal">Ubah</button>' +
      '<button class="del" title="Hapus jadwal">Hapus</button>';
    el.appendChild(main);
    el.querySelector('.edit').onclick = () => openEdit(r.id);
    el.querySelector('.del').onclick = () => confirmDelete(r);
    attachRowGestures(main, r);
    const noUrut = el.querySelector('.urut');
    noUrut.textContent = String(urut);
    noUrut.setAttribute('aria-label', filterMode === 'cust'
      ? 'Kunjungan ke-' + urut
      : 'Urutan ke-' + urut + ' pada ' + hariBulan(r.date));
    el.querySelector('.t').textContent = r.time;
    const namaEl = el.querySelector('.nama');
    namaEl.textContent = nameOf(r.customerId);
    namaEl.title = 'Lihat semua kunjungan ' + nameOf(r.customerId);
    namaEl.onclick = () => cariCustomer(r.customerId);
    // Bentuk tandanya sama persis dengan yang nanti keluar di salinan WA
    const tandaT = tandaTreatment(r.treatments);
    if (tandaT) {
      const chip = document.createElement('span');
      chip.className = 'tanda-treat';
      chip.textContent = tandaT;
      chip.title = 'Jenis treatment: ' + namaKombinasi(rapikanTreatment(r.treatments));
      el.querySelector('.n').appendChild(chip);
    }
    // Cuma customer baru yang diberi tanda. Keterangan "customer lama · Nx
    // <bulan>" yang dulu duduk di bawah nama sudah tidak ada: satu baris per
    // jadwal jauh lebih cepat dipindai, dan jumlah kunjungannya justru lebih
    // lengkap terbaca di riwayat — sejauh tap namanya.
    if (!sudahLamaDatang(r.customerId, totalVisits)) {
      const tanda = document.createElement('span');
      tanda.className = 'tanda-baru';
      tanda.textContent = 'Baru';
      tanda.title = 'Customer baru';
      el.querySelector('.n').appendChild(tanda);
    }
    list.appendChild(el);
  });
  jadwalkanAnalitik();
}

// Total jadwal yang sedang tampil — supaya jumlahnya tidak perlu dihitung sendiri
function setRingkasList(rows) {
  const box = $('listTotal');
  if (!rows.length) { box.textContent = ''; return; }
  // Mode riwayat menanyakan hal lain: bukan berapa jadwal hari itu, tapi sudah
  // berapa kali orangnya datang dan sejak kapan. rows sudah urut tanggal.
  if (filterMode === 'cust') {
    const awal = rows[0].date, akhir = rows[rows.length - 1].date;
    box.textContent = rows.length + 'x kunjungan · ' + (awal === akhir
      ? tglSingkat(awal)
      : 'pertama ' + tglSingkat(awal) + ' · terakhir ' + tglSingkat(akhir));
    return;
  }
  const hari = new Set(rows.map((r) => r.date)).size;
  box.textContent = hari > 1
    ? rows.length + ' jadwal · ' + hari + ' hari'
    : rows.length + ' jadwal';
}

// Rekap kombinasi treatment dari jadwal yang sedang tampil. Selama belum ada
// satu pun jadwal yang jenisnya diisi, kotaknya disembunyikan — daftar lama
// yang semuanya kosong tidak perlu diberi tabel berisi satu baris "Belum diisi".
function setRingkasTreat(rows) {
  const box = $('treatRingkas');
  const kombinasi = ringkasTreatment(rows);
  const adaIsi = kombinasi.some((k) => k.t.length);
  box.hidden = !rows.length || !adaIsi;
  if (box.hidden) { box.innerHTML = ''; return; }
  box.innerHTML = '<h3>Jenis treatment</h3>';
  kombinasi.forEach((k) => {
    const baris = document.createElement('div');
    baris.className = 'treat-baris' + (k.t.length ? '' : ' kosong');
    const nama = document.createElement('span');
    nama.textContent = namaKombinasi(k.t);
    const n = document.createElement('span');
    n.className = 'treat-n';
    n.textContent = k.n;
    baris.append(nama, n);
    box.appendChild(baris);
  });
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

  main.addEventListener('touchend', (e) => {
    const wasSwipe = mode === 'swipe' && dx < -70;
    // Geser dan tekan-lama sudah menghasilkan tindakannya sendiri. Tanpa ini,
    // klik semu yang menyusul di ujung gestur ikut menekan nama customer di
    // bawah jari dan daftarnya berpindah ke riwayat orang itu. Tap biasa tidak
    // kena: mode-nya masih null selama tekan-lama belum sempat jalan.
    if (mode !== null) e.preventDefault();
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
  const baruSet = new Set();
  rows.forEach((r) => {
    if (r.date !== lastDate) {
      lines.push('', '📅 *' + hariBulan(r.date) + '*');
      lastDate = r.date;
      n = 0;
    }
    n++;
    const baru = !sudahLamaDatang(r.customerId);
    if (baru) baruSet.add(r.customerId);
    // Rambut tidak ditulis — itu dasarnya. Yang muncul cuma tambahannya
    // ("Tama (+Exo & Muka)") atau justru ketiadaan rambutnya ("Tama (Muka Only)").
    const tandaT = tandaTreatment(r.treatments);
    lines.push(n + '. ' + r.time + ' — ' + nameOf(r.customerId)
      + (tandaT ? ' (' + tandaT + ')' : '') + (baru ? ' 🆕' : ''));
  });

  // Dua baris penutup, menggantikan keterangan "🆕 customer baru" yang dulu.
  // Nol tetap ditulis: barisnya sendiri yang menyebut apa yang dihitung, jadi
  // yang membaca tahu memang tidak ada, bukan sekadar lupa dicantumkan.
  lines.push('', 'jumlah jadwal : ' + rows.length,
    'jumlah cust baru : ' + baruSet.size);

  // Rekap kombinasi treatment. Ikut cuma kalau memang ada yang diisi, supaya
  // salinan dari daftar lama tidak berbuntut satu baris "Belum diisi" saja.
  const kombinasi = ringkasTreatment(rows);
  if (kombinasi.some((k) => k.t.length)) {
    lines.push('', '*Jenis treatment*');
    kombinasi.forEach((k) => lines.push(namaKombinasi(k.t) + ' : ' + k.n));
  }
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
// Satu file = satu cadangan utuh: isinya semua cabang sekaligus, bukan cuma
// yang kebetulan sedang dibuka. Sebelumnya cadangan cabang sebelah cuma bisa
// diambil dengan berpindah cabang dulu, dan cabang yang lupa dipindahi tidak
// pernah punya cadangan sama sekali.
//
// Isi tiap cabang dibaca dan ditulis langsung dari/ke server, bukan dari array
// di memori: memori cuma memuat cabang yang sedang dibuka, jadi untuk cabang
// sebelah tidak ada apa pun di layar ini yang bisa dijadikan pegangan.
const EXPORT_VERSI = 3;

const isiExportBtn = $('exportBtn').innerHTML;
const isiImportBtn = $('importBtn').innerHTML;
// Dua-duanya dikunci sekaligus. Pekerjaannya berjalan beberapa detik dan
// menyentuh banyak dokumen; export dan import yang berjalan bertumpuk bisa
// saling menimpa hasil bacaannya.
function kunciTombolData(btn, label) {
  $('exportBtn').disabled = true;
  $('importBtn').disabled = true;
  btn.textContent = label;
}
function bukaTombolData() {
  $('exportBtn').disabled = false; $('exportBtn').innerHTML = isiExportBtn;
  $('importBtn').disabled = false; $('importBtn').innerHTML = isiImportBtn;
}

// Sengaja dari server, bukan getDoc biasa: file cadangan harus mewakili isi
// server apa adanya, dan cache memori bisa saja belum menyusul.
async function bacaCabang(id) {
  const isi = {};
  for (const key of KEYS_DATA) {
    const snap = await getDocFromServer(doc(db, 'users', uid, 'cabang', id, 'data', key));
    isi[key] = snap.exists() ? (snap.data().rows || []) : [];
  }
  return isi;
}

// Baca-gabung-tulis satu cabang dalam satu transaksi. Tanpa ini ada jeda
// antara membaca isi cabang dan menuliskannya kembali, dan apa pun yang
// ditulis perangkat lain di jeda itu akan hilang tertimpa hasil gabungan yang
// dihitung dari isi sebelum perubahannya. Jeda itu cuma sepersekian detik,
// tapi persis begitulah 24 customer hilang pada 7 Agustus 2026.
//
// Transaksi juga membuat ketiga dokumennya utuh sekali jalan: tidak ada lagi
// keadaan setengah jadi di mana customer sudah masuk tapi jadwalnya belum,
// gara-gara sambungan putus di tengah tiga penulisan berurutan.
async function gabungCabang(id, dariFile) {
  const refs = KEYS_DATA.map((key) => doc(db, 'users', uid, 'cabang', id, 'data', key));
  return runTransaction(db, async (tx) => {
    // Semua pembacaan harus selesai sebelum penulisan pertama — aturan
    // transaksi Firestore. Isinya selalu dari server, tidak pernah dari cache.
    const isi = {};
    for (let i = 0; i < KEYS_DATA.length; i++) {
      const snap = await tx.get(refs[i]);
      isi[KEYS_DATA[i]] = snap.exists() ? (snap.data().rows || []) : [];
    }
    // Dihitung ulang tiap kali transaksi diulang karena bentrok, di atas isi
    // yang baru dibaca lagi — jadi pengulangannya tidak pernah menggandakan
    // apa pun maupun memakai isi yang sudah basi.
    const n = gabungData(isi, dariFile);
    if (n.berubah) KEYS_DATA.forEach((key, i) => tx.set(refs[i], { rows: isi[key] }));
    return n;
  });
}

$('exportBtn').addEventListener('click', async () => {
  if (!tersambung) {
    toast('Belum tersambung ke server — data cabang tidak bisa dibaca.', true); return;
  }
  if (!cabangSiap || !cabangList.length) {
    toast('Daftar cabang masih dimuat — tunggu sebentar lalu ulangi.', true); return;
  }
  kunciTombolData($('exportBtn'), 'Menyiapkan…');
  try {
    const branches = [];
    for (const c of cabangList) {
      const isi = await bacaCabang(c.id);
      branches.push({
        name: c.name,
        customers: isi[KEY_CUSTOMERS],
        appointments: isi[KEY_APPOINTMENTS],
        staff: isi[KEY_STAFF],
      });
    }
    if (!branches.some((b) => b.customers.length || b.appointments.length)) {
      toast('Belum ada data untuk di-export.', true); return;
    }
    // Cabang yang sedang dibuka ikut ditulis datar di luar `branches`, dalam
    // bentuk file versi lama. Perangkat yang aplikasinya belum diperbarui jadi
    // tetap bisa membaca file ini — dapat satu cabang, bukan pesan "format
    // tidak dikenali". Yang sudah diperbarui membaca `branches` dan
    // mengabaikan salinan datar ini.
    const aktif = branches[Math.max(0, cabangList.findIndex((c) => c.id === cabangId))];
    const payload = {
      app: 'jadwal-treatment', version: EXPORT_VERSI, exportedAt: new Date().toISOString(),
      branches,
      customers: aktif.customers, appointments: aktif.appointments, staff: aktif.staff,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'jadwal-treatment-' + today() + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Data ' + branches.length + ' cabang ter-export sebagai file JSON.');
  } catch (e) {
    toast('Gagal membaca data cabang: ' + e.message, true);
  } finally {
    bukaTombolData();
  }
});

// Menggabungkan isi satu cabang dari file ke isi cabang itu yang baru dibaca
// dari server. Aturannya sama seperti dulu: customer dicocokkan berdasarkan
// nama, jadwal yang customer+tanggal+jamnya sudah ada dilewati.
function gabungData(isi, dariFile) {
  const dftCustomers = isi[KEY_CUSTOMERS];
  const dftAppointments = isi[KEY_APPOINTMENTS];
  const dftStaff = isi[KEY_STAFF];
  let cust = 0, appt = 0, berubah = false;
  const idMap = new Map(); // id di file -> id di cabang tujuan

  const tambahStaff = (nama) => {
    const n = String(nama).trim().replace(/\s+/g, ' ');
    if (!n) return '';
    if (!dftStaff.some((s) => s.toLowerCase() === n.toLowerCase())) {
      dftStaff.push(n);
      dftStaff.sort((a, b) => a.localeCompare(b, 'id'));
      berubah = true;
    }
    return n;
  };

  (dariFile.customers || []).forEach((c) => {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return;
    const name = c.name.trim().replace(/\s+/g, ' ');
    const q = name.toLowerCase();
    let existing = dftCustomers.find((x) => x.name.toLowerCase() === q);
    if (!existing) {
      existing = { id: buatId(), name };
      dftCustomers.push(existing);
      cust++; berubah = true;
    }
    // Penanda "sudah lama datang, baru masuk sistem" ikut terbawa. Sekali
    // seseorang diakui customer lama, tidak ada file yang bisa mencabutnya —
    // ketiadaan penanda di file cuma berarti file itu belum tahu.
    if (c.sudahLama && !existing.sudahLama) { existing.sudahLama = true; berubah = true; }
    // Gender ikut terbawa: koreksi manual dari file menang atas tebakan yang
    // belum dikoreksi, tapi koreksi manual yang sudah ada di sini tidak pernah
    // ditimpa. Tebakan lawan tebakan sama saja hasilnya, jadi tidak diapa-apakan.
    if ((c.gender === 'P' || c.gender === 'L') && !existing.genderManual
        && (!existing.gender || c.genderManual)) {
      existing.gender = c.gender;
      if (c.genderManual) existing.genderManual = true;
      berubah = true;
    }
    idMap.set(c.id, existing.id);
  });

  (dariFile.appointments || []).forEach((a) => {
    if (!a || !idMap.has(a.customerId)) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.date || '') || !/^\d{2}:\d{2}$/.test(a.time || '')) return;
    const cid = idMap.get(a.customerId);
    if (dftAppointments.some((x) => x.customerId === cid && x.date === a.date && x.time === a.time)) return;
    const baru = { id: buatId(), customerId: cid, date: a.date, time: a.time };
    // Kode yang tidak dikenal dibuang di sini dan urutannya disamakan, jadi
    // file dari versi mana pun masuk dalam bentuk yang sama.
    const jenis = rapikanTreatment(a.treatments);
    if (jenis.length) baru.treatments = jenis;
    if (a.done === true) baru.done = true;
    if (typeof a.staff === 'string' && a.staff.trim()) baru.staff = tambahStaff(a.staff);
    dftAppointments.push(baru);
    appt++; berubah = true;
  });

  (Array.isArray(dariFile.staff) ? dariFile.staff : [])
    .forEach((s) => { if (typeof s === 'string') tambahStaff(s); });

  return { cust, appt, berubah };
}

// Mengunci daftar cabang di server, lalu memetakan tiap nama cabang di file ke
// id cabang di sana. Nama yang belum terdaftar dibuat di transaksi yang sama.
//
// Sengaja dari daftar di server, bukan dari `cabangList` di memori: kalau
// perangkat lain menambah cabang sesudah snapshot terakhir sampai ke sini,
// menulis balik daftar versi memori akan menghapus cabang itu dari daftar dan
// membuat seluruh isinya yatim — masih ada di Firestore, tapi tidak ada lagi
// yang bisa membukanya.
async function petakanCabang(namaList) {
  const ref = doc(db, 'users', uid, 'data', 'branches');
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    const rows = snap.exists() ? (snap.data().rows || []) : [];
    // Daftar kosong di server padahal di layar ada isinya: tanda bahaya yang
    // sama yang dijaga peringatanCabangKosong. Menulis daftar baru di atasnya
    // akan menguburkan semua cabang lama, jadi import berhenti di sini.
    if (!rows.length && cabangList.length) {
      throw new Error('daftar cabang di server terbaca kosong — periksa datanya dulu');
    }
    const peta = new Map();
    const baru = [];
    namaList.forEach((name) => {
      const q = name.toLowerCase();
      let c = rows.find((x) => String(x.name || '').toLowerCase() === q);
      if (!c) { c = { id: buatId(), name }; rows.push(c); baru.push(name); }
      peta.set(q, c.id);
    });
    if (baru.length) tx.set(ref, { rows });
    return { peta, baru };
  });
}

$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); }
  catch { toast('File tidak bisa dibaca — bukan JSON valid.', true); return; }

  // File versi lama tidak punya daftar cabang dan isinya cuma satu cabang
  // tanpa nama. Itu diperlakukan sebagai file untuk cabang yang sedang dibuka
  // — persis perilaku sebelumnya, jadi file cadangan lama tetap masuk.
  let daftarCabangFile;
  if (Array.isArray(data.branches)) {
    daftarCabangFile = data.branches;
  } else if (Array.isArray(data.customers) && Array.isArray(data.appointments)) {
    const aktif = cabangList.find((c) => c.id === cabangId);
    if (!aktif) { toast('Cabang belum siap — tunggu sebentar lalu ulangi.', true); return; }
    daftarCabangFile = [{
      name: aktif.name,
      customers: data.customers, appointments: data.appointments, staff: data.staff,
    }];
  } else {
    toast('Format file tidak dikenali.', true); return;
  }
  if (!bolehUbahCabang()) return;

  // Nama cabang dirapikan dan digabung dulu: dua entri "Puri" dan "puri " di
  // satu file harus mendarat di cabang yang sama, bukan bikin cabang kembar.
  const tujuan = [];
  daftarCabangFile.forEach((b) => {
    const name = String((b && b.name) || '').trim().replace(/\s+/g, ' ');
    if (!name || !Array.isArray(b.customers) || !Array.isArray(b.appointments)) return;
    const q = name.toLowerCase();
    const sudah = tujuan.find((t) => t.nama.toLowerCase() === q);
    if (sudah) { sudah.isi.push(b); return; }
    tujuan.push({ nama: name, isi: [b] });
  });
  if (!tujuan.length) { toast('Tidak ada cabang berisi data di file itu.', true); return; }

  // Import menulis ke cabang yang tidak sedang dilihat operator, dan tidak ada
  // tombol urung. Cabang mana saja yang akan disentuh disebutkan lebih dulu.
  const belumAda = tujuan
    .filter((t) => !cabangList.some((c) => c.name.toLowerCase() === t.nama.toLowerCase()))
    .map((t) => t.nama);
  const rincian = 'Import data ke ' + tujuan.length + ' cabang: '
    + tujuan.map((t) => t.nama).join(', ') + '.'
    + (belumAda.length ? '\n\nCabang baru akan dibuat: ' + belumAda.join(', ') + '.' : '')
    + '\n\nData yang sudah ada tidak dihapus — yang masuk cuma tambahannya.';
  if (!confirm(rincian)) return;
  // Diperiksa ulang sesudah dialognya dijawab. Dialog itu bisa terbuka berapa
  // lama pun, dan pemeriksaan sebelum dialog sudah basi begitu sambungan
  // sempat putus di sela itu. Transaksinya memang akan gagal sendiri, tapi
  // pesannya jadi pesan galat Firestore, bukan alasan yang bisa dibaca operator.
  if (!bolehUbahCabang()) return;

  kunciTombolData($('importBtn'), 'Mengimpor…');
  try {
    // Daftar cabang dikunci dan ditulis lebih dulu. Kalau urutannya dibalik,
    // data yang sudah masuk ke id yang belum pernah terdaftar akan jadi yatim
    // begitu penulisan daftarnya gagal.
    const { peta, baru } = await petakanCabang(tujuan.map((t) => t.nama));
    let totalCust = 0, totalAppt = 0, gagal = [];
    for (const t of tujuan) {
      const id = peta.get(t.nama.toLowerCase());
      try {
        for (const b of t.isi) {
          const n = await gabungCabang(id, b);
          totalCust += n.cust; totalAppt += n.appt;
        }
      } catch (e) {
        // Satu cabang yang gagal tidak boleh menghentikan yang lain: yang
        // berhenti di tengah justru meninggalkan keadaan paling sulit dibaca,
        // karena tidak ada yang tahu sampai cabang mana yang sudah masuk.
        gagal.push(t.nama + ' (' + e.message + ')');
      }
    }
    const catatanBaru = baru.length ? ' (' + baru.length + ' cabang baru dibuat)' : '';
    if (gagal.length) {
      toast('Import sebagian: ' + totalCust + ' customer, ' + totalAppt
        + ' jadwal masuk. Gagal di ' + gagal.join('; ')
        + ' — ulangi dengan file yang sama untuk melengkapinya.', true);
    } else {
      toast('Import selesai: ' + totalCust + ' customer baru, ' + totalAppt
        + ' jadwal ditambahkan di ' + tujuan.length + ' cabang' + catatanBaru + '.');
    }
  } catch (e) {
    // Gagal di petakanCabang: belum ada satu pun data yang ditulis.
    toast('Import dibatalkan: ' + e.message, true);
  } finally {
    bukaTombolData();
  }
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
// Sekali cukup: dengan includeMetadataChanges, keadaan buntu ini akan menyala
// lagi tiap kali metadata snapshot-nya berubah, dan toast-nya jadi beruntun.
let peringatanCabangKosong = false;

function mulaiSync() {
  setSambung(false); // dianggap belum tersambung sampai server yang bilang lain
  cabangSiap = false;
  resetDataSiap();
  stopCabangList = onSnapshot(
    doc(db, 'users', uid, 'data', 'branches'),
    // includeMetadataChanges: tanpa ini listener diam saja waktu sambungan
    // putus, dan status di layar ikut basi.
    { includeMetadataChanges: true },
    (snap) => {
      // Satu sambungan dipakai bersama seluruh listener, jadi metadata dari
      // dokumen yang selalu aktif ini sudah mewakili status aplikasi.
      setSambung(!snap.metadata.fromCache);
      // Cuma jawaban server yang murni — bukan gema tulisan sendiri — yang
      // boleh membuka gerbang tulis daftar cabang.
      const dariServer = !snap.metadata.fromCache && !snap.metadata.hasPendingWrites;
      const rows = snap.exists() ? (snap.data().rows || []) : [];
      if (!rows.length) {
        // Kosong menurut cache belum tentu benar-benar kosong. Kalau ini
        // diteruskan, perangkat yang dibuka tanpa sinyal akan membuat ulang
        // cabang default dan menimpa daftar cabang asli begitu tersambung.
        if (!dariServer) return;
        // Dokumennya ada tapi rows-nya kosong berarti bukan akun baru, melainkan
        // daftar cabang yang pernah terisi lalu jadi kosong. Membuat cabang
        // default di atasnya berarti tiga id acak yang baru, dan seluruh data
        // lama jadi yatim di bawah id cabang lama: masih ada di Firestore, tapi
        // tidak terjangkau dari mana pun. Lebih baik berhenti dan bilang apa adanya.
        if (snap.exists()) {
          cabangSiap = false;
          if (!peringatanCabangKosong) {
            peringatanCabangKosong = true;
            toast('Daftar cabang kosong di server — jangan simpan apa pun dulu, periksa datanya.', true);
          }
          return;
        }
        buatCabangDefault();
        return;
      }
      cabangList = rows;
      if (dariServer) cabangSiap = true;
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
      // Daftar cabang yang gagal dibaca berarti `cabangList` di memori tidak
      // bisa dipertanggungjawabkan lagi; gerbang tulisnya ditutup balik.
      cabangSiap = false;
      setSambung(false);
      toast('Gagal memuat daftar cabang: ' + e.message, true);
    }
  );
}

function mulaiSyncData() {
  stopData.forEach((lepas) => lepas());
  // Melepas listener tidak membatalkan snapshot yang sudah dalam perjalanan.
  // Tanpa penanda cabang ini, jawaban cabang lama bisa mendarat sesudah operator
  // pindah cabang, menggantikan isi memori, lalu ikut tertulis balik ke cabang
  // yang baru — isi cabang lama nyasar, isi cabang baru habis.
  const cabangDipasang = cabangId;
  resetDataSiap();
  const pasang = (key, terapkan) => onSnapshot(
    doc(db, 'users', uid, 'cabang', cabangDipasang, 'data', key),
    (snap) => {
      if (cabangId !== cabangDipasang) return;
      // Ditandai siap sebelum diterapkan: lengkapiGender() menyimpan dari dalam
      // terapkan(), dan penyimpanan itu harus lolos gerbang save().
      dataSiap[key] = true;
      terapkan(snap.exists() ? (snap.data().rows || []) : []);
      renderList();
    },
    (e) => {
      if (cabangId !== cabangDipasang) return;
      // Gagal baca berarti isi di layar tidak bisa dipertanggungjawabkan lagi;
      // gerbangnya ditutup balik supaya tidak ada yang tertulis menimpanya.
      dataSiap[key] = false;
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
// Sekali percobaan per sesi, dan sengaja tidak pernah dikembalikan ke false.
// Jalur ini membuat tiga id cabang acak yang baru; kalau ia sampai jalan dua
// kali — misalnya karena tulisan pertamanya gagal separuh jalan — data yang
// sudah terlanjur dipindahkan ke id ronde pertama langsung jadi yatim. Kalau
// percobaannya gagal, jalan keluarnya memuat ulang halaman, bukan mencoba lagi.
let migrasiDicoba = false;
async function buatCabangDefault() {
  if (migrasiDicoba) return;
  migrasiDicoba = true;
  try {
    // Satu pembacaan terakhir langsung ke server sebelum menulis apa pun.
    // Snapshot yang memicu jalur ini bisa saja sudah ketinggalan; dokumen
    // branches yang ternyata sudah terisi berarti ini bukan akun baru, dan
    // menimpanya sama saja dengan memutus jalan ke seluruh data di bawahnya.
    const cek = await getDoc(doc(db, 'users', uid, 'data', 'branches'));
    if (cek.exists() && (cek.data().rows || []).length) return;
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
    // Termasuk kalau pembacaan branches di atas yang gagal: server yang tidak
    // bisa ditanya bukan berarti "akun baru", jadi jalur ini berhenti di sini
    // dan tidak pernah jatuh ke pembuatan cabang default.
    toast('Gagal menyiapkan cabang: ' + e.message, true);
  }
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
  // Array di atas sekarang kosong bukan karena cabang barunya kosong, tapi
  // karena isinya belum sempat datang. Gerbangnya ditutup di detik yang sama.
  resetDataSiap();
  // Customer & jadwal disimpan per cabang, jadi nama yang sedang dibuka
  // riwayatnya tidak ada artinya lagi di cabang sebelah.
  if (filterMode === 'cust') setFilter('today');
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
  if (!bolehUbahCabang()) return;
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
      resetDataSiap(); cabangSiap = false; peringatanCabangKosong = false;
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
  const pelanggan = new Set(rows.map((a) => a.customerId));
  return {
    rows,
    total: rows.length,
    jumlahCustomer: pelanggan.size,
    customerBaru: [...pelanggan].filter(baruDiBulan(kunci)).length,
    treatmentG,
    custG,
  };
}

// "Baru bulan ini" sengaja dihitung dari kunjungan pertama yang tercatat, bukan
// dari tanda "Baru" di daftar jadwal. Tanda itu memakai jumlah kunjungan sampai
// hari ini, jadi orang yang baru di bulan Juni berhenti terhitung baru begitu ia
// datang lagi di bulan Juli — angka bulan lalu akan menyusut sendiri tiap kali
// dibuka, dan pembandingnya jadi tidak ada artinya. Tanda sudahLama tetap
// menang: itu customer lama yang kebetulan baru masuk sistem.
function baruDiBulan(kunci) {
  const pertama = new Map();
  appointments.forEach((a) => {
    const p = pertama.get(a.customerId);
    if (!p || a.date < p) pertama.set(a.customerId, a.date);
  });
  return (customerId) => {
    const c = customers.find((x) => x.id === customerId);
    if (c && c.sudahLama) return false;
    const awal = pertama.get(customerId);
    return !!awal && kunciDari(awal) === kunci;
  };
}

// --- Deretan angka utama ---
function renderKpi(kini, lalu) {
  const box = $('kpiRow');
  box.innerHTML = '';
  [
    ['Total treatment', kini.total, lalu.total],
    ['Jumlah customer', kini.jumlahCustomer, lalu.jumlahCustomer],
    ['Customer baru', kini.customerBaru, lalu.customerBaru],
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

// --- Kombinasi treatment (batang mendatar, porsi dari total bulan itu) ---
// Bentuknya sengaja dipinjam dari komposisi gender: dua kartu ini menjawab
// pertanyaan yang sama bentuknya ("dari sekian treatment, berapa porsi tiap
// kelompok"), jadi keduanya pantas dibaca dengan cara yang sama.
function renderKomb(kini) {
  const box = $('chartKomb');
  box.innerHTML = '';
  if (!kini.rows.length) {
    box.innerHTML = '<div class="empty">Belum ada jadwal di bulan ini.</div>';
    return;
  }
  const kombinasi = ringkasTreatment(kini.rows);
  // Sebulan yang jenisnya belum diisi sama sekali tidak perlu diberi satu
  // batang "Belum diisi 100%" — itu bukan komposisi, cuma ketiadaan data.
  if (!kombinasi.some((k) => k.t.length)) {
    box.innerHTML = '<div class="empty">Belum ada jadwal yang jenisnya diisi bulan ini.</div>';
    return;
  }
  kombinasi.forEach((k) => {
    const persen = Math.round(k.n / kini.total * 100);
    const nama = namaKombinasi(k.t);

    const baris = document.createElement('div');
    baris.className = 'gen-row';
    baris.tabIndex = 0;

    const label = document.createElement('div');
    label.className = 'gen-label';
    const teksLabel = document.createElement('span');
    teksLabel.textContent = nama;
    label.appendChild(teksLabel);

    const nilai = document.createElement('div');
    nilai.className = 'gen-val';
    nilai.textContent = String(k.n);
    const pct = document.createElement('span');
    pct.className = 'gen-persen';
    pct.textContent = persen + '%';
    nilai.appendChild(pct);

    const atas = document.createElement('div');
    atas.className = 'gen-atas';
    atas.append(label, nilai);

    const track = document.createElement('div');
    track.className = 'gen-track';
    const bar = document.createElement('div');
    // Yang belum diisi dapat abu-abu, bukan warna merek: di palet ini abu-abu
    // memang jatahnya data yang belum lengkap, bukan salah satu kategori.
    bar.className = 'gen-bar komb' + (k.t.length ? '' : ' kosong');
    // Dibagi total bulan itu, sama seperti komposisi gender — panjang batang
    // berarti porsi, jadi ia bicara hal yang sama dengan persen di sebelahnya.
    bar.style.width = Math.max(2, k.n / kini.total * 100) + '%';
    track.appendChild(bar);

    baris.append(atas, track);
    baris.setAttribute('aria-label', nama + ': ' + k.n + ' treatment, ' + persen + '% dari bulan ini.');
    pasangTip(baris, '<b>' + k.n + ' treatment</b> · ' + persen + '%<br>' + nama);
    box.appendChild(baris);
  });
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
    // Jumlahnya dicetak langsung di kotak — di HP tidak ada hover untuk memunculkan
    // tooltip. Hari kosong ikut ditulis 0, bukan dikosongkan: kotak tanpa angka
    // membaca seperti angkanya belum sempat termuat, bukan seperti hari yang sepi.
    const tgl = document.createElement('span');
    tgl.className = 'heat-tgl';
    tgl.textContent = String(t);
    const jml = document.createElement('span');
    jml.className = 'heat-jml';
    jml.textContent = String(n);
    sel.append(tgl, jml);
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
  pilihTanggal(iso);
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

  tambah('Per kombinasi treatment', ['Kombinasi', 'Treatment', 'Porsi'],
    kini.total
      ? ringkasTreatment(kini.rows).map((k) =>
        [namaKombinasi(k.t), k.n, Math.round(k.n / kini.total * 100) + '%'])
      : [],
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
  renderKomb(kini);
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

  // --- Tiga angka utama ---
  const kpi = [
    ['Total treatment', kini.total, lalu.total],
    ['Jumlah customer', kini.jumlahCustomer, lalu.jumlahCustomer],
    ['Customer baru', kini.customerBaru, lalu.customerBaru],
  ];
  const kpiH = 112, sela = 16, kpiW = (W - sela * (kpi.length - 1)) / kpi.length;
  kpi.forEach(([label, nilai, sebelum], i) => {
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

  // --- Kombinasi treatment ---
  const kombinasi = kini.total ? ringkasTreatment(kini.rows) : [];
  const barisT = kombinasi.some((k) => k.t.length) ? kombinasi : [];
  const tinggiT = 62 + (barisT.length ? barisT.length * 56 : 40) + 14;
  vizPanel(ctx, C, L, y, W, tinggiT);
  vizTeks(ctx, 'Kombinasi Treatment', L + 22, y + 40, { ukuran: 17.5, tebal: 700, warna: C.text });
  let ty = y + 64;
  if (!barisT.length) {
    vizTeks(ctx, kini.total ? 'Belum ada jadwal yang jenisnya diisi bulan ini.'
      : 'Belum ada jadwal di bulan ini.',
      L + 22, ty + 18, { ukuran: 14, warna: C.muted });
  } else barisT.forEach((k) => {
    const persen = Math.round(k.n / kini.total * 100);
    const nama = namaKombinasi(k.t);
    vizTeks(ctx, nama, L + 22, ty + 14, { ukuran: 14.5, tebal: 600, warna: C.text });
    // Jumlah dan persen dipisah kurung dan beda bobot, sama seperti komposisi
    // gender — persennya turunan, jadi ia yang mengalah.
    const teksPersen = '(' + persen + '%)';
    vizTeks(ctx, teksPersen, L + W - 22, ty + 14, { ukuran: 12, tebal: 600, warna: C.muted, rata: 'right' });
    vizTeks(ctx, String(k.n), L + W - 22 - vizLebar(ctx, teksPersen, 12, 600) - 7, ty + 14,
      { ukuran: 14.5, tebal: 700, warna: C.text, rata: 'right' });
    const jalur = W - 44;
    ctx.fillStyle = C.field;
    vizKotak(ctx, L + 22, ty + 27, jalur, 11, 6);
    ctx.fill();
    ctx.fillStyle = k.t.length ? C.accent : C.gen['?'];
    vizKotak(ctx, L + 22, ty + 27, Math.max(8, jalur * k.n / kini.total), 11, 6);
    ctx.fill();
    ty += 56;
  });
  y += tinggiT + 18;

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
  vizTeks(ctx, 'Angka besarnya jumlah treatment, dan makin pekat warnanya makin ramai.',
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
    const n = perHari.get(iso) || 0;
    const tingkat = tingkatWarna(n, maksHari);
    ctx.fillStyle = C.h[tingkat];
    vizKotak(ctx, x, ky, selW, selH, 10);
    ctx.fill();
    // Dua langkah tergelap pakai tinta putih supaya angkanya tetap terbaca
    const tinta = tingkat >= 3 ? '#ffffff' : C.text2;
    // Sama seperti di layar: tanggal kecil di pojok, jumlah treatment di tengah,
    // hari kosong tetap ditulis 0
    vizTeks(ctx, String(t), x + 7, ky + 14, { ukuran: 10, tebal: 600, warna: tinta });
    vizTeks(ctx, String(n), x + selW / 2, ky + selH / 2 + 7,
      { ukuran: 16, tebal: 700, warna: tinta, rata: 'center' });
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
// Tema terang / gelap
// ------------------------------------------------------------
// Pilihannya per perangkat (localStorage, seperti pilihan cabang): HP kasir
// dan layar di meja depan boleh beda, dan temanya memang urusan mata orang
// yang sedang memegang, bukan data salon.
//
// Selama tombolnya belum pernah ditekan, tampilan ikut setelan HP. Sekali
// ditekan, pilihan itu yang menang. Kalau yang dipilih ternyata sama dengan
// setelan HP-nya, penandanya justru dihapus — jadi tidak ada mode ketiga
// "ikut sistem" yang perlu dijelaskan di layar: menekan tombolnya sampai
// kembali cocok dengan HP membuat aplikasinya ikut HP lagi dengan sendirinya.
//
// Nilai awalnya sudah dipasang skrip kecil di <head> supaya tidak ada kedip
// putih saat dibuka; di sini tinggal menyamakan ikon dan menangani penekanan.
// ============================================================
const KUNCI_TEMA = 'jt_tema';
const mediaGelap = matchMedia('(prefers-color-scheme: dark)');
const temaBtn = $('temaBtn');
const temaTersimpan = () => {
  try { return localStorage.getItem(KUNCI_TEMA); } catch { return null; }
};
const temaAktif = () => (document.documentElement.dataset.tema === 'gelap' ? 'gelap' : 'terang');

function pasangTema(tema) {
  document.documentElement.dataset.tema = tema;
  // Palang status HP ikut, supaya tepi layar tidak tertinggal terang sendirian
  $('metaTema').content = tema === 'gelap' ? '#171114' : '#d6336c';
  // Ikon dan judulnya menyebut tampilan yang akan didapat, bukan yang sedang
  // dipakai — tombol yang menggambarkan keadaan sekarang selalu ambigu:
  // ditekan untuk apa, mempertahankannya atau menggantinya?
  const keGelap = tema !== 'gelap';
  temaBtn.querySelector('use').setAttribute('href', keGelap ? '#i-gelap' : '#i-terang');
  const label = keGelap ? 'Ganti ke tampilan gelap' : 'Ganti ke tampilan terang';
  temaBtn.setAttribute('aria-label', label);
  temaBtn.title = label;
}

temaBtn.addEventListener('click', () => {
  const baru = temaAktif() === 'gelap' ? 'terang' : 'gelap';
  const samaDenganHp = baru === (mediaGelap.matches ? 'gelap' : 'terang');
  try {
    if (samaDenganHp) localStorage.removeItem(KUNCI_TEMA);
    else localStorage.setItem(KUNCI_TEMA, baru);
  } catch { /* mode privat: temanya tetap berganti, cuma tidak diingat */ }
  pasangTema(baru);
});

// Setelan HP berubah di tengah pemakaian — mis. jadwal gelap otomatis begitu
// malam. Diikuti hanya selama pemakainya belum pernah memilih sendiri.
mediaGelap.addEventListener('change', (e) => {
  if (!temaTersimpan()) pasangTema(e.matches ? 'gelap' : 'terang');
});

pasangTema(temaAktif());

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
