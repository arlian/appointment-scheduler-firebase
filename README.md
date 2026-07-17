# Jadwal Treatment

Sistem manajemen penjadwalan customer untuk treatment, dengan auto-deteksi nama
customer yang sudah pernah terdaftar.

**Buka aplikasinya:** https://arlian.github.io/appointment-scheduler/

## Cara menjalankan

```bash
./jalankan.sh
```

Skrip ini menjalankan server Python di http://localhost:8000 dan membuka
browser otomatis. Hentikan dengan Ctrl+C. (Butuh Python 3, yang biasanya
sudah terpasang.)

Data tersimpan di **localStorage browser** — artinya data melekat pada browser
dan komputer yang dipakai. Kalau ganti browser/komputer atau menghapus data
situs (clear site data), datanya tidak ikut.

## Fitur

- **Auto-deteksi customer**: saat mengetik nama, sistem menampilkan saran
  customer lama (tidak peduli besar/kecil huruf). Jika cocok, muncul tanda
  "Customer terdeteksi" beserta riwayat kunjungannya; jika belum ada, otomatis
  tersimpan sebagai customer baru saat jadwal disimpan.
- **Daftar jadwal** dikelompokkan per tanggal, dengan penanda customer
  baru/lama dan jumlah kunjungan.
- **Cegah duplikat**: satu customer tidak bisa punya dua jadwal di tanggal dan
  jam yang sama persis.
- Hapus jadwal dengan tombol "Hapus".
