# K3Vision

K3Vision adalah aplikasi monitoring keselamatan kerja berbasis computer vision untuk membantu proses absensi pekerja sekaligus memvalidasi kelengkapan APD. Sistem ini menggabungkan pengenalan wajah, deteksi APD, dashboard web, penyimpanan riwayat kehadiran, dan notifikasi Telegram ketika ditemukan pelanggaran.

## Gambaran Singkat

Dalam satu alur kerja, K3Vision dapat:

- mendaftarkan wajah pekerja beserta data identitasnya,
- mengenali pekerja saat proses absensi,
- memeriksa kelengkapan APD seperti helm, rompi, dan sepatu,
- menolak absensi jika APD belum lengkap,
- mengirim alert Telegram dengan foto anotasi,
- menyediakan dashboard statistik dan histori absensi.

Repositori ini cocok dijadikan MVP atau dasar pengembangan sistem K3 digital untuk area kerja, proyek konstruksi, laboratorium, atau lingkungan industri.

## Fitur Utama

- Absensi berbasis face recognition menggunakan `DeepFace`.
- Deteksi APD berbasis model `YOLO` lokal pada `model/best.pt`.
- Monitoring frame real-time melalui endpoint API.
- Notifikasi Telegram untuk absensi ditolak dan temuan APD tidak lengkap.
- Face blur otomatis pada foto alert absensi untuk membantu menjaga privasi.
- Penyimpanan data pekerja dan riwayat absensi dengan `SQLite`.
- Enkripsi wajah pekerja sebelum disimpan ke database.
- Dashboard web statis untuk menampilkan status dan ringkasan data.

## Arsitektur Singkat

Komponen utama proyek:

- `main.py` menjalankan aplikasi FastAPI dan memuat seluruh router.
- `attendance.py` menangani registrasi wajah, identifikasi pekerja, absensi, dan statistik dashboard.
- `monitoring.py` menangani analisis frame monitoring dan alert APD.
- `face_recognition.py` mengelola embedding wajah dan proses pencocokan identitas.
- `ppe_detector.py` menjalankan model YOLO untuk mendeteksi person dan APD.
- `telegram_notifier.py` menangani integrasi Telegram, cooldown alert, dan blur wajah.
- `database.py` mengelola SQLite, tabel pekerja, tabel absensi, dan enkripsi data wajah.
- `static/` berisi antarmuka web.

## Teknologi yang Digunakan

- Python 3.11
- FastAPI
- Uvicorn
- OpenCV
- DeepFace
- Ultralytics YOLO
- SQLite
- Python Dotenv
- Telegram Bot API

## Cara Menjalankan

### 1. Clone dan masuk ke folder project

```bash
git clone <url-repo-anda>
cd K3Vision
```

### 2. Buat virtual environment

```bash
python -m venv venv311
```

Windows PowerShell:

```powershell
.\venv311\Scripts\Activate.ps1
```

Windows CMD:

```bat
venv311\Scripts\activate.bat
```

### 3. Install dependency

```bash
pip install -r requirements.txt
```

### 4. Siapkan file environment

Salin `.env.example` menjadi `.env`, lalu isi kredensial Telegram:

```env
TELEGRAM_BOT_TOKEN=isi_token_bot_telegram_anda
TELEGRAM_CHAT_IDS=isi_chat_id_telegram_tujuan
```

Jika belum ingin memakai Telegram, aplikasi tetap bisa berjalan, tetapi fitur alert tidak akan aktif.

### 5. Pastikan model tersedia

Model deteksi APD diharapkan berada di:

```text
model/best.pt
```

Jika file model tidak tersedia, modul PPE detector akan masuk ke mode placeholder dan hasil deteksi tidak akan berjalan normal.

### 6. Jalankan server

```bash
uvicorn main:app --reload --port 8000
```

Atau gunakan helper script:

```powershell
.\start.ps1
```

Setelah server aktif, buka:

```text
http://127.0.0.1:8000/
```

## Alur Penggunaan

### Registrasi pekerja

1. Upload foto wajah pekerja.
2. Isi nama, departemen, jabatan, email, dan nomor telepon.
3. Sistem akan mengekstrak wajah, mengenkripsi data gambar, lalu menyimpannya ke database.

### Absensi

1. Upload frame atau foto pekerja.
2. Sistem mengenali identitas pekerja.
3. Sistem memeriksa APD: helm, rompi, dan sepatu.
4. Jika APD lengkap, absensi diterima.
5. Jika APD tidak lengkap, absensi ditolak dan alert Telegram dapat dikirim.

### Monitoring

1. Kirim frame ke endpoint monitoring.
2. Sistem mendeteksi person dan APD pada frame.
3. Jika ada pelanggaran APD, sistem membuat anotasi dan mengirim notifikasi Telegram dengan cooldown agar tidak spam.

## Endpoint Penting

Beberapa endpoint yang paling relevan:

- `GET /` menampilkan dashboard web.
- `GET /api/system/status` melihat status aplikasi dan konfigurasi Telegram.
- `POST /api/system/telegram-test` mengirim pesan uji Telegram.
- `POST /register-face` mendaftarkan wajah pekerja baru.
- `POST /identify-worker` mengidentifikasi pekerja dari gambar.
- `POST /attendance/check` melakukan absensi dan validasi APD.
- `POST /monitor/frame` memproses frame monitoring APD.
- `GET /workers` mengambil daftar pekerja.
- `GET /attendance/history` mengambil histori absensi.
- `GET /dashboard/stats` mengambil ringkasan statistik dashboard.
- `GET /reports/compliance` mengambil laporan kepatuhan APD.
- `GET /telegram/discover-chat-ids` membantu menemukan chat ID Telegram dari bot updates.

Dokumentasi interaktif FastAPI tersedia di:

```text
http://127.0.0.1:8000/docs
```

## Struktur Folder

```text
K3Vision/
|-- main.py
|-- attendance.py
|-- monitoring.py
|-- ppe_detector.py
|-- face_recognition.py
|-- telegram_notifier.py
|-- database.py
|-- requirements.txt
|-- .env.example
|-- model/
|   `-- best.pt
|-- static/
|-- dataset/
|-- runs/
`-- start.ps1
```

## Keamanan dan Privasi

- Gambar wajah pekerja disimpan dalam bentuk terenkripsi menggunakan `Fernet`.
- File kunci enkripsi berada pada `k3vision_enc.key`.
- Notifikasi Telegram untuk absensi ditolak mendukung blur wajah otomatis.
- Jangan unggah file berikut ke repository publik:
  - `.env`
  - `k3vision.db`
  - `k3vision_enc.key`
  - isi `venv311/`
  - artefak training pada `runs/`

## Catatan Pengembangan

Beberapa hal yang sudah terlihat dari implementasi saat ini:

- Proyek ini sudah cukup kuat untuk demo dan MVP.
- Model APD masih bergantung pada file lokal `model/best.pt`.
- Database masih menggunakan SQLite sehingga cocok untuk single-node deployment.
- Sebagian folder seperti `venv311/`, `__pycache__/`, database lokal, dan artefak training sebaiknya tidak ikut dipush ke GitHub.

## Potensi Pengembangan Lanjutan

- Integrasi kamera CCTV atau RTSP stream langsung.
- Role-based access untuk admin dan pengawas.
- Export laporan ke PDF atau Excel.
- Deployment ke server internal atau edge device.
- Analitik kepatuhan APD per area, shift, atau departemen.

## Lisensi

Tambahkan lisensi sesuai kebutuhan tim, misalnya `MIT`, `Apache-2.0`, atau lisensi internal kampus/proyek.

---

Jika kamu ingin, saya juga bisa lanjut bantu rapikan repo sebelum push, misalnya dengan membuat `.gitignore`, merapikan struktur folder, atau menambahkan section screenshot/demo ke README ini.
