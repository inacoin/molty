# Molty Royale Multi-Manager

AI Agent untuk Molty Royale Battle Royale. Manajer ini memungkinkan Anda untuk mengelola banyak akun secara bersamaan dengan fitur seperti pembuatan massal (bulk creation), pemantauan transaksi, dan permainan otomatis.

## 🚀 Fitur
- **Dukungan Multi-Akun**: Kelola banyak akun dari satu antarmuka.
- **Pembuatan Massal (Bulk Create)**: Membuat banyak akun dengan cepat menggunakan pola yang dapat disesuaikan.
- **Log Real-time**: Pantau aktivitas bot dan log permainan secara langsung.
- **Notifikasi Telegram**: Dapatkan notifikasi saat akun baru dibuat dan backup database otomatis.
- **Riwayat Transaksi**: Lihat riwayat transaksi detail untuk setiap akun.
- **Mode Ganda**: Pilih antara Mode Terintegrasi (Hemat Memori) dan Mode Terisolasi (Performa Tinggi).

## 🛠️ Cara Penggunaan dengan Google Colab

Ikuti langkah-langkah berikut untuk menjalankan manajer di [Google Colab](https://colab.google/):

1. **Buka Google Colab**: Kunjungi [colab.google](https://colab.google/).
2. **Notebook Baru**: Klik `File` -> `New notebook`.
3. **Hubungkan Runtime**: Klik tombol `Connect` di pojok kanan atas.
4. **Tambah Kode**: Salin blok kode berikut ke dalam sel kode dan jalankan:

```bash
!apt update
!apt install unzip
!git clone https://github.com/inacoin/molty.git
%cd molty
!npm install
!node manager.js
```

## 🤖 Integrasi Telegram

Untuk mendapatkan notifikasi dan backup otomatis ke Telegram, buat file `.env` di direktori utama:

1. Buat bot melalui [@BotFather](https://t.me/botfather) untuk mendapatkan `Bot Token`.
2. Dapatkan `Chat ID` Anda (bisa melalui [@userinfobot](https://t.me/userinfobot)).
3. Buat file `.env` dengan isi sebagai berikut:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token_here
   TELEGRAM_CHAT_ID=your_chat_id_here
   ```

## 💻 Instalasi Lokal

Jika Anda lebih suka menjalankannya secara lokal:

### Prasyarat
- [Node.js](https://nodejs.org/) (disarankan v16 atau lebih tinggi)

### Langkah-langkah
1. Clone repositori:
   ```bash
   git clone https://github.com/inacoin/molty.git
   ```
2. Masuk ke direktori proyek:
   ```bash
   cd molty
   ```
3. Instal dependensi:
   ```bash
   npm install
   ```
4. Jalankan manajer:
   ```bash
   node manager.js
   ```

## 📄 Lisensi
Proyek ini dilisensikan di bawah Lisensi MIT.
