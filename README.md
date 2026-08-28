# Jadwal Treatment — versi Firebase (eksperimen)

Versi eksperimen dari [appointment-scheduler](https://github.com/arlian/appointment-scheduler)
yang menyimpan data di **Cloud Firestore**, bukan localStorage — jadi data yang
sama bisa dibuka dari HP, tablet, dan komputer mana pun setelah login dengan
akun salon. Firestore adalah satu-satunya sumber kebenaran: tidak ada salinan
data yang menetap di perangkat, dan tanpa sambungan aplikasi hanya bisa dilihat
— perubahan ditahan sampai sambungan pulih.

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
WA, export/import), ditambah:

- **Sinkron antar perangkat** real-time: ubah jadwal di HP, layar komputer
  ikut berubah tanpa refresh.
- **Login akun salon** — data hanya bisa dibuka setelah login; tombol "Keluar
  dari akun" ada di bawah Export/Import.
- **Daftar jadwal yang tidak perlu dihitung manual**: total yang sedang tampil
  tercetak di atas daftar ("12 jadwal · 5 hari"), tiap judul tanggal membawa
  jumlah hari itu, dan tiap baris bernomor antrian yang mulai lagi dari 1 di
  setiap tanggal.
- **Pindah hari** lewat sepasang tombol tepat di atas daftar, muncul saat yang
  tampil memang satu hari saja ("Hari Ini" atau tanggal pilihan). Tanggal yang
  dituju tertulis di tombolnya. Kembali ke tanggal hari ini, filternya balik
  jadi "Hari Ini" sendiri.
- **Cari nama → riwayat kunjungan**: chip "Cari Nama" di baris filter membuka
  kotak nama; pilih satu customer, daftar jadwal berganti jadi seluruh
  kunjungannya (semua tanggal, tanpa batas bulan), dengan ringkasan "8x
  kunjungan · pertama 3 Mar 2026 · terakhir 11 Agu 2026" di atasnya. Jalan
  pintasnya: tap nama customer di baris jadwal mana pun. Tombol chip-nya
  ditekan lagi untuk kembali ke "Hari Ini". Riwayat terbatas pada cabang yang
  sedang dibuka — customer dan jadwal memang tersimpan per cabang.
- **Jenis treatment** (lihat bagian di bawah).
- **Tampilan gelap** (lihat bagian di bawah).
- **Server satu-satunya sumber kebenaran**: tidak ada cache data yang menetap
  di perangkat. Saat sinyal hilang muncul palang merah dan perubahan ditolak,
  supaya perangkat yang datanya tertinggal tidak bisa menimpa data terbaru.
  Tiap dokumen ditulis utuh sekali kirim, jadi tulisan dari layar yang basi
  akan menghapus apa pun yang ditambahkan perangkat lain. Palangnya sendiri
  ditahan 3 detik sebelum muncul: snapshot pertama Firestore hampir selalu
  datang dari cache dan jawaban server menyusul sepersekian detik kemudian,
  jadi tanpa jeda itu palangnya berkedip tiap kali aplikasi dibuka. Yang
  ditahan cuma tampilannya — penolakan perubahan tetap berlaku sejak detik
  pertama sambungan dianggap putus.
- **Tersambung ≠ siap menulis**: status sambungan dibaca dari snapshot daftar
  cabang, yang sampai lebih dulu daripada isi cabangnya. Di jeda itu aplikasi
  merasa sudah tersambung padahal customers/appointments/staff masih array
  kosong, dan menyimpan apa pun akan mengirim array yang cuma berisi baris baru
  — seluruh isi dokumen di server tertimpa. Itu yang menghabiskan data Puri dan
  Kemayoran pada 22 Agustus 2026. Sekarang tiap dokumen punya penanda "sudah
  termuat" sendiri, dan penyimpanan ditolak sampai ketiganya sampai, dengan
  pesan yang membedakan "belum tersambung" dari "data masih dimuat". Snapshot
  yang menyala untuk cabang yang sudah bukan cabang aktif diabaikan, dan daftar
  cabang tidak pernah ditulis sebelum jawaban server yang pertama diterima.
  Menghapus jadwal terakhir di satu cabang tetap boleh — kosong karena
  dikosongkan operator memang beda dengan kosong karena belum dimuat.
- **Rencana lanjutan (belum dikerjakan)**: memecah `{rows: [...]}` menjadi satu
  dokumen per customer dan per jadwal, supaya satu penyimpanan cuma menyentuh
  satu dokumen dan seluruh kelas bug "tulisan utuh menimpa segalanya" hilang
  secara struktur, bukan cuma dijaga gerbang.
- **Tab Analitik** — ringkasan sebulan untuk cabang yang sedang dibuka, bisa
  digeser ke bulan mana pun lewat panah di atas:
  - tiga angka utama (total treatment, customer dilayani, dan customer baru)
    lengkap dengan selisih terhadap bulan sebelumnya. "Customer baru" dihitung
    dari kunjungan pertama yang tercatat, bukan dari tanda **Baru** di daftar
    jadwal — tanda itu memakai jumlah kunjungan sampai hari ini, jadi angka
    bulan lalu akan menyusut sendiri tiap kali dibuka;
  - **kombinasi treatment** — porsi tiap kombinasi dari seluruh treatment bulan
    itu, lengkap dengan persennya, dibaca dengan bentuk yang sama seperti
    komposisi gender. Jadwal yang jenisnya belum diisi ikut terhitung sebagai
    barisnya sendiri (abu-abu, selalu paling bawah) supaya persen yang lain
    tidak melar; kalau sebulan itu tidak ada satu pun yang diisi, kartunya
    berisi keterangan, bukan satu batang "Belum diisi 100%";
  - **kalender kepadatan** ala grafik kontribusi GitHub — tiap kotak satu hari,
    dengan jumlah treatment tercetak langsung di dalamnya (jadi tetap kebaca di
    HP, yang tidak punya hover) dan warna makin pekat makin ramai; tap satu
    kotak untuk langsung melihat jadwal hari itu di tab Jadwal;
  - **jam tersibuk** dalam bentuk batang;
  - **komposisi gender** (lihat bagian di bawah);
  - tombol **"Salin sebagai Gambar"** — seluruh ringkasan bulan itu jadi satu
    gambar PNG yang langsung masuk clipboard, tinggal paste di WhatsApp. Kalau
    browsernya tidak bisa menyalin gambar, otomatis pindah ke share sheet HP,
    dan kalau itu pun tidak ada, filenya diunduh;
  - tombol "Lihat angka dalam tabel" untuk membaca semua angkanya tanpa
    bergantung pada warna.
- **Konfirmasi customer baru** (lihat bagian di bawah).
- **Multi-cabang**: tiap cabang punya data sendiri (customer, jadwal,
  pegawai). Cabang bawaan: **Puri, Kemayoran, Bandung** (data lama otomatis
  masuk ke cabang pertama). Ganti cabang lewat chip 📍 di bawah judul,
  tambah lewat "+ Cabang". Pilihan cabang diingat per perangkat — refresh
  atau buka ulang tetap di cabang terakhir yang dipilih. Salinan WA
  mengikuti cabang yang sedang dibuka (nama cabang ikut tercantum di
  salinannya), sedangkan export/import berlaku untuk semua cabang
  sekaligus (lihat bagian di bawah).
- **Gender customer** (lihat bagian di bawah).

## Jenis treatment

Saat menambah jadwal ada tiga pilihan yang bisa dicentang lebih dari satu:
**Rambut** (tercentang sendiri, karena itu yang paling sering), **Exo**, dan
**Muka**. Boleh dikosongkan semua — jadwal yang jenisnya belum ditanyakan
tetap bisa disimpan. Jenisnya juga bisa diperbaiki belakangan lewat sheet
"Ubah Jadwal" (tekan lama pada barisnya).

Tombol yang terpilih ditandai dua kali: latarnya jadi merah, dan muncul cakram
putih bercentang merah di pojok kanan atas. Warna saja tidak cukup — yang tidak
bisa membedakan merah dari putih tetap harus bisa membaca mana yang aktif, dan
bentuk centang mengerjakan itu tanpa bergantung pada warna.

Cakramnya putih dengan centang merah, bukan sebaliknya. Penanda yang berdiri di
atas latar merah harus dibedakan oleh terang-gelapnya, bukan oleh hue lain:
cakram putih 4.62:1 terhadap tombol, sedangkan cakram berwarna yang sama
gelapnya (hijau, misalnya) cuma 1.34:1 — hasilnya menabrak, bukan menonjol.

Ketiganya berdiri sendiri-sendiri: boleh dicentang satu, dua, atau ketiganya,
dan tidak ada yang mensyaratkan yang lain. Exo maupun Muka sah tanpa Rambut.
Rambut cuma istimewa waktu ditulis (lihat tabel di bawah), bukan waktu dipilih.

### Mengisi jadwal lama yang jenisnya kosong

Jadwal dari masa sebelum fitur ini ada tidak punya jenis sama sekali. Untuk
mengisinya sekaligus dengan Rambut ada [`isi-treatment.js`](isi-treatment.js) —
skrip sekali pakai yang **bukan bagian dari aplikasi**: tidak dimuat
`index.html`, tidak ikut di-cache service worker, dan tidak menambah apa pun ke
layar. Perkakas perawatan tidak perlu menempati aplikasi selamanya.

1. Buka aplikasinya di browser komputer, lalu login seperti biasa.
2. **Tutup aplikasinya di perangkat lain.** Tiap dokumen ditulis utuh sekali
   kirim, jadi layar lain yang ikut menyimpan bisa menimpa hasil skrip ini.
3. Buka DevTools (F12) → tab **Console**.
4. Tempel seluruh isi file, tekan Enter. Yang jalan cuma pemeriksaan — belum
   ada satu pun data yang berubah, dan cadangan seluruh jadwal otomatis
   terunduh sebagai JSON.
5. Periksa tabel yang tercetak. Kalau sudah cocok:
   `await isiTreatment({ tulis: true })`

Skrip menumpang sesi login yang sudah ada di halaman, jadi tidak ada password
yang perlu diketik dan tidak ada service account yang perlu diunduh. Ia juga
menjangkau **semua cabang** sekali jalan, bukan cuma yang sedang dibuka.

Yang dianggap kosong adalah yang tidak menyisakan apa pun setelah dirapikan,
jadi jadwal yang isinya cuma kode tak dikenal ikut terjaring. Satu jenis saja —
termasuk `Exo` atau `Muka` sendirian — sudah terhitung terisi dan tidak
disentuh. Menjalankannya dua kali tidak mengubah apa pun lagi.

Cara penulisannya di daftar dan di salinan WhatsApp sengaja dibuat sama
persis. Rambut tidak ikut ditulis karena ia dasarnya; yang muncul cuma
tambahannya, atau justru ketiadaan rambutnya:

| Yang dicentang        | Yang tertulis di belakang nama |
| --------------------- | ------------------------------ |
| Rambut                | *(tidak ada)*                  |
| Rambut + Exo          | `Tama (+Exo)`                  |
| Rambut + Muka         | `Tama (+Muka)`                 |
| Rambut + Exo + Muka   | `Tama (+Exo & Muka)`           |
| Exo saja              | `Tama (Exo Only)`              |
| Muka saja             | `Tama (Muka Only)`             |
| Exo + Muka            | `Tama (Exo & Muka Only)`       |
| *(kosong)*            | *(tidak ada)*                  |

Tambahan lebih dari satu disambung "&", bukan dirangkai plus sendiri-sendiri:
`+Exo +Muka` terbaca seperti dua tanda yang kebetulan berdempetan, sedangkan
`+Exo & Muka` jelas satu tanda berisi dua hal.

Di bawah daftar jadwal ada rekap **jumlah tiap kombinasi** dari jadwal yang
sedang tampil
(mis. `Rambut + Exo : 3`), diurutkan dari kombinasi terbanyak. Jadwal yang
jenisnya belum diisi masuk baris "Belum diisi" di paling bawah. Seluruh rekap
ini hilang sendiri kalau tidak ada satu pun jadwal yang jenisnya terisi, jadi
daftar lama tidak berbuntut tabel kosong. Rekapnya **cuma di layar** — salinan
WhatsApp tidak membawanya.

Datanya disimpan di field `treatments` pada tiap jadwal, hanya kalau memang
ada isinya. Jadwal lama yang belum punya field ini tetap sah dan ikut
export/import seperti biasa.

## Cari slot kosong

Tombol **Slot Kosong** di kepala kartu Daftar Jadwal. Yang dicari bukan "jam
yang tidak ada jadwalnya", melainkan **jam yang masih ada pegawai menganggur**.
Dua pegawai berarti dua jadwal boleh tumpang tindih; yang ketiga barulah membuat
jamnya penuh.

Karena itu tiap jadwal dihitung sebagai rentang `[mulai, selesai)` menurut
perkiraan durasinya, bukan sebagai satu titik jam.

**Jam kerja 09:00–17:00.** Slot dihitung muat kalau seluruhnya masih di dalam
jam itu — treatment yang baru selesai lewat jam tutup tidak dianggap muat.
Jadwal yang mulai sebelum jam buka tetap menyita pegawai selama sisa
durasinya masih menyeberang ke dalam jendela.

### Perkiraan durasi

| Kombinasi | Menit |
|---|---|
| Rambut | 30 |
| Exo | 30 |
| Muka | 40 |
| Rambut + Exo | 60 |
| Rambut + Muka | 60 |
| Exo + Muka | 60 |
| Rambut + Exo + Muka | 70 |

Angkanya perkiraan dari yang mengerjakan, bukan hasil hitungan. Tempatnya di
`DURASI_TREAT` pada [app.js](app.js) — satu tabel, dan daftar pilihan durasi di
sheet-nya dibangun dari tabel itu juga, jadi menambah jenis treatment cukup
diubah di satu tempat.

Jadwal yang **jenisnya belum diisi** dihitung 30 menit, sama dengan rambut —
jenis yang paling sering dan yang sudah tercentang duluan di form.

### Yang bisa diatur

- **Pegawai** — bawaannya 2, bisa diubah 1–20. Ini angka **bawaan untuk semua
  hari**; tiap tanggal punya kotaknya sendiri di judul harinya, karena jumlah
  pegawai memang bisa beda tiap hari.

  Yang disimpan cuma hari yang benar-benar disetel sendiri. Selebihnya ikut
  angka bawaan — jadi mengubah bawaannya langsung berlaku untuk semua hari yang
  belum disentuh, dan hari yang sudah disetel tidak ikut tergeser. Hari yang
  angkanya berbeda dari bawaan diberi tanda warna, supaya tidak ada hari yang
  diam-diam dihitung dengan angka lain tanpa terlihat. Mengetik angkanya balik
  sama dengan bawaan menghapus penyimpangannya, bukan menyimpannya sebagai angka
  yang kebetulan sama.

  Mengubah angka satu hari cuma membangun ulang blok hari itu, bukan seluruh
  daftar — kalau seluruhnya dibangun ulang, kotak yang sedang diketik ikut
  terhapus dan kursornya lompat keluar di tengah pengetikan.
- **Cari jadwal untuk jenis** — tombol centang Rambut / Exo / Muka, **sama
  persis dengan pemilih di form isi jadwal**. Sengaja bukan dropdown berisi
  tujuh kombinasi jadi: yang dipikirkan operator "rambut sama muka", bukan
  mencari baris "Rambut + Muka" di sebuah daftar. Durasinya muncul sendiri di
  bawah tombolnya begitu jenisnya dicentang, dan hasilnya langsung dihitung
  ulang tanpa perlu menekan apa pun.

  **Rambut tercentang tiap kali sheet-nya dibuka** — bukan cuma sekali waktu
  halaman dimuat. Sama seperti form isi jadwal yang juga kembali ke
  `TREAT_BAWAAN` sesudah tiap simpan: pencarian berikutnya hampir selalu untuk
  rambut lagi, dan centang sisa pencarian sebelumnya diam-diam mengubah
  jawabannya tanpa ada yang menyadari.

  Rentang yang terlalu pendek tetap ditampilkan tapi diredupkan, lengkap dengan
  keterangan kurang berapa lama. Celah yang ada tetap perlu terlihat supaya
  operator tahu jadwal mana yang tinggal digeser sedikit.

Pemilih jenisnya memakai komponen yang sama (`pasangTreatSeg`) dengan form isi
dan sheet ubah. Komponen itu diberi dua kait opsional — keterangan sendiri dan
pemberitahuan saat pilihannya berubah — sedangkan dua pemakai lama tidak
melewatkan apa pun dan tetap berperilaku seperti semula.

### Hari mana yang diperiksa

Mengikuti **filter tanggal yang sedang dipilih**, dan sengaja dihitung dari
filternya — bukan dari jadwal yang tampil. Hari yang kosong melompong justru
yang paling perlu muncul di sini, dan hari seperti itu tidak akan pernah lahir
dari daftar jadwal. Filter yang tidak menunjuk hari tertentu ("Semua", atau
rentang tanggal yang belum diisi lengkap) memakai tanggal yang memang ada
jadwalnya, dibatasi 31 hari sekali jalan.

Jumlah pegawai yang menyita dihitung dari **seluruh jadwal hari itu**, termasuk
yang sedang disaring keluar layar oleh mode riwayat satu customer.

### Salin slot ke WhatsApp

Tombol **Salin untuk WA** di dalam sheet-nya. Isinya sengaja **cuma rentang
jamnya**:

```
*SLOT KOSONG PURI* 🕒

📅 *Selasa, 1 September 2026*
16:15 – 17:00

📅 *Rabu, 2 September 2026*
09:00 – 17:00
```

Tidak ada jumlah pegawai luang, tidak ada lama rentangnya. Yang dikirim ke
customer adalah tawaran jam; sisanya catatan kerja yang tidak ada urusannya di
sana.

Dua hal yang disaring diam-diam, dan keduanya disengaja:

- **Rentang yang tidak muat** untuk jenis yang sedang dicari tidak ikut.
  Menawarkan celah 20 menit untuk treatment 60 menit sama saja dengan tidak
  menawarkan.
- **Hari yang penuh tidak ditulis sama sekali.** Daftar ini isinya tawaran;
  baris "penuh" cuma memanjangkan pesan tanpa menambah pilihan.

Kalau tidak ada satu pun rentang yang muat, tidak ada yang disalin — yang keluar
pesan galat, bukan pesan berisi judul saja.

Nama cabang ikut di judul hanya kalau cabangnya lebih dari satu, aturan yang
sama dengan salinan daftar jadwal. Kode clipboard-nya dipakai bersama kedua
tombol salin (`salinTeks`), termasuk jalur cadangan untuk browser tanpa
Clipboard API.

### Hari dan jam yang sudah lewat dilewati

Slot yang sudah lewat tidak bisa diisi lagi, jadi tidak ikut dicari:

- **Hari sebelum hari ini dibuang**, berapa pun rentang filternya. Filter
  "Seminggu ke Belakang" jadi menyisakan hari ini saja; kalau seluruh harinya
  sudah lewat — misalnya satu tanggal di bulan lalu — hasilnya berbunyi apa
  adanya, bukan daftar kosong tanpa keterangan. Berapa hari yang dilewati
  disebut di baris ringkasan.
- **Hari ini dipotong dari jam sekarang**, dibulatkan ke atas ke kelipatan 15
  menit. Slot yang berbunyi "14:07" terbaca seperti salah hitung; 14:15 itu jam
  yang memang dipakai orang waktu membuat janji. Judul harinya diberi tanda
  "sisa hari ini" supaya jelas angkanya bukan hitungan sehari penuh.
- Kalau jam kerja hari ini memang sudah habis, yang tertulis "Jam kerja hari ini
  sudah lewat" — bukan "Penuh". Dua sebab yang berbeda: penuh berarti masih bisa
  digeser ke besok, jam kerja habis berarti hari itu memang sudah tutup.

## Jadwal disimpan per bulan

Susunan di Firestore:

```
users/{uid}/data/branches                      -> { rows: [{id, name}, ...] }
users/{uid}/cabang/{id}/data/customers         -> { rows: [...] }
users/{uid}/cabang/{id}/data/staff             -> { rows: [...] }
users/{uid}/cabang/{id}/appointments/{YYYY-MM} -> { rows: [...] }   <- satu dokumen per bulan
users/{uid}/cabang/{id}/photos/{fotoId}
```

Customer dan pegawai tetap satu dokumen — jumlahnya tumbuh pelan dan seluruh
isinya memang selalu dibutuhkan sekaligus. **Jadwal dipecah per bulan.**

Alasannya batas keras Firestore: **satu dokumen berhenti di 1 MiB**. Dengan
~270 jadwal per bulan di cabang tersibuk dan ~156 byte per baris, riwayat yang
ditumpuk di satu dokumen menabrak batas itu dalam belasan bulan — dan sejak
saat itu tidak ada jadwal baru yang bisa disimpan sama sekali. Dipecah per
bulan, tiap dokumen berhenti tumbuh di akhir bulannya: yang terbesar sekarang
~43 KB, dan tidak akan pernah mendekati batas itu.

Efek keduanya sama pentingnya. Dulu mencentang satu jadwal berarti mengirim
ulang **seluruh riwayat** cabang itu — 81 KB untuk mengubah satu baris.
Sekarang yang dikirim cuma dokumen bulan yang tersentuh. Mengubah tanggal
jadwal ke bulan lain menulis dua dokumen: bulan asal dan bulan tujuan, supaya
barisnya tidak tertinggal di keduanya sekaligus.

Yang **tidak** berubah: `appointments` di memori tetap satu array datar berisi
seluruh riwayat, digabung dari semua dokumen bulanan waktu cabangnya dibuka.
Filter, hitungan kunjungan, riwayat per customer, dan analitik semuanya
membacanya persis seperti sebelum dipecah — jadi "customer baru" tetap dihitung
dari seluruh riwayat, bukan dari bulan yang kebetulan sedang tampil.

### Pemindahan dari susunan lama — sudah selesai

Sampai 28 Agustus 2026 jadwal tersimpan di satu dokumen `data/appointments`
berisi seluruh riwayat cabang. Pemindahannya berjalan otomatis waktu tiap
cabang dibuka, dalam satu transaksi: dokumen lama dibaca, dipecah jadi dokumen
bulanan, lalu dokumen lamanya dihapus.

Ketiga cabang sudah dipindahkan, jadi **kode pemindahannya sudah dihapus**.
Konsekuensinya: kalau suatu saat ada cabang yang isinya masih di
`data/appointments` — misalnya hasil pemulihan cadangan lama langsung di
Firestore console — cabang itu akan tampil **tanpa jadwal sama sekali**.
Dokumen lamanya tidak dibaca lagi oleh layar utama.

Satu jaring pengaman sengaja ditinggalkan: **export tetap membaca dokumen
lama** dan menggabungnya dengan dokumen bulanan ([`bacaCabang()`](app.js)).
Jadi kalau ada isi yang tertinggal di susunan lama, file cadangan tetap
memuatnya utuh — dan mengimpor file itu kembali akan mendudukkannya di dokumen
bulanan yang benar.

Security rules tidak perlu diubah: `match /users/{uid}/{document=**}` sudah
mencakup koleksi baru ini.

## Export & import — semua cabang sekaligus

Satu file JSON = satu cadangan utuh: isinya **semua cabang**, bukan cuma
cabang yang sedang dibuka. Tidak perlu lagi berpindah cabang tiga kali untuk
mencadangkan tiga cabang, dan tidak ada lagi cabang yang tidak punya cadangan
gara-gara lupa dipindahi.

**Export** membaca isi tiap cabang langsung dari server, bukan dari yang
sedang tampil di layar — layar cuma memuat satu cabang. Karena itu tombolnya
butuh sambungan; kalau palang merah sedang muncul, export ditolak dengan
alasannya. Selama berjalan tombolnya berubah jadi "Menyiapkan…" dan
tombol Import ikut terkunci.

**Import** mencocokkan cabang di file dengan cabang di sini **berdasarkan
nama** (huruf besar/kecil tidak dibedakan). Cabang yang namanya belum ada
**dibuat otomatis**, jadi file dari akun atau perangkat yang cabangnya lebih
banyak tetap masuk utuh tanpa ada datanya yang hilang diam-diam. Karena
sekarang yang tersentuh bisa cabang yang tidak sedang dilihat, daftar cabang
tujuan dan cabang baru yang akan dibuat dikonfirmasi dulu sebelum apa pun
ditulis.

Penggabungan per cabang aturannya sama seperti dulu: customer dicocokkan
berdasarkan nama, jadwal yang customer + tanggal + jamnya sudah ada dianggap
duplikat dan dilewati. **Import tidak pernah menghapus** — yang masuk hanya
tambahannya.

### Kenapa import pakai transaksi

Baca-gabung-tulis dijalankan sebagai **satu transaksi Firestore per cabang**,
begitu juga penulisan daftar cabang. Alasannya sama dengan yang membuat
seluruh aplikasi ini paranoid soal penyimpanan: tiap dokumen ditulis utuh
sekali kirim, jadi kalau ada jeda antara membaca isi cabang dan menuliskannya
kembali, apa pun yang ditulis perangkat lain di jeda itu akan hilang tertimpa
hasil gabungan yang dihitung dari isi sebelum perubahannya. Transaksi menutup
jeda itu: kalau isinya berubah di tengah jalan, Firestore mengulang
penggabungan di atas isi yang baru, bukan menimpanya.

Efek keduanya, satu cabang masuk sekali jalan — customer, pegawai, dan semua
dokumen bulan yang tersentuh file itu — tidak ada lagi keadaan setengah jadi
berisi customer yang jadwalnya belum ikut karena sambungan putus di tengah
beberapa penulisan berurutan.

Yang dibaca dan dikunci transaksinya cuma dokumen bulan yang benar-benar
disebut file itu, bukan seluruh riwayat cabang. Bulan yang semua jadwalnya
ternyata sudah ada tidak ditulis ulang sama sekali.

Daftar cabang juga dibaca ulang dari server di dalam transaksinya, bukan dari
daftar yang ada di layar. Kalau perangkat lain menambah cabang sesudah
snapshot terakhir sampai ke sini, menulis balik daftar versi layar akan
menghapus cabang itu dari daftar dan membuat seluruh isinya yatim: masih ada
di Firestore, tapi tidak ada lagi yang bisa membukanya. Satu penjaga lagi:
kalau daftar cabang di server terbaca **kosong** padahal di layar ada isinya,
import dibatalkan tanpa menulis apa pun — itu tanda bahaya yang sama yang
sudah dijaga di tempat lain.

Kalau satu cabang gagal (sambungan putus, transaksinya kalah bentrok berkali-
kali), cabang lain tetap dilanjutkan dan nama yang gagal disebutkan di pesan
akhir. Aman diulang dengan file yang sama: yang sudah masuk terhitung duplikat
dan dilewati, jadi import kedua hanya melengkapi sisanya.

**File cadangan lama tetap bisa dipakai.** File tanpa daftar cabang dianggap
milik cabang yang sedang dibuka, persis seperti perilaku versi sebelumnya.
Sebaliknya, file baru juga masih bisa dibaca perangkat yang aplikasinya belum
diperbarui: di luar daftar cabang, isi cabang yang sedang dibuka ikut ditulis
dalam bentuk lama, jadi perangkat itu dapat satu cabang — bukan pesan
"format tidak dikenali".

Foto hasil treatment tidak ikut file JSON (tersimpan sebagai dokumen
tersendiri di Firestore); yang terbawa adalah customer, jadwal, dan daftar
pegawai.

## Tandai selesai — sedang dimatikan

Fitur centang selesai (pegawai yang menangani + foto hasil treatment) untuk
sementara dihilangkan dari layar karena belum diperlukan: lingkaran centang di
tiap jadwal, panel isian pegawai/foto, tanda "Selesai" di daftar, dan ✅ di
salinan WhatsApp semuanya tidak ada lagi.

Yang hilang cuma tampilannya. Data yang terlanjur tercatat — field
`done`/`staff`/`photos` di tiap jadwal, daftar pegawai, dan dokumen foto di
koleksi `photos` — tetap utuh di Firestore dan tetap ikut export/import, jadi
fiturnya bisa dipasang lagi kapan saja tanpa ada yang perlu diisi ulang. Satu
hal yang tetap jalan diam-diam: foto ikut terhapus kalau jadwal induknya
dihapus, supaya tidak ada foto yatim yang menumpuk tanpa bisa dijangkau.

## Customer baru atau customer lama yang belum tercatat

Nama yang belum ada di sistem belum tentu orang baru — banyak customer lama
yang selama ini cuma tercatat di buku. Kalau semuanya ikut terhitung baru,
label "customer baru" di daftar jadwal jadi tidak ada artinya.

Karena itu, begitu **Simpan Jadwal** ditekan untuk nama yang belum dikenal,
muncul dulu satu panel dengan dua pilihan:

- **Customer baru** — memang benar-benar baru.
- **Customer lama, baru dicatat** — sudah lama datang, cuma belum pernah masuk
  sistem. Jawaban ini tersimpan di data customer (`sudahLama`), jadi jadwalnya
  langsung tertulis "customer lama" sejak kunjungan pertama yang tercatat,
  bukan menunggu kunjungan kedua.

Nama yang **mirip** ikut ditampilkan di panel itu, lengkap dengan jumlah
kunjungannya, dan bisa langsung dipakai lewat tombol "Ini orangnya". Ini
penjaga terhadap customer kembar: salah ketik satu huruf atau sapaan yang beda
("Ci Lulu" vs "Cici Lulu") diam-diam membuat orang yang sama jadi dua data, dan
riwayat kunjungannya ikut terbelah. Kemiripan dinilai setelah sapaan dan tanda
baca dibuang: nama yang satu memuat yang lain, ada kata yang sama persis, atau
bedanya cuma satu-dua huruf (nama pendek dibatasi satu huruf — pada nama empat
huruf, beda dua huruf sudah orang lain).

Nama yang sudah terdaftar tidak lewat panel ini sama sekali; alurnya persis
seperti sebelumnya, langsung tersimpan.

**Menandainya.** Di daftar jadwal, customer baru dapat tanda **Baru** di sebelah
namanya, supaya langsung kelihatan waktu daftarnya dibaca sekilas. Customer lama
tidak diberi keterangan apa-apa — tiap jadwal cukup satu baris, dan jumlah
kunjungannya justru lebih lengkap terbaca di riwayat, sejauh tap namanya. Di
salinan WhatsApp tandanya jadi 🆕 di ujung baris.

## Gender customer

Versi awal aplikasi ini tidak punya kolom gender sama sekali. Yang menyelamatkan
keadaan: nama customer selalu ditulis lengkap dengan sapaannya, dan sapaan itu
sudah menunjukkan gendernya.

**Saat mendaftar.** Di bawah nama ada pilihan **Perempuan / Laki-laki** yang
terisi sendiri begitu namanya diketik — "Ci Lulu" langsung ke perempuan, "Ko
Hans" ke laki-laki. Biasanya tidak perlu disentuh sama sekali. Kalau sapaannya
tidak dikenali, pilihannya kosong dan jadwal tidak bisa disimpan sebelum
gendernya dipilih, supaya tidak ada lagi data yang bolong.

**Kamus sapaannya:**

| | Sapaan |
|---|---|
| Perempuan | Ci, Cici, Cece, Ibu, Bu, Mama, Mami, Tante, Mbak, Nyonya, Nona, Istri |
| Laki-laki | Ko, Koko, Pa, Pak, Bapa, Bapak, Om, Mas, Papa, Papi, Tuan, Suami, Ps (Pastur), Romo |
| Tidak menunjuk gender | Anak, Cucu, Ponakan, Adik, Kakak, Temen, Pdt, Dr, Drg |

Yang dibaca hanya **sapaan pertama**, karena nama sering menyebut orang lain di
belakangnya — "Ko Roy Suami Ci Marinee" tetap laki-laki, "Ci Aling Mama Ko Hans"
tetap perempuan. Kelompok ketiga sengaja menghentikan pembacaan: tanpa itu "Anak
Ci Kiwi" akan terbaca perempuan, padahal "Ci" di situ ibunya. *Pdt* (Pendeta)
tidak dianggap laki-laki karena pendeta perempuan itu biasa; *Ps* (Pastur)
dianggap laki-laki.

**Data lama.** Customer yang terdaftar sebelum ada kolom ini ikut terisi sendiri
dengan kamus yang sama, dan hasilnya ditulis balik ke Firebase — jadi gender
benar-benar tersimpan sebagai data, bukan ditebak ulang tiap kali dibuka. Dari
84 customer di data awal, 83 langsung terisi; sisanya yang sapaannya tidak
menunjuk gender dibiarkan kosong supaya kelihatan dan bisa dilengkapi manual.

**Membacanya.** Kartu **Komposisi Gender** di tab Analitik menampilkan jumlah
treatment per gender untuk bulan yang sedang dibuka, lengkap dengan persentase
dan selisihnya terhadap bulan sebelumnya (▲ +12 / ▼ −3 / ±0). Panjang batangnya
dihitung terhadap **total bulan itu**, bukan terhadap gender terbanyak — jadi
batang yang terisi separuh memang berarti separuh dari semua treatment, sama
dengan persen di sebelahnya, dan semua batang kalau dijumlah pas 100%. Arah naik-turun
terbaca dari panah dan angkanya, bukan dari warna saja. Baris *Belum diketahui*
cuma muncul kalau memang masih ada sisanya.

**Mengoreksi.** Tombol **"Koreksi gender"** di bawah grafik Komposisi Gender
menampilkan semua customer yang punya jadwal di bulan itu, yang belum ketahuan
di urutan paling atas. Bisa juga langsung diperbaiki lewat pilihan gender di
form saat membuat jadwal berikutnya. Pilihan manual ditandai khusus: ia tidak
akan tertimpa tebakan kalau namanya diedit, dan tidak tertimpa saat import.
Sebaliknya, gender yang masih hasil tebakan akan dibaca ulang kalau sapaan di
namanya diperbaiki.

## Tampilan gelap

Tombol bulan/matahari di pojok kanan atas. Ikon dan keterangannya selalu
menyebut tampilan yang *akan didapat* kalau ditekan, bukan yang sedang
dipakai — tombol yang menggambarkan keadaan sekarang selalu ambigu: ditekan
untuk mempertahankannya atau untuk menggantinya?

**Sebelum pernah ditekan, tampilan ikut setelan HP.** Jadi HP yang punya
jadwal gelap otomatis saat malam akan ikut berganti sendiri, tanpa ada yang
perlu diatur. Sekali tombolnya ditekan, pilihan itu yang menang dan diingat
per perangkat (seperti pilihan cabang) — HP kasir dan layar di meja depan
boleh beda, karena tema itu urusan mata orang yang sedang memegang, bukan
data salon.

**Tidak ada mode ketiga "ikut sistem".** Kalau tema yang dipilih ternyata sama
dengan setelan HP-nya, penandanya justru dihapus — menekan tombolnya sampai
kembali cocok dengan HP membuat aplikasinya ikut HP lagi dengan sendirinya.
Satu tombol, dua keadaan, tanpa keadaan tersembunyi yang harus dijelaskan di
layar.

**Yang ikut berganti.** Seluruh tampilan memakai token warna di `:root`, jadi
tema gelap cuma menimpa nilai tokennya — termasuk gambar PNG "Salin sebagai
Gambar", karena `warnaViz()` di app.js membaca token yang sama. Gambar yang
dikirim ke WhatsApp mengikuti tampilan layar yang menekan tombolnya. Pemilih
tanggal dan jam bawaan browser ikut lewat `color-scheme`, supaya kalendernya
tidak muncul putih menyilaukan di tengah layar gelap.

**Warnanya.** Latarnya hitam keplum, bukan abu-abu netral — tema terang pun
putihnya dicondongkan ke merah muda, dan abu-abu netral membuat warna merek
di atasnya terbaca seperti warna nyasar. Merah muda mereknya (`#d6336c`)
sengaja tidak diubah untuk isian tombol: di situ tulisannya putih, dan warna
itu yang menjaga kontrasnya tetap lolos 4.5:1. Yang dibalik cuma warna
*tulisan* merek, yang di latar gelap justru harus dimudakan.

Ramp kalender kepadatan dibalik arahnya: di tema terang ia berjalan dari
terang ke pekat, di tema gelap dari pekat ke terang — yang ramai tetap yang
paling menonjol dari latarnya. Dua langkah teratasnya persis dua langkah
terbawah tema terang, jadi warnanya masih warna merek, dan angka di dalam
kotaknya tetap lolos 4.5:1 tanpa aturan tinta yang perlu diubah.
