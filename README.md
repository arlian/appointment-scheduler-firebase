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
  atau buka ulang tetap di cabang terakhir yang dipilih. Export/import dan
  salinan WA mengikuti cabang yang sedang dibuka (nama cabang ikut
  tercantum di salinan WA).
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

Exo tidak bisa dipilih sendirian: tombolnya mati sampai Rambut dicentang, dan
begitu Rambut dilepas, Exo ikut lepas. Muka sebaliknya — boleh berdiri sendiri
tanpa Rambut.

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
jadi data aneh seperti `['exo']` tanpa Rambut ikut terjaring. Yang seperti itu
tidak ditimpa jadi Rambut saja — Rambut ditambahkan sebagai dasarnya dan Exo-nya
tetap. `Muka` yang berdiri sendiri memang sah, jadi tidak ikut tersapu.
Menjalankannya dua kali tidak mengubah apa pun lagi.

Cara penulisannya di daftar dan di salinan WhatsApp sengaja dibuat sama
persis. Rambut tidak ikut ditulis karena ia dasarnya; yang muncul cuma
tambahannya, atau justru ketiadaan rambutnya:

| Yang dicentang        | Yang tertulis di belakang nama |
| --------------------- | ------------------------------ |
| Rambut                | *(tidak ada)*                  |
| Rambut + Exo          | `Tama (+Exo)`                  |
| Rambut + Muka         | `Tama (+Muka)`                 |
| Rambut + Exo + Muka   | `Tama (+Exo & Muka)`           |
| Muka saja             | `Tama (Muka Only)`             |
| *(kosong)*            | *(tidak ada)*                  |

Tambahan lebih dari satu disambung "&", bukan dirangkai plus sendiri-sendiri:
`+Exo +Muka` terbaca seperti dua tanda yang kebetulan berdempetan, sedangkan
`+Exo & Muka` jelas satu tanda berisi dua hal.

Di bawah daftar jadwal — dan di ekor salinan WhatsApp, setelah "jumlah cust
baru" — ada rekap **jumlah tiap kombinasi** dari jadwal yang sedang tampil
(mis. `Rambut + Exo : 3`), diurutkan dari kombinasi terbanyak. Jadwal yang
jenisnya belum diisi masuk baris "Belum diisi" di paling bawah. Seluruh rekap
ini hilang sendiri kalau tidak ada satu pun jadwal yang jenisnya terisi, jadi
daftar lama tidak berbuntut tabel kosong.

Datanya disimpan di field `treatments` pada tiap jadwal, hanya kalau memang
ada isinya. Jadwal lama yang belum punya field ini tetap sah dan ikut
export/import seperti biasa.

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
namanya — bukan keterangan kecil di bawahnya, supaya langsung kelihatan waktu
daftarnya dibaca sekilas. Customer lama tetap memakai baris keterangan berisi
jumlah kunjungan bulan itu. Di salinan WhatsApp tandanya jadi 🆕 di ujung baris,
ditutup dua baris hitungan:

```
jumlah jadwal : 6
jumlah cust baru : 2
```

Nol tetap ditulis — barisnya sendiri yang menyebut apa yang dihitung, jadi yang
membaca tahu memang tidak ada, bukan sekadar lupa dicantumkan.

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
