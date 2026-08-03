# Jadwal Treatment — versi Firebase (eksperimen)

Versi eksperimen dari [appointment-scheduler](https://github.com/arlian/appointment-scheduler)
yang menyimpan data di **Cloud Firestore**, bukan localStorage — jadi data yang
sama bisa dibuka dari HP, tablet, dan komputer mana pun setelah login dengan
akun salon. Tetap bisa dipakai offline; perubahan menyusul terkirim begitu
online lagi.

## Setup Firebase (sekali saja, ±10 menit)

Semua langkah dilakukan di https://console.firebase.google.com (login pakai
akun Google apa saja — akun Google ini hanya untuk mengelola, bukan untuk
login di aplikasinya).

**1. Buat project.** "Add project" → beri nama (mis. `jadwal-treatment`) →
Google Analytics boleh dimatikan → Create.

**2. Aktifkan login email/password.** Menu **Build → Authentication** → Get
started → tab **Sign-in method** → pilih **Email/Password** → aktifkan yang
atas saja (email link tidak perlu) → Save.

**3. Buat akun salon.** Masih di Authentication, tab **Users** → **Add user**
→ isi email dan password pilihanmu (emailnya tidak harus email sungguhan,
mis. `salon@jadwal.app`). Akun inilah yang dipakai login di semua perangkat.

**4. Tutup pendaftaran akun baru** (supaya orang lain tidak bisa bikin akun di
project-mu): Authentication → tab **Settings** → **User actions** → matikan
**Enable create (sign-up)**.

**5. Buat database.** Menu **Build → Firestore Database** → Create database →
lokasi pilih `asia-southeast2` (Jakarta) → mulai dalam **production mode** →
Create.

**6. Pasang Security Rules.** Di Firestore, tab **Rules**, ganti seluruh
isinya dengan ini lalu **Publish**:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Tiap akun hanya boleh membaca/menulis data di bawah UID-nya sendiri
    match /users/{uid}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }
  }
}
```

**7. Ambil config web.** Ikon gerigi → **Project settings** → bagian **Your
apps** → klik ikon web `</>` → beri nama bebas (hosting tidak perlu dicentang)
→ Register → pilih **Config** → salin objek `{ apiKey: ..., ... }` ke file
[`firebase-config.js`](firebase-config.js) di folder ini.

> Config ini aman berada di kode publik/GitHub — isinya hanya pengenal
> project, bukan kunci rahasia. Penjaga datanya adalah Security Rules
> (langkah 6) + login. Yang harus dirahasiakan cuma password akun salon.

**8. (Kalau nanti di-hosting)** Authentication → Settings → **Authorized
domains** → tambahkan domain tempat aplikasi dipasang (mis.
`arlian.github.io`). `localhost` sudah diizinkan sejak awal.

## Cara menjalankan

```bash
./jalankan.sh        # atau jalankan.bat di Windows
```

Server jalan di http://localhost:8010 (sengaja beda port dari versi asli yang
di 8000, supaya bisa jalan berdampingan dan datanya tidak tercampur).

Saat pertama dibuka akan muncul layar login — masuk pakai email/password dari
langkah 3. Login cukup sekali per perangkat.

## Migrasi data lama

Buka versi ini di browser/perangkat yang selama ini dipakai (yang datanya
paling lengkap di localStorage), lalu login. Kalau database masih kosong, data
lama otomatis terangkat ke Firestore. Data localStorage tidak dihapus, jadi
versi asli tetap utuh. Alternatifnya: export JSON dari versi asli → import di
versi ini.

## Fitur

Sama dengan versi asli (auto-deteksi customer, filter jadwal, salin format
WA, tandai selesai + pegawai, export/import), ditambah:

- **Sinkron antar perangkat** real-time: ubah jadwal di HP, layar komputer
  ikut berubah tanpa refresh.
- **Login akun salon** — data hanya bisa dibuka setelah login; tombol "Keluar
  dari akun" ada di bawah Export/Import.
- **Offline tetap jalan**: Firestore menyimpan salinan lokal; saat sinyal
  hilang aplikasi tetap bisa dipakai dan tersinkron ulang otomatis.
- **Tab Analitik** — ringkasan sebulan untuk cabang yang sedang dibuka, bisa
  digeser ke bulan mana pun lewat panah di atas:
  - dua angka utama (total treatment dan customer dilayani) lengkap dengan
    selisih terhadap bulan sebelumnya;
  - **kalender kepadatan** ala grafik kontribusi GitHub — tiap kotak satu hari,
    makin pekat makin ramai; tap satu kotak untuk langsung melihat jadwal hari
    itu di tab Jadwal;
  - **jam tersibuk** dalam bentuk batang;
  - tombol "Lihat angka dalam tabel" untuk membaca semua angkanya tanpa
    bergantung pada warna.
- **Multi-cabang**: tiap cabang punya data sendiri (customer, jadwal,
  pegawai). Cabang bawaan: **Puri, Kemayoran, Bandung** (data lama otomatis
  masuk ke cabang pertama). Ganti cabang lewat chip 📍 di bawah judul,
  tambah lewat "+ Cabang". Pilihan cabang diingat per perangkat — refresh
  atau buka ulang tetap di cabang terakhir yang dipilih. Export/import dan
  salinan WA mengikuti cabang yang sedang dibuka (nama cabang ikut
  tercantum di salinan WA).
