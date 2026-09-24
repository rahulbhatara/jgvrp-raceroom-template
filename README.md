# JGVRP RaceRoom Scoreboard Template & Telemetry System

Template UI custom scoreboard dan sistem telemetri untuk fitur **RaceRoom** di server GTA V FiveM **JGVRP** (Jogjagamers Roleplay).

Repository ini berisi template dashboard web responsif untuk NUI FiveM yang menerima panggilan fungsi dari game engine, serta dokumentasi teknis lengkap mengenai format data API dan mekanisme balapan hasil *reverse-engineering*.

---

## 🏎️ Daftar Isi
1. [Arsitektur NUI JGVRP](#arsitektur-nui-jgvrp)
2. [Dokumentasi Fungsi API](#dokumentasi-fungsi-api)
   - [`updateScoreboard(payload)`](#1-updatescoreboardpayload)
   - [`setLap(currentLap, totalLaps)`](#2-setlapcurrentlap-totallaps)
   - [`setTime(seconds)`](#3-settimeseconds)
3. [Perilaku per Mode Balapan](#perilaku-per-mode-balapan)
   - [Mode Circuit](#-mode-circuit)
   - [Mode Endurance](#-mode-endurance)
   - [Mode Sprint](#-mode-sprint)
4. [Mekanisme Checkpoint vs Map Editor](#mekanisme-checkpoint-vs-map-editor-temuan-krusial)
5. [Implementasi Tampilan UI (Opsi A)](#implementasi-tampilan-ui-opsi-a)
6. [Backend Telemetry Server (Port 6767)](#backend-telemetry-server-port-6767)
7. [Petunjuk Penggunaan](#petunjuk-penggunaan)

---

## Arsitektur NUI JGVRP

Pada sistem custom HUD / Scoreboard JGVRP:
1. Setiap pemain menjalankan instance web browser Chromium (CEF) lokal di client FiveM masing-masing.
2. Server/Client script JGVRP mengeksekusi fungsi JavaScript secara global pada objek `window` (`window.updateScoreboard`, `window.setLap`, `window.setTime`).
3. Template ini (`script.js`) menyediakan implementasi ketiga fungsi tersebut untuk memperbarui DOM visual, sekaligus membuka koneksi WebSocket (`/ws`) untuk mem-*forward* raw data ke backend analisis.

---

## Dokumentasi Fungsi API

### 1. `updateScoreboard(payload)`
Dipanggil secara periodik (setiap ~500ms) oleh game untuk memperbarui urutan pembalap di scoreboard.

- **Tipe Parameter:** `string` (JSON String yang berisi Array of Objects)
- **Contoh Pemanggilan Asli:**
  ```javascript
  updateScoreboard("[{\"name\":\"Carlos Webster\",\"checkpoints\":4,\"timeDiff\":0,\"position\":{\"x\":-1463.56,\"y\":2401.76,\"z\":26.01}},{\"name\":\"Jackson Cooper\",\"checkpoints\":3,\"timeDiff\":9666,\"position\":{\"x\":-1389.99,\"y\":2421.78,\"z\":26.98}}]");
  ```

#### Struktur Objek Pembalap:
| Field | Tipe | Deskripsi |
| :--- | :--- | :--- |
| `name` | `string` | Nama karakter pembalap (misal: `"Carlos Webster"`). |
| `checkpoints` | `integer` | Jumlah checkpoint yang **sudah berhasil dilewati (*cleared*)** secara kumulatif sejak start. |
| `timeDiff` | `number` | Selisih waktu dengan leader dalam satuan **milidetik (*milliseconds*)**. Nilai `0` berarti pemimpin balap (*Leader*). Contoh: `9666` = `+9.67 detik`. |
| `position` | `object` | Koordinat 3D GTA pembalap di dalam game world: `{ x: float, y: float, z: float }`. **Bukan** nomor peringkat 1/2/3. |

> [!NOTE]
> **Penentuan Peringkat (POS):**  
> Peringkat 1, 2, 3 ditentukan oleh urutan index array yang dikirimkan oleh server (Index 0 = Posisi 1 / Leader). Jika perlu diurutkan mandiri, urutkan berdasarkan `checkpoints` terbesar (descending), kemudian `timeDiff` terkecil (ascending).

---

### 2. `setLap(currentLap, totalLaps)`
Dipanggil untuk mengupdate status putaran (lap) pembalap.

- **Parameter:**
  - `currentLap` (`number`): Nomor lap yang sedang dijalani pembalap lokal (dimulai dari `1`, atau `0` pada endurance).
  - `totalLaps` (`number | null`): Jumlah total lap balapan.

- **Karakteristik Penting:**
  - Fungsi ini bersifat **lokal per-client**: game memanggil fungsi ini di layar Carlos untuk status lap Carlos, dan di layar Jackson untuk status lap Jackson.
  - Pada mode **Circuit**: Mengirim 2 angka, misal `setLap(1, 3)`, `setLap(2, 3)`, `setLap(3, 3)`.
  - Pada mode **Endurance**: Parameter kedua bernilai **`null`** (atau tidak dioper dari server), misal `setLap(0, null)`, `setLap(1, null)`, `setLap(2, null)`.
  - Pada mode **Sprint**: Fungsi `setLap` **SAMA SEKALI TIDAK DIPANGGIL** oleh server, karena mode Sprint murni balapan 1 putaran (point-to-point tanpa konsep lap). Template secara otomatis mendeteksi mode Sprint jika `setTime` berjalan namun `setLap` tidak pernah dikirimkan.
  - Saat menyentuh garis finish akhir: Server **tidak** menembakkan `setLap(4, 3)`, melainkan langsung menyelesaikan balapan.

---

### 3. `setTime(seconds)`
Dipanggil setiap detik untuk memperbarui timer balapan.

- **Tipe Parameter:** `integer` (Detik)
- **Contoh Pemanggilan:**
  ```javascript
  setTime(250); // Waktu balapan
  ```

- **Perbedaan Perilaku Waktu:**
  - **Circuit Mode:** Menghitung **MAJU (*Elapsed Time*)** mulai dari `0, 1, 2, 3...` hingga garis finish.
  - **Endurance Mode:** Menghitung **MUNDUR (*Countdown Timer*)** dari batas durasi yang diset (misal 5 menit = `300, 299... 0`, 20 menit = `1200, 1199... 0`).
  - **Sprint Mode:** Menghitung **MAJU (*Elapsed Time*)** mulai dari `0, 1, 2, 3...` hingga menyentuh checkpoint terakhir.

---

## Perilaku per Mode Balapan

| Fitur | 🏁 Mode Circuit | ⏳ Mode Endurance | ⚡ Mode Sprint |
| :--- | :--- | :--- | :--- |
| **`setLap`** | Mengirim `[current, total]` (misal: `[1, 3]`) | Mengirim `[current, null]` (tanpa total lap) | **TIDAK ADA / TIDAK DIPANGGIL** (1 lap saja) |
| **`setTime`** | **Menghitung Maju** (`0` $\rightarrow$ selesai) | **Menghitung Mundur** (`1200` $\rightarrow$ `0`) | **Menghitung Maju** (`0` $\rightarrow$ selesai) |
| **Label Lap UI** | `1 / 3`, `2 / 3`, `3 / 3` | `LAP 1`, `LAP 2`, `LAP 3` | `SPRINT` (Point-to-Point) |
| **Garis Akhir** | Ditentukan oleh Lap terakhir tercapai | Ditentukan saat timer `setTime` menyentuh `0` | Ditentukan saat Checkpoint akhir tercapai |

---

## Mekanisme Checkpoint vs Map Editor (Temuan Krusial)

Saat membuat trek balap di **Map Editor (Pre-Race)** vs data yang diterima di **Telemetry API**, terdapat perbedaan konsep penting:

### 1. Map Editor (Pre-Race)
Misalkan Anda membuat trek dengan 4 checkpoint:
- **Marker 1:** Titik awal (Garis Start / Finish) tempat kendaraan diletakkan di grid.
- **Marker 2:** Checkpoint belokan pertama.
- **Marker 3:** Checkpoint belokan kedua.
- **Marker 4:** Checkpoint sebelum kembali ke garis start/finish.

### 2. Telemetry API (`updateScoreboard`)
Di API server JGVRP, variabelnya bernama jamak: **`checkpoints`** (artinya: **jumlah checkpoint yang SUDAH berhasil dilewati**):
- **Saat di grid start:** Pembalap belum bergerak $\rightarrow$ belum ada checkpoint yang dilewati $\rightarrow$ `checkpoints: 0` (array `[]`).
- **Saat melewati Marker 2:** Pembalap baru melewati 1 checkpoint $\rightarrow$ `checkpoints: 1`.
- **Saat melewati Marker 3:** Pembalap sudah melewati 2 checkpoint $\rightarrow$ `checkpoints: 2`.
- **Saat melewati Marker 4:** Pembalap sudah melewati 3 checkpoint $\rightarrow$ `checkpoints: 3`.
- **Saat kembali melewati Marker 1 (Start/Finish):** Pembalap telah menyelesaikan 4 checkpoint (1 lap tuntas!) $\rightarrow$ `checkpoints: 4` $\rightarrow$ server langsung menaikkan `setLap(2, 3)`!

### Hubungan Rumus Checkpoint & Lap:
Jika sebuah trek memiliki $N$ checkpoint per putaran (misal $N = 4$):
$$\text{Lap Pembalap} = \lfloor \frac{\text{checkpoints} - 1}{N} \rfloor + 1$$
$$\text{Checkpoint di Lap Tersebut} = ((\text{checkpoints} - 1) \pmod N) + 1$$

---

## Implementasi Tampilan UI (Opsi A)

Sesuai kesepakatan desain, template ini menerapkan **Opsi A (Checkpoints Cleared)**:
1. **Header Kolom `CP`:** Menampilkan jumlah total checkpoint yang berhasil dilewati pembalap berupa angka murni (`1`, `2`, `5`, `10`). Angka ini menjamin akurasi peringkat pembalap di mode apa pun tanpa tergantung pada jumlah checkpoint yang disetel pembuat trek.
2. **Kolom `GAP`:**
   - Posisi 1 (Leader): Ditampilkan badge hijau **`LEADER`**.
   - Posisi di belakangnya: Dikonversi dari milidetik ke detik dengan 2 angka di belakang koma (misal: `+9.67s`, atau `+01:15` jika di atas 1 menit).
3. **Format Waktu (`TIME`):** Otomatis memformat detik ke format bersih `MM:SS` (atau `HH:MM:SS` untuk durasi panjang).
4. **Badge Mode Otomatis:**
   - Otomatis menampilkan `CIRCUIT` jika `totalLaps > 1`.
   - Otomatis menampilkan `ENDURANCE` jika `totalLaps` bernilai `null` / tidak diberikan.
   - Otomatis menampilkan `SPRINT` jika hanya 1 putaran.
5. **Visualisasi Koordinat 2D (Dynamic Track Silhouette Minimap):**
   - Memanfaatkan koordinat 3D GTA `{x, y, z}` yang dikirimkan pembalap di `updateScoreboard`.
   - **Multi-Car Filter & Crash Rejection:** Script merekam pergerakan pembalap dengan filter cerdas (kecepatan & sudut belok). Jika mobil melintir, berhenti mendadak, atau menabrak dinding, koordinatnya otomatis ditolak (*rejected*), dan pelacakan lintasan otomatis dialihkan ke mobil tercepat berikutnya yang melaju normal. Sirkuit tidak akan rusak meskipun pembalap pertama tabrakan di lap 1.
   - **Pit Lane Auto-Detection:** Sistem otomatis mendeteksi ketika ada mobil yang membelah di koridor paralel sejajar lurus start/finish (jarak 6-35m) dengan kecepatan servis (15-90 km/h) dan menampilkannya sebagai garis *pit lane* putus-putus berwarna kuning (*amber*) lengkap dengan label "PIT".
   - **Closed Loop Auto-Detection:** Sistem otomatis mendeteksi ketika pembalap telah kembali mendekati garis start awal (lap selesai) untuk mengunci lintasan (*close loop*).
   - **Posisi di Bawah (Bottom Minimap 4:3):** Terletak rapi di bagian bawah scoreboard dengan aspect ratio 4:3 (`400x300`) sehingga proporsi lintasan luas dan simetris.
   - Skala dan titik tengah menyesuaikan otomatis (*auto-bounding box & centering*) untuk ukuran trek apa pun (dari trek gokart pendek hingga jalan tol panjang).
   - Semua pembalap tetap dirender sebagai titik bergerak (*blip*) live lengkap dengan nomor posisinya (P1 hijau emerald, P2+ oranye) di atas siluet trek tersebut.
6. **Formula 1 Official Typography:**
   - 100% font scoreboard, header, tabel, waktu, dan kanvas minimap menggunakan font resmi **Formula1-Bold** dan **Formula1-Regular**.
   - Ukuran font ditingkatkan secara proporsional (~25%-35%) agar sangat jelas dan mudah dibaca saat berkendara di in-game FiveM pada resolusi 1080p, 1440p, maupun 4K.
7. **Performa Ringan (No Heavy CSS):**
   - `backdrop-filter: blur(...)` dan bayangan berat dihilangkan agar berjalan lancar 60 FPS di dalam CEF FiveM tanpa lag.

---

## Petunjuk Penggunaan

### 1. Menjalankan di Vercel / GitHub Pages
Repository ini siap langsung di-deploy ke Vercel atau hosting statis lainnya:
- Sudah dilengkapi [`vercel.json`](vercel.json) dengan konfigurasi CORS dan iframe headers untuk FiveM.
- Tidak membutuhkan backend server; visualisasi trek dan scoreboard berjalan 100% di browser client.

### 2. Memasang Template di FiveM JGVRP
Masukkan URL hosting Vercel Anda (misal `https://<project-anda>.vercel.app`) ke dalam pengaturan custom URL raceroom di in-game JGVRP.

### 3. Struktur HTML Standar
```html
<link rel="stylesheet" href="styles.css">

<!-- Layout Scoreboard -->
<main class="raceroom-container">
    <header class="race-header">
        <div class="race-badge" id="race-mode">RACE</div>
        <div class="race-meta">
            <div class="meta-item">
                <span class="meta-label">LAP</span>
                <span class="meta-val" id="lap-display">- / -</span>
            </div>
            <div class="meta-item">
                <span class="meta-label">TIME</span>
                <span class="meta-val" id="time-display">00:00</span>
            </div>
        </div>
    </header>

    <section class="scoreboard-section">
        <table class="scoreboard-table">
            <thead>
                <tr>
                    <th class="col-pos">POS</th>
                    <th class="col-driver">DRIVER</th>
                    <th class="col-lap" id="th-lap">CP</th>
                    <th class="col-time" id="th-time">GAP</th>
                </tr>
            </thead>
            <tbody id="scoreboard-body"></tbody>
        </table>
    </section>

    <!-- Dynamic 2D Track Silhouette Minimap (4:3 Aspect Ratio at Bottom) -->
    <section class="track-minimap-section" id="track-section">
        <canvas id="track-canvas" width="400" height="300"></canvas>
    </section>
</main>

<script src="script.js"></script>
```

---

## Lisensi & Kontributor
- **Template Author:** JGVRP Community
- **Reverse-Engineering & Telemetry Backend:** Pair programming research with Antigravity AI
