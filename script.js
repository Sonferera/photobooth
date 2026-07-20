// ═══════════════════════════════════════════════════════════════
//  PHOTOBOOTH APP — script.js
//  Fitur: Filter, Live Preview, Retake, Timer Konfigurabel
// ═══════════════════════════════════════════════════════════════

// ── 1. CONSTANTS ──
const FILTERS = [
  { name: "Normal", css: "none" },
  { name: "B&W", css: "grayscale(100%)" },
  { name: "Sepia", css: "sepia(80%)" },
  { name: "Warm", css: "sepia(30%) saturate(140%) brightness(110%)" },
  { name: "Cool", css: "saturate(80%) brightness(105%) hue-rotate(15deg)" },
  { name: "Vintage", css: "sepia(40%) contrast(90%) brightness(90%)" },
  { name: "Hi-Con", css: "contrast(150%) saturate(120%)" },
  { name: "Fade", css: "contrast(80%) brightness(115%) saturate(80%)" },
];

// ── 2. STATE ──
const sessionState = {
  step: "landing",
  selectedTemplate: null,
  currentCaptureIndex: 0,
  totalRequiredCaptures: 0,
  capturedPhotos: [], // Array of canvas elements (filter sudah di-bake)
  captureMap: null, // Mapping slot → captureIndex
  selectedFilter: "none", // CSS filter string aktif
  timerDuration: 3, // Durasi countdown (detik)
  previewBgImg: null, // Cached bg image untuk preview
  previewOverlayImg: null, // Cached overlay image untuk preview
  tempTemplateName: "",
  countdownInterval: null,
};

const configCache = new Map();
let currentStream = null; // Menyimpan status kamera yang sedang menyala

// ── 3. DOM ELEMENTS ──
const video = document.getElementById("camera-stream");
const canvas = document.getElementById("photo-canvas");
const ctx = canvas.getContext("2d");
const countdownElement = document.getElementById("countdown");
const grid = document.getElementById("template-grid");

// ── 4. INIT ──
document.addEventListener("DOMContentLoaded", () => {
  loadManifest();
  renderFilterBar();
  setupEventListeners();
});

// ═══════════════════════════════════════════════════════════════
//  NAVIGATION
// ═══════════════════════════════════════════════════════════════
function goToStep(stepId) {
  document
    .querySelectorAll(".step")
    .forEach((el) => el.classList.remove("active"));
  document.getElementById(stepId).classList.add("active");
  sessionState.step = stepId;
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════════════
//  MANIFEST & GALLERY
// ═══════════════════════════════════════════════════════════════
async function loadManifest() {
  try {
    const response = await fetch("assets/templates/manifest.json");
    if (!response.ok) throw new Error("Gagal memuat manifest");
    const templates = await response.json();
    renderGallery(templates);
  } catch (error) {
    console.error("Error fetching manifest:", error);
    grid.innerHTML =
      "<p>Gagal memuat galeri template. Pastikan kamu menjalankan file ini lewat Local Server.</p>";
  }
}

function renderGallery(templates) {
  grid.innerHTML = "";
  templates.forEach((tmpl) => {
    const card = document.createElement("div");
    card.className = "template-card";
    card.innerHTML = `
      <img src="${tmpl.thumbnail}" alt="${tmpl.name}" onerror="this.src='https://via.placeholder.com/150?text=No+Thumb'">
      <div class="template-card-info">
        <h3>${tmpl.name}</h3>
        ${tmpl.category ? `<p class="template-category">${tmpl.category}</p>` : ""}
      </div>
    `;
    card.addEventListener("click", async () => {
      sessionState.tempTemplateName = tmpl.name;
      await selectTemplate(tmpl.id);
    });
    grid.appendChild(card);
  });
}

async function selectTemplate(templateId) {
  try {
    let config;
    if (configCache.has(templateId)) {
      config = configCache.get(templateId);
    } else {
      const response = await fetch(
        `assets/templates/${templateId}/config.json`,
      );
      if (!response.ok)
        throw new Error(`Gagal memuat config untuk ${templateId}`);
      config = await response.json();
      configCache.set(templateId, config);
    }

    sessionState.selectedTemplate = config;

    // Cek apakah template punya opsi mode
    if (config.modes && config.modes.length > 0) {
      tampilkanModalMode(config);
    } else {
      // Template tanpa mode — pakai captureIndex bawaan
      sessionState.captureMap = config.photoSlots.map((s) => s.captureIndex);
      sessionState.totalRequiredCaptures = new Set(
        sessionState.captureMap,
      ).size;
      startCamera();
    }
  } catch (error) {
    console.error("Error loading template config:", error);
    alert("Gagal memuat detail template.");
  }
}

// ═══════════════════════════════════════════════════════════════
//  MODE SELECTION MODAL
// ═══════════════════════════════════════════════════════════════
function tampilkanModalMode(config) {
  const modal = document.getElementById("mode-overlay");
  const title = document.getElementById("mode-template-name");
  const optionsContainer = document.getElementById("mode-options");

  title.textContent =
    sessionState.tempTemplateName || config.name || "Template Terpilih";
  optionsContainer.innerHTML = "";
  modal.style.display = "flex";

  config.modes.forEach((mode, index) => {
    const btn = document.createElement("button");
    btn.className = index === 0 ? "btn btn-primary" : "btn btn-secondary";
    btn.style.width = "100%";
    btn.style.marginBottom = "10px";
    btn.style.padding = "14px 16px";
    btn.style.textAlign = "left";
    btn.style.lineHeight = "1.4";

    const totalJepret = new Set(mode.captureMap).size;
    btn.innerHTML = `
      <strong>${mode.icon || ""} ${mode.name} (${totalJepret}x Jepret)</strong><br>
      <small style="font-weight: normal;">${mode.description}</small>
    `;

    btn.onclick = () => {
      sessionState.captureMap = mode.captureMap;
      sessionState.totalRequiredCaptures = totalJepret;
      modal.style.display = "none";
      startCamera();
    };

    optionsContainer.appendChild(btn);
  });

  document.getElementById("btn-mode-back").onclick = () => {
    modal.style.display = "none";
  };
}

// ═══════════════════════════════════════════════════════════════
//  FILTER SYSTEM
// ═══════════════════════════════════════════════════════════════
function renderFilterBar() {
  const bar = document.getElementById("filter-bar");
  if (!bar) return;
  bar.innerHTML = "";

  FILTERS.forEach((f, i) => {
    const btn = document.createElement("button");
    btn.className = "filter-btn" + (i === 0 ? " active" : "");
    btn.textContent = f.name;
    btn.addEventListener("click", () => selectFilter(f.css, btn));
    bar.appendChild(btn);
  });
}

function selectFilter(filterCss, btn) {
  sessionState.selectedFilter = filterCss;
  // Live preview pada video
  video.style.filter = filterCss === "none" ? "" : filterCss;
  // Highlight tombol aktif
  document
    .querySelectorAll(".filter-btn")
    .forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
}

// ═══════════════════════════════════════════════════════════════
//  CAMERA & CAPTURE
// ═══════════════════════════════════════════════════════════════
// 5. CAMERA & CAPTURE LOGIC
async function startCamera(deviceId = null) {
  const loadingOverlay = document.getElementById("loading-overlay");

  try {
    if (loadingOverlay) loadingOverlay.style.display = "flex";

    // Matikan lensa yang sedang menyala sebelum pindah ke lensa baru
    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
    }

    // Atur permintaan kamera (Jika ada deviceId spesifik, gunakan itu. Jika tidak, prioritaskan kamera depan)
    const videoConstraints = { aspect_ratio: 4 / 3 };
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = "user"; // "user" = kamera depan, "environment" = belakang
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
    });

    currentStream = stream; // Simpan ke global variable
    video.srcObject = stream;

    if (loadingOverlay) loadingOverlay.style.display = "none";

    sessionState.capturedPhotos = [];
    sessionState.currentCaptureIndex = 0;

    goToStep("step-capture");
    updateCaptureText();

    // PENTING: Panggil fungsi pencari lensa HANYA SETELAH izin kamera diberikan
    await populateCameraDropdown(deviceId);

    const btnStartCap = document.getElementById("btn-start-capture");
    btnStartCap.style.display = "inline-block";

    btnStartCap.replaceWith(btnStartCap.cloneNode(true));
    document
      .getElementById("btn-start-capture")
      .addEventListener("click", function () {
        this.style.display = "none";
        // Sembunyikan pilihan kamera saat mulai jepret agar tidak mengganggu
        document.querySelector(".camera-selector").style.display = "none";
        tampilkanCountdownAndJepret();
      });
  } catch (err) {
    if (loadingOverlay) loadingOverlay.style.display = "none";
    alert("Kamera tidak bisa diakses! Pastikan kamu telah mengizinkan akses.");
    console.error(err);
  }
}

// FUNGSI BARU: Mendata semua lensa di HP/Laptop
async function populateCameraDropdown(activeDeviceId) {
  const selectorContainer = document.querySelector(".camera-selector");
  const selectElement = document.getElementById("camera-select");

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputDevices = devices.filter(
      (device) => device.kind === "videoinput",
    );

    // Jika kameranya cuma 1 (misal laptop lawas), tidak usah tampilkan dropdown
    if (videoInputDevices.length <= 1) {
      selectorContainer.style.display = "none";
      return;
    }

    selectorContainer.style.display = "block";
    selectElement.innerHTML = ""; // Bersihkan isi dropdown lama

    videoInputDevices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      // Gunakan nama asli lensa dari OS, atau nama generic jika OS menyembunyikannya
      option.text = device.label || `Kamera ${index + 1}`;

      // Beri tanda "Terpilih" pada kamera yang sedang aktif
      if (activeDeviceId && device.deviceId === activeDeviceId) {
        option.selected = true;
      } else if (
        !activeDeviceId &&
        device.label.toLowerCase().includes("front")
      ) {
        option.selected = true;
      }

      selectElement.appendChild(option);
    });

    // Deteksi saat user memilih lensa lain di dropdown
    selectElement.onchange = (e) => {
      startCamera(e.target.value); // Restart fungsi kamera dengan lensa baru
    };
  } catch (error) {
    console.error("Gagal mendata kamera:", error);
  }
}

async function preloadTemplateAssets() {
  const config = sessionState.selectedTemplate;
  const basePath = `assets/templates/${config.id}/`;

  try {
    const [bgImg, overlayImg] = await Promise.all([
      loadImg(basePath + config.assets.background),
      loadImg(basePath + config.assets.overlay),
    ]);
    sessionState.previewBgImg = bgImg;
    sessionState.previewOverlayImg = overlayImg;
  } catch (err) {
    console.error("Error preloading template assets:", err);
  }
}

function loadImg(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Gagal memuat: ${src}`));
    img.src = src;
  });
}

function showCameraMode() {
  document.getElementById("capture-camera-mode").style.display = "block";
  document.getElementById("capture-review-mode").style.display = "none";
  document.getElementById("btn-capture").style.display = "";
  document.getElementById("btn-capture").disabled = false;
}

function updateCaptureText() {
  document.getElementById("capture-subtitle").textContent =
    `Foto ${sessionState.currentCaptureIndex + 1} dari ${sessionState.totalRequiredCaptures}`;
}

function onCaptureClick() {
  // Disable tombol biar ga double-click
  const btn = document.getElementById("btn-capture");
  btn.disabled = true;
  tampilkanCountdownAndJepret();
}

function tampilkanCountdownAndJepret() {
  let timer = sessionState.timerDuration;
  countdownElement.textContent = timer;
  countdownElement.style.display = "flex";

  // Jika timer = 0, langsung jepret (edge case)
  if (timer <= 0) {
    countdownElement.style.display = "none";
    ambilFotoTemporer();
    return;
  }

  sessionState.countdownInterval = setInterval(() => {
    timer--;
    if (timer > 0) {
      countdownElement.textContent = timer;
    } else {
      clearInterval(sessionState.countdownInterval);
      sessionState.countdownInterval = null;
      countdownElement.style.display = "none";
      ambilFotoTemporer();
    }
  }, 1000);
}

function ambilFotoTemporer() {
  // Flash effect
  const flash = document.getElementById("flash-overlay");
  if (flash) {
    flash.classList.remove("flash");
    void flash.offsetWidth; // trigger reflow for re-animation
    flash.classList.add("flash");
  }

  // Capture frame dari video dengan filter applied
  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d");
  tempCanvas.width = video.videoWidth;
  tempCanvas.height = video.videoHeight;

  // Apply filter ke canvas context
  if (sessionState.selectedFilter !== "none") {
    tempCtx.filter = sessionState.selectedFilter;
  }
  tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
  tempCtx.filter = "none"; // reset

  sessionState.capturedPhotos.push(tempCanvas);
  sessionState.currentCaptureIndex++;

  // Masuk ke review mode
  showReview();
}

// ═══════════════════════════════════════════════════════════════
//  REVIEW & LIVE PREVIEW
// ═══════════════════════════════════════════════════════════════
function showReview() {
  document.getElementById("capture-camera-mode").style.display = "none";
  document.getElementById("capture-review-mode").style.display = "block";

  const total = sessionState.totalRequiredCaptures;
  const current = sessionState.currentCaptureIndex;

  document.getElementById("review-subtitle").textContent =
    `Foto ${current} dari ${total} selesai`;

  // Ganti teks tombol jika foto terakhir
  const btnNext = document.getElementById("btn-next");
  if (current >= total) {
    btnNext.textContent = "✅ Selesai!";
  } else {
    btnNext.textContent = "✅ Lanjut";
  }

  // Render mini preview bingkai
  renderMiniPreview();
}

function renderMiniPreview() {
  const config = sessionState.selectedTemplate;
  const previewCanvas = document.getElementById("preview-canvas");
  const previewCtx = previewCanvas.getContext("2d");

  const bgImg = sessionState.previewBgImg;
  const overlayImg = sessionState.previewOverlayImg;
  if (!bgImg) return;

  // Hitung ukuran preview (max 350px lebar)
  const maxW = 350;
  const scale = maxW / config.canvas.width;
  previewCanvas.width = maxW;
  previewCanvas.height = Math.round(config.canvas.height * scale);

  const w = previewCanvas.width;
  const h = previewCanvas.height;

  // 1. Gambar background
  previewCtx.drawImage(bgImg, 0, 0, w, h);

  // 2. Gambar foto-foto yang sudah diambil ke slot masing-masing
  config.photoSlots.forEach((slot, i) => {
    const targetIndex = sessionState.captureMap[i];
    const photoCanvas = sessionState.capturedPhotos[targetIndex];
    if (!photoCanvas) {
      // Slot belum terisi — gambar placeholder transparan
      drawEmptySlot(previewCtx, slot, w, h, scale);
      return;
    }

    const centerX = w * slot.xPct;
    const centerY = h * slot.yPct;
    const photoWidth = w * slot.wPct;
    const photoHeight = h * slot.hPct;

    previewCtx.save();
    previewCtx.translate(centerX, centerY);
    previewCtx.rotate((slot.rotateDeg * Math.PI) / 180);

    // Rounded corners
    if (slot.cornerRadius) {
      previewCtx.beginPath();
      previewCtx.roundRect(
        -photoWidth / 2,
        -photoHeight / 2,
        photoWidth,
        photoHeight,
        slot.cornerRadius * scale,
      );
      previewCtx.clip();
    }

    if (slot.mirror) previewCtx.scale(-1, 1);

    // Object-fit: cover
    const sw = photoCanvas.width;
    const sh = photoCanvas.height;
    const sRatio = sw / sh;
    const tRatio = photoWidth / photoHeight;
    let sx, sy, sWidth, sHeight;

    if (sRatio > tRatio) {
      sHeight = sh;
      sWidth = sh * tRatio;
      sx = (sw - sWidth) / 2;
      sy = 0;
    } else {
      sWidth = sw;
      sHeight = sw / tRatio;
      sx = 0;
      sy = (sh - sHeight) / 2;
    }

    previewCtx.drawImage(
      photoCanvas,
      sx,
      sy,
      sWidth,
      sHeight,
      -photoWidth / 2,
      -photoHeight / 2,
      photoWidth,
      photoHeight,
    );
    previewCtx.restore();
  });

  // 3. Gambar overlay
  if (overlayImg) {
    previewCtx.drawImage(overlayImg, 0, 0, w, h);
  }
}

function drawEmptySlot(ctxRef, slot, w, h, scale) {
  const centerX = w * slot.xPct;
  const centerY = h * slot.yPct;
  const pw = w * slot.wPct;
  const ph = h * slot.hPct;

  ctxRef.save();
  ctxRef.translate(centerX, centerY);
  ctxRef.rotate((slot.rotateDeg * Math.PI) / 180);

  ctxRef.beginPath();
  if (slot.cornerRadius) {
    ctxRef.roundRect(-pw / 2, -ph / 2, pw, ph, slot.cornerRadius * scale);
  } else {
    ctxRef.rect(-pw / 2, -ph / 2, pw, ph);
  }

  // Placeholder semi-transparan
  ctxRef.fillStyle = "rgba(0, 0, 0, 0.15)";
  ctxRef.fill();

  // Border putus-putus
  ctxRef.setLineDash([4, 4]);
  ctxRef.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctxRef.lineWidth = 1.5;
  ctxRef.stroke();
  ctxRef.setLineDash([]);

  ctxRef.restore();
}

// ── Retake ──
function handleRetake() {
  // Hapus foto terakhir
  sessionState.capturedPhotos.pop();
  sessionState.currentCaptureIndex--;

  // Kembali ke camera mode
  showCameraMode();
  updateCaptureText();
}

// ── Next / Selesai ──
function handleNext() {
  if (sessionState.currentCaptureIndex >= sessionState.totalRequiredCaptures) {
    // Semua foto selesai → matikan kamera, gabungkan
    stopCamera();
    gabungkanPhotoStrip();
  } else {
    // Masih ada foto lagi → kembali ke camera mode
    showCameraMode();
    updateCaptureText();
  }
}

function stopCamera() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  }
  video.style.filter = "";
}

// ═══════════════════════════════════════════════════════════════
//  COMPOSITING (PENGGABUNGAN AKHIR)
// ═══════════════════════════════════════════════════════════════
function gabungkanPhotoStrip() {
  goToStep("step-result");
  const config = sessionState.selectedTemplate;

  // Gunakan image yang sudah di-preload
  const bgImg = sessionState.previewBgImg;
  const overlayImg = sessionState.previewOverlayImg;

  if (!bgImg || !overlayImg) {
    alert("Gagal memuat gambar template.");
    return;
  }

  canvas.width = bgImg.width;
  canvas.height = bgImg.height;
  const w = canvas.width;
  const h = canvas.height;

  // 1. Gambar BG
  ctx.drawImage(bgImg, 0, 0, w, h);

  // 2. Gambar Foto-Foto
  config.photoSlots.forEach((slot, i) => {
    const targetIndex = sessionState.captureMap[i];
    const photoCanvas = sessionState.capturedPhotos[targetIndex];
    if (!photoCanvas) return;

    const centerX = w * slot.xPct;
    const centerY = h * slot.yPct;
    const photoWidth = w * slot.wPct;
    const photoHeight = h * slot.hPct;

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate((slot.rotateDeg * Math.PI) / 180);

    // Rounded Corners
    if (slot.cornerRadius) {
      ctx.beginPath();
      ctx.roundRect(
        -photoWidth / 2,
        -photoHeight / 2,
        photoWidth,
        photoHeight,
        slot.cornerRadius,
      );
      ctx.clip();
    }

    if (slot.mirror) ctx.scale(-1, 1);

    // Object-fit: cover
    const sw = photoCanvas.width;
    const sh = photoCanvas.height;
    const sRatio = sw / sh;
    const tRatio = photoWidth / photoHeight;
    let sx, sy, sWidth, sHeight;

    if (sRatio > tRatio) {
      sHeight = sh;
      sWidth = sh * tRatio;
      sx = (sw - sWidth) / 2;
      sy = 0;
    } else {
      sWidth = sw;
      sHeight = sw / tRatio;
      sx = 0;
      sy = (sh - sHeight) / 2;
    }

    ctx.drawImage(
      photoCanvas,
      sx,
      sy,
      sWidth,
      sHeight,
      -photoWidth / 2,
      -photoHeight / 2,
      photoWidth,
      photoHeight,
    );
    ctx.restore();
  });

  // 3. Gambar Overlay
  ctx.drawImage(overlayImg, 0, 0, w, h);
}

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
function setupEventListeners() {
  // Capture button
  document
    .getElementById("btn-capture")
    .addEventListener("click", onCaptureClick);

  // Timer selector
  document.getElementById("timer-select").addEventListener("change", (e) => {
    sessionState.timerDuration = parseInt(e.target.value);
  });

  // Back from capture
  document.getElementById("btn-back-capture").addEventListener("click", () => {
    stopCamera();
    document.getElementById("capture-camera-mode").style.display = "block";
    document.getElementById("capture-review-mode").style.display = "none";
    goToStep("step-landing");
  });

  // Review: Retake & Next
  document.getElementById("btn-retake").addEventListener("click", handleRetake);
  document.getElementById("btn-next").addEventListener("click", handleNext);

  // Result: Download
  document.getElementById("btn-download").addEventListener("click", () => {
    const link = document.createElement("a");
    link.download = `photobooth-${sessionState.selectedTemplate.id}.png`;
    link.href = canvas.toDataURL("image/png");
    link.click();
  });

  // Result: Restart
  document.getElementById("btn-restart").addEventListener("click", () => {
    stopCamera();
    document.getElementById("capture-camera-mode").style.display = "block";
    document.getElementById("capture-review-mode").style.display = "none";
    goToStep("step-landing");
  });
}
