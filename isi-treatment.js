// ============================================================
// isi-treatment.js — mengisi jenis treatment yang masih kosong dengan Rambut
// ------------------------------------------------------------
// Perkakas sekali pakai untuk data lama, dari masa sebelum jenis treatment ada
// di aplikasi ini. Bukan bagian dari aplikasi: tidak dimuat index.html, tidak
// ikut di-cache service worker, dan tidak menambah apa pun ke layar.
//
// CARA PAKAI
//   1. Buka aplikasinya di browser komputer, lalu login seperti biasa.
//   2. Tutup aplikasinya di perangkat lain. Tiap dokumen ditulis utuh sekali
//      kirim, jadi layar lain yang ikut menyimpan bisa menimpa hasil skrip ini.
//   3. Buka DevTools (F12) → tab Console.
//   4. Tempel SELURUH isi file ini, tekan Enter.
//      Yang jalan cuma pemeriksaan — belum ada satu pun data yang berubah.
//      Cadangan seluruh jadwal otomatis terunduh sebagai file JSON.
//   5. Periksa tabel yang tercetak. Kalau sudah cocok, jalankan:
//         await isiTreatment({ tulis: true })
//
// Skrip ini menumpang sesi login yang sudah ada di halaman — tidak ada password
// yang perlu diketik, dan tidak ada service account yang perlu diunduh.
//
// Beda dari mengerjakannya lewat aplikasi: ini menjangkau SEMUA cabang sekali
// jalan, bukan cuma cabang yang sedang dibuka.
// ============================================================
(async () => {
  const SDK = 'https://www.gstatic.com/firebasejs/11.6.1/';

  // Modul yang sama persis dengan yang dipakai app.js. Karena URL-nya identik,
  // browser mengembalikan modul yang itu-itu juga — jadi getApps() di bawah
  // menemukan instance Firebase milik aplikasi, lengkap dengan sesi loginnya.
  const { getApps } = await import(SDK + 'firebase-app.js');
  const { getAuth } = await import(SDK + 'firebase-auth.js');
  const { getFirestore, doc, getDoc, setDoc } = await import(SDK + 'firebase-firestore.js');

  const app = getApps()[0];
  if (!app) throw new Error(
    'Firebase belum jalan di halaman ini. Buka dulu aplikasinya, baru tempel skrip ini.');
  const user = getAuth(app).currentUser;
  if (!user) throw new Error(
    'Belum login. Masuk dulu di aplikasinya, baru tempel skrip ini.');

  const db = getFirestore(app);
  const uid = user.uid;

  // Disalin dari app.js, bukan diimpor: app.js dimuat sebagai module, jadi isinya
  // tidak bisa dijangkau dari console. Aturannya harus sama persis — Exo tidak
  // pernah berdiri tanpa Rambut, dan urutannya selalu mengikuti URUT_T.
  const URUT_T = ['rambut', 'exo', 'muka'];
  const rapikan = (list) => {
    const set = new Set(Array.isArray(list) ? list : []);
    if (!set.has('rambut')) set.delete('exo');
    return URUT_T.filter((k) => set.has(k));
  };

  // "Kosong" = tidak menyisakan apa pun setelah dirapikan. Ini ikut menjaring
  // data aneh seperti ['exo'] tanpa Rambut, yang memang perlu diperbaiki juga.
  const kosong = (a) => !rapikan(a.treatments).length;

  // Yang kosong TIDAK ditimpa jadi ['rambut'] mentah-mentah: Rambut ditambahkan
  // sebagai dasar dan sisanya dipertahankan, jadi ['exo'] jadi ['rambut','exo']
  // dan exo-nya tidak ikut hilang.
  const isi = (a) => rapikan(['rambut', ...(Array.isArray(a.treatments) ? a.treatments : [])]);

  const jalurAppt = (idCabang) => doc(db, 'users', uid, 'cabang', idCabang, 'data', 'appointments');
  const baca = async (ref) => (await getDoc(ref)).data();

  function unduh(nama, isiFile) {
    const url = URL.createObjectURL(new Blob([isiFile], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = nama;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function isiTreatment({ tulis = false } = {}) {
    const br = await baca(doc(db, 'users', uid, 'data', 'branches'));
    const cabang = (br && br.rows) || [];
    if (!cabang.length) throw new Error('Daftar cabang tidak terbaca. Batal, tidak ada yang diubah.');

    const cadangan = { app: 'jadwal-treatment', catatan: 'cadangan sebelum isi-treatment',
      uid, waktu: new Date().toISOString(), cabang: [] };
    const ringkas = [];
    const contoh = [];
    let totalKena = 0;

    for (const c of cabang) {
      const ref = jalurAppt(c.id);
      const d = await baca(ref);
      const rows = (d && d.rows) || [];
      cadangan.cabang.push({ id: c.id, nama: c.name, appointments: rows });

      const sasaran = rows.filter(kosong);
      totalKena += sasaran.length;
      ringkas.push({ Cabang: c.name, 'Total jadwal': rows.length, 'Masih kosong': sasaran.length });
      sasaran.slice(0, 3).forEach((a) => contoh.push({
        Cabang: c.name, Tanggal: a.date, Jam: a.time,
        Sekarang: JSON.stringify(a.treatments === undefined ? null : a.treatments),
        Jadi: JSON.stringify(isi(a)),
      }));

      if (tulis && sasaran.length) {
        sasaran.forEach((a) => { a.treatments = isi(a); });
        await setDoc(ref, { rows });
        console.log('✔ ' + c.name + ': ' + sasaran.length + ' jadwal disimpan.');
      }
    }

    console.table(ringkas);
    if (contoh.length) {
      console.log('Contoh perubahan (maks 3 per cabang):');
      console.table(contoh);
    }

    if (!tulis) {
      unduh('cadangan-sebelum-isi-treatment-' + new Date().toISOString().slice(0, 10) + '.json',
        JSON.stringify(cadangan, null, 2));
      console.log('%cPemeriksaan saja — belum ada data yang berubah.',
        'font-weight:bold');
      console.log('Cadangan seluruh jadwal sudah terunduh sebagai file JSON.');
      console.log(totalKena
        ? 'Kalau tabel di atas sudah cocok, jalankan:  await isiTreatment({ tulis: true })'
        : 'Tidak ada jadwal kosong. Tidak ada yang perlu dijalankan.');
    } else {
      console.log('%cSelesai: ' + totalKena + ' jadwal diisi Rambut.',
        'font-weight:bold');
      console.log('Aplikasi di layar ikut ter-update sendiri lewat listener-nya.');
    }
    return { totalKena, cabang: ringkas };
  }

  window.isiTreatment = isiTreatment;
  await isiTreatment();
})();
