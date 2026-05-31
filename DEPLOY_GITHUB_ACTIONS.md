# CI/CD Otomatis ke VPS Hostinger

Dokumen ini menjelaskan cara membuat deploy otomatis dari GitHub ke VPS Hostinger menggunakan `GitHub Actions + SSH + systemd`.

Skema deploy:

1. Anda push perubahan ke GitHub
2. GitHub Actions berjalan
3. GitHub Actions SSH ke VPS
4. VPS menjalankan `git pull`
5. VPS install dependency jika perlu
6. VPS restart service `k3vision`

Workflow sudah disiapkan di:

- `.github/workflows/deploy.yml`

## 1. Prasyarat

Sebelum CI/CD diaktifkan, pastikan hal berikut sudah benar di VPS:

- aplikasi sudah berjalan normal
- service `systemd` sudah aktif
- repo project sudah ada di server
- folder project punya path tetap, misalnya:

```text
/var/www/k3vision-hse-attendance-monitoring
```

- virtual environment sudah ada di:

```text
/var/www/k3vision-hse-attendance-monitoring/venv
```

## 2. Cara kerja workflow yang sudah dibuat

Workflow akan aktif saat:

- ada `push` ke branch `main`
- ada `push` ke branch `master`
- Anda menekan `Run workflow` manual dari tab Actions

Lalu workflow akan:

- konek ke VPS via SSH
- masuk ke folder project
- `git fetch`
- `git checkout` branch deploy
- `git pull`
- `pip install -r requirements.txt`
- `systemctl restart k3vision`

## 3. Buat SSH key khusus untuk GitHub Actions

Di laptop lokal Anda jalankan:

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f github_actions_hostinger
```

Hasilnya ada 2 file:

- `github_actions_hostinger`
- `github_actions_hostinger.pub`

## 4. Daftarkan public key ke VPS

Lihat isi public key:

```bash
cat github_actions_hostinger.pub
```

Lalu login ke VPS dan tempel isinya ke:

```text
~/.ssh/authorized_keys
```

Contoh cepat di VPS:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
nano ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Tempel isi file `.pub`, lalu simpan.

## 5. Masukkan private key ke GitHub Secrets

Di GitHub repository:

`Settings -> Secrets and variables -> Actions`

Buat repository secrets berikut:

- `HOSTINGER_HOST`
  Isi: IP VPS atau hostname VPS
- `HOSTINGER_USER`
  Isi: user SSH VPS, misalnya `root`
- `HOSTINGER_PORT`
  Isi: `22`
- `HOSTINGER_SSH_KEY`
  Isi: seluruh isi file private key `github_actions_hostinger`

Catatan:

- Isi `HOSTINGER_SSH_KEY` harus mulai dari `-----BEGIN OPENSSH PRIVATE KEY-----`
- sampai `-----END OPENSSH PRIVATE KEY-----`

## 6. Buat GitHub Variables

Masih di menu:

`Settings -> Secrets and variables -> Actions -> Variables`

Buat repository variables berikut:

- `PROJECT_PATH`
  Isi:
  `/var/www/k3vision-hse-attendance-monitoring`
- `DEPLOY_BRANCH`
  Isi:
  `main`
- `SERVICE_NAME`
  Isi:
  `k3vision`

Kalau branch utama repo Anda masih `master`, isi `DEPLOY_BRANCH=master`.

## 7. Penting untuk repo private

Workflow ini menjalankan `git pull` langsung di VPS.

Artinya VPS Anda juga harus punya akses ke repo GitHub jika repo bersifat private.

Kalau repo Anda private, ada dua opsi:

### Opsi A: Jadikan repo public

Ini yang paling sederhana untuk demo/MVP, selama tidak ada secret di repo.

### Opsi B: Pasang deploy key di VPS

Anda buat SSH key lain di VPS khusus untuk akses GitHub, lalu tambahkan public key tersebut ke GitHub sebagai deploy key pada repo.

Kalau repo Anda private dan mau tetap private, ini opsi yang lebih aman.

## 8. Uji koneksi SSH dulu

Sebelum berharap workflow jalan, tes manual dari laptop:

```bash
ssh -i github_actions_hostinger root@IP_VPS_ANDA
```

Kalau ini gagal, GitHub Actions juga akan gagal.

## 9. Jalankan workflow

Setelah secrets dan variables selesai:

1. push perubahan ke branch `main` atau `master`
2. buka tab `Actions` di GitHub
3. cek workflow `Deploy to Hostinger VPS`

Atau jalankan manual dari `Run workflow`.

## 10. Cara membaca kegagalan

Kalau workflow gagal, biasanya penyebabnya salah satu dari ini:

- SSH key salah
- user SSH salah
- VPS belum bisa `git pull`
- `PROJECT_PATH` salah
- `venv` tidak ada
- nama service salah

Periksa log di tab `Actions`.

## 11. Verifikasi di VPS

Sesudah workflow sukses, Anda bisa cek dari VPS:

```bash
systemctl status k3vision --no-pager
journalctl -u k3vision -n 100 --no-pager
```

## 12. Keamanan yang disarankan

- jangan simpan `.env` di GitHub
- jangan simpan `k3vision_enc.key` di GitHub
- gunakan SSH key khusus untuk GitHub Actions, jangan pakai key pribadi utama
- kalau sudah stabil, pertimbangkan pakai user deploy khusus, jangan `root`

## 13. Jika Anda ingin zero-downtime yang lebih rapi

Tahap berikutnya bisa ditingkatkan menjadi:

- branch `staging` dan `production`
- workflow test dulu baru deploy
- backup database sebelum restart
- health check setelah deploy

Untuk versi sekarang, workflow ini sudah cukup bagus untuk:

- demo
- MVP
- update cepat setelah push
