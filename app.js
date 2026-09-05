// ============================================================
// Penyimpanan (Firestore) — server satu-satunya sumber kebenaran.
// Susunan: users/{uid}/data/profil — nama klinik, satu dokumen tingkat akun —
// users/{uid}/cabang/{id}/data/{customers|staff} — satu dokumen
// berisi { rows: [...] } meniru bentuk array lama — dan jadwal di
// users/{uid}/cabang/{id}/appointments/{YYYY-MM}, satu dokumen per bulan.
//
// Jadwal dipecah per bulan karena satu dokumen Firestore berhenti di 1 MiB:
// dengan ~270 jadwal per bulan, riwayat yang ditumpuk di satu dokumen akan
// menabrak batas itu dalam hitungan belasan bulan, dan sejak itu tidak ada
// jadwal baru yang bisa disimpan sama sekali. Dipecah per bulan, tiap dokumen
// berhenti tumbuh di akhir bulannya. Efek sampingnya sama pentingnya: mengubah
// satu jadwal cuma mengirim ulang bulan itu, bukan seluruh riwayat.
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
  initializeFirestore, memoryLocalCache, doc, collection, getDoc,
  getDocFromServer, getDocsFromServer,
  setDoc, deleteDoc, onSnapshot, runTransaction,
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const KEY_CUSTOMERS = 'customers';       // [{id, name, gender?, genderManual?, sudahLama?, phone?, sapaan?, diingatkan?}]
// Bukan lagi nama dokumen seperti dua yang lain, melainkan nama koleksi
// bulanannya — sekaligus tetap dipakai sebagai kunci di `dataSiap`.
const KEY_APPOINTMENTS = 'appointments'; // [{id, customerId, date, time, treatments?}]
// Pegawai cuma dipakai fitur "tandai selesai" yang sedang dinonaktifkan. Datanya
// tetap ikut disinkronkan dan ikut terbawa export/import supaya utuh saat fiturnya
// dinyalakan lagi — begitu juga field done/staff/photos di tiap appointment.
const KEY_STAFF = 'staff';               // ['Nama Pegawai', ...]
// Jumlah pegawai yang dipakai pencarian slot, satu angka untuk tiap hari dalam
// seminggu. Disimpan per cabang, karena Puri dan Bandung tidak pernah punya
// jumlah pegawai yang sama — dan sebelum ini angkanya cuma satu untuk semua
// hari, cuma hidup di memori satu tab, ikut terbawa waktu pindah cabang, lalu
// hilang begitu halaman dimuat ulang.
const KEY_PEGAWAI = 'pegawai';           // [{hari, n}] — hari 0..6, Minggu = 0
// Jam buka dan tutup, juga satu baris untuk tiap hari dalam seminggu. Alasannya
// sama dengan pegawai: cabang yang satu tutup jam 17:00 dan yang sebelah masih
// buka sampai malam, dan Sabtu hampir tidak pernah sama dengan hari kerja.
// Sebelum ini jamnya satu pasang tetap di dalam kode — tidak ada yang bisa
// mengubahnya tanpa mengubah app.js.
const KEY_JAM = 'jam';                   // [{hari, buka, tutup}] — 'HH:MM'

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

// Nama klinik, dipakai di pesan WhatsApp supaya penerimanya tahu ini dari
// siapa. Kosong selama dokumen profilnya belum ada — dan memang boleh kosong:
// seluruh teks yang memakainya jatuh kembali ke bentuk lamanya, jadi akun yang
// belum sempat mengisinya tidak jadi rusak.
let namaKlinik = '';

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
// Ketiganya tetap punya penanda kesiapan sendiri, walau jadwal sekarang datang
// dari koleksi bulanan dan bukan lagi dari satu dokumen seperti dua yang lain.
const KEYS_DATA = [KEY_CUSTOMERS, KEY_APPOINTMENTS, KEY_STAFF, KEY_PEGAWAI, KEY_JAM];
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

// Alamat dokumen, dikumpulkan di satu tempat supaya susunan koleksinya cuma
// tertulis sekali dan tidak ada pemanggil yang salah mengeja jalurnya.
const refData = (id, key) => doc(db, 'users', uid, 'cabang', id, 'data', key);
const refJadwalKol = (id) => collection(db, 'users', uid, 'cabang', id, 'appointments');
const refJadwal = (id, kunci) => doc(db, 'users', uid, 'cabang', id, 'appointments', kunci);

// Cuma dipakai customers & staff sekarang; jadwal lewat simpanJadwal().
function save(key, data) {
  // Jaring terakhir; pemanggilnya sudah lewat bolehUbah(). Kesiapan diperiksa
  // per key supaya penyimpanan yang dipicu snapshot itu sendiri — lengkapiGender()
  // — tetap jalan begitu dokumennya siap, tanpa menunggu dua dokumen lainnya.
  if (!tersambung || !cabangId || !dataSiap[key]) return;
  setDoc(refData(cabangId, key), { rows: data })
    .catch((e) => toast('Gagal menyimpan ke cloud: ' + e.message, true));
}

// Jadwal datar -> Map 'YYYY-MM' -> baris bulan itu. Bulan yang tidak punya
// baris sama sekali tidak muncul sebagai kunci.
function kelompokBulan(rows) {
  const per = new Map();
  rows.forEach((a) => {
    const k = kunciDari(a.date);
    if (!per.has(k)) per.set(k, []);
    per.get(k).push(a);
  });
  return per;
}

// Tanggal yang tidak berbentuk 'YYYY-MM-DD' tidak punya bulan yang bisa
// dijadikan nama dokumen. Barisnya juga tidak pernah terbaca filter mana pun,
// jadi disaring di pintu masuk daripada menghasilkan dokumen bernama aneh.
const tanggalSah = (a) => !!a && typeof a.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(a.date);

// Menyimpan jadwal untuk bulan-bulan yang tersentuh saja. `appointments` di
// memori tetap satu array datar berisi seluruh riwayat — yang dipecah cuma
// bentuk simpannya — jadi isi tiap dokumen bulanan selalu dihitung ulang dari
// array itu, bukan ditambal per baris.
function simpanBulan(kunciSet) {
  if (!tersambung || !cabangId || !dataSiap[KEY_APPOINTMENTS]) return;
  const per = kelompokBulan(appointments.filter(tanggalSah));
  const cab = cabangId;
  kunciSet.forEach((k) => {
    const rows = per.get(k) || [];
    // Bulan yang barisnya habis dihapus dokumennya, bukan ditinggalkan berisi
    // { rows: [] }: dokumen kosong tetap ikut terbaca listener dan tetap
    // dihitung satu pembacaan tiap kali cabangnya dibuka.
    const janji = rows.length ? setDoc(refJadwal(cab, k), { rows }) : deleteDoc(refJadwal(cab, k));
    janji.catch((e) => toast('Gagal menyimpan ke cloud: ' + e.message, true));
  });
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
// dijawab operator sendiri di sheet konfirmasi saat namanya pertama disimpan,
// dan bisa diperbaiki kapan saja lewat bukaUbahStatus().
//
// Jawaban operator menang atas jumlah kunjungan, dua-duanya arah. Yang sudah
// dijawab "lama" tetap lama walau kunjungannya baru satu; yang dijawab "baru"
// tetap baru walau kunjungannya lebih dari satu — orang yang langsung memesan
// beberapa sesi sekaligus di hari pertama tetap orang baru waktu ia datang.
// Yang tidak pernah dijawab jatuh ke jumlah kunjungan seperti sebelumnya.
const sudahLamaDatang = (customerId, totalVisits) => {
  const c = customers.find((x) => x.id === customerId);
  if (c && typeof c.sudahLama === 'boolean') return c.sudahLama;
  return (totalVisits != null ? totalVisits : visitCount(customerId)) > 1;
};

// Sapaan di pembuka pesan WhatsApp. Nama di data ini nama lengkap beserta
// panggilannya — "Ibu Siti Rahma", "Ci Mei Lin" — dan itu memang yang dibaca
// tebakGender(), jadi kolomnya tidak bisa dipendekkan begitu saja. Yang dipakai
// menyapa cuma sebagiannya, dan bagian mana yang wajar cuma operator yang tahu:
// "Ci Mei" benar, "Ci Mei Lin" kaku, "Mei Lin" kehilangan panggilannya.
//
// Kosong berarti belum pernah ditanyakan — bukan berarti nama lengkapnya yang
// dipakai. Yang belum terisi ditanyakan dulu lewat bukaSapaan() sebelum
// pesannya berangkat, jadi tidak ada pesan yang keluar dengan sapaan tebakan.
// Dirapikan waktu dibaca, bukan cuma waktu disimpan: isian yang cuma berisi
// spasi lolos dari pemeriksaan "sudah ada isinya" dan pesannya berangkat
// menyapa ruang kosong. Kotak isiannya sendiri sudah menolak yang kosong, tapi
// data ini juga bisa datang dari file cadangan dan dari perangkat lain.
// Isian awal untuk yang sapaannya belum pernah diisi: kata paling depan dari
// namanya. Nama di data ini selalu diawali panggilannya — "Ibu Siti Rahma",
// "Ci Mei Lin" — jadi kata pertamanya hampir selalu kata yang memang dipakai
// menyapa orangnya. Ini cuma isian awal: kotaknya terbuka dan bisa dipanjangkan
// jadi "Ibu Siti" sebelum disimpan.
const sapaanBawaan = (nama) => String(nama || '').trim().split(/\s+/)[0] || '';

const sapaanCustomer = (customerId) => {
  const c = customers.find((x) => x.id === customerId);
  return (c && c.sapaan ? c.sapaan.trim() : '');
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

// Perkiraan lama pengerjaan tiap kombinasi, dalam menit. Kuncinya kode yang
// sudah dirapikan lalu disambung '+', jadi urutannya selalu sama dengan URUT_T.
// Angkanya bukan hasil hitungan — ini perkiraan dari yang mengerjakan, dan
// memang di sinilah tempatnya diubah kalau ternyata meleset.
const DURASI_TREAT = {
  'rambut': 30,
  'exo': 30,
  'muka': 40,
  'rambut+exo': 60,
  'rambut+muka': 60,
  'exo+muka': 60,
  'rambut+exo+muka': 70,
};
// Jadwal yang jenisnya belum diisi dianggap rambut — jenis yang paling sering
// dan yang sudah tercentang duluan di form (TREAT_BAWAAN).
const DURASI_BAWAAN = 30;
const durasiJadwal = (a) => {
  const t = rapikanTreatment(a && a.treatments);
  return (t.length && DURASI_TREAT[t.join('+')]) || DURASI_BAWAAN;
};

// Jendela jam kerja yang dicari slotnya. Slot harus muat seluruhnya di dalam
// jendela ini — treatment yang baru selesai lewat jam tutup tidak dihitung muat.
// Ini cuma bawaannya: jam yang benar-benar dipakai datang dari setelan cabang,
// satu pasang untuk tiap hari dalam seminggu (lihat jamHari di bawah).
const JAM_BUKA_BAWAAN = '10:00';
const JAM_TUTUP_BAWAAN = '17:00';
const JAM_BAWAAN = { buka: JAM_BUKA_BAWAAN, tutup: JAM_TUTUP_BAWAAN };
const PEGAWAI_BAWAAN = 2;
// Batas hari yang dihitung sekali jalan. Filter "Semua" bisa menjangkau ratusan
// hari, dan daftar sepanjang itu tidak ada yang membacanya.
const MAKS_HARI_SLOT = 31;
// Kisi jam mulai yang ditawarkan. Yang ditanyakan customer bukan "rentangnya
// dari jam berapa sampai jam berapa", melainkan "bisanya jam berapa saja" — dan
// jawaban itu selalu jam bulat atau setengahan, bukan 10:07. Kisinya dihitung
// dari tengah malam, bukan dari jam buka: cabang yang buka 10:30 tetap
// menawarkan 10:30, 11:00, 11:30 — bukan 10:30, 11:00 yang bergeser sendiri.
const KISI_SLOT = 30;

// Bentuk daftar jam waktu dikirim sebagai teks — salinan Slot Kosong maupun
// pesan reminder. Satu pasang angka untuk keduanya, bukan sendiri-sendiri: dua
// daftar yang isinya sama persis tapi bentuknya beda cuma membuat yang
// membacanya bertanya-tanya apa bedanya.
//
// Empat sebaris karena hari yang lowong sejak pagi punya belasan jam mulai, dan
// belasan baris per hari membuat pesannya berubah jadi dinding jam.
const JAM_SEBARIS = 4;
// Pemisahnya koma, dipilih karena paling gampang dibaca — deretan jam yang
// dipisah titik tengah terbaca seperti satu blok, sedangkan koma memberi tiap
// jam ujungnya sendiri.
//
// Ongkos URL-nya kebetulan yang paling murah juga, dan itu perlu diingat kalau
// bentuk ini nanti diubah: pesan reminder berangkat lewat wa.me, dan di situ
// ', ' jadi 6 karakter URL sementara ' · ' jadi 12. Selisihnya di seminggu penuh
// sekitar 420 karakter — dulu itu cukup untuk membuat hari terjauh dipotong,
// sebelum BATAS_URL di bawah dinaikkan.
const PISAH_JAM = ', ';

const keMenit = (jam) => (+jam.slice(0, 2)) * 60 + (+jam.slice(3, 5));
// Jam sekarang, dibulatkan ke atas ke kelipatan 15 menit. Slot yang dimulai
// "14:07" terbaca seperti salah hitung; 14:15 itu jam yang memang orang pakai
// waktu membuat janji.
const menitSekarang = () => {
  const d = new Date();
  return Math.ceil((d.getHours() * 60 + d.getMinutes()) / 15) * 15;
};
const keJam = (m) => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
const labelDurasi = (m) => {
  const j = Math.floor(m / 60), sisa = m % 60;
  if (!j) return sisa + ' menit';
  return j + ' jam' + (sisa ? ' ' + sisa + ' menit' : '');
};

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

// Berapa treatment yang sudah ditandai selesai bulan itu, dipecah per pegawai.
// Yang belum ditandai selesai sama sekali tidak ikut: pertanyaannya "siapa
// mengerjakan berapa", dan jadwal yang belum dikerjakan belum punya jawabannya.
//
// Pegawai sekarang wajib diisi waktu menandai selesai, tapi data lama — dan
// yang namanya dihapus dari daftar — masih bisa kosong. Yang seperti itu tetap
// dihitung, sebagai barisnya sendiri paling bawah: kalau dibuang, jumlah
// seluruh baris tidak lagi sama dengan jumlah yang selesai, dan angka yang
// tidak menjumlah membuat orang mencari-cari selisihnya.
function ringkasPegawai(rows) {
  const selesai = rows.filter((a) => a.done === true);
  const peta = new Map();
  selesai.forEach((a) => {
    const nama = (a.staff || '').trim();
    peta.set(nama, (peta.get(nama) || 0) + 1);
  });
  const daftar = [...peta.entries()]
    .map(([nama, n]) => ({ nama, n }))
    .sort((a, b) => Number(!a.nama) - Number(!b.nama) || b.n - a.n
      || a.nama.localeCompare(b.nama, 'id'));
  return { selesai: selesai.length, daftar };
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
// `opsi.hint` menggantikan keterangan bawaan, `opsi.onUbah` dipanggil tiap kali
// pilihannya berubah karena ditekan. Keduanya opsional: dua pemakai lama —
// form isi dan sheet ubah — tidak melewatkan apa pun dan tetap seperti semula.
function pasangTreatSeg(segId, hintId, opsi = {}) {
  const seg = $(segId), hint = $(hintId);
  let pilih = new Set();

  function gambar() {
    [...seg.children].forEach((b) => {
      const aktif = pilih.has(b.dataset.t);
      b.classList.toggle('aktif', aktif);
      b.setAttribute('aria-pressed', aktif ? 'true' : 'false');
    });
    if (opsi.hint) { hint.textContent = opsi.hint(rapikanTreatment([...pilih])); return; }
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
    if (opsi.onUbah) opsi.onUbah(rapikanTreatment([...pilih]));
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
    //
    // Jawaban "baru" sengaja tidak ditulis sebagai false: orang yang memang
    // baru hari ini harus berhenti terbaca baru begitu ia datang lagi. Yang
    // ditulis false cuma koreksi manual dari bukaUbahStatus() — di situ
    // operator memang sedang membantah jumlah kunjungannya.
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
  simpanBulan(new Set([kunciDari(date)]));

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
// Sheet yang sama juga dipakai untuk memperbaiki status customer yang sudah
// terdaftar: tombol di sheet konfirmasi sering tertekan buru-buru, dan sebelum
// ini jawaban yang telanjur salah tidak ada jalan mundurnya sama sekali —
// yang telanjur "lama" tidak pernah bisa dicabut, dan yang telanjur "baru"
// harus ditunggu sampai kunjungan keduanya. Wordingnya cuma ada di satu tempat
// supaya pertanyaannya tidak pernah berbunyi beda di dua layar.
let pendingStatus = null; // id customer yang statusnya sedang diubah

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
  pendingStatus = null;
  $('newCustJudul').textContent = 'Nama ini belum ada di sistem';
  $('newCustName').textContent = nama;
  $('newCustSub').textContent = 'Benar-benar customer baru, atau sebenarnya '
    + 'sudah lama datang tapi belum pernah dicatat di sini?';
  $('newCustBaru').textContent = 'Customer baru';
  $('newCustLama').textContent = 'Customer lama, baru dicatat';

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

// Status customer yang sudah terdaftar. Pertanyaannya sama, yang beda cuma
// tidak ada jadwal yang menunggu jawaban — dan daftar "nama mirip" tidak ada
// gunanya di sini: orangnya sudah jelas siapa.
function bukaUbahStatus(id) {
  const c = customers.find((x) => x.id === id);
  if (!c) return;
  pendingJadwal = null;
  pendingStatus = id;
  const n = visitCount(id);
  const lama = sudahLamaDatang(id, n);
  $('newCustJudul').textContent = 'Status customer';
  $('newCustName').textContent = c.name;
  $('newCustSub').textContent = (n
    ? n + 'x kunjungan tercatat di sini. '
    : 'Belum ada kunjungan tercatat di sini. ')
    + 'Benar-benar customer baru, atau sudah lama datang sebelum masuk sistem?';
  // Yang sedang berlaku diberi tanda: tanpa itu sheet ini terbaca seperti
  // pertanyaan yang belum pernah dijawab, dan operator tidak tahu apa yang
  // sebenarnya sedang ia ubah.
  $('newCustBaru').textContent = 'Customer baru' + (lama ? '' : ' (sekarang)');
  $('newCustLama').textContent = 'Customer lama' + (lama ? ' (sekarang)' : '');
  $('newCustMirip').hidden = true;
  $('newCustMiripList').innerHTML = '';
  $('newCustSheet').hidden = false;
}

function tutupKonfirmasiBaru() {
  pendingJadwal = null;
  pendingStatus = null;
  $('newCustSheet').hidden = true;
}

// Jawabannya ditulis apa adanya — termasuk `false` untuk "baru". Menghapus
// penandanya tidak cukup: tanpa penanda, orang yang sudah memesan dua sesi
// sekaligus langsung terbaca customer lama lagi, persis yang mau dikoreksi.
function simpanStatus(id, status) {
  const c = customers.find((x) => x.id === id);
  tutupKonfirmasiBaru();
  if (!c) return;
  const lama = status === 'lama';
  if (c.sudahLama === lama) return; // jawabannya sama, tidak ada yang perlu ditulis
  if (!bolehUbah()) return;
  c.sudahLama = lama;
  save(KEY_CUSTOMERS, customers);
  renderList();
  toast(c.name + (lama
    ? ' dicatat sebagai customer lama.'
    : ' dicatat sebagai customer baru.'));
}

function jawabKonfirmasi(status) {
  if (pendingStatus) { simpanStatus(pendingStatus, status); return; }
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
  // Kotak nomor dan kotak sapaan berdiri di atas sheet reminder. Tanpa berhenti
  // di sini, satu ketukan Esc menutup dua-duanya sekaligus dan daftarnya ikut
  // hilang. Sapaan diperiksa lebih dulu: ia yang muncul belakangan dalam alur
  // kirim, jadi ia juga yang paling atas kalau dua-duanya sempat terbuka.
  if (!$('sapaanSheet').hidden) { tutupSapaan(); return; }
  if (!$('hpSheet').hidden) { tutupHp(); return; }
  if (!$('editSheet').hidden) closeEdit();
  if (!$('selesaiSheet').hidden) tutupSelesai();
  if (!$('newCustSheet').hidden) tutupKonfirmasiBaru();
  if (!$('cabangSheet').hidden) closeCabangSheet();
  if (!$('slotSheet').hidden) tutupSlot();
  if (!$('reminderSheet').hidden) tutupReminder();
  // Paling belakang: mode pilih bukan lapisan di atas layar, jadi ia baru
  // dimatikan kalau memang tidak ada kotak apa pun yang sedang terbuka.
  else if (modePilih) setModePilih(false);
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

  // Tanggal baru bisa jatuh di bulan lain: dokumen bulan asalnya harus ikut
  // ditulis ulang, kalau tidak barisnya tertinggal di sana dan jadwalnya jadi
  // terbaca dua kali — sekali di bulan lama, sekali di bulan baru.
  const bulanTersentuh = new Set([kunciDari(a.date), kunciDari(date)]);
  a.date = date;
  a.time = time;
  const jenis = treatEdit.get();
  if (jenis.length) a.treatments = jenis; else delete a.treatments;
  simpanBulan(bulanTersentuh);
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
// Tandai selesai + pegawai yang menangani
// ------------------------------------------------------------
// Dipasang lagi memakai field lama yang memang tidak pernah dihapus: `done`
// dan `staff` di tiap jadwal, dan daftar nama di dokumen staff. Data yang
// terlanjur tercatat dulu langsung terbaca lagi tanpa perlu diisi ulang.
//
// Foto hasil treatment tetap tidak dipasang — yang diminta cuma penanda selesai
// dan pegawainya. Pembersih foto di atas tetap jalan untuk data lama.
//
// Keduanya satu keputusan ("sudah dikerjakan, oleh siapa"), jadi satu kotak.
// Centang di baris jadwal cuma pintunya; yang menyimpan tombol di kotak ini.
//
// Pegawainya wajib diisi: setengah jawaban ("sudah dikerjakan, entah oleh
// siapa") tidak bisa dilengkapi belakangan — beberapa hari kemudian tidak ada
// lagi yang ingat, dan rekap per pegawai di analitik ikut kehilangan angkanya.
// Yang dicabut tidak menanyakan apa-apa, jadi tidak ikut aturan ini.
// ============================================================
let selesaiId = null;     // id jadwal yang sedang dibuka, kalau cuma satu
let selesaiBanyak = null; // array id, kalau yang dibuka hasil pilih beberapa
let selesaiPeg = null;    // nama pegawai yang sedang terpilih, null = belum ada

// Mode pilih beberapa. Menandai selesai satu per satu berarti membuka kotak
// yang sama berulang-ulang padahal jawabannya sama — satu pegawai biasanya
// mengerjakan beberapa orang di hari yang sama. Di mode ini centangnya
// mengumpulkan dulu, dan pegawainya ditanyakan sekali di ujung.
let modePilih = false;
const dipilih = new Set();

function setModePilih(nyala) {
  modePilih = nyala;
  dipilih.clear();
  perbaruiPilihBar();
  renderList();
}

function togglePilih(id) {
  if (dipilih.has(id)) dipilih.delete(id); else dipilih.add(id);
  perbaruiPilihBar();
  renderList();
}

function perbaruiPilihBar() {
  const n = dipilih.size;
  $('pilihMulai').hidden = modePilih;
  $('pilihAksi').hidden = !modePilih;
  $('pilihJml').hidden = !modePilih;
  $('pilihJml').textContent = n ? n + ' dipilih' : 'Ketuk centangnya';
  $('pilihJml').classList.toggle('kosong', !n);
  // Tombolnya tetap terlihat walau belum ada yang dipilih — tombol yang hilang
  // timbul tiap kali centang ditekan membuat barisnya bergoyang sendiri.
  $('pilihSelesai').disabled = !n;
  // Mencabut cuma masuk akal kalau ada yang memang sudah ditandai. Tombolnya
  // tetap terlihat walau mati, supaya letak tombol di sebelahnya tidak berpindah
  // tiap kali pilihannya berubah.
  $('pilihCabut').disabled = !adaSelesaiDipilih();
}

const adaSelesaiDipilih = () =>
  [...dipilih].some((id) => {
    const a = appointments.find((x) => x.id === id);
    return a && a.done === true;
  });

$('pilihMulai').addEventListener('click', () => setModePilih(true));
$('pilihKeluar').addEventListener('click', () => setModePilih(false));
$('pilihSelesai').addEventListener('click', () => {
  if (dipilih.size) bukaSelesaiBanyak([...dipilih]);
});
// Mencabut tidak lewat kotak pegawai sama sekali: yang dicabut justru catatan
// pegawainya, jadi tidak ada yang perlu ditanyakan. Sekali tekan, langsung
// dikerjakan — sama seperti mencabut tanda "sudah diingatkan" di daftar
// reminder, dan sama-sama bisa dipasang lagi kalau ternyata salah tekan.
$('pilihCabut').addEventListener('click', () => {
  if (!dipilih.size) return;
  selesaiId = null;
  selesaiBanyak = [...dipilih];
  selesaiPeg = null;
  simpanSelesai(false);
});

// Beberapa jadwal sekaligus. Pertanyaannya sama persis, jadi kotaknya juga
// sama — yang berbeda cuma yang tertulis di kepalanya dan berapa jadwal yang
// nanti ikut tersentuh waktu disimpan.
function bukaSelesaiBanyak(ids) {
  const rows = ids.map((id) => appointments.find((a) => a.id === id)).filter(Boolean);
  if (!rows.length) return;
  selesaiId = null;
  selesaiBanyak = rows.map((a) => a.id);
  // Pegawai yang sudah sama di seluruh pilihan langsung ikut terpilih; kalau
  // campur, tidak ada yang dipilihkan — menebak salah satunya berarti diam-diam
  // menimpa yang lain waktu disimpan.
  const pegSama = rows.every((a) => (a.staff || '') === (rows[0].staff || ''))
    ? (rows[0].staff || '') : '';
  selesaiPeg = pegSama || null;
  $('selesaiNama').textContent = rows.length + ' treatment dipilih';
  // Namanya disebut sampai tiga, sisanya dihitung — daftar dua puluh nama di
  // kepala kotak justru tidak terbaca lagi.
  const nama = [...new Set(rows.map((a) => nameOf(a.customerId)))];
  $('selesaiWaktu').textContent = nama.slice(0, 3).join(', ')
    + (nama.length > 3 ? ', dan ' + (nama.length - 3) + ' lainnya' : '');
  $('selesaiBatalkan').hidden = !rows.some((a) => a.done);
  $('selesaiSimpan').textContent = 'Tandai selesai';
  $('selesaiPegBaru').value = '';
  renderPilihPegawai();
  $('selesaiSheet').hidden = false;
}

function bukaSelesai(apptId) {
  const a = appointments.find((x) => x.id === apptId);
  if (!a) return;
  selesaiId = apptId;
  selesaiBanyak = null;
  selesaiPeg = a.staff || null;
  $('selesaiNama').textContent = nameOf(a.customerId);
  const jenis = rapikanTreatment(a.treatments);
  $('selesaiWaktu').textContent = hariBulan(a.date) + ' · ' + a.time
    + (jenis.length ? ' · ' + namaKombinasi(jenis) : '');
  // Yang sudah selesai dibuka untuk mengganti pegawainya, bukan untuk
  // menandainya lagi — tulisan tombolnya ikut menyesuaikan supaya tidak
  // terbaca seperti pekerjaan yang belum dilakukan.
  $('selesaiBatalkan').hidden = !a.done;
  $('selesaiSimpan').textContent = a.done ? 'Simpan' : 'Tandai selesai';
  $('selesaiPegBaru').value = '';
  renderPilihPegawai();
  $('selesaiSheet').hidden = false;
}

// Tombol simpannya mati selama belum ada pegawai yang terpilih. Dimatikan,
// bukan disembunyikan: tombol yang timbul-hilang tiap kali nama ditekan
// membuat kotaknya bergoyang sendiri. Yang mencabut tidak ikut dimatikan.
function perbaruiSimpanSelesai() {
  $('selesaiSimpan').disabled = !selesaiPeg;
}

function renderPilihPegawai() {
  const box = $('selesaiPeg');
  box.innerHTML = '';
  perbaruiSimpanSelesai();
  const daftar = staff.slice();
  // Pegawai yang sudah tidak ada di daftar tapi masih tercatat di jadwal ini
  // tetap ikut muncul — kalau tidak, pilihan yang sudah tersimpan terbaca
  // hilang begitu kotaknya dibuka, dan menyimpan lagi diam-diam menghapusnya.
  if (selesaiPeg && !daftar.some((n) => n.toLowerCase() === selesaiPeg.toLowerCase())) {
    daftar.push(selesaiPeg);
  }
  if (!daftar.length) {
    const p = document.createElement('p');
    p.className = 'peg-kosong';
    p.textContent = 'Belum ada nama pegawai di cabang ini — tambahkan di bawah.';
    box.appendChild(p);
    return;
  }
  daftar.forEach((nama) => {
    const aktif = selesaiPeg === nama;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'peg-btn' + (aktif ? ' aktif' : '');
    b.setAttribute('aria-pressed', aktif ? 'true' : 'false');
    b.textContent = nama;
    // Ditekan lagi berarti batal memilih: satu-satunya jalan mencabut pegawai
    // dari jadwal yang pegawainya terlanjur salah isi.
    b.onclick = () => { selesaiPeg = aktif ? null : nama; renderPilihPegawai(); };
    box.appendChild(b);
  });
}

// Nama baru langsung ikut terpilih: yang mengetiknya sedang menjawab "siapa
// yang menangani", bukan sedang mengurus daftar pegawai.
function tambahPegawai() {
  const nama = $('selesaiPegBaru').value.trim().replace(/\s+/g, ' ');
  if (!nama) { $('selesaiPegBaru').focus(); return; }
  if (!bolehUbah()) return;
  addStaff(nama);
  selesaiPeg = staff.find((n) => n.toLowerCase() === nama.toLowerCase()) || nama;
  $('selesaiPegBaru').value = '';
  renderPilihPegawai();
}

function tutupSelesai() {
  $('selesaiSheet').hidden = true;
  selesaiId = null;
  selesaiBanyak = null;
  selesaiPeg = null;
}

function simpanSelesai(selesai) {
  const ids = selesaiBanyak || (selesaiId ? [selesaiId] : []);
  const rows = ids.map((id) => appointments.find((a) => a.id === id)).filter(Boolean);
  // Semuanya bisa saja sudah dihapus perangkat lain selagi kotak ini terbuka.
  if (!rows.length) { tutupSelesai(); return; }
  if (!bolehUbah()) return;
  const peg = selesaiPeg;
  // Tombolnya sudah mati kalau pegawainya belum dipilih; ini penjaga terakhir
  // supaya jalan lain ke sini tidak menyelipkan tanda selesai tanpa nama.
  if (selesai && !peg) {
    toast('Pilih dulu pegawai yang menangani.', true);
    return;
  }
  // Tanggalnya bisa jatuh di bulan yang berbeda-beda — tiap bulan yang tersentuh
  // harus ikut ditulis ulang, kalau tidak sebagian perubahannya tidak tersimpan.
  const bulan = new Set();
  // Yang benar-benar berubah dihitung sendiri: waktu mencabut, pilihan biasanya
  // bercampur dengan jadwal yang memang belum pernah ditandai, dan menyebut
  // seluruh jumlah pilihan membuat kalimatnya berbohong.
  let ubah = 0;
  let namaUbah = '';
  rows.forEach((a) => {
    if (selesai) {
      a.done = true;
      if (peg) a.staff = peg; else delete a.staff;
    } else {
      if (a.done !== true) return;
      // Dibatalkan berarti treatment-nya belum dikerjakan, dan catatan siapa
      // yang mengerjakan ikut kehilangan artinya.
      delete a.done;
      delete a.staff;
    }
    if (!ubah) namaUbah = nameOf(a.customerId);
    ubah++;
    bulan.add(kunciDari(a.date));
  });
  // Tidak ada satu pun yang perlu dicabut: tidak ada yang ditulis ke server,
  // dan tidak ada kabar palsu bahwa sesuatu sudah dikerjakan.
  if (!ubah) {
    tutupSelesai();
    toast('Tidak ada yang bertanda selesai di pilihan ini.', true);
    return;
  }
  simpanBulan(bulan);
  tutupSelesai();
  // Pilihannya sudah dikerjakan, jadi modenya ikut selesai — membiarkannya
  // menyala dengan centang yang masih tertinggal cuma menunggu salah tekan.
  if (modePilih) setModePilih(false); else renderList();
  const sebut = ubah > 1 ? ubah + ' treatment' : 'Treatment ' + namaUbah;
  toast(selesai
    ? sebut + ' ditandai selesai' + (peg ? ' — dikerjakan ' + peg + '.' : '.')
    : 'Tanda selesai pada ' + (ubah > 1 ? sebut : namaUbah) + ' dicabut.');
}

$('selesaiSimpan').addEventListener('click', () => simpanSelesai(true));
$('selesaiBatalkan').addEventListener('click', () => simpanSelesai(false));
$('selesaiTutup').addEventListener('click', tutupSelesai);
$('selesaiPegTambah').addEventListener('click', tambahPegawai);
$('selesaiPegBaru').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); tambahPegawai(); }
});
$('selesaiSheet').addEventListener('click', (e) => {
  if (e.target === $('selesaiSheet')) tutupSelesai();
});

// ============================================================
// Daftar jadwal (render)
// ============================================================
function renderList() {
  const list = $('list');
  list.innerHTML = '';
  list.classList.toggle('mode-pilih', modePilih);
  const rows = filteredRows();
  // Jadwal yang sudah dihapus — di sini atau di perangkat lain — tidak boleh
  // tertinggal di dalam pilihan: hitungannya jadi menyebut baris yang tidak
  // ada, dan tombol "Kosongkan" tidak pernah terbaca penuh.
  if (modePilih && dipilih.size) {
    const ada = new Set(appointments.map((a) => a.id));
    let hilang = false;
    dipilih.forEach((id) => { if (!ada.has(id)) { dipilih.delete(id); hilang = true; } });
    if (hilang) perbaruiPilihBar();
  }
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
      // "Pilih semua" duduk di judul hari, bukan di baris tombol atas: dengan
      // begitu cakupannya tidak perlu dijelaskan — yang tersapu jelas jadwal
      // yang ada di bawah judul itu saja. Satu tombol untuk seluruh daftar
      // terlalu jauh akibatnya kalau daftarnya sedang menampilkan sebulan.
      if (modePilih) {
        const idHari = rows.filter((x) => x.date === r.date).map((x) => x.id);
        const penuh = idHari.every((id) => dipilih.has(id));
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'hari-pilih';
        b.textContent = penuh ? 'Kosongkan' : 'Pilih semua';
        b.title = (penuh ? 'Kosongkan pilihan ' : 'Pilih semua jadwal ') + hariBulan(r.date);
        b.onclick = () => {
          idHari.forEach((id) => { if (penuh) dipilih.delete(id); else dipilih.add(id); });
          perbaruiPilihBar();
          renderList();
        };
        h.appendChild(b);
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
      '<div class="who"><div class="n"><button type="button" class="nama"></button></div>' +
        '<div class="tanda"></div></div>' +
      '<button type="button" class="cek">' + ikon('cek') + '</button>' +
      '<button class="edit" title="Ubah jadwal">Ubah</button>' +
      '<button class="del" title="Hapus jadwal">Hapus</button>';
    el.appendChild(main);
    // Centang selesai. Tetap tampil di layar sempit — tombol Ubah dan Hapus di
    // sebelahnya yang disembunyikan, karena keduanya punya gestur pengganti;
    // menandai selesai tidak punya.
    const cekEl = el.querySelector('.cek');
    // Di mode pilih, centangnya berhenti menunjukkan "sudah selesai" dan
    // berganti menunjukkan "sedang dipilih". Keadaan selesai tidak ikut hilang
    // dari layar: barisnya tetap redup dan nama pegawainya tetap tertulis.
    const tandai = modePilih ? dipilih.has(r.id) : !!r.done;
    cekEl.classList.toggle('sudah', tandai);
    cekEl.setAttribute('aria-pressed', tandai ? 'true' : 'false');
    cekEl.title = modePilih
      ? (tandai ? 'Batal pilih' : 'Pilih jadwal ini' + (r.done ? ' (sudah selesai)' : ''))
      : r.done
        ? 'Selesai' + (r.staff ? ' — dikerjakan ' + r.staff : '') + '. Ketuk untuk mengubah.'
        : 'Tandai treatment selesai';
    cekEl.onclick = (e) => {
      // Ketukan di centang tidak boleh ikut terbaca sebagai ketukan di baris —
      // di mode pilih keduanya menyalakan hal yang sama dan pilihannya batal
      // lagi seketika.
      e.stopPropagation();
      if (modePilih) togglePilih(r.id); else bukaSelesai(r.id);
    };
    el.classList.toggle('selesai', !!r.done);
    el.classList.toggle('dipilih', modePilih && dipilih.has(r.id));
    el.querySelector('.edit').onclick = () => openEdit(r.id);
    el.querySelector('.del').onclick = () => confirmDelete(r);
    // Di mode pilih, seluruh barisnya jadi sasaran ketuk — mengharuskan
    // lingkaran kecil yang tepat sasaran padahal yang sedang dikerjakan
    // belasan baris cuma memperlambat. Gesturnya tidak dipasang: geser kiri
    // yang tidak sengaja saat memilih akan menghapus jadwal.
    if (modePilih) main.onclick = () => togglePilih(r.id);
    else attachRowGestures(main, r);
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
    // Tanda-tandanya turun ke barisnya sendiri di bawah nama, tidak lagi
    // berjejer di belakangnya: pada baris yang lengkap — treatment, pegawai,
    // dan "Baru" sekaligus — nama panjang tinggal tersisa beberapa huruf
    // sebelum terpotong. Dipisah begini namanya selalu utuh, dan tanda-tanda
    // itu terbaca sebagai keterangan jadwalnya, bukan bagian dari namanya.
    const tandaEl = el.querySelector('.tanda');
    // Bentuk tandanya sama persis dengan yang nanti keluar di salinan WA
    const tandaT = tandaTreatment(r.treatments);
    if (tandaT) {
      const chip = document.createElement('span');
      chip.className = 'tanda-treat';
      chip.textContent = tandaT;
      chip.title = 'Jenis treatment: ' + namaKombinasi(rapikanTreatment(r.treatments));
      tandaEl.appendChild(chip);
    }
    // Pegawai yang menangani, cuma pada yang sudah ditandai selesai. Ditulis di
    // barisnya, bukan di dalam centang: yang dicari waktu daftar ini dipindai
    // adalah "siapa mengerjakan siapa", dan itu terbaca sekali lihat kalau
    // dua-duanya masih dalam satu baris jadwal.
    if (r.done && r.staff) {
      const peg = document.createElement('span');
      peg.className = 'tanda-peg';
      peg.textContent = r.staff;
      peg.title = 'Dikerjakan ' + r.staff;
      tandaEl.appendChild(peg);
    }
    // Cuma customer baru yang diberi tanda. Keterangan "customer lama · Nx
    // <bulan>" yang dulu duduk di sini sudah tidak ada — kalimat sepanjang itu
    // di tiap baris memperlambat pemindaian, dan jumlah kunjungannya justru
    // lebih lengkap terbaca di riwayat, sejauh tap namanya.
    // Tandanya sekaligus jadi jalan mencabutnya: kalau yang terbaca salah,
    // yang salah itu justru yang sedang dilihat. <button>, bukan <span> —
    // attachRowGestures melewati apa pun yang berupa tombol, jadi menekannya
    // tidak ikut membuka sheet ubah jadwal.
    if (!sudahLamaDatang(r.customerId, totalVisits)) {
      const tanda = document.createElement('button');
      tanda.type = 'button';
      tanda.className = 'tanda-baru';
      tanda.textContent = 'Baru';
      tanda.title = 'Customer baru — ketuk untuk mengubah statusnya';
      tanda.onclick = () => bukaUbahStatus(r.customerId);
      tandaEl.appendChild(tanda);
    }
    list.appendChild(el);
  });
  jadwalkanAnalitik();
}

// Status lama/baru sebagai tombol, sebentuk dengan tombol nomor di sebelahnya:
// keterangan yang baru ketahuan bisa diketuk waktu disentuh. Di layar riwayat
// inilah satu-satunya tempat status customer lama bisa dicabut — di daftar
// jadwal yang bisa diketuk cuma tanda "Baru", dan customer lama tidak punya.
function tombolStatus(id, sendiri) {
  const lama = sudahLamaDatang(id);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hp-ubah' + (sendiri ? ' sendiri' : '');
  b.textContent = lama ? 'customer lama' : 'customer baru';
  b.title = 'Ubah status ' + nameOf(id);
  b.onclick = () => bukaUbahStatus(id);
  return b;
}

// Sapaan customer, sebentuk dengan tombol status dan nomor di sebelahnya. Di
// alur kirim sapaannya sudah ditanyakan sendiri, jadi tombol ini gunanya untuk
// yang sudah terlanjur tersimpan salah — dan layar riwayat ini tempat yang
// wajar untuknya: ia memang dibuka waktu yang dicari satu orang tertentu.
function tombolSapaan(id) {
  const sapaan = sapaanCustomer(id);
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hp-ubah' + (sapaan ? '' : ' kosong');
  b.textContent = sapaan ? 'sapaan "' + sapaan + '"' : 'sapaan belum diisi';
  b.title = (sapaan ? 'Ubah sapaan ' : 'Isi sapaan ') + nameOf(id)
    + ' — dipakai di pembuka pesan WhatsApp';
  b.onclick = () => bukaSapaan({ id, nama: nameOf(id) }, null);
  return b;
}

// Nomor customer sebagai tombol: menampilkan nomornya sekaligus jadi jalan
// mengubahnya. Sheet isiannya sama persis dengan yang dipakai daftar reminder,
// jadi aturan nomor sah dan cara menyimpannya cuma tertulis di satu tempat.
function tombolNomor(id, sendiri) {
  const c = customers.find((x) => x.id === id);
  const nomor = c && c.phone ? nomorLokal(c.phone) : '';
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'hp-ubah' + (nomor ? '' : ' kosong') + (sendiri ? ' sendiri' : '');
  b.textContent = nomor || 'belum ada nomor';
  b.title = (nomor ? 'Ubah nomor ' : 'Isi nomor ') + nameOf(id) + ' — sekalian sapaannya';
  b.onclick = () => bukaHp({ id, nama: nameOf(id) }, false);
  return b;
}

// Total jadwal yang sedang tampil — supaya jumlahnya tidak perlu dihitung sendiri
function setRingkasList(rows) {
  const box = $('listTotal');
  box.textContent = '';
  // Mode riwayat menanyakan hal lain: bukan berapa jadwal hari itu, tapi sudah
  // berapa kali orangnya datang dan sejak kapan. rows sudah urut tanggal.
  if (filterMode === 'cust' && custCari) {
    if (rows.length) {
      const awal = rows[0].date, akhir = rows[rows.length - 1].date;
      box.textContent = rows.length + 'x kunjungan · ' + (awal === akhir
        ? tglSingkat(awal)
        : 'pertama ' + tglSingkat(awal) + ' · terakhir ' + tglSingkat(akhir));
    }
    // Jalan kedua ke nomor customer. Sebelum ini nomornya cuma bisa disunting
    // dari sheet Reminder, dan sheet itu isinya cuma yang terakhir datang
    // REM_MULAI-REM_SAMPAI hari lalu — jadi nomor orang yang baru kemarin
    // datang tidak bisa dikoreksi sampai namanya kebetulan masuk daftar itu.
    // Di sini tempatnya justru wajar: layar ini memang dibuka ketika yang
    // dicari satu orang tertentu. Ikut muncul walau kunjungannya belum ada satu
    // pun — customer yang baru dicatat yang paling sering perlu diisikan nomor.
    box.appendChild(tombolStatus(custCari, !rows.length));
    box.appendChild(tombolNomor(custCari, false));
    box.appendChild(tombolSapaan(custCari));
    return;
  }
  if (!rows.length) return;
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
  simpanBulan(new Set([kunciDari(r.date)]));
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
  rows.forEach((r) => {
    if (r.date !== lastDate) {
      lines.push('', '📅 *' + hariBulan(r.date) + '*');
      lastDate = r.date;
      n = 0;
    }
    n++;
    const baru = !sudahLamaDatang(r.customerId);
    // Rambut tidak ditulis — itu dasarnya. Yang muncul cuma tambahannya
    // ("Tama (+Exo & Muka)") atau justru ketiadaan rambutnya ("Tama (Muka Only)").
    const tandaT = tandaTreatment(r.treatments);
    lines.push(n + '. ' + r.time + ' — ' + nameOf(r.customerId)
      + (tandaT ? ' (' + tandaT + ')' : '') + (baru ? ' 🆕' : ''));
  });

  // Tidak ada penutup apa pun: tidak ada baris jumlah, tidak ada rekap jenis
  // treatment. Yang dikirim ke WA cuma daftar jadwalnya — jumlahnya sudah
  // terbaca dari nomor urut terakhir, dan rekapnya tetap ada di layar aplikasi
  // buat yang memang perlu.
  return lines.join('\n');
}

// Dipakai dua tombol salin: daftar jadwal dan daftar slot kosong.
async function salinTeks(text) {
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
}

$('waBtn').addEventListener('click', async () => {
  const text = buildWhatsAppText();
  if (!text) { toast('Belum ada jadwal untuk disalin.', true); return; }
  await salinTeks(text);
  toast('Jadwal tersalin — tinggal paste di WhatsApp.');
});

// ============================================================
// Cari slot kosong
// ============================================================
// Yang dicari bukan "jam yang tidak ada jadwalnya", melainkan jam yang masih
// ada pegawai menganggur. Dua pegawai berarti dua jadwal boleh tumpang tindih;
// yang ketiga barulah membuat jamnya penuh. Karena itu tiap jadwal dihitung
// sebagai rentang [mulai, selesai) menurut perkiraan durasinya, bukan sebagai
// satu titik jam.

// Rentang menganggur di satu hari, sudah dipotong jam buka/tutup.
// Hasilnya [{a, b, min, max}] — a/b dalam menit sejak tengah malam, min/max
// jumlah pegawai yang luang di sepanjang rentang itu.
function slotKosong(rowsHari, pegawai, palingAwal = 0, jam = JAM_BAWAAN) {
  // `palingAwal` memotong jendela dari depan — dipakai untuk hari ini, supaya
  // jam yang sudah lewat tidak ditawarkan sebagai slot yang masih bisa diisi.
  const buka = Math.max(keMenit(jam.buka), palingAwal);
  const tutup = keMenit(jam.tutup);
  if (buka >= tutup) return [];
  // Jadwal yang seluruhnya di luar jam kerja tidak ikut menyita pegawai di
  // dalam jendela — tapi yang mulai sebelum buka dan baru selesai sesudahnya
  // tetap ikut, karena pegawainya memang belum bebas waktu pintu dibuka.
  const kerja = rowsHari
    .map((a) => ({ m: keMenit(a.time), s: keMenit(a.time) + durasiJadwal(a) }))
    .filter((x) => x.s > buka && x.m < tutup);

  // Batas ruas: jam buka, jam tutup, dan tiap awal/akhir jadwal di antaranya.
  // Di antara dua batas berurutan, jumlah yang sibuk pasti tetap.
  const batas = new Set([buka, tutup]);
  kerja.forEach((x) => {
    if (x.m > buka && x.m < tutup) batas.add(x.m);
    if (x.s > buka && x.s < tutup) batas.add(x.s);
  });
  const titik = [...batas].sort((p, q) => p - q);

  const hasil = [];
  for (let i = 0; i < titik.length - 1; i++) {
    const a = titik[i], b = titik[i + 1];
    const sibuk = kerja.filter((x) => x.m < b && x.s > a).length;
    const sisa = pegawai - sibuk;
    if (sisa < 1) continue;
    // Ruas bersebelahan yang sama-sama masih punya sisa disambung jadi satu
    // rentang: dua potong 30 menit yang berdempetan itu satu jam yang bisa
    // dipakai, bukan dua slot terpisah yang masing-masing cuma muat rambut.
    //
    // Ruas aslinya tetap disimpan di seg[]. Sesudah disambung, sisa pegawai di
    // tiap bagian rentang tidak bisa dibaca lagi dari min/max, padahal jam mulai
    // yang ditawarkan perlu tahu sisanya persis di sepanjang treatment itu saja.
    const akhir = hasil[hasil.length - 1];
    if (akhir && akhir.b === a) {
      akhir.b = b;
      akhir.min = Math.min(akhir.min, sisa);
      akhir.max = Math.max(akhir.max, sisa);
      akhir.seg.push({ a, b, sisa });
    } else {
      hasil.push({ a, b, min: sisa, max: sisa, seg: [{ a, b, sisa }] });
    }
  }
  return hasil;
}

// Jam mulai yang bisa ditawarkan di dalam satu rentang luang, untuk treatment
// selama `durasi`. Bukan tiap titik di rentang itu, melainkan kisi setengah jam:
// rentang 10:00–12:00 untuk rambut menghasilkan 10:00, 10:30, 11:00, 11:30 —
// yang terakhir masih selesai pas jam 12:00.
//
// Awal rentangnya sendiri selalu ikut walau tidak jatuh di kisi. Rentang yang
// mulai 10:15 karena jadwal sebelumnya baru selesai di situ tetap menawarkan
// 10:15; membulatkannya ke 10:30 membuang seperempat jam yang sebetulnya luang.
//
// Hasilnya [{m, peg}] — m menit mulai, peg jumlah pegawai yang luang di
// sepanjang treatment kalau dimulai jam itu. Yang dipakai sisa paling sedikit,
// karena rentang panjang bisa berubah sisanya di tengah.
function jamMulaiSlot(sl, durasi) {
  const out = [];
  const paling = sl.b - durasi;
  if (paling < sl.a) return out;
  const luang = (m) => Math.min(...sl.seg
    .filter((x) => x.a < m + durasi && x.b > m)
    .map((x) => x.sisa));
  out.push({ m: sl.a, peg: luang(sl.a) });
  // +1 supaya awal rentang yang kebetulan sudah jatuh di kisi tidak keluar dua kali.
  for (let m = Math.ceil((sl.a + 1) / KISI_SLOT) * KISI_SLOT; m <= paling; m += KISI_SLOT) {
    out.push({ m, peg: luang(m) });
  }
  return out;
}

// Tanggal mana saja yang sedang dicakup filter — bukan tanggal yang kebetulan
// ada jadwalnya. Hari yang kosong melompong justru yang paling perlu muncul di
// pencarian slot, dan hari seperti itu tidak pernah lahir dari filteredRows().
function tanggalFilter() {
  const deret = (mulai, akhir) => {
    const out = [];
    for (let d = mulai; d <= akhir && out.length < MAKS_HARI_SLOT; d = isoGeser(d, 1)) out.push(d);
    return out;
  };
  const adaJadwalnya = () => [...new Set(appointments.map((r) => r.date))].sort().slice(0, MAKS_HARI_SLOT);
  if (filterMode === 'today') return [today()];
  if (filterMode === 'day') return $('filterDate').value ? [$('filterDate').value] : [];
  if (filterMode === 'week') { const [a, b] = thisWeekRange(); return deret(a, b); }
  if (filterMode === 'pastweek') return deret(hariGeser(-7), today());
  if (filterMode === 'nextweek') return deret(today(), hariGeser(7));
  if (filterMode === 'date') {
    const a = $('filterStart').value, b = $('filterEnd').value;
    if (a && b) return deret(a, b);
    // Rentang yang belum diisi lengkap tidak punya ujung. Dipakai tanggal yang
    // memang ada jadwalnya, daripada melebar ke ribuan hari kosong.
    return adaJadwalnya();
  }
  return adaJadwalnya(); // 'all'
}

// Kotak angka dengan tombol − dan +. Di iPhone <input type="number"> tidak
// punya panah sama sekali, dan memanggil papan ketik angka cuma untuk mengubah
// 2 jadi 3 jauh lebih repot daripada satu ketukan. Kotaknya tetap bisa diketik
// buat yang mau langsung lompat ke 8.
function buatStepper({ id, nilai, min, max, aria, onUbah, kecil }) {
  const kotak = document.createElement('div');
  // Versi kecil dipakai di judul tiap tanggal. Ukuran penuh di sana terlalu
  // ramai — satu kotak sebesar itu berulang di tiap baris hari menenggelamkan
  // tanggalnya sendiri. Sasaran sentuhnya tetap dilebarkan lewat CSS, jadi yang
  // mengecil cuma yang terlihat.
  kotak.className = 'stepper' + (kecil ? ' kecil' : '');
  const inp = document.createElement('input');
  inp.type = 'text';
  // inputmode, bukan type=number: papan ketik angka tetap muncul di HP, tapi
  // tanpa panah kecil bawaan yang di iPhone memang tidak pernah ada dan di
  // desktop justru menempel di tombol + yang baru dipasang ini.
  inp.inputMode = 'numeric';
  inp.autocomplete = 'off';
  if (id) inp.id = id;
  inp.value = nilai;
  inp.setAttribute('aria-label', aria);
  const batas = (n) => Math.max(min, Math.min(max, n));
  // Angka sah yang terakhir dilihat kotak ini. Dipakai kalau kotaknya
  // ditinggalkan dalam keadaan kosong atau berisi yang bukan angka: keadaan itu
  // dulu jatuh ke `min`, dan itu tidak apa-apa selama min = 1 — tapi min
  // sekarang 0, yang artinya "tutup". Kotak yang tak sengaja terhapus lalu
  // ditinggal jangan sampai menutup harinya.
  let terakhir = nilai;
  const pakai = (n, dariTombol) => {
    const b = batas(n);
    terakhir = b;
    inp.value = b;
    onUbah(b, dariTombol);
  };
  const tombol = (tanda, delta, judul) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stepper-btn';
    b.textContent = tanda;
    b.title = judul;
    b.setAttribute('aria-label', judul);
    b.addEventListener('click', () => pakai(Math.round(+inp.value || min) + delta, true));
    return b;
  };
  // Diketik langsung tidak dibatasi di tiap ketukan — mengetik "12" akan
  // terpotong jadi "1" lalu ditolak kalau dipaksa membatasi per huruf.
  inp.addEventListener('input', () => {
    // Kotak kosong bukan angka nol. Tanpa pemeriksaan ini, +'' = 0 dan harinya
    // ikut tertutup di detik operator menghapus isinya untuk mengetik ulang.
    if (!inp.value.trim()) return;
    const n = Math.round(+inp.value);
    if (Number.isFinite(n) && n >= min && n <= max) { terakhir = n; onUbah(n, false); }
  });
  // Yang tidak masuk akal baru dirapikan waktu kotaknya ditinggalkan — kembali
  // ke angka sah yang terakhir, bukan ke batas bawah.
  inp.addEventListener('blur', () => {
    const n = Math.round(+inp.value);
    pakai(inp.value.trim() && Number.isFinite(n) ? n : terakhir, false);
  });
  kotak.append(tombol('−', -1, 'Kurangi'), inp, tombol('+', +1, 'Tambah'));
  return kotak;
}

// Jumlah pegawai per hari dalam seminggu — inilah acuannya sekarang, dan inilah
// satu-satunya bagian yang tersimpan ke server. Indeksnya mengikuti
// Date.getDay(), jadi 0 itu Minggu; urutan bacanya diatur HARI_URUT, bukan
// urutan indeksnya.
const HARI_URUT = [1, 2, 3, 4, 5, 6, 0];      // Senin dulu, seperti kalender
const HARI_SINGKAT = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
const HARI_PANJANG = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
const pegawaiAwal = () => HARI_SINGKAT.map(() => PEGAWAI_BAWAAN);
let pegawaiHari = pegawaiAwal();

// Penyimpangan untuk satu tanggal tertentu — Sabtu depan yang kebetulan cuma
// kebagian satu pegawai, hari kejepit yang justru ditambah. Sengaja tidak ikut
// disimpan ke server: yang begini umurnya sependek pencarian slot yang sedang
// berjalan, dan menyimpannya cuma menumpuk tanggal mati di dokumen yang ikut
// dibaca tiap kali cabangnya dibuka. Hilang begitu halaman dimuat ulang — yang
// tetap acuan mingguannya.
const pegawaiPerTgl = new Map();
const pegawaiAcuan = (tgl) => pegawaiHari[new Date(tgl + 'T00:00:00').getDay()];
const pegawaiUntuk = (tgl) => (pegawaiPerTgl.has(tgl) ? pegawaiPerTgl.get(tgl) : pegawaiAcuan(tgl));

// Nol pegawai = cabangnya tutup hari itu. Sengaja bukan penanda tersendiri:
// slotKosong() sudah menghasilkan nol slot untuk nol pegawai, jadi seluruh
// jalur yang menawarkan jam — salinan slot kosong, tawaran di pesan reminder —
// melewatinya tanpa perlu tahu apa-apa soal hari tutup. Yang membedakan cuma
// kalimat di layar: "tutup" dan "penuh" dua hal berbeda buat operator.
const hariTutup = (tgl) => pegawaiUntuk(tgl) === 0;

// Dokumen -> memori. Baris yang tidak masuk akal — hari di luar 0..6, angka di
// luar 1..20, baris kosong — dibuang diam-diam: dokumen ini bisa saja ditulis
// versi aplikasi yang lebih baru, dan satu baris aneh tidak boleh menghapus
// seluruh setelan cabang ini dari layar. Hari yang tidak disebut dokumennya
// jatuh ke PEGAWAI_BAWAAN, jadi cabang yang belum punya dokumen ini tetap jalan.
function terapkanPegawai(rows) {
  const baru = pegawaiAwal();
  rows.forEach((r) => {
    const h = Number(r && r.hari);
    const n = Math.round(Number(r && r.n));
    if (!Number.isInteger(h) || h < 0 || h > 6) return;
    if (!Number.isFinite(n) || n < 0 || n > 20) return;
    baru[h] = n;
  });
  // Snapshot yang isinya sama dengan yang sudah di layar berhenti di sini.
  // Tiap penyimpanan memantul balik sebagai snapshot — termasuk penyimpanan
  // dari perangkat ini sendiri — dan kalau pantulan itu ikut menggambar ulang,
  // kotak angka yang sedang diketik operator ikut terhapus dan kursornya lompat
  // keluar di tengah pengetikan.
  if (baru.every((n, i) => n === pegawaiHari[i])) return;
  pegawaiHari = baru;
  // Setelannya bisa berubah dari perangkat lain selagi sheet-nya terbuka di
  // sini. Yang tertutup tidak perlu digambar — bukaSlot() membangunnya ulang
  // dari angka yang sama waktu dibuka nanti.
  if (!$('slotSheet').hidden) {
    renderPegawaiHari();
    // Baris jamnya tidak dibangun ulang — cuma penandanya yang digeser, supaya
    // pemilih jam yang mungkin sedang terbuka di sini tidak ikut tertutup.
    HARI_URUT.forEach(segarkanTandaJam);
    renderSlot();
  }
}

// Memori -> dokumen. Ketujuh hari selalu ditulis lengkap, dalam urutan baca
// Senin..Minggu: dokumennya cuma tujuh baris, jadi tidak ada gunanya berhemat
// dengan menulis yang berbeda saja — dan yang lengkap jauh lebih mudah dibaca
// kalau suatu hari perlu diperiksa langsung di konsol Firestore.
function barisPegawai() {
  return HARI_URUT.map((h) => ({ hari: h, n: pegawaiHari[h] }));
}

// Angkanya berubah beberapa kali dalam sedetik — tombol +/- ditekan beruntun,
// atau angkanya diketik digit demi digit — dan tiap perubahan itu tidak perlu
// jadi satu tulisan sendiri ke server. Jedanya sekalian membuat pesan "belum
// tersambung" keluar sekali di ujung, bukan tiap ketukan.
//
// Cabangnya dikunci sejak penundaan dimulai: kalau operator pindah cabang
// sebelum jedanya habis, tulisan yang tertunda itu akan mendarat di cabang yang
// salah. Itu persis kecelakaan yang dijaga `cabangDipasang` di mulaiSyncData().
const JEDA_SIMPAN_PEGAWAI = 800;
let tundaPegawai = null;
function batalSimpanPegawai() { clearTimeout(tundaPegawai); tundaPegawai = null; }
function simpanPegawai() {
  const cab = cabangId;
  batalSimpanPegawai();
  tundaPegawai = setTimeout(() => {
    tundaPegawai = null;
    if (cabangId !== cab || !bolehUbah()) return;
    save(KEY_PEGAWAI, barisPegawai());
  }, JEDA_SIMPAN_PEGAWAI);
}

// Setelan cabang yang ditinggalkan dilepas seluruhnya — termasuk penyimpangan
// per tanggal, yang tanggalnya memang milik cabang sebelumnya — dan tulisan
// yang masih tertunda ikut dibatalkan sebelum sempat mendarat di cabang baru.
function lupakanPegawai() {
  batalSimpanPegawai();
  pegawaiHari = pegawaiAwal();
  pegawaiPerTgl.clear();
}

// ── Jam kerja tiap hari ──────────────────────────────────────────────────
// Sepasang jam buka/tutup untuk tiap hari dalam seminggu, bersebelahan dengan
// jumlah pegawai dan disimpan dengan cara yang sama persis: satu dokumen per
// cabang, ketujuh harinya ditulis lengkap. Tidak ada penyimpangan per tanggal
// seperti pegawaiPerTgl — hari yang jamnya benar-benar lain biasanya hari libur,
// dan itu sudah terwakili dengan menaruh nol pegawai di hari itu.
const jamAwal = () => HARI_SINGKAT.map(() => ({ ...JAM_BAWAAN }));
let jamHari = jamAwal();
const jamUntuk = (tgl) => jamHari[new Date(tgl + 'T00:00:00').getDay()];
// Jam yang terbalik — tutup lebih awal daripada buka — tetap disimpan apa
// adanya, bukan diam-diam ditolak: yang salah ketik perlu melihat angkanya
// masih di situ supaya tahu apa yang harus dibetulkan. Yang menanganinya
// tampilan, lewat penanda di kotaknya dan kalimatnya sendiri di daftar hari.
const jamTerbalik = (jam) => keMenit(jam.buka) >= keMenit(jam.tutup);
const JAM_POLA = /^([01]\d|2[0-3]):[0-5]\d$/;
const jamSah = (v) => typeof v === 'string' && JAM_POLA.test(v);
// Seluruh minggu memakai jam yang sama itu keadaan yang paling sering, dan
// layarnya menyebut jamnya sekali di atas kalau begitu — bukan mengulanginya di
// tiap hari.
const jamSeragam = () => jamHari.every((j) => j.buka === jamHari[0].buka && j.tutup === jamHari[0].tutup);

// Dokumen -> memori. Sama seperti terapkanPegawai(): baris yang tidak masuk akal
// dibuang diam-diam, hari yang tidak disebut jatuh ke jam bawaan, dan snapshot
// yang isinya sama persis dengan yang sudah di layar berhenti di sini supaya
// kotak jam yang sedang diketik tidak tersapu pantulan simpanannya sendiri.
function terapkanJam(rows) {
  const baru = jamAwal();
  rows.forEach((r) => {
    const h = Number(r && r.hari);
    if (!Number.isInteger(h) || h < 0 || h > 6) return;
    if (!jamSah(r.buka) || !jamSah(r.tutup)) return;
    baru[h] = { buka: r.buka, tutup: r.tutup };
  });
  if (baru.every((j, i) => j.buka === jamHari[i].buka && j.tutup === jamHari[i].tutup)) return;
  jamHari = baru;
  if (!$('slotSheet').hidden) {
    renderJamHari();
    // Kalimat di bawah judul ikut dihitung ulang: setelan yang datang dari
    // perangkat lain bisa membuat minggunya berhenti seragam, dan kalimat yang
    // tertinggal masih menyebut satu pasang jam untuk seluruh minggu.
    tandaiSubJam();
    renderSlot();
  }
}

// Memori -> dokumen. Ketujuh hari lengkap, urutan baca Senin..Minggu — persis
// alasan yang sama dengan barisPegawai().
function barisJam() {
  return HARI_URUT.map((h) => ({ hari: h, buka: jamHari[h].buka, tutup: jamHari[h].tutup }));
}

// Kotak jam berubah tiap komponen yang disentuh — jamnya dulu, menitnya
// menyusul — jadi penundaannya sama perlunya dengan di kotak pegawai, dan
// cabangnya dikunci sejak penundaan dimulai karena alasan yang sama.
const JEDA_SIMPAN_JAM = 800;
let tundaJam = null;
function batalSimpanJam() { clearTimeout(tundaJam); tundaJam = null; }
function simpanJam() {
  const cab = cabangId;
  batalSimpanJam();
  tundaJam = setTimeout(() => {
    tundaJam = null;
    if (cabangId !== cab || !bolehUbah()) return;
    save(KEY_JAM, barisJam());
  }, JEDA_SIMPAN_JAM);
}

function lupakanJam() {
  batalSimpanJam();
  jamHari = jamAwal();
}

// Tujuh baris, satu tiap hari: nama hari, jam buka, jam tutup. Kotaknya
// <input type="time"> bawaan, bukan stepper seperti pegawai — yang diubah di
// sini jam dan menit sekaligus, dan pemilih jam bawaan perangkat sudah jauh
// lebih cepat untuk itu daripada dua puluh ketukan tombol +.
function renderJamHari() {
  const box = $('slotJamBox');
  box.innerHTML = '';
  HARI_URUT.forEach((h) => {
    // Sengaja <div>, bukan <label>: aturan `.slot-atur label` di style.css
    // memaksa display:block dan akan meratakan barisnya jadi tumpukan. Kotaknya
    // sudah punya aria-label sendiri, jadi tidak ada yang hilang.
    const baris = document.createElement('div');
    baris.className = 'jam-hari';
    baris.dataset.hari = h;

    const nama = document.createElement('span');
    nama.className = 'jam-hari-nama';
    nama.textContent = HARI_SINGKAT[h];

    const buatKotak = (bagian) => {
      const inp = document.createElement('input');
      inp.type = 'time';
      inp.value = jamHari[h][bagian];
      inp.setAttribute('aria-label',
        'Jam ' + (bagian === 'buka' ? 'buka' : 'tutup') + ' hari ' + HARI_PANJANG[h]);
      inp.addEventListener('input', () => {
        // Kotak yang sedang dikosongkan di tengah pengetikan tidak boleh
        // menghapus jam yang sudah tersimpan. Yang belum lengkap dibiarkan
        // menunggu ketukan berikutnya, bukan disimpan sebagai jam kosong.
        if (!jamSah(inp.value)) return;
        jamHari[h][bagian] = inp.value;
        // Penandanya digeser di tempat: membangun ulang barisnya akan menutup
        // pemilih jam yang jarinya masih di situ.
        tandaiJamHari(baris, h);
        tandaiSubJam();
        renderSlot();
        simpanJam();
      });
      // Kotak yang ditinggalkan belum lengkap dikembalikan ke jam yang tersimpan
      // begitu jarinya pindah. Kalau dibiarkan, kotaknya terlihat kosong padahal
      // hari itu tetap dihitung memakai jam lamanya — persis keadaan yang bikin
      // operator mengira jamnya sudah terhapus.
      inp.addEventListener('blur', () => { inp.value = jamHari[h][bagian]; });
      return inp;
    };

    const pisah = document.createElement('span');
    pisah.className = 'jam-hari-pisah';
    pisah.textContent = '–';
    baris.append(nama, buatKotak('buka'), pisah, buatKotak('tutup'));
    tandaiJamHari(baris, h);
    box.appendChild(baris);
  });
}

// Dua penanda di satu baris jam: hari yang tidak ada pegawainya diredupkan —
// jamnya masih tersimpan, tapi hari itu memang tutup — dan jam yang terbalik
// diberi tanda salah supaya tidak diam-diam menghasilkan nol slot tanpa sebab
// yang terlihat.
function tandaiJamHari(baris, h) {
  baris.classList.toggle('tutup', pegawaiHari[h] === 0);
  baris.classList.toggle('salah', jamTerbalik(jamHari[h]));
}

// Baris jam pegawai ikut menyesuaikan waktu angka pegawai hari itu diubah —
// tanpa ini, hari yang baru saja disetel nol pegawai masih terlihat seperti
// hari kerja biasa di kotak jamnya.
function segarkanTandaJam(h) {
  const baris = $('slotJamBox').querySelector('.jam-hari[data-hari="' + h + '"]');
  if (baris) tandaiJamHari(baris, h);
}

// Kalimat di bawah judul sheet. Jam yang sama sepanjang minggu disebut sekali
// di sini; kalau harinya berbeda-beda, yang disebut cuma aturannya — jam tiap
// harinya sudah terbaca di kotak setelan dan di judul tiap hari.
function tandaiSubJam() {
  $('slotSub').textContent = (jamSeragam()
    ? 'Jam kerja ' + jamHari[0].buka + '–' + jamHari[0].tutup + '. '
    : 'Jam kerjanya beda-beda tiap hari. ')
    + 'Slot dihitung muat kalau seluruhnya masih di dalam jam hari itu.';
}

// Tujuh kotak angka, satu tiap hari. Dibangun ulang tiap kali sheet dibuka dan
// tiap kali setelannya benar-benar berubah — aman, karena terapkanPegawai()
// sudah menyaring pantulan snapshot yang isinya sama, jadi kotak yang sedang
// diketik tidak pernah tersapu oleh simpanannya sendiri.
function renderPegawaiHari() {
  const box = $('slotPegawaiBox');
  box.innerHTML = '';
  HARI_URUT.forEach((h) => {
    const sel = document.createElement('span');
    sel.className = 'peg-hari';
    const nama = document.createElement('span');
    nama.className = 'peg-hari-nama';
    nama.textContent = HARI_SINGKAT[h];
    sel.classList.toggle('tutup', pegawaiHari[h] === 0);
    sel.append(nama, buatStepper({
      kecil: true, nilai: pegawaiHari[h], min: 0, max: 20,
      aria: 'Jumlah pegawai setiap hari ' + HARI_PANJANG[h] + ' (0 = tutup)',
      onUbah: (n) => {
        pegawaiHari[h] = n;
        // Tandanya digeser di tempat, bukan lewat renderPegawaiHari(): membangun
        // ulang barisnya akan menghapus kotak yang jarinya masih di situ.
        sel.classList.toggle('tutup', n === 0);
        // Baris jam hari itu ikut diredupkan/dinyalakan di detik yang sama:
        // nol pegawai berarti hari itu tutup, dan jamnya tidak berlaku hari itu.
        segarkanTandaJam(h);
        // Daftar slot ikut berubah saat itu juga: hari yang angkanya baru saja
        // dinaikkan langsung memperlihatkan jam yang tadinya terhitung penuh.
        renderSlot();
        simpanPegawai();
      },
    }));
    box.appendChild(sel);
  });
}

// Tanggal yang sedang tampil, disimpan supaya baris ringkasan bisa dihitung
// ulang tanpa membangun ulang seluruh daftar.
let tanggalSlot = [];
let dilewatiSlot = 0;
// Jenis yang sedang dicarikan jadwal. Durasinya tidak disimpan terpisah —
// selalu diturunkan dari pilihan ini lewat tabel yang sama dengan yang dipakai
// menghitung jadwal yang sudah ada, jadi tidak mungkin keduanya berbeda.
let treatCari = TREAT_BAWAAN.slice();
const durasiCari = () => durasiJadwal({ treatments: treatCari });
const namaCari = () => namaKombinasi(rapikanTreatment(treatCari));

// Slot satu hari, sudah memakai jumlah pegawai khusus hari itu kalau ada.
const slotHari = (tgl, hariIni) => slotKosong(
  // Sengaja dari `appointments`, bukan filteredRows(): yang menyita pegawai
  // adalah seluruh jadwal hari itu, termasuk yang sedang disaring keluar layar
  // oleh mode riwayat satu customer.
  appointments.filter((a) => a.date === tgl),
  pegawaiUntuk(tgl),
  // Hari ini dipotong dari jam sekarang; hari-hari berikutnya utuh sejak buka.
  tgl === hariIni ? menitSekarang() : 0,
  jamUntuk(tgl),
);

// Semua jam mulai di satu hari, dari seluruh rentang luangnya, sudah menurut
// jenis yang sedang dicari. Ini yang dihitung di mana-mana sekarang — daftar di
// layar, baris ringkasan, dan salinan WhatsApp — supaya ketiganya tidak mungkin
// menyebut angka yang berbeda.
//
// Namanya bukan jamHari(): itu sudah dipakai jam buka/tutup tiap hari dalam
// seminggu, dan keduanya memang beda — yang itu jendela harinya, yang ini
// jam-jam yang bisa dipakai mulai di dalam jendela itu.
const jamMulaiHari = (tgl, hariIni) =>
  slotHari(tgl, hariIni).flatMap((sl) => jamMulaiSlot(sl, durasiCari()));

// Satu blok hari, lengkap dengan kotak jumlah pegawainya sendiri.
//
// Dibangun sebagai satu elemen yang berdiri sendiri supaya mengubah angka
// pegawai satu hari cukup mengganti blok itu saja. Kalau seluruh daftar
// dibangun ulang, kotak yang sedang diketik ikut terhapus dan kursornya lompat
// keluar di tengah pengetikan.
function bangunHariSlot(tgl, hariIni) {
  const slot = slotHari(tgl, hariIni);
  const jam = jamUntuk(tgl);

  const h = document.createElement('div');
  h.className = 'slot-hari';
  h.dataset.tgl = tgl;

  const judul = document.createElement('div');
  judul.className = 'slot-head';
  const nama = document.createElement('span');
  nama.textContent = hariBulan(tgl);
  // Jumlah jadwal hari itu tidak ditulis: yang dicari di layar ini justru yang
  // kosong, dan angka yang terisi sudah terbaca di daftar jadwal sendiri.
  // Yang tetap perlu disebut cuma kalau harinya sudah terpotong jam berjalan —
  // tanpa itu, daftar yang mulai jam 14:00 terlihat seperti salah hitung.
  const kotak = document.createElement('span');
  kotak.className = 'slot-peg-hari' + (pegawaiPerTgl.has(tgl) ? ' ubah' : '');
  kotak.append(buatStepper({
    kecil: true,
    nilai: pegawaiUntuk(tgl), min: 0, max: 20,
    aria: 'Jumlah pegawai pada ' + hariBulan(tgl) + ' (0 = tutup)',
    onUbah: (n, dariTombol) => {
      // Diketik balik sama dengan acuan harinya = tidak jadi menyimpang. Dihapus
      // dari peta, bukan disimpan sebagai angka yang kebetulan sama: tanggal itu
      // ikut lagi kalau acuan hari itu nanti diubah, dan tandanya ikut padam.
      if (n === pegawaiAcuan(tgl)) pegawaiPerTgl.delete(tgl); else pegawaiPerTgl.set(tgl, n);
      gantiHariSlot(tgl, dariTombol);
    },
  }), document.createTextNode('pegawai'));
  judul.appendChild(nama);
  // Jam kerja hari itu ditulis di judulnya cuma kalau minggunya memang tidak
  // seragam. Kalau ketujuh harinya sama, jamnya sudah disebut sekali di atas —
  // mengulanginya di tiap hari cuma memenuhi baris yang sudah padat. Kalau
  // beda-beda, tanpa ini daftar yang berhenti jam 14:00 di satu hari dan jam
  // 20:00 di hari lain terbaca seperti salah hitung.
  if (!jamSeragam() && !hariTutup(tgl)) {
    const jamEl = document.createElement('span');
    jamEl.className = 'slot-jam-hari';
    jamEl.textContent = jam.buka + '–' + jam.tutup;
    judul.appendChild(jamEl);
  }
  if (tgl === hariIni && menitSekarang() > keMenit(jam.buka)) {
    const sisa = document.createElement('span');
    sisa.className = 'slot-sisa';
    sisa.textContent = 'sisa hari ini';
    judul.appendChild(sisa);
  }
  judul.appendChild(kotak);
  h.appendChild(judul);

  // `jam` di atas sudah dipakai jam kerja hari itu, jadi daftar jam mulainya
  // pakai nama sendiri — dua hal yang beda: yang satu jendela harinya, yang satu
  // jam-jam yang bisa dipakai mulai di dalam jendela itu.
  const jamMulai = slot.flatMap((sl) => jamMulaiSlot(sl, durasiCari()));

  if (!jamMulai.length) {
    const p = document.createElement('div');
    p.className = 'slot-penuh' + (hariTutup(tgl) ? ' slot-tutup' : '');
    // Lima sebab yang berbeda, dan operator perlu tahu bedanya: tutup berarti
    // memang tidak ada yang masuk, jam terbalik berarti setelannya yang salah,
    // jam kerja habis berarti hari ini saja yang sudah lewat, penuh berarti
    // masih bisa digeser ke besok, dan celah yang kurang panjang berarti harinya
    // masih bisa dipakai kalau satu-dua jadwal digeser sedikit.
    const terpanjang = slot.reduce((m, sl) => Math.max(m, sl.b - sl.a), 0);
    p.textContent = hariTutup(tgl)
      ? 'Tutup — tidak ada pegawai yang masuk hari ini.'
      // Yang ini salah setelan, bukan keadaan hari itu: tanpa disebut, jam yang
      // terbalik cuma terbaca sebagai "penuh" dan tidak ada yang tahu kenapa
      // harinya tidak pernah punya slot.
      : jamTerbalik(jam)
        ? 'Jam kerjanya belum benar — jam tutup harus lewat dari jam buka.'
        : (tgl === hariIni && menitSekarang() >= keMenit(jam.tutup))
          ? 'Jam kerja hari ini sudah lewat.'
          : !slot.length
            ? 'Penuh — tidak ada pegawai yang luang.'
            : 'Celah terpanjang cuma ' + labelDurasi(terpanjang) + ' — kurang '
              + labelDurasi(durasiCari() - terpanjang) + ' untuk ' + namaCari() + '.';
    h.appendChild(p);
    return h;
  }

  const daftar = document.createElement('div');
  daftar.className = 'slot-jam-list';
  jamMulai.forEach((j) => {
    const el = document.createElement('span');
    el.className = 'slot-chip';
    const t = document.createElement('span');
    t.textContent = keJam(j.m);
    el.appendChild(t);
    // Jam yang dua pegawainya sama-sama luang muat dua orang sekaligus. Tanpa
    // penanda ini jam seperti itu terbaca sebagai satu tempat saja, dan yang
    // kedua tidak pernah ditawarkan ke siapa pun.
    if (j.peg > 1) {
      const p = document.createElement('span');
      p.className = 'slot-chip-peg';
      p.textContent = '×' + j.peg;
      el.appendChild(p);
      el.title = j.peg + ' pegawai luang kalau mulai jam ' + keJam(j.m);
    }
    daftar.appendChild(el);
  });
  h.appendChild(daftar);
  return h;
}

// Membangun ulang satu hari saja, di tempatnya. Kursor di kotak pegawai hari
// itu dikembalikan supaya angkanya bisa terus diketik tanpa terputus.
function gantiHariSlot(tgl, dariTombol) {
  const lama = $('slotHasil').querySelector('.slot-hari[data-tgl="' + tgl + '"]');
  if (!lama) return;
  const inpLama = lama.querySelector('.stepper input');
  const sedangDiketik = document.activeElement === inpLama;
  const baru = bangunHariSlot(tgl, today());
  lama.replaceWith(baru);
  if (sedangDiketik) {
    const inp = baru.querySelector('.stepper input');
    inp.focus();
    // Kursor ditaruh di ujung, bukan menyorot seluruh isinya: menyorot membuat
    // angka berikutnya yang diketik menimpa, bukan menyambung.
    inp.setSelectionRange(inp.value.length, inp.value.length);
  } else if (dariTombol) {
    // Tombol yang baru ditekan ikut terganti, jadi fokusnya hilang dan ketukan
    // berikutnya tidak mendarat di mana-mana. Dikembalikan ke tombol yang sama.
    const tombol = baru.querySelectorAll('.stepper-btn');
    const kurang = document.activeElement && document.activeElement.textContent === '−';
    (kurang ? tombol[0] : tombol[1]).focus();
  }
  ringkasSlot();
}

// Baris ringkasan dihitung ulang dari keadaan sekarang, bukan ditumpuk selagi
// daftarnya dibangun — supaya penggantian satu hari pun tetap memperbaruinya.
function ringkasSlot() {
  const hariIni = today();
  const muat = tanggalSlot.reduce((n, tgl) => n + jamMulaiHari(tgl, hariIni).length, 0);
  const sebut = namaCari() + ' (' + labelDurasi(durasiCari()) + ')';
  // Hari tutup dan hari lewat sama-sama tidak menyumbang slot, tapi sebabnya
  // beda — tanpa disebut, "tidak ada slot" di cabang yang tutup dua hari
  // seminggu terbaca seperti jadwalnya yang kelewat padat.
  const tutup = tanggalSlot.filter(hariTutup).length;
  const catatan = [];
  if (tutup) catatan.push(tutup + ' hari tutup');
  if (dilewatiSlot) catatan.push(dilewatiSlot + ' hari yang sudah lewat dilewati');
  const ekor = ' di ' + tanggalSlot.length + ' hari yang diperiksa'
    + (catatan.length ? ' — ' + catatan.join(', ') : '') + '.';
  $('slotRingkas').textContent = muat
    ? muat + ' pilihan jam untuk ' + sebut + ekor
    : 'Tidak ada jam yang muat untuk ' + sebut + ekor;
}

function renderSlot() {
  const box = $('slotHasil');
  box.innerHTML = '';
  tanggalSlot = []; dilewatiSlot = 0;
  const semuaTanggal = tanggalFilter();
  if (!semuaTanggal.length) {
    box.innerHTML = '<div class="empty">Pilih dulu filter tanggalnya — mode ini tidak menunjuk hari tertentu.</div>';
    $('slotRingkas').textContent = '';
    return;
  }
  // Hari yang sudah lewat tidak bisa diisi lagi, jadi tidak ikut dicari. Filter
  // seperti "Seminggu ke Belakang" memang isinya hampir seluruhnya hari lewat —
  // yang tersisa cuma hari ini, dan itu yang ditampilkan.
  const hariIni = today();
  tanggalSlot = semuaTanggal.filter((t) => t >= hariIni);
  dilewatiSlot = semuaTanggal.length - tanggalSlot.length;
  if (!tanggalSlot.length) {
    box.innerHTML = '<div class="empty">Semua hari di filter ini sudah lewat — tidak ada yang bisa dicarikan jadwal.</div>';
    $('slotRingkas').textContent = '';
    return;
  }
  tanggalSlot.forEach((tgl) => box.appendChild(bangunHariSlot(tgl, hariIni)));
  ringkasSlot();
}

function buildSlotWaText() {
  const hariIni = today();
  const tanggal = tanggalFilter().filter((t) => t >= hariIni);
  if (!tanggal.length) return null;
  const cabang = cabangList.find((c) => c.id === cabangId);
  const judulCabang = cabangList.length > 1 && cabang ? ' ' + cabang.name.toUpperCase() : '';
  const lines = ['*SLOT KOSONG' + judulCabang + '* 🕒'];
  let ada = 0;
  tanggal.forEach((tgl) => {
    const jam = jamMulaiHari(tgl, hariIni);
    // Hari yang penuh tidak ditulis sama sekali. Daftar ini isinya tawaran;
    // baris "penuh" cuma memanjangkan pesan tanpa menambah pilihan.
    if (!jam.length) return;
    ada += jam.length;
    lines.push('', '📅 *' + hariBulan(tgl) + '*');
    // Bentuknya sama persis dengan pesan reminder — lihat JAM_SEBARIS.
    for (let i = 0; i < jam.length; i += JAM_SEBARIS) {
      lines.push(jam.slice(i, i + JAM_SEBARIS).map((j) => keJam(j.m)).join(PISAH_JAM));
    }
  });
  return ada ? lines.join('\n') : null;
}

// Jenisnya dipilih dengan tombol centang yang sama persis seperti di form isi
// jadwal — bukan dropdown berisi tujuh kombinasi jadi. Yang dipikirkan operator
// tetap "rambut sama muka", bukan mencari baris "Rambut + Muka" di daftar.
const treatSlot = pasangTreatSeg('slotTreat', 'slotTreatHint', {
  hint: (t) => 'Perkiraan ' + labelDurasi(durasiJadwal({ treatments: t }))
    + (t.length ? '' : ' — jenis kosong dihitung sama dengan rambut saja.'),
  onUbah: (t) => { treatCari = t; renderSlot(); },
});
treatSlot.set(treatCari);

function bukaSlot() {
  if (!dataSiap[KEY_APPOINTMENTS]) {
    toast('Jadwal masih dimuat — tunggu sebentar lalu ulangi.', true);
    return;
  }
  renderPegawaiHari();
  renderJamHari();
  tandaiSubJam();
  // Jenisnya dikembalikan ke rambut tiap kali sheet dibuka, bukan cuma sekali
  // waktu halaman dimuat — sama seperti form isi jadwal yang juga kembali ke
  // TREAT_BAWAAN sesudah tiap simpan. Pencarian berikutnya hampir selalu untuk
  // rambut lagi, dan centang sisa pencarian sebelumnya diam-diam mengubah
  // jawabannya tanpa ada yang menyadari.
  treatCari = TREAT_BAWAAN.slice();
  treatSlot.set(treatCari);
  $('slotSheet').hidden = false;
  renderSlot();
}
function tutupSlot() { $('slotSheet').hidden = true; }

$('slotBtn').addEventListener('click', bukaSlot);
$('slotWaBtn').addEventListener('click', async () => {
  const text = buildSlotWaText();
  if (!text) {
    toast('Tidak ada jam yang muat untuk ' + namaCari() + ' — tidak ada yang bisa disalin.', true);
    return;
  }
  await salinTeks(text);
  toast('Slot kosong tersalin — tinggal paste di WhatsApp.');
});
$('slotTutup').addEventListener('click', tutupSlot);
$('slotSheet').addEventListener('click', (e) => { if (e.target === $('slotSheet')) tutupSlot(); });
// ============================================================
// Reminder: customer yang belum menjadwalkan lagi
// ------------------------------------------------------------
// Yang dicari bukan "siapa yang tidak datang minggu ini", melainkan siapa yang
// baru saja datang lalu pulang tanpa janji berikutnya. Bedanya penting: orang
// yang sudah booking untuk minggu depan tetap sepi di minggu berjalan, dan
// mengingatkan dia cuma membuat operator terbaca tidak memegang catatannya
// sendiri.
//
// Seluruh hitungannya lokal — `appointments` di memori sudah berisi riwayat
// penuh dari semua dokumen bulanan — jadi membuka daftar ini tidak menambah
// satu pun pembacaan Firestore.
// ============================================================
// Jendela "sudah waktunya dihubungi", dihitung dari kunjungan terakhir.
// Batas bawahnya bukan nol: orang yang baru datang satu-empat hari lalu belum
// perlu diingatkan apa-apa, dan pesan yang datang terlalu cepat justru terbaca
// seperti salon yang tidak ingat ia baru saja ke sini. Batas atasnya menutup
// ujung yang lain — lewat dua minggu, yang dibutuhkan bukan lagi pengingat.
const REM_MULAI = 5;   // hari paling cepat sesudah kunjungan terakhir
const REM_SAMPAI = 14; // hari paling lama yang masih dianggap perlu diingatkan

// Nomor disimpan dalam bentuk yang langsung bisa ditempel ke wa.me: deret angka
// berformat negara tanpa tanda plus ('628123456789'). Yang diketik operator
// dibiarkan bebas — '0812-3456-7890', '+62 812 3456 7890', dan '812 3456 7890'
// semuanya bermuara ke nilai yang sama, karena tiga-tiganya memang cara orang
// menuliskan nomor yang sama.
function rapikanNomor(teks) {
  const d = String(teks || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('62')) return d;
  if (d.startsWith('0')) return '62' + d.slice(1);
  // Nol di depan yang kelewat waktu mengetik. Nomor seluler Indonesia selalu
  // mulai dari 8, jadi tebakannya aman.
  if (d.startsWith('8')) return '62' + d;
  return d; // nomor luar negeri: tidak ditebak-tebak, dipakai apa adanya
}

// Sekadar penjaring salah ketik, bukan pemeriksa nomor sungguhan: yang ditolak
// cuma panjang yang mustahil. Nomor Indonesia berformat negara jatuh di 11-14
// angka; jauh di bawah itu hampir pasti kurang satu-dua ketukan.
const nomorSah = (d) => /^\d{9,15}$/.test(d);

// Dibalik ke bentuk yang biasa dilihat operator waktu ditaruh di kotak isian.
// '628...' benar buat wa.me tapi susah dicocokkan dengan buku catatan.
const nomorLokal = (d) => (d && d.startsWith('62') ? '0' + d.slice(2) : (d || ''));

const selisihHari = (dari, sampai) =>
  Math.round((new Date(sampai + 'T00:00:00') - new Date(dari + 'T00:00:00')) / 86400000);

const labelJeda = (n) => (n <= 0 ? 'hari ini' : n === 1 ? 'kemarin' : n + ' hari lalu');

// Kandidat yang dibawa keluar sengaja cuma id-nya, bukan objek customer-nya.
// Snapshot customers yang mendarat selagi sheet terbuka mengganti seluruh isi
// array dengan objek baru; referensi lama yang masih dipegang di sini akan
// menunjuk objek yatim, dan nomor yang ditulis ke situ tidak akan pernah ikut
// tersimpan.
function kandidatReminder() {
  const hariIni = today();
  // Kunjungan terakhir dicari dari seluruh riwayat, bukan cuma dari dalam
  // jendela. Kalau dibatasi jendela, orang yang datang 10 hari lalu dan datang
  // lagi 2 hari lalu akan terbaca "terakhir 10 hari lalu" — kunjungan barunya
  // tidak ikut terlihat karena jatuh di luar jendela — lalu diingatkan padahal
  // ia baru saja pulang dari sini.
  const terakhir = new Map();  // customerId -> kunjungan terakhir yang tercatat
  const mendatang = new Set(); // customerId yang sudah punya jadwal sesudah hari ini
  appointments.forEach((a) => {
    if (!tanggalSah(a)) return;
    if (a.date > hariIni) { mendatang.add(a.customerId); return; }
    const t = terakhir.get(a.customerId);
    if (!t || a.date > t) terakhir.set(a.customerId, a.date);
  });
  const out = [];
  terakhir.forEach((tgl, id) => {
    if (mendatang.has(id)) return;
    // Jendelanya diperiksa di sini, sesudah kunjungan terakhirnya pasti benar.
    const jeda = selisihHari(tgl, hariIni);
    if (jeda < REM_MULAI || jeda > REM_SAMPAI) return;
    const c = customers.find((x) => x.id === id);
    if (!c) return; // jadwal yatim: customer-nya sudah tidak ada lagi di daftar
    // Tanda "sudah diingatkan" hanya berlaku sepanjang kunjungan terakhir ini.
    // Tanda yang lebih tua dari kunjungannya berarti sisa putaran sebelumnya --
    // ia sudah datang sesudah diingatkan, lalu sepi lagi — dan membawanya ke
    // putaran ini membuat orangnya tidak pernah terhubungi lagi.
    const ingat = typeof c.diingatkan === 'string' && c.diingatkan >= tgl ? c.diingatkan : null;
    out.push({
      id, nama: c.name, tgl, jeda, total: visitCount(id),
      ingat, jedaIngat: ingat ? selisihHari(ingat, hariIni) : null,
    });
  });
  // Dua lapis urutan. Yang belum dihubungi selalu di atas: itu yang menunggu
  // dikerjakan, dan mencampurnya dengan yang sudah selesai membuat operator
  // harus memilah sendiri tiap kali daftarnya dibuka.
  //
  // Di dalam tiap lapis, yang paling baru datang duluan — jadi daftarnya
  // mengalir dari hari ke-5 turun ke hari ke-14, bukan sebaliknya. Nama dipakai
  // sebagai pemutus supaya orang-orang di tanggal yang sama tidak bertukar
  // tempat sendiri tiap kali daftarnya digambar ulang.
  return out.sort((a, b) =>
    (a.ingat ? 1 : 0) - (b.ingat ? 1 : 0)
    || b.tgl.localeCompare(a.tgl)
    || a.nama.localeCompare(b.nama, 'id'));
}

// Sebutan tempat untuk teks WhatsApp: nama klinik, lalu nama cabang kalau
// cabangnya memang lebih dari satu ('Skinwriter Kemayoran'). Dua-duanya boleh
// tidak ada — akun yang belum mengisi nama klinik dan cuma punya satu cabang
// mendapat string kosong, dan kalimat yang memakainya menutup sendiri tanpa
// menyisakan kata 'di' yang menggantung.
function namaTempat() {
  const cabang = cabangList.find((c) => c.id === cabangId);
  return [namaKlinik, cabangList.length > 1 && cabang ? cabang.name : '']
    .filter(Boolean).join(' ');
}

// Salam menurut jam di perangkat operator saat tombol kirim ditekan — bukan jam
// kunjungan customer, yang sudah lewat berhari-hari dan tidak ada hubungannya
// dengan kapan pesannya dibaca.
//
// 'malam' tetap disediakan walau jam kerja tutup pukul 17:00: operator yang
// membereskan daftar ini selepas tutup bukan hal aneh, dan "Selamat sore"
// yang terkirim pukul delapan malam justru menandakan pesannya tidak ditulis
// orang. Batasnya mengikuti pemakaian sehari-hari, bukan pembagian resmi.
function salamWaktu(sekarang) {
  const jam = (sekarang || new Date()).getHours();
  if (jam < 10) return 'Selamat pagi';   // 00:00 - 09:59
  if (jam < 14) return 'Selamat siang';  // 10:00 - 13:59
  if (jam < 18) return 'Selamat sore';   // 14:00 - 17:59
  return 'Selamat malam';                // 18:00 - 23:59
}

// Yang menyapa isi kolom sapaan, bukan nama lengkapnya. Panggilan memang sudah
// menyatu dengan nama di data ini — "Ibu Siti", "Ci Mei", "Pak Budi" — dan itu
// justru yang dibaca tebakGender() lewat daftar SAPAAN, jadi kolom nama tidak
// bisa ikut dipendekkan. Menambahkan "Kak" di depannya juga bukan jalan
// keluar: hasilnya "Kak Ibu Siti Rahma".
//
// Karena itu sapaannya jadi kolom sendiri, diisi operator sekali per customer.
//
// Nadanya sengaja lebih formal daripada catatan internal: ini satu-satunya
// teks di aplikasi ini yang dibaca customer, bukan operator.
// Jendela tawaran jadwal: besok sampai tujuh hari ke depan. Hari ini sengaja
// dilewati — sisa jamnya tinggal sedikit dan orang yang baru dihubungi sore ini
// hampir tidak mungkin datang hari ini juga, jadi menawarkannya lebih sering
// meleset daripada kena.
const REM_SLOT_HARI = 7;

// Emoji di judul hari. Satu sakelar, karena nasibnya beda per perangkat:
// dikirim dari HP emojinya utuh, dikirim dari PC ia bisa jatuh jadi tanda tanya
// di kotak ketik WhatsApp — jalur wa.me di desktop melewati tahap yang
// menjatuhkan karakter di luar Windows-1252. Kalau itu terjadi lagi, ubah satu
// baris ini ke false dan judul harinya kembali polos.
//
// Cuma judul hari yang dapat emoji, dan itu bukan soal selera: satu emoji jadi
// 12 karakter URL, sedangkan judul hari cuma tujuh buah per pesan sementara
// baris jam bisa dua puluh delapan. Penanda yang paling sering muncul yang
// paling mahal, jadi baris jam tetap tanda hubung biasa.
const REM_EMOJI = true;
const TANDA_HARI = REM_EMOJI ? '\u{1F4C5} ' : '';
const TANDA_JAM = '- ';

// Tawaran jadwal untuk satu customer, memakai mesin slot yang sama dengan sheet
// "Slot Kosong" — jadi jam yang ditawarkan ke customer tidak mungkin beda
// dengan yang dilihat operator di layar.
//
// Durasinya diambil dari treatment terakhir orang itu, bukan dari centang di
// sheet Slot Kosong: pesan ini harus berdiri sendiri, tidak boleh berubah isi
// gara-gara pilihan yang kebetulan tertinggal di layar lain. Jadwal lama yang
// tidak punya field treatments jatuh ke durasi bawaan lewat durasiJadwal(),
// persis seperti perlakuan di seluruh aplikasi.
//
// Seluruh jam yang muat ikut ditulis — tidak ada batas berapa jam yang boleh
// disebut per hari. Orang yang cuma bisa jam tertentu perlu melihat jam itu ada
// di daftarnya; tawaran yang dipangkas membuat dia menjawab "tidak ada yang
// cocok" padahal jamnya kosong. Yang menjaga panjang pesannya tinggal BATAS_URL
// di bawah, dan ia memotong per hari dari yang terjauh — bukan memotong jam di
// hari yang sudah terlanjur ditulis.
//
// Hasilnya satu blok teks per hari: judul harinya, lalu jam-jamnya menurut
// JAM_SEBARIS dan PISAH_JAM — bentuk yang sama persis dengan salinan Slot
// Kosong, karena yang dilihat operator di layar dan yang dibaca customer di
// WhatsApp tidak boleh cuma mirip. Bukan satu baris panjang berisi seluruh jam
// hari itu: deret yang menyambung sampai membungkus tiga kali justru paling
// susah dibaca di layar HP, dan mata yang mencari satu jam tertentu kehilangan
// tempatnya.
function slotTawaran(k) {
  const hariIni = today();
  const terakhir = appointments.find((a) => a.customerId === k.id && a.date === k.tgl);
  const durasi = durasiJadwal(terakhir);
  const blok = [];
  for (let i = 1; i <= REM_SLOT_HARI; i++) {
    const tgl = hariGeser(i);
    const jam = slotHari(tgl, hariIni).flatMap((sl) => jamMulaiSlot(sl, durasi));
    // Hari yang penuh tidak ditulis sama sekali — sama seperti salinan slot
    // kosong. Baris "penuh" cuma memanjangkan pesan tanpa menambah pilihan.
    if (!jam.length) continue;
    // Susunannya mengikuti salinan jadwal dan salinan slot kosong: nama hari
    // ditebalkan, jamnya turun di bawahnya.
    const baris = [];
    for (let i = 0; i < jam.length; i += JAM_SEBARIS) {
      baris.push(TANDA_JAM + jam.slice(i, i + JAM_SEBARIS).map((j) => keJam(j.m)).join(PISAH_JAM));
    }
    blok.push([TANDA_HARI + '*' + hariBulan(tgl) + '*'].concat(baris).join('\n'));
  }
  return blok;
}

// Batas panjang URL wa.me. Tidak ada batas baku untuk URL. Yang dijaga bukan
// cuma "gagal terbuka": URL yang kepanjangan bisa terpotong diam-diam, dan pesan
// yang terpenggal di tengah baris jam tetap terkirim tanpa ada yang menyadarinya.
//
// Angkanya 2048 selama pesannya masih pendek — batas lama Internet Explorer,
// dipakai karena tidak ada ruginya waktu itu. Ia mulai memotong hari begitu
// seluruh jam ikut ditulis dan pemisahnya diberi spasi, jadi dinaikkan ke 4096:
// masih jauh di bawah kemampuan semua browser yang dipakai sekarang (Chrome
// ~32.000, Firefox ~65.000, Safari lebih tinggi lagi).
//
// Diukur dengan bentuk sekarang, tujuh hari sekaligus, rambut 30 menit: jam
// kerja bawaan 10:00–17:00 berhenti di 1.874, buka sampai 21:00 di 2.616, dan
// buka 08:00–22:00 — empat belas jam sehari — di 3.169. Ketiganya terkirim utuh
// dan masih bersisa, jadi tidak ada cabang yang kehilangan hari terjauhnya.
//
// Angkanya sengaja tidak dikembalikan ke 2048 waktu pemisahnya kembali jadi
// koma: yang 2048 memang cukup untuk jam kerja bawaan, tapi cabang yang buka
// sampai malam sudah lewat batas itu dan kehilangan dua hari — persis keadaan
// yang tidak kelihatan sampai ada yang mengeluh tawarannya cuma sampai Jumat.
//
// Yang belum bisa diukur dari sini cuma satu: apakah jalur wa.me sendiri
// memotong di suatu tempat. Kalau suatu hari ada pesan yang sampai dalam
// keadaan terpenggal, angka inilah yang pertama diturunkan.
const BATAS_URL = 4096;

// Panjang URL seandainya pesannya jadi dikirim. Nomor tujuannya belum tentu
// diketahui waktu pesannya disusun, jadi yang dihitung nomor terpanjang yang
// masuk akal — lebih baik memotong sehari terlalu cepat daripada kelewatan.
const panjangUrl = (teks) =>
  'https://wa.me/'.length + 15 + '?text='.length + encodeURIComponent(teks).length;

// Satu-satunya teks di aplikasi ini yang berangkat lewat URL (wa.me), bukan
// lewat clipboard seperti salinan jadwal, salinan slot kosong, dan salinan
// daftar reminder. Dua hal yang perlu diingat waktu menyentuh teksnya:
//
// Pertama, di jalan menuju WhatsApp ada tahap yang bisa menjatuhkan karakter di
// luar Windows-1252 — emoji sampai di kotak ketik sebagai tanda tanya kalau
// dikirim dari PC, tapi utuh kalau dikirim dari HP. Itu yang diatur REM_EMOJI.
//
// Kedua, encodeURIComponent menagih mahal untuk apa pun di luar ASCII: satu
// emoji jadi 12 karakter URL, satu bullet sembilan. Karena itu pemisah jam
// tetap tanda hubung biasa — ia muncul di tiap baris, dan yang paling sering
// muncul yang paling mahal.
//
// Salinan yang lewat clipboard tidak kena dua-duanya sama sekali.
function buildReminderText(k) {
  const tawaran = slotTawaran(k);
  // Ajakannya berbentuk pertanyaan, bukan pemberitahuan: yang diminta dari
  // pembacanya memang satu jawaban, dan kalimat begini yang paling sering
  // dibalas. Ia juga sudah lengkap berdiri sendiri, jadi cabang yang tidak
  // punya daftar jadwal berhenti di sini tanpa perlu penutup tambahan.
  const ajakan = 'Apakah mau kami jadwalkan untuk treatment berikutnya?';
  // Salam, lalu langsung ke maksudnya. Kalimat "terima kasih sudah treatment
  // pada tanggal sekian" sudah tidak ada: yang membacanya tahu sendiri kapan ia
  // datang, dan mengulanginya cuma menunda kalimat yang benar-benar meminta
  // jawaban. namaTempat() tetap dipakai salinan daftar reminder, jadi nama
  // kliniknya tidak jadi hilang dari mana-mana.
  // Nama lengkap cuma jaring pengaman: alur kirim selalu lewat mulaiKirimWa()
  // yang menanyakan sapaannya dulu kalau belum ada.
  const kepala = salamWaktu() + ', ' + (sapaanCustomer(k.id) || k.nama) + '.\n\n';
  // Seminggu ke depan yang penuh sama sekali bukan alasan menahan pesannya:
  // ajakannya tetap terkirim, cuma tanpa daftar tawaran. Antarhari dipisah
  // baris kosong, bukan cuma ganti baris: tanpa jeda itu judul hari berikutnya
  // menempel di jam terakhir hari sebelumnya.
  const susun = (blok) => kepala + (blok.length
    ? ajakan + ' Berikut jam yang masih tersedia:\n\n' + blok.join('\n\n')
    : ajakan);
  let teks = susun(tawaran);
  // Hari terjauh dibuang lebih dulu, satu per satu sampai muat: besok dan lusa
  // yang paling mungkin dipilih orang, jadi hari ketujuh yang paling sedikit
  // ruginya kalau hilang. Dipotong per hari, bukan per baris jam, supaya tidak
  // ada hari yang tampil dengan daftar jamnya separuh — yang membacanya akan
  // mengira memang cuma segitu yang tersedia.
  while (tawaran.length && panjangUrl(teks) > BATAS_URL) {
    tawaran.pop();
    teks = susun(tawaran);
  }
  return teks;
}

// Daftar untuk dibaca sendiri/diteruskan ke pemilik, bukan untuk dikirim ke
// customer — jadi isinya nama dan jarak waktunya, bukan kalimat ajakan.
// Yang disalin daftar kerjanya, bukan seluruh isi layar: yang sudah dihubungi
// tidak perlu dikerjakan lagi, jadi ia cukup jadi satu baris hitungan di bawah.
function buildReminderListText(semua) {
  const daftar = semua.filter((k) => !k.ingat);
  const sudah = semua.length - daftar.length;
  if (!daftar.length) return null;
  const tempat = namaTempat();
  const lines = ['*PERLU DIINGATKAN' + (tempat ? ' ' + tempat.toUpperCase() : '')
    + '* \u{1F514}'];
  // Dikelompokkan per hari kunjungan terakhir, dan nomornya mulai dari 1 lagi
  // di tiap hari — sama persis dengan bentuk salinan jadwal, supaya yang
  // menerimanya di WA tidak perlu membaca dua susunan yang berbeda.
  let lastDate = null;
  let n = 0;
  daftar.forEach((k) => {
    if (k.tgl !== lastDate) {
      lines.push('', '\u{1F4C5} *' + hariBulan(k.tgl) + '* — ' + labelJeda(k.jeda));
      lastDate = k.tgl;
      n = 0;
    }
    n++;
    lines.push(n + '. ' + k.nama);
  });
  if (sudah) lines.push('', '_' + sudah + ' orang lain sudah diingatkan._');
  return lines.join('\n');
}

let daftarReminder = [];

function renderReminder() {
  const box = $('remHasil');
  box.innerHTML = '';
  daftarReminder = kandidatReminder();
  const n = daftarReminder.length;
  const belum = daftarReminder.filter((k) => !k.ingat).length;
  const sudah = n - belum;
  $('remRingkas').textContent = n
    ? (belum ? belum + ' belum dihubungi' : 'Semuanya sudah dihubungi')
      + (sudah ? ', ' + sudah + ' sudah diingatkan' : '')
      + ' \u2014 terakhir datang ' + REM_MULAI + '-' + REM_SAMPAI + ' hari lalu.'
    : 'Tidak ada yang terakhir datang ' + REM_MULAI + '-' + REM_SAMPAI
      + ' hari lalu tanpa jadwal berikutnya.';
  if (!n) {
    box.innerHTML = '<div class="empty">Tidak ada yang perlu diingatkan.</div>';
    return;
  }
  // Jumlah per hari dihitung per bagian, bukan sekali untuk seluruh daftar:
  // satu tanggal bisa muncul di dua bagian sekaligus — dua orang datang di
  // hari yang sama, yang satu sudah dihubungi dan yang satu belum — dan angka
  // yang dihitung menyeluruh akan menulis "2 orang" di kedua judulnya.
  const perHari = new Map();
  daftarReminder.forEach((k) => {
    const kunci = (k.ingat ? 'y' : 't') + k.tgl;
    perHari.set(kunci, (perHari.get(kunci) || 0) + 1);
  });
  // Judul bagian cuma dipasang kalau memang ada yang sudah dihubungi. Selama
  // belum ada, daftarnya tidak perlu diberi tahu bahwa isinya "yang belum" --
  // memang itu seluruh isinya.
  const adaSudah = daftarReminder.some((k) => k.ingat);
  let bagianTerakhir = null;
  let tglTerakhir = null;
  daftarReminder.forEach((k) => {
    const bagian = !!k.ingat;
    if (adaSudah && bagian !== bagianTerakhir) {
      const b = document.createElement('div');
      b.className = 'rem-bagian';
      b.textContent = bagian ? 'Sudah diingatkan' : 'Belum dihubungi';
      box.appendChild(b);
      bagianTerakhir = bagian;
      tglTerakhir = null; // tanggal yang sama boleh muncul lagi di bagian berikutnya
    }
    if (k.tgl !== tglTerakhir) {
      const h = document.createElement('div');
      h.className = 'day-head';
      h.textContent = hariBulan(k.tgl);
      const ket = document.createElement('span');
      ket.className = 'day-jml';
      ket.textContent = labelJeda(k.jeda) + ' · '
        + perHari.get((k.ingat ? 'y' : 't') + k.tgl) + ' orang';
      h.appendChild(ket);
      box.appendChild(h);
      tglTerakhir = k.tgl;
    }
    const c = customers.find((x) => x.id === k.id);
    const el = document.createElement('div');
    el.className = 'rem-item';
    el.innerHTML =
      '<button type="button" class="rem-nama"></button>'
      + '<button type="button" class="rem-hp"></button>'
      + '<button type="button" class="rem-wa"></button>';
    el.classList.toggle('sudah', !!k.ingat);
    el.querySelector('.rem-wa').textContent = k.ingat ? 'Kirim lagi' : 'Kirim WA';

    const namaEl = el.querySelector('.rem-nama');
    namaEl.textContent = k.nama;
    namaEl.title = 'Lihat semua kunjungan ' + k.nama;
    // Sapaannya ikut di belakang nama lengkap: itu kata yang akan dibaca
    // customer di pesannya, jadi salah sapa ketahuan dari daftar ini — sebelum
    // pesannya dikirim, bukan sesudah. Yang sama persis dengan nama lengkapnya
    // tidak ditulis lagi: "Ibu Siti Rahma (Ibu Siti Rahma)" cuma memanjangkan
    // baris tanpa memberi tahu apa pun.
    const sapaan = sapaanCustomer(k.id);
    if (sapaan && sapaan.toLowerCase() !== k.nama.toLowerCase()) {
      const s = document.createElement('span');
      s.className = 'rem-sapaan';
      s.textContent = ' (' + sapaan + ')';
      namaEl.appendChild(s);
      namaEl.title += ' — disapa "' + sapaan + '" di pesan WhatsApp';
    }
    // Pintu yang sama dengan nama di daftar jadwal: sebelum menghubungi orangnya,
    // yang paling sering ditanya adalah "dia biasanya berapa lama sekali datang".
    namaEl.onclick = () => { tutupReminder(); cariCustomer(k.id); };

    // Nomornya ditampilkan supaya operator bisa memastikan ia menghubungi orang
    // yang benar sebelum menekan kirim, dan sekaligus jadi jalan mengoreksinya
    // kalau salah ketik. Yang belum punya nomor tetap diberi tempat yang sama,
    // jadi tinggi tiap barisnya tidak berubah-ubah.
    const hpEl = el.querySelector('.rem-hp');
    const nomor = c && c.phone ? nomorLokal(c.phone) : '';
    hpEl.textContent = nomor || 'belum ada nomor';
    hpEl.classList.toggle('kosong', !nomor);
    hpEl.title = (nomor ? 'Ubah nomor ' : 'Isi nomor ') + k.nama + ' — sekalian sapaannya';
    hpEl.onclick = () => bukaHp(k, false);

    // Nomor dan sapaan yang belum ada ditanyakan sendiri oleh mulaiKirimWa()
    el.querySelector('.rem-wa').onclick = () =>
      mulaiKirimWa(k, nomor ? rapikanNomor(nomor) : '');

    // Baris kedua, cuma untuk yang sudah dihubungi. Tandanya sekaligus tombol
    // pencabutnya: kalau ternyata WhatsApp cuma terbuka lalu ditutup tanpa
    // mengirim, catatannya tidak boleh terlanjur mengunci orangnya di bawah.
    if (k.ingat) {
      const tanda = document.createElement('button');
      tanda.type = 'button';
      tanda.className = 'rem-tanda';
      tanda.textContent = 'diingatkan ' + labelJeda(k.jedaIngat);
      tanda.title = 'Cabut tanda ini — ' + k.nama + ' kembali ke daftar yang belum dihubungi';
      tanda.onclick = () => cabutIngat(k.id);
      el.appendChild(tanda);
    }

    box.appendChild(el);
  });
}

// Satu pintu untuk seluruh alur kirim. Dua hal harus ada sebelum pesannya
// berangkat — nomor tujuannya dan sapaannya — dan yang belum ada ditanyakan
// dulu lewat kotak isian, bukan lewat pesan error yang menyuruh operator
// mencari sendiri di mana isiannya. Tiap kotak menyambung ke sini lagi sesudah
// disimpan, jadi orang yang dua-duanya belum ada tetap sampai ke WhatsApp
// dalam satu rangkaian ketukan.
//
// Urutannya nomor dulu baru sapaan: nomor yang salah membatalkan seluruh
// kiriman, sedangkan sapaan cuma menentukan bunyinya. Yang paling mungkin
// membuat operator berhenti di tengah jalan ditanyakan lebih dulu.
function mulaiKirimWa(k, nomor) {
  if (!nomor) { bukaHp(k, true); return; }
  if (!sapaanCustomer(k.id)) { bukaSapaan(k, nomor); return; }
  kirimWa(k, nomor);
}

// Membuka WhatsApp dengan pesan yang sudah tersusun. Dipanggil dari dua tempat
// — tombol kirim di baris, dan sesudah nomor baru disimpan — jadi bentuk
// tautannya cuma tertulis sekali.
function kirimWa(k, nomor) {
  window.open('https://wa.me/' + nomor + '?text=' + encodeURIComponent(buildReminderText(k)),
    '_blank', 'noopener');
  tandaiIngat(k.id);
}

// Yang tercatat sebenarnya "pesannya sudah dibuka di WhatsApp", bukan "sudah
// terkirim": wa.me cuma menyiapkan pesannya, dan operator masih harus menekan
// kirim sendiri di sana. Halaman ini tidak pernah tahu apakah itu jadi
// dilakukan — karena itu kata yang dipakai di layar "diingatkan", bukan
// "terkirim", dan tandanya bisa dicabut lagi kalau ternyata batal.
function tandaiIngat(id) {
  const c = customers.find((x) => x.id === id);
  if (!c) return;
  const hari = today();
  if (c.diingatkan === hari) return; // sudah ditandai hari ini, tidak perlu tulis ulang
  // Gagal menyimpan tandanya tidak menghalangi pesannya dikirim — WhatsApp
  // sudah terbuka duluan. Yang hilang cuma catatannya, dan bolehUbah() sudah
  // memberi tahu sebabnya.
  if (!bolehUbah()) return;
  c.diingatkan = hari;
  save(KEY_CUSTOMERS, customers);
  renderReminder();
}

function cabutIngat(id) {
  const c = customers.find((x) => x.id === id);
  if (!c || !c.diingatkan) return;
  if (!bolehUbah()) return;
  const nama = c.name;
  delete c.diingatkan;
  save(KEY_CUSTOMERS, customers);
  renderReminder();
  toast('Tanda "sudah diingatkan" pada ' + nama + ' dicabut.');
}

// Kotak isian nomor sekaligus sapaan. Dua-duanya cuma dipakai pesan WhatsApp
// dan dua-duanya paling sering perlu dibetulkan tepat sebelum pesannya dikirim,
// jadi mengurusnya di satu kotak menghemat satu putaran buka-tutup sheet.
//
// Yang dipegang cuma id customer-nya, bukan objeknya: snapshot customers yang
// mendarat selagi kotak ini terbuka mengganti seluruh isi array dengan objek
// baru, dan yang ditulis ke objek lama tidak akan pernah ikut tersimpan.
let hpTarget = null;
// Dibuka dari tombol kirim, bukan dari nomornya. Bedanya menentukan apa yang
// terjadi sesudah simpan: langsung membuka WhatsApp, atau berhenti di situ.
let hpLanjutKirim = false;

function bukaHp(k, lanjutKirim) {
  const c = customers.find((x) => x.id === k.id);
  hpTarget = k;
  hpLanjutKirim = lanjutKirim;
  $('hpNama').textContent = k.nama;
  $('hpInput').value = nomorLokal(c && c.phone);
  // Sama seperti kotak sapaan: yang belum pernah diisi jatuh ke kata paling
  // depan dari namanya.
  $('hpSapaan').value = (c && c.sapaan) || sapaanBawaan(k.nama);
  perbaruiContohHp();
  $('hpKet').textContent = lanjutKirim
    ? 'Keduanya disimpan dulu, lalu WhatsApp langsung terbuka dengan pesannya.'
    : 'Kosongkan lalu simpan kalau nomornya mau dihapus.';
  $('hpSheet').hidden = false;
  $('hpInput').focus();
  $('hpInput').select();
}

// Contoh kalimat pembukanya, bentuk yang sama persis dengan kotak sapaan.
function perbaruiContohHp() {
  const isi = $('hpSapaan').value.trim().replace(/\s+/g, ' ');
  $('hpContoh').textContent = isi
    ? salamWaktu() + ', ' + isi + '.'
    : 'Sapaannya belum diisi — akan ditanyakan lagi sebelum pesannya dikirim.';
  $('hpContoh').classList.toggle('kosong', !isi);
}

function tutupHp() {
  $('hpSheet').hidden = true;
  hpTarget = null;
  hpLanjutKirim = false;
}

function simpanHp() {
  if (!hpTarget) return;
  const k = hpTarget, lanjut = hpLanjutKirim;
  const isi = $('hpInput').value.trim();
  const d = rapikanNomor(isi);
  if (isi && !nomorSah(d)) {
    toast('Nomor "' + isi + '" sepertinya belum lengkap.', true);
    return;
  }
  // Dibuka dari tombol kirim tapi dikosongkan: tidak ada yang bisa dihubungi,
  // jadi kotaknya ditahan tetap terbuka daripada menutup tanpa hasil apa pun.
  if (lanjut && !d) {
    toast('Isi nomornya dulu supaya WhatsApp bisa dibuka.', true);
    return;
  }
  // Dikosongkan di sini berarti "belum ditentukan", bukan ditolak seperti di
  // kotak sapaan: yang membuka kotak ini sering cuma mau membetulkan nomor, dan
  // sapaan yang kosong toh masih ditanyakan lagi sebelum pesannya berangkat.
  const sapaan = $('hpSapaan').value.trim().replace(/\s+/g, ' ');
  const asli = customers.find((x) => x.id === k.id);
  if (!asli) { tutupHp(); return; }
  const nomorBeda = (asli.phone || '') !== d;
  const sapaanBeda = (asli.sapaan || '') !== sapaan;
  if (nomorBeda || sapaanBeda) {
    // Menyimpannya berarti menulis ulang seluruh dokumen customers, jadi ia
    // lewat gerbang yang sama dengan perubahan data lainnya.
    if (!bolehUbah()) return;
    if (d) asli.phone = d; else delete asli.phone;
    if (sapaan) asli.sapaan = sapaan; else delete asli.sapaan;
    save(KEY_CUSTOMERS, customers);
  }
  const nama = asli.name;
  tutupHp();
  renderReminder();
  // Sheet ini sekarang bisa dibuka dari luar daftar reminder, jadi yang
  // digambar ulang bukan cuma daftar itu.
  renderList();
  // window.open masih dihitung lanjutan dari ketukan tombol Simpan, jadi ia
  // tidak kena penghadang popup.
  //
  // Lewat pintu yang sama, bukan langsung kirim: sapaannya bisa saja dibiarkan
  // kosong di sini, dan kotak sapaan menyusul di belakang kotak ini.
  if (lanjut) { mulaiKirimWa(k, d); return; }
  // Yang disebut cuma yang benar-benar berubah — kalimat yang menyebut kedua
  // isian padahal cuma satu yang disentuh membuat operator ragu sendiri.
  if (nomorBeda && sapaanBeda) toast('Nomor dan sapaan ' + nama + ' tersimpan.');
  else if (nomorBeda) toast(d ? 'Nomor ' + nama + ' tersimpan.' : 'Nomor ' + nama + ' dihapus.');
  else if (sapaanBeda) {
    toast(sapaan
      ? 'Sapaan ' + nama + ' disimpan: "' + sapaan + '".'
      : 'Sapaan ' + nama + ' dikosongkan.');
  }
}

// ============================================================
// Kotak sapaan
// ------------------------------------------------------------
// Muncul sendiri sebelum pesan pertama ke orang yang sapaannya belum pernah
// diisi, dan bisa dibuka lagi kapan saja dari baris ringkasan riwayat kalau
// sapaannya perlu dikoreksi.
// ============================================================
// Yang dipegang cuma id customer-nya, bukan objeknya — alasannya sama dengan
// kotak nomor: snapshot customers yang mendarat selagi kotak ini terbuka
// mengganti seluruh isi array dengan objek baru.
let sapaanTarget = null;
// Nomor tujuan kalau kotak ini bagian dari alur kirim. Berisi = WhatsApp
// terbuka sendiri sesudah disimpan; null = kotaknya dibuka sendiri untuk
// mengoreksi, dan sesudah simpan berhenti di situ.
let sapaanNomor = null;

function bukaSapaan(k, nomor) {
  const c = customers.find((x) => x.id === k.id);
  sapaanTarget = k;
  sapaanNomor = nomor || null;
  $('sapaanNama').textContent = k.nama;
  // Belum pernah diisi: kotaknya tidak dibiarkan kosong, isinya kata paling
  // depan dari namanya — bentuk terpendek yang sudah bisa langsung dipakai
  // menyapa. Yang perlu dipanjangkan tinggal dipanjangkan; contoh kalimatnya di
  // bawah kotak memperlihatkan bunyinya sebelum disimpan.
  $('sapaanInput').value = (c && c.sapaan) || sapaanBawaan(k.nama);
  $('sapaanKet').textContent = sapaanNomor
    ? 'Sapaannya disimpan dulu, lalu WhatsApp langsung terbuka dengan pesannya.'
    : 'Tersimpan di data customer, jadi cuma ditanyakan sekali.';
  perbaruiContohSapaan();
  $('sapaanSheet').hidden = false;
  $('sapaanInput').focus();
  $('sapaanInput').select();
}

// Kalimat pembuka pesannya, disusun dengan salam jam sekarang — bentuk yang
// sama persis dengan yang nanti berangkat lewat buildReminderText().
function perbaruiContohSapaan() {
  const isi = $('sapaanInput').value.trim().replace(/\s+/g, ' ');
  $('sapaanContoh').textContent = isi
    ? salamWaktu() + ', ' + isi + '.'
    : 'Sapaannya belum diisi.';
  $('sapaanContoh').classList.toggle('kosong', !isi);
}

function tutupSapaan() {
  $('sapaanSheet').hidden = true;
  sapaanTarget = null;
  sapaanNomor = null;
}

function simpanSapaan() {
  if (!sapaanTarget) return;
  const k = sapaanTarget, nomor = sapaanNomor;
  const isi = $('sapaanInput').value.trim().replace(/\s+/g, ' ');
  // Dikosongkan berarti pesannya berangkat tanpa yang disapa. Kotaknya ditahan
  // tetap terbuka daripada menyimpan keadaan yang tidak bisa dipakai.
  if (!isi) { toast('Isi sapaannya dulu — pesannya dibuka dengan itu.', true); return; }
  const asli = customers.find((x) => x.id === k.id);
  if (!asli) { tutupSapaan(); return; }
  const berubah = (asli.sapaan || '') !== isi;
  if (berubah) {
    // Menyimpan sapaan berarti menulis ulang seluruh dokumen customers, jadi ia
    // lewat gerbang yang sama dengan perubahan data lainnya.
    if (!bolehUbah()) return;
    asli.sapaan = isi;
    save(KEY_CUSTOMERS, customers);
  }
  const nama = asli.name;
  tutupSapaan();
  renderReminder();
  renderList();
  // window.open masih dihitung lanjutan dari ketukan tombol Simpan, jadi ia
  // tidak kena penghadang popup.
  if (nomor) { kirimWa(k, nomor); return; }
  if (berubah) toast('Sapaan ' + nama + ' disimpan: "' + isi + '".');
}

$('sapaanSimpan').addEventListener('click', simpanSapaan);
$('sapaanBatal').addEventListener('click', tutupSapaan);
$('sapaanSheet').addEventListener('click', (e) => {
  if (e.target === $('sapaanSheet')) tutupSapaan();
});
$('sapaanInput').addEventListener('input', perbaruiContohSapaan);
$('sapaanInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); simpanSapaan(); }
});

$('hpSimpan').addEventListener('click', simpanHp);
$('hpBatal').addEventListener('click', tutupHp);
$('hpSheet').addEventListener('click', (e) => { if (e.target === $('hpSheet')) tutupHp(); });
$('hpSapaan').addEventListener('input', perbaruiContohHp);
[$('hpInput'), $('hpSapaan')].forEach((el) => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); simpanHp(); }
  });
});

function bukaReminder() {
  if (!dataSiap[KEY_APPOINTMENTS] || !dataSiap[KEY_CUSTOMERS]) {
    toast('Data masih dimuat — tunggu sebentar lalu ulangi.', true);
    return;
  }
  $('reminderSheet').hidden = false;
  renderReminder();
}
function tutupReminder() { $('reminderSheet').hidden = true; }

$('reminderBtn').addEventListener('click', bukaReminder);
$('remTutup').addEventListener('click', tutupReminder);
$('reminderSheet').addEventListener('click', (e) => {
  if (e.target === $('reminderSheet')) tutupReminder();
});
$('remSalinBtn').addEventListener('click', async () => {
  const text = buildReminderListText(daftarReminder);
  if (!text) { toast('Tidak ada yang perlu diingatkan — tidak ada yang bisa disalin.', true); return; }
  await salinTeks(text);
  toast('Daftar tersalin — tinggal paste di WhatsApp.');
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
  for (const key of [KEY_CUSTOMERS, KEY_STAFF]) {
    const snap = await getDocFromServer(refData(id, key));
    isi[key] = snap.exists() ? (snap.data().rows || []) : [];
  }
  // Jadwal dikumpulkan dari dokumen bulanannya jadi satu array datar. Bentuk
  // file cadangan sengaja tidak ikut berubah: file yang dibuat versi ini tetap
  // terbaca aplikasi versi lama, dan file lama tetap terbaca yang ini.
  const jadwal = [];
  const kol = await getDocsFromServer(refJadwalKol(id));
  kol.forEach((d) => (d.data().rows || []).forEach((a) => jadwal.push(a)));
  // Cabang yang belum pernah dibuka di versi ini masih menyimpan riwayatnya di
  // dokumen lama — pemindahan cuma jalan untuk cabang yang sedang dibuka.
  // Cadangan harus tetap memuatnya, kalau tidak isinya diam-diam tidak lengkap
  // justru untuk cabang yang paling jarang disentuh.
  const lama = await getDocFromServer(refData(id, KEY_APPOINTMENTS));
  if (lama.exists()) {
    const punyaId = new Set(jadwal.map((a) => a && a.id));
    (lama.data().rows || []).forEach((a) => { if (a && !punyaId.has(a.id)) jadwal.push(a); });
  }
  isi[KEY_APPOINTMENTS] = jadwal;
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
  // Bulan mana saja yang akan tersentuh sudah ketahuan dari isi file, jadi yang
  // dibaca dan dikunci transaksi cuma dokumen bulan itu. Tanpa ini transaksinya
  // harus membaca seluruh riwayat cabang — persis yang dihindari pemecahan ini.
  const bulanFile = new Set();
  (dariFile.appointments || []).forEach((a) => {
    if (tanggalSah(a)) bulanFile.add(kunciDari(a.date));
  });
  const refCust = refData(id, KEY_CUSTOMERS);
  const refStaff = refData(id, KEY_STAFF);
  return runTransaction(db, async (tx) => {
    // Semua pembacaan harus selesai sebelum penulisan pertama — aturan
    // transaksi Firestore. Isinya selalu dari server, tidak pernah dari cache.
    const isi = {};
    const snapCust = await tx.get(refCust);
    isi[KEY_CUSTOMERS] = snapCust.exists() ? (snapCust.data().rows || []) : [];
    const snapStaff = await tx.get(refStaff);
    isi[KEY_STAFF] = snapStaff.exists() ? (snapStaff.data().rows || []) : [];
    const perBulan = new Map();
    for (const k of bulanFile) {
      const snap = await tx.get(refJadwal(id, k));
      perBulan.set(k, snap.exists() ? (snap.data().rows || []) : []);
    }
    isi[KEY_APPOINTMENTS] = perBulan;
    // Dihitung ulang tiap kali transaksi diulang karena bentrok, di atas isi
    // yang baru dibaca lagi — jadi pengulangannya tidak pernah menggandakan
    // apa pun maupun memakai isi yang sudah basi.
    const n = gabungData(isi, dariFile);
    if (n.berubah) {
      tx.set(refCust, { rows: isi[KEY_CUSTOMERS] });
      tx.set(refStaff, { rows: isi[KEY_STAFF] });
      // Cuma bulan yang benar-benar bertambah yang ditulis ulang. Bulan yang
      // semua jadwalnya ternyata sudah ada tidak perlu disentuh sama sekali.
      n.bulan.forEach((k) => tx.set(refJadwal(id, k), { rows: perBulan.get(k) }));
    }
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
  // Map 'YYYY-MM' -> baris bulan itu, sudah berisi dokumen bulan yang tersentuh
  // file ini saja. Bulan lain tidak ikut dibaca dan tidak ikut ditulis.
  const dftJadwal = isi[KEY_APPOINTMENTS];
  const dftStaff = isi[KEY_STAFF];
  let cust = 0, appt = 0, berubah = false;
  const bulan = new Set(); // bulan yang isinya benar-benar bertambah
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
    // Penanda "sudah lama datang, baru masuk sistem" ikut terbawa, tapi cuma
    // untuk mengisi yang di sini belum pernah dijawab — ketiadaan penanda di
    // file cuma berarti file itu belum tahu. Jawaban yang sudah ada di sini
    // tidak pernah ditimpa: file cadangan bisa saja lebih tua daripada koreksi
    // yang baru saja dilakukan operator.
    if (c.sudahLama && typeof existing.sudahLama !== 'boolean') {
      existing.sudahLama = true;
      berubah = true;
    }
    // Nomor WhatsApp ikut terbawa, tapi cuma untuk mengisi yang masih kosong.
    // Nomor yang sudah ada di sini lebih baru daripada isi file cadangan, dan
    // menimpanya berarti mengembalikan nomor lama yang mungkin sudah diperbaiki.
    if (!existing.phone && typeof c.phone === 'string' && /^\d{9,15}$/.test(c.phone)) {
      existing.phone = c.phone;
      berubah = true;
    }
    // Sapaan ikut terbawa dengan aturan yang sama seperti nomor: cuma mengisi
    // yang di sini masih kosong, tidak pernah menimpa yang sudah ada.
    if (!existing.sapaan && typeof c.sapaan === 'string' && c.sapaan.trim()) {
      existing.sapaan = c.sapaan.trim().slice(0, 40);
      berubah = true;
    }
    // Tanda "sudah diingatkan" ikut terbawa kalau file punya yang lebih baru.
    // Yang lebih tua tidak pernah menang: memundurkan tanggalnya cuma membuat
    // orang yang sudah dihubungi kemarin terbaca belum dihubungi lagi.
    if (typeof c.diingatkan === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.diingatkan)
        && (!existing.diingatkan || c.diingatkan > existing.diingatkan)) {
      existing.diingatkan = c.diingatkan;
      berubah = true;
    }
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
    // Jadwal kembar cuma mungkin ada di bulan yang sama dengan tanggalnya, jadi
    // yang diperiksa cukup dokumen bulan itu — bukan seluruh riwayat cabang.
    const kunci = kunciDari(a.date);
    if (!dftJadwal.has(kunci)) dftJadwal.set(kunci, []);
    const isiBulan = dftJadwal.get(kunci);
    if (isiBulan.some((x) => x.customerId === cid && x.date === a.date && x.time === a.time)) return;
    const baru = { id: buatId(), customerId: cid, date: a.date, time: a.time };
    // Kode yang tidak dikenal dibuang di sini dan urutannya disamakan, jadi
    // file dari versi mana pun masuk dalam bentuk yang sama.
    const jenis = rapikanTreatment(a.treatments);
    if (jenis.length) baru.treatments = jenis;
    if (a.done === true) baru.done = true;
    if (typeof a.staff === 'string' && a.staff.trim()) baru.staff = tambahStaff(a.staff);
    isiBulan.push(baru);
    bulan.add(kunci);
    appt++; berubah = true;
  });

  (Array.isArray(dariFile.staff) ? dariFile.staff : [])
    .forEach((s) => { if (typeof s === 'string') tambahStaff(s); });

  return { cust, appt, berubah, bulan };
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
let stopProfil = null;
let stopData = [];
// Sekali cukup: dengan includeMetadataChanges, keadaan buntu ini akan menyala
// lagi tiap kali metadata snapshot-nya berubah, dan toast-nya jadi beruntun.
let peringatanCabangKosong = false;

function mulaiSync() {
  setSambung(false); // dianggap belum tersambung sampai server yang bilang lain
  cabangSiap = false;
  resetDataSiap();
  // Nama klinik berdiri di tingkat akun, sejajar dengan daftar cabang — bukan
  // di dalam cabang — jadi ia tidak ikut dilepas-pasang tiap pindah cabang.
  //
  // Kegagalannya sengaja tidak menutup gerbang tulis dan tidak mengubah status
  // sambungan seperti listener lain: yang hilang cuma satu nama di teks pesan,
  // dan menghentikan seluruh aplikasi karena itu jelas berlebihan.
  stopProfil = onSnapshot(
    doc(db, 'users', uid, 'data', 'profil'),
    (snap) => {
      const n = snap.exists() ? snap.data().nama : '';
      namaKlinik = typeof n === 'string' ? n.trim() : '';
    },
    () => { namaKlinik = ''; }
  );
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
    refData(cabangDipasang, key),
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
  // Jadwal datang dari koleksi bulanan, jadi listener-nya satu koleksi — bukan
  // satu dokumen seperti dua di atas. Selebihnya perlakuannya sama persis.
  const pasangJadwal = () => onSnapshot(
    refJadwalKol(cabangDipasang),
    (snap) => {
      if (cabangId !== cabangDipasang) return;
      // Digabung jadi satu array datar berisi seluruh riwayat. Bentuk di memori
      // sengaja tidak ikut berubah: filteredRows, visitCount, dan analitik
      // semuanya membaca array ini apa adanya seperti sebelum dipecah.
      const semua = [];
      snap.forEach((d) => (d.data().rows || []).forEach((a) => semua.push(a)));
      dataSiap[KEY_APPOINTMENTS] = true;
      appointments = semua;
      renderList();
    },
    (e) => {
      if (cabangId !== cabangDipasang) return;
      dataSiap[KEY_APPOINTMENTS] = false;
      setSambung(false);
      toast('Gagal memuat jadwal: ' + e.message, true);
    }
  );
  stopData = [
    pasang(KEY_CUSTOMERS, (rows) => { customers = rows; lengkapiGender(); }),
    pasang(KEY_STAFF, (rows) => { staff = rows; }),
    pasang(KEY_PEGAWAI, terapkanPegawai),
    pasang(KEY_JAM, terapkanJam),
    pasangJadwal(),
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
        if (key === KEY_APPOINTMENTS) {
          // Langsung ke bentuk bulanan. Menulisnya ke dokumen lama dulu cuma
          // membuat pemindahan yang baru saja dihindari harus jalan lagi.
          const per = kelompokBulan(rows.filter(tanggalSah));
          for (const [k, isi] of per) await setDoc(refJadwal(daftar[0].id, k), { rows: isi });
        } else {
          await setDoc(refData(daftar[0].id, key), { rows });
        }
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
  // Jumlah pegawai dan jam kerja milik cabang sebelumnya — termasuk tulisan yang
  // masih tertunda — tidak boleh ikut menyeberang. Keduanya kembali ke bawaan
  // sampai setelan cabang yang baru datang dari server.
  lupakanPegawai();
  lupakanJam();
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
      if (stopProfil) { stopProfil(); stopProfil = null; }
      namaKlinik = '';
      stopData.forEach((lepas) => lepas());
      stopData = [];
      setSambung(false); // palang ikut disembunyikan karena uid sudah kosong
      customers = []; appointments = []; staff = [];
      lupakanPegawai();
      lupakanJam();
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

// --- Berapa yang diselesaikan tiap pegawai ---
// Bentuknya sama persis dengan kartu kombinasi treatment di atasnya: baris,
// angka, persen, batang. Yang beda cuma pembaginya — di sini jumlah yang
// selesai, bukan seluruh treatment bulan itu. Kalau dibagi seluruh treatment,
// bulan yang baru separuh ditandai membuat semua pegawai terbaca berkinerja
// setengah, padahal yang belum ditandai belum tentu belum dikerjakan.
function renderPegawai(kini) {
  const box = $('chartPegawai');
  box.innerHTML = '';
  if (!kini.rows.length) {
    box.innerHTML = '<div class="empty">Belum ada jadwal di bulan ini.</div>';
    return;
  }
  const { selesai, daftar } = ringkasPegawai(kini.rows);
  if (!selesai) {
    box.innerHTML = '<div class="empty">Belum ada treatment yang ditandai selesai bulan ini.</div>';
    return;
  }
  daftar.forEach((k) => {
    const persen = Math.round(k.n / selesai * 100);
    const nama = k.nama || 'Tanpa pegawai';

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
    // Yang pegawainya tidak disebut dapat abu-abu, aturan yang sama dengan
    // kombinasi treatment yang jenisnya belum diisi.
    bar.className = 'gen-bar komb' + (k.nama ? '' : ' kosong');
    bar.style.width = Math.max(2, k.n / selesai * 100) + '%';
    track.appendChild(bar);

    baris.append(atas, track);
    baris.setAttribute('aria-label',
      nama + ': ' + k.n + ' treatment selesai, ' + persen + '% dari yang selesai bulan ini.');
    pasangTip(baris, '<b>' + k.n + ' selesai</b> · ' + persen + '%<br>' + nama);
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

  const peg = ringkasPegawai(kini.rows);
  tambah('Per pegawai (yang sudah ditandai selesai)', ['Pegawai', 'Selesai', 'Porsi'],
    peg.daftar.map((k) =>
      [k.nama || 'Tanpa pegawai', k.n, Math.round(k.n / peg.selesai * 100) + '%']),
    'Belum ada treatment yang ditandai selesai bulan ini.');

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
  renderPegawai(kini);
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

  // --- Pegawai ---
  const peg = ringkasPegawai(kini.rows);
  const barisP = peg.selesai ? peg.daftar : [];
  const tinggiP = 62 + (barisP.length ? barisP.length * 56 : 40) + 14;
  vizPanel(ctx, C, L, y, W, tinggiP);
  vizTeks(ctx, 'Pegawai', L + 22, y + 40, { ukuran: 17.5, tebal: 700, warna: C.text });
  let py = y + 64;
  if (!barisP.length) {
    vizTeks(ctx, kini.total ? 'Belum ada treatment yang ditandai selesai bulan ini.'
      : 'Belum ada jadwal di bulan ini.',
      L + 22, py + 18, { ukuran: 14, warna: C.muted });
  } else barisP.forEach((k) => {
    const persen = Math.round(k.n / peg.selesai * 100);
    const nama = k.nama || 'Tanpa pegawai';
    vizTeks(ctx, nama, L + 22, py + 14, { ukuran: 14.5, tebal: 600, warna: C.text });
    const teksPersen = '(' + persen + '%)';
    vizTeks(ctx, teksPersen, L + W - 22, py + 14, { ukuran: 12, tebal: 600, warna: C.muted, rata: 'right' });
    vizTeks(ctx, String(k.n), L + W - 22 - vizLebar(ctx, teksPersen, 12, 600) - 7, py + 14,
      { ukuran: 14.5, tebal: 700, warna: C.text, rata: 'right' });
    const jalur = W - 44;
    ctx.fillStyle = C.field;
    vizKotak(ctx, L + 22, py + 27, jalur, 11, 6);
    ctx.fill();
    ctx.fillStyle = k.nama ? C.accent : C.gen['?'];
    vizKotak(ctx, L + 22, py + 27, Math.max(8, jalur * k.n / peg.selesai), 11, 6);
    ctx.fill();
    py += 56;
  });
  y += tinggiP + 18;

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
