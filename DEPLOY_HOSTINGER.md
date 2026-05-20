# Deploy K3Vision ke VPS Hostinger

Panduan ini disusun untuk struktur proyek K3Vision saat ini:

- backend `FastAPI` dari `main.py`
- process manager `systemd`
- reverse proxy `nginx`
- database lokal `SQLite`
- model lokal `model/best.pt`

Panduan ini cocok untuk VPS Ubuntu di Hostinger dengan spesifikasi seperti `2 vCPU / 8 GB RAM`.

## 1. Persiapan sebelum upload

Pastikan file berikut **ada di server**:

- source code proyek
- `model/best.pt`
- `k3vision_enc.key`

Jika Anda ingin mempertahankan data lama juga pindahkan:

- `k3vision.db`

Jangan upload:

- `venv311/`
- `__pycache__/`
- `.env` lokal dari laptop jika isinya belum final

## 2. Arah domain ke VPS

Di panel domain Hostinger, buat `A record` untuk:

- `@` ke IP VPS
- `www` ke IP VPS

Tunggu propagasi DNS jika belum langsung aktif.

## 3. Login ke VPS

Dari terminal lokal:

```bash
ssh root@IP_VPS_ANDA
```

Jika Anda memakai user non-root, ganti `root` sesuai user VPS Anda.

## 4. Install dependency sistem

```bash
apt update
apt install -y python3 python3-venv python3-pip git nginx libgl1 libglib2.0-0 build-essential
```

Catatan:

- `libgl1` dan `libglib2.0-0` penting untuk `opencv`
- `build-essential` membantu jika ada package Python yang perlu build tambahan

## 5. Upload source code

Jika memakai GitHub:

```bash
cd /var/www
git clone URL_REPO_GITHUB k3vision
chown -R www-data:www-data /var/www/k3vision
cd /var/www/k3vision
```

Jika belum memakai GitHub, upload folder proyek lewat SFTP/VS Code lalu letakkan di:

```text
/var/www/k3vision
```

## 6. Buat virtual environment

```bash
cd /var/www/k3vision
python3 -m venv venv
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
```

Jika install `deepface` atau dependency lain gagal, catat error-nya. Biasanya masalah ada di dependency sistem atau versi package.

## 7. Buat file environment

Buat file `.env`:

```bash
nano /var/www/k3vision/.env
```

Isi minimal:

```env
TELEGRAM_BOT_TOKEN=isi_token_bot_anda
TELEGRAM_CHAT_IDS=isi_chat_id_anda
```

## 8. Pindahkan file data penting

Pastikan file berikut benar-benar ada:

```text
/var/www/k3vision/model/best.pt
/var/www/k3vision/k3vision_enc.key
```

Opsional jika ingin membawa data lama:

```text
/var/www/k3vision/k3vision.db
```

Atur permission:

```bash
chown -R www-data:www-data /var/www/k3vision
chmod 600 /var/www/k3vision/.env
```

## 9. Test manual dulu

Sebelum memakai service, jalankan manual:

```bash
cd /var/www/k3vision
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000
```

Lalu buka:

```text
http://IP_VPS_ANDA:8000
```

Tes juga:

- `/docs`
- `/api/system/status`
- `/api/system/telegram-test`

Jika sudah oke, hentikan dengan `Ctrl+C`.

## 10. Pasang service systemd

Di repo ini sudah disiapkan file:

- `deploy/k3vision.service`

Copy ke server:

```bash
cp /var/www/k3vision/deploy/k3vision.service /etc/systemd/system/k3vision.service
```

Reload dan jalankan:

```bash
systemctl daemon-reload
systemctl enable k3vision
systemctl start k3vision
systemctl status k3vision
```

Untuk melihat log:

```bash
journalctl -u k3vision -f
```

## 11. Pasang nginx

Di repo ini sudah disiapkan file:

- `deploy/nginx.k3vision.conf`

Edit dulu domainnya:

```bash
nano /var/www/k3vision/deploy/nginx.k3vision.conf
```

Ganti:

- `example.com`
- `www.example.com`

Lalu aktifkan:

```bash
cp /var/www/k3vision/deploy/nginx.k3vision.conf /etc/nginx/sites-available/k3vision
ln -s /etc/nginx/sites-available/k3vision /etc/nginx/sites-enabled/k3vision
nginx -t
systemctl restart nginx
```

Jika default nginx site bentrok, nonaktifkan:

```bash
rm -f /etc/nginx/sites-enabled/default
systemctl restart nginx
```

## 12. Pasang HTTPS

```bash
apt install -y certbot python3-certbot-nginx
certbot --nginx -d domainanda.com -d www.domainanda.com
```

Setelah berhasil, akses aplikasi dari:

```text
https://domainanda.com
```

## 13. Update aplikasi setelah deploy

Kalau nanti ada perubahan kode:

```bash
cd /var/www/k3vision
git pull
source venv/bin/activate
pip install -r requirements.txt
systemctl restart k3vision
```

## 14. Checklist masalah umum

### Aplikasi tidak bisa start

Periksa:

```bash
systemctl status k3vision
journalctl -u k3vision -n 100 --no-pager
```

### Domain belum terbuka

Periksa:

- DNS `A record` sudah benar
- port `80` dan `443` VPS terbuka
- nginx aktif

### Telegram tidak mengirim

Periksa:

- isi `.env`
- endpoint `/api/system/status`
- endpoint `/api/system/telegram-test`

### Foto upload gagal

Naikkan batas:

```nginx
client_max_body_size 20M;
```

Jika perlu, ubah menjadi `50M`.

### Inferensi lambat

Ini wajar jika:

- model cukup berat
- VPS hanya `2 vCPU`
- ada banyak request paralel

Untuk MVP, jalankan `1` process dulu. Jangan pakai banyak worker sebelum kita ukur penggunaan RAM dan CPU.

## 15. Rekomendasi produksi untuk K3Vision

- Gunakan `1` worker dulu
- Jangan pakai `--reload`
- Simpan backup `k3vision.db`
- Simpan backup `k3vision_enc.key`
- Gunakan HTTPS sebelum demo publik

## 16. File yang sudah disiapkan di repo ini

- `deploy/k3vision.service`
- `deploy/nginx.k3vision.conf`
- `DEPLOY_HOSTINGER.md`

## 17. Catatan penting

Karena aplikasi ini memakai `SQLite`, deploy ini cocok untuk:

- MVP
- demo
- trafik rendah
- satu server

Kalau nanti ingin dipakai banyak user atau banyak kamera, langkah berikutnya biasanya:

- pindah ke PostgreSQL
- pisahkan proses inferensi
- pakai queue/background worker
