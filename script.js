// ═══════════════════════════════════════════════════════════════
//  PHOTOBOOTH APP — script.js
//  Fitur: Filter, Live Preview, Retake, Timer Konfigurabel, Auto-Camera
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
let isFrontCameraActive = true; // Track kamera depan/belakang
let deviceOrientationAngle = 0; // 0 = portrait, 90 = landscape-right, -90 = landscape-left

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
  initOrientationDetection();
});

// ── 5. DEVICE ORIENTATION DETECTION ──
function initOrientationDetection() {
  if (!window.DeviceOrientationEvent) return;
  let debounceTimer = null;
  let lastAngle = 0;

  window.addEventListener(
    "deviceorientation",
    (e) => {
      if (e.gamma === null) return;
      let angle = 0;
      if (Math.abs(e.gamma) > 45) {
        angle = e.gamma > 0 ? 90 : -90;
      }
      if (angle === lastAngle) return;
      lastAngle = angle;

      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const screenAngle = screen.orientation ? screen.orientation.angle : 0;
        if (screenAngle === 0 || screenAngle === 180) {
          deviceOrientationAngle = angle;
        } else {
          deviceOrientationAngle = 0;
        }
        updateVideoTransform();
      }, 250);
    },
    true,
  );
}

function updateVideoTransform() {
  if (!video || !video.videoWidth) return;

  const isPortraitStream = video.videoWidth < video.videoHeight;
  const isLandscapePhysical = deviceOrientationAngle !== 0;

  // Jika HP landscape tapi stream portrait (berarti OS melock rotasi)
  if (isLandscapePhysical && isPortraitStream) {
    let rotDeg = deviceOrientationAngle;
    if (isFrontCameraActive) {
      rotDeg = -rotDeg;
    }
    const mirrorScale = isFrontCameraActive ? "scaleX(-1)" : "scaleX(1)";
    
    // Set video element menjadi 3:4 secara layout, lalu rotasi ke 4:3
    video.style.position = "absolute";
    video.style.top = "50%";
    video.style.left = "50%";
    video.style.width = "75%";       // 3/4 dari container
    video.style.height = "133.333%"; // 4/3 dari container
    video.style.transform = `translate(-50%, -50%) ${mirrorScale} rotate(${rotDeg}deg)`;
  } else {
    // Normal
    const mirrorScale = isFrontCameraActive ? "scaleX(-1)" : "none";
    video.style.position = "static";
    video.style.width = "100%";
    video.style.height = "100%";
    video.style.transform = mirrorScale;
  }
}

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

    // PENTING: Panggil preload agar gambar tersedia untuk fungsi Live Preview / Mini Preview!
    await preloadTemplateAssets();

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
async function startCamera(deviceId = null) {
  const loadingOverlay = document.getElementById("loading-overlay");

  try {
    if (loadingOverlay) loadingOverlay.style.display = "flex";

    if (currentStream) {
      currentStream.getTracks().forEach((track) => track.stop());
    }

    const videoConstraints = {
      width: { ideal: 4096 },
      height: { ideal: 4096 }
    };
    if (deviceId) {
      videoConstraints.deviceId = { exact: deviceId };
    } else {
      videoConstraints.facingMode = "user";
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
      });
    } catch (constraintErr) {
      // Fallback: coba tanpa constraint spesifik jika gagal
      console.warn("Constraint awal gagal, mencoba fallback:", constraintErr);
      const fallbackConstraints = deviceId
        ? { deviceId: { exact: deviceId } }
        : { facingMode: "user" };
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: fallbackConstraints,
        });
      } catch (fallbackErr) {
        // Fallback terakhir: tanpa constraint sama sekali
        console.warn("Fallback kedua gagal, mencoba video: true:", fallbackErr);
        stream = await navigator.mediaDevices.getUserMedia({ video: true });
      }
    }

    currentStream = stream;
    video.srcObject = stream;

    // --- SOLUSI: FLIP KAMERA & CEK BELAKANG/DEPAN ---
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const label = track.label.toLowerCase();

    // Set state kamera depan/belakang + mirror
    if (settings.facingMode === "environment" || label.includes("back")) {
      isFrontCameraActive = false;
    } else {
      isFrontCameraActive = true;
    }

    video.addEventListener('loadedmetadata', () => {
      updateVideoTransform();
    }, { once: true });

    if (loadingOverlay) loadingOverlay.style.display = "none";

    sessionState.capturedPhotos = [];
    sessionState.currentCaptureIndex = 0;

    goToStep("step-capture");
    updateCaptureText();

    // Generate dropdown lensa
    await populateCameraDropdown(deviceId || settings.deviceId);

    const btnStartCap = document.getElementById("btn-start-capture");
    if (btnStartCap) {
      btnStartCap.style.display = "inline-block";

      btnStartCap.replaceWith(btnStartCap.cloneNode(true));
      document
        .getElementById("btn-start-capture")
        .addEventListener("click", function () {
          this.style.display = "none";
          const camSelector = document.querySelector(".camera-selector");
          if (camSelector) camSelector.style.display = "none";
          tampilkanCountdownAndJepret();
        });
    }
  } catch (err) {
    if (loadingOverlay) loadingOverlay.style.display = "none";
    console.error("Camera error:", err.name, err.message);

    let msg = "Kamera tidak bisa diakses!\n\n";
    if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
      msg += "Izin kamera ditolak. Coba:\n1. Klik ikon gembok/kamera di address bar\n2. Izinkan kamera\n3. Refresh halaman";
    } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError") {
      msg += "Tidak ditemukan kamera pada perangkat ini.";
    } else if (err.name === "NotReadableError" || err.name === "TrackStartError") {
      msg += "Kamera sedang digunakan aplikasi lain. Tutup aplikasi lain yang menggunakan kamera, lalu refresh.";
    } else if (err.name === "OverconstrainedError") {
      msg += "Kamera tidak mendukung pengaturan yang diminta. Coba refresh halaman.";
    } else {
      msg += "Pastikan kamu telah mengizinkan akses kamera di browser.";
    }
    alert(msg);
  }
}

async function populateCameraDropdown(activeDeviceId) {
  const selectorContainer = document.querySelector(".camera-selector");
  const selectElement = document.getElementById("camera-select");
  if (!selectorContainer || !selectElement) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputDevices = devices.filter(
      (device) => device.kind === "videoinput",
    );

    if (videoInputDevices.length <= 1) {
      selectorContainer.style.display = "none";
      return;
    }

    selectorContainer.style.display = "block";
    selectElement.innerHTML = "";

    videoInputDevices.forEach((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;

      // --- SOLUSI: TRANSLATE NAMA LENSA MENJADI RAMAH USER ---
      let labelRaw = device.label.toLowerCase();
      let niceName = `Kamera ${index + 1}`;

      if (labelRaw.includes("front") || labelRaw.includes("user")) {
        niceName = "📸 Kamera Depan";
        if (
          videoInputDevices.filter((d) =>
            d.label.toLowerCase().includes("front"),
          ).length > 1
        ) {
          niceName += ` (${index + 1})`;
        }
      } else if (
        labelRaw.includes("back") ||
        labelRaw.includes("environment")
      ) {
        niceName = "🎥 Kamera Belakang";
        const backCams = videoInputDevices.filter((d) =>
          d.label.toLowerCase().includes("back"),
        );
        if (backCams.length > 1) {
          niceName += ` Lensa ${backCams.indexOf(device) + 1}`;
        }
      } else {
        niceName = device.label || niceName;
      }

      option.text = niceName;

      // Pilih kamera yang aktif
      if (activeDeviceId && device.deviceId === activeDeviceId) {
        option.selected = true;
      } else if (!activeDeviceId && labelRaw.includes("front")) {
        option.selected = true;
      }

      selectElement.appendChild(option);
    });

    selectElement.onchange = (e) => {
      startCamera(e.target.value);
    };
  } catch (error) {
    console.error("Gagal mendata kamera:", error);
  }
}

// Preload assets dijalankan sekali di awal pemilihan template
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
  const btn = document.getElementById("btn-capture");
  btn.disabled = true;
  tampilkanCountdownAndJepret();
}

function tampilkanCountdownAndJepret() {
  let timer = sessionState.timerDuration;
  countdownElement.textContent = timer;
  countdownElement.style.display = "flex";

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
  const flash = document.getElementById("flash-overlay");
  if (flash) {
    flash.classList.remove("flash");
    void flash.offsetWidth;
    flash.classList.add("flash");
  }

  const tempCanvas = document.createElement("canvas");
  const tempCtx = tempCanvas.getContext("2d");

  const isPortraitStream = video.videoWidth < video.videoHeight;
  const isLandscapePhysical = deviceOrientationAngle !== 0;

  if (isLandscapePhysical && isPortraitStream) {
    // HP landscape tapi stream portrait -> tukar dimensi canvas
    tempCanvas.width = video.videoHeight;
    tempCanvas.height = video.videoWidth;

    tempCtx.save();
    tempCtx.translate(tempCanvas.width / 2, tempCanvas.height / 2);
    
    if (isFrontCameraActive) {
      tempCtx.scale(-1, 1);
    }
    
    let rotRad = deviceOrientationAngle === 90 ? Math.PI / 2 : -Math.PI / 2;
    if (isFrontCameraActive) {
      rotRad = -rotRad;
    }
    tempCtx.rotate(rotRad);

    // Gambar video dengan titik tengah sebagai poros
    tempCtx.drawImage(
      video,
      -video.videoWidth / 2,
      -video.videoHeight / 2,
      video.videoWidth,
      video.videoHeight
    );
    tempCtx.restore();
  } else {
    // Normal capture
    tempCanvas.width = video.videoWidth;
    tempCanvas.height = video.videoHeight;

    tempCtx.save();
    if (isFrontCameraActive) {
      tempCtx.translate(tempCanvas.width, 0);
      tempCtx.scale(-1, 1);
    }
    tempCtx.drawImage(video, 0, 0, tempCanvas.width, tempCanvas.height);
    tempCtx.restore();
  }

  if (sessionState.selectedFilter !== "none") {
    tempCtx.filter = sessionState.selectedFilter;
    // Terapkan filter ke canvas yang sudah ada gambarnya
    const filteredCanvas = document.createElement("canvas");
    filteredCanvas.width = tempCanvas.width;
    filteredCanvas.height = tempCanvas.height;
    const filteredCtx = filteredCanvas.getContext("2d");
    filteredCtx.filter = sessionState.selectedFilter;
    filteredCtx.drawImage(tempCanvas, 0, 0);
    sessionState.capturedPhotos.push(filteredCanvas);
  } else {
    sessionState.capturedPhotos.push(tempCanvas);
  }
  sessionState.currentCaptureIndex++;

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

  const btnNext = document.getElementById("btn-next");
  if (current >= total) {
    btnNext.textContent = "✅ Selesai!";
  } else {
    btnNext.textContent = "✅ Lanjut";
  }

  renderMiniPreview();
}

function renderMiniPreview() {
  const config = sessionState.selectedTemplate;
  const previewCanvas = document.getElementById("preview-canvas");
  const previewCtx = previewCanvas.getContext("2d");

  const bgImg = sessionState.previewBgImg;
  const overlayImg = sessionState.previewOverlayImg;
  if (!bgImg) return;

  const maxW = 350;
  const scale = maxW / config.canvas.width;
  previewCanvas.width = maxW;
  previewCanvas.height = Math.round(config.canvas.height * scale);

  const w = previewCanvas.width;
  const h = previewCanvas.height;

  previewCtx.drawImage(bgImg, 0, 0, w, h);

  config.photoSlots.forEach((slot, i) => {
    const targetIndex = sessionState.captureMap[i];
    const photoCanvas = sessionState.capturedPhotos[targetIndex];
    if (!photoCanvas) {
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

  ctxRef.fillStyle = "rgba(0, 0, 0, 0.15)";
  ctxRef.fill();

  ctxRef.setLineDash([4, 4]);
  ctxRef.strokeStyle = "rgba(255, 255, 255, 0.5)";
  ctxRef.lineWidth = 1.5;
  ctxRef.stroke();
  ctxRef.setLineDash([]);

  ctxRef.restore();
}

function handleRetake() {
  sessionState.capturedPhotos.pop();
  sessionState.currentCaptureIndex--;
  showCameraMode();
  updateCaptureText();
}

function handleNext() {
  if (sessionState.currentCaptureIndex >= sessionState.totalRequiredCaptures) {
    stopCamera();
    gabungkanPhotoStrip();
  } else {
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

  ctx.drawImage(bgImg, 0, 0, w, h);

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

  ctx.drawImage(overlayImg, 0, 0, w, h);
}

// ═══════════════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════════════
function setupEventListeners() {
  const btnCapture = document.getElementById("btn-capture");
  if (btnCapture) btnCapture.addEventListener("click", onCaptureClick);

  const timerSelect = document.getElementById("timer-select");
  if (timerSelect) {
    timerSelect.addEventListener("change", (e) => {
      sessionState.timerDuration = parseInt(e.target.value);
    });
  }

  const btnBackCapture = document.getElementById("btn-back-capture");
  if (btnBackCapture) {
    btnBackCapture.addEventListener("click", () => {
      stopCamera();
      document.getElementById("capture-camera-mode").style.display = "block";
      document.getElementById("capture-review-mode").style.display = "none";
      goToStep("step-landing");
    });
  }

  const btnRetake = document.getElementById("btn-retake");
  if (btnRetake) btnRetake.addEventListener("click", handleRetake);

  const btnNext = document.getElementById("btn-next");
  if (btnNext) btnNext.addEventListener("click", handleNext);

  const btnDownload = document.getElementById("btn-download");
  if (btnDownload) {
    btnDownload.addEventListener("click", () => {
      const link = document.createElement("a");
      link.download = `photobooth-${sessionState.selectedTemplate.id}.png`;
      link.href = canvas.toDataURL("image/png");
      link.click();
    });
  }

  const btnRestart = document.getElementById("btn-restart");
  if (btnRestart) {
    btnRestart.addEventListener("click", () => {
      stopCamera();
      document.getElementById("capture-camera-mode").style.display = "block";
      document.getElementById("capture-review-mode").style.display = "none";
      goToStep("step-landing");
    });
  }
}
