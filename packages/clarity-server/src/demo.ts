import { Express, Request, Response } from "express";
import { IAnalyticsRepository } from "./db/repository";
import { RawClickRecord } from "./types";

// Local playground at /demo. Disabled in production. Reads go through /api/v1/demo/heatmaps, which need no secret
// and serve only the demo_local project.
export function registerDemo(app: Express, repository: IAnalyticsRepository): void {
  // ----------------------------------------------------
  // 6. Interactive Demo Playground & Dummy Data Seeding
  // ----------------------------------------------------
  async function seedDemoData(targetRepo: IAnalyticsRepository, projectId: string, pageUrl: string) {
    const now = Date.now();
    const rawClicks: RawClickRecord[] = [];

    // Helper to add realistic clicks with specific element-relative coordinate ranges
    const addScatteredClicks = (
      selector: string,
      hash: string,
      count: number,
      centerX: number = 16384,
      centerY: number = 16384,
      spreadX: number = 6000,
      spreadY: number = 6000
    ) => {
      for (let i = 0; i < count; i++) {
        const offsetX = Math.floor((Math.random() - 0.5) * 2 * spreadX);
        const offsetY = Math.floor((Math.random() - 0.5) * 2 * spreadY);
        const eX = Math.max(300, Math.min(32400, centerX + offsetX));
        const eY = Math.max(300, Math.min(32400, centerY + offsetY));
        rawClicks.push({
          id: `seed-${projectId}-${selector}-${i}-${Date.now()}-${Math.random()}`,
          projectId,
          pageUrl,
          device: "desktop",
          hash,
          selector,
          eX,
          eY,
          timestamp: now - (count - i) * 25000,
          clientTime: null
        });
      }
    };

    // 1. Hero CTA: scattered across left (eX~8000), center (eX~16384), and right (eX~26000)
    addScatteredClicks("#hero-cta", "hash_hero_cta", 12, 8000, 16384, 3000, 4000);   // Left side
    addScatteredClicks("#hero-cta", "hash_hero_cta", 20, 16384, 16384, 3500, 4000);  // Center
    addScatteredClicks("#hero-cta", "hash_hero_cta", 10, 25000, 16384, 3000, 4000);  // Right side

    // 2. Hero Subtitle Text (Clicks outside buttons!)
    addScatteredClicks("#hero-subtitle", "hash_hero_subtitle", 8, 16384, 16384, 8000, 5000);

    // 3. Paket Pro Card & Button
    addScatteredClicks("#btn-pro", "hash_btn_pro", 18, 16384, 16384, 5000, 5000);
    addScatteredClicks("#card-pro", "hash_card_pro", 10, 16384, 10000, 8000, 6000);   // Card header/text area

    // 4. Paket Starter Card & Button
    addScatteredClicks("#btn-starter", "hash_btn_starter", 8, 12000, 16384, 4000, 4000);
    addScatteredClicks("#card-starter", "hash_card_starter", 5, 16384, 12000, 6000, 5000);

    // 5. Paket Enterprise Button
    addScatteredClicks("#btn-enterprise", "hash_btn_enterprise", 6, 20000, 16384, 4000, 4000);

    // 6. Mid section & Deep section
    addScatteredClicks("#btn-fold", "hash_btn_fold", 14, 14000, 16384, 5000, 4000);
    addScatteredClicks("#section-fold", "hash_section_fold", 6, 16384, 12000, 7000, 5000);
    addScatteredClicks("#btn-deep", "hash_btn_deep", 9, 18000, 16384, 4000, 4000);

    await targetRepo.saveRawClicks(rawClicks);

    // Realistic scroll reach distribution across 35 mock user sessions
    const scrollSessions = [
      { count: 12, maxReach: 100 },
      { count: 10, maxReach: 75 },
      { count: 8, maxReach: 50 },
      { count: 5, maxReach: 25 }
    ];

    let sessionIdx = 0;
    for (const group of scrollSessions) {
      for (let i = 0; i < group.count; i++) {
        sessionIdx++;
        await targetRepo.saveRawScroll({
          id: `seed-scroll-${projectId}-${sessionIdx}-${now}`,
          projectId,
          pageUrl,
          device: "desktop",
          sessionId: `mock-session-${sessionIdx}`,
          maxScrollReachY: group.maxReach,
          timestamp: now - sessionIdx * 45000,
          clientTime: null
        });
      }
    }

    return { seededClicks: rawClicks.length, seededSessions: sessionIdx };
  }

  app.post("/api/v1/demo/seed", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "Demo endpoints are disabled in production environment" });
      return;
    }
    const projectId = String(req.query.projectId || req.body?.projectId || "demo_local");
    if (projectId !== "demo_local") {
      res.status(403).json({ error: "Only 'demo_local' project data can be manipulated via demo endpoints" });
      return;
    }
    const pageUrl = String(req.query.pageUrl || req.body?.pageUrl || "http://localhost:3000/demo");
    const result = await seedDemoData(repository, projectId, pageUrl);
    res.status(200).json({ success: true, ...result });
  });

  app.post("/api/v1/demo/reset", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "Demo endpoints are disabled in production environment" });
      return;
    }
    const projectId = String(req.query.projectId || req.body?.projectId || "demo_local");
    if (projectId !== "demo_local") {
      res.status(403).json({ error: "Only 'demo_local' project data can be manipulated via demo endpoints" });
      return;
    }
    const pageUrl = String(req.query.pageUrl || req.body?.pageUrl || "http://localhost:3000/demo");
    await repository.clearProjectData(projectId, pageUrl);
    res.status(200).json({ success: true, message: "Cleared all telemetry data for demo" });
  });

  app.get("/api/v1/demo/heatmaps/:kind", async (req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(403).json({ error: "Demo endpoints are disabled in production environment" });
      return;
    }
    const pageUrl = String(req.query.pageUrl || "http://localhost:3000/demo");
    const query = { projectId: "demo_local", pageUrl };
    if (req.params.kind === "click") {
      const activity = await repository.getClickActivity(query);
      res.status(200).json({ activity, totalClicks: activity.reduce((sum, a) => sum + a.totalclicks, 0) });
    } else if (req.params.kind === "scroll") {
      const { scrollMap, totalSessions, avgFoldY } = await repository.getScrollMap(query);
      res.status(200).json({ scrollMap, totalSessions, averageFoldY: avgFoldY });
    } else {
      res.status(404).end();
    }
  });

  app.get("/demo", async (_req: Request, res: Response) => {
    if (process.env.NODE_ENV === "production") {
      res.status(404).end();
      return;
    }
    // Ensure demo_local project is registered
    const existing = await repository.getProject("demo_local");
    if (!existing) {
      await repository.createProject({
        id: "demo_local",
        name: "Local Manual Test Playground",
        allowedDomains: ["*"],
        isActive: true,
        createdAt: Date.now()
      });
    }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Skalpl Heatmap - Interactive Playground (Record & Visualize)</title>
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 0; background: #f8fafc; color: #1e293b; }
    
    /* Floating Header Command Bar */
    .top-command-bar {
      position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 999999999;
      background: rgba(255, 255, 255, 0.96); backdrop-filter: blur(12px); border-radius: 16px; padding: 10px 18px;
      box-shadow: 0 14px 35px -8px rgba(0,0,0,0.22), 0 6px 12px -4px rgba(0,0,0,0.1);
      display: flex; gap: 12px; align-items: center; border: 1px solid rgba(226, 232, 240, 0.8);
      max-width: 95vw; flex-wrap: wrap; justify-content: center;
    }
    
    /* Mode Segmented Switch */
    .mode-switch {
      display: flex; background: #e2e8f0; border-radius: 10px; padding: 3px; gap: 2px;
    }
    .mode-btn {
      padding: 7px 14px; border-radius: 8px; border: none; font-weight: 700; cursor: pointer; font-size: 13px; transition: all 0.2s;
      background: transparent; color: #64748b; display: flex; align-items: center; gap: 6px;
    }
    .mode-btn.active.record {
      background: #ef4444; color: white; box-shadow: 0 2px 8px rgba(239, 68, 68, 0.4);
    }
    .mode-btn.active.visualize {
      background: #6366f1; color: white; box-shadow: 0 2px 8px rgba(99, 102, 241, 0.4);
    }

    /* Sub controls */
    .action-group {
      display: flex; gap: 8px; align-items: center;
    }
    .action-btn {
      padding: 7px 13px; border-radius: 8px; border: none; font-weight: 600; cursor: pointer; font-size: 12.5px; transition: all 0.2s;
    }
    .btn-heat { background: #dc2626; color: white; }
    .btn-heat:hover { background: #b91c1c; }
    .btn-scroll { background: #2563eb; color: white; }
    .btn-scroll:hover { background: #1d4ed8; }
    .btn-seed { background: #10b981; color: white; }
    .btn-seed:hover { background: #059669; }
    .btn-reset { background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; }
    .btn-reset:hover { background: #fee2e2; }
    .btn-clear { background: #f1f5f9; color: #475569; border: 1px solid #cbd5e1; }
    .btn-clear:hover { background: #e2e8f0; }

    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%; background: #22c55e;
      display: inline-block; animation: pulse 1.5s infinite;
    }
    @keyframes pulse {
      0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
      70% { transform: scale(1.1); box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
      100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
    }

    .badge {
      font-size: 12px; font-weight: 600; background: #f1f5f9; padding: 5px 10px; border-radius: 6px; color: #334155;
    }

    /* Interactive Click Ripple Feedback */
    .click-ripple {
      position: absolute; width: 28px; height: 28px; border-radius: 50%;
      border: 2px solid #ef4444; background: rgba(239, 68, 68, 0.3);
      pointer-events: none; transform: translate(-50%, -50%) scale(0.4);
      animation: ripple-anim 0.6s ease-out forwards; z-index: 999999;
    }
    @keyframes ripple-anim {
      to { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
    }

    .toast-pill {
      position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); z-index: 999999999;
      background: #0f172a; color: #f8fafc; padding: 8px 18px; border-radius: 20px; font-size: 13px; font-weight: 500;
      opacity: 0; transition: opacity 0.3s; pointer-events: none; box-shadow: 0 8px 20px rgba(0,0,0,0.3);
    }

    /* Playground Content */
    header { background: linear-gradient(135deg, #4f46e5, #7c3aed); color: white; padding: 95px 24px 75px; text-align: center; }
    header h1 { margin: 0 0 12px; font-size: 38px; }
    header p { margin: 0 auto 24px; max-width: 680px; font-size: 17px; opacity: 0.92; line-height: 1.5; }
    
    .cta-btn {
      background: #22c55e; color: white; padding: 15px 36px; font-size: 17px; font-weight: bold;
      border-radius: 10px; border: none; cursor: pointer; box-shadow: 0 4px 14px rgba(34,197,94,0.4);
      transition: transform 0.1s, background 0.2s;
    }
    .cta-btn:active { transform: scale(0.97); }
    .cta-btn:hover { background: #16a34a; }

    .container { max-width: 1000px; margin: 40px auto; padding: 0 20px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px; margin: 40px 0; }
    .card {
      background: white; border-radius: 14px; padding: 26px; border: 1px solid #e2e8f0;
      box-shadow: 0 2px 6px rgba(0,0,0,0.03); transition: transform 0.2s; cursor: pointer;
    }
    .card:hover { transform: translateY(-2px); border-color: #cbd5e1; }
    .card h3 { margin-top: 0; font-size: 20px; }
    .card button {
      background: #3b82f6; color: white; border: none; padding: 11px 18px; border-radius: 8px; cursor: pointer; font-weight: 600;
      transition: opacity 0.2s; width: 100%; margin-top: 14px;
    }
    .card button:hover { opacity: 0.9; }

    .info-banner {
      background: #eff6ff; border: 1px solid #bfdbfe; color: #1e40af; border-radius: 10px; padding: 14px 18px;
      margin: 20px auto; max-width: 1000px; font-size: 14px; line-height: 1.5;
    }
    
    .scroll-section {
      background: white; border-radius: 14px; padding: 40px; margin: 40px 0; border: 1px solid #e2e8f0; min-height: 420px;
    }
    footer { background: #0f172a; color: #94a3b8; text-align: center; padding: 60px 20px; margin-top: 80px; }
  </style>

  <!-- 1. Tracking SDK (Clarity Engine) -->
  <script src="/tracker.js"></script>
  <script>
    window.skalplHeatmap("start", {
      projectId: "demo_local",
      upload: "/api/v1/collect",
      delay: 500 // Flush clicks every 500ms
    });
  </script>

  <!-- 2. Visualize Engine for Rendering Heatmap Overlay -->
  <script src="/visualize.js"></script>
</head>
<body>

  <!-- Floating Command Bar -->
  <div class="top-command-bar">
    <!-- Mode Switcher -->
    <div class="mode-switch">
      <button class="mode-btn active record" id="tab-record" onclick="setMode('record')">
        <span class="pulse-dot"></span> 🔴 Mode Record
      </button>
      <button class="mode-btn visualize" id="tab-visualize" onclick="setMode('visualize')">
        🔥 Mode Visualize
      </button>
    </div>

    <!-- Controls for Record Mode -->
    <div class="action-group" id="controls-record">
      <span class="badge" id="click-stats">Clicks Lokal: 0</span>
      <span class="badge" id="db-stats" style="background: #e0f2fe; color: #0369a1;">Klik di DB: Memeriksa...</span>
      <button class="action-btn btn-reset" onclick="resetDbData()" title="Hapus seluruh klik di database untuk mulai merekam dari nol">🗑️ Reset DB</button>
      <button class="action-btn btn-seed" onclick="seedSampleData()" title="Suntikkan 100+ sampel klik tersebar">🎯 Seed Contoh</button>
    </div>

    <!-- Controls for Visualize Mode -->
    <div class="action-group" id="controls-visualize" style="display: none;">
      <button class="action-btn btn-heat" onclick="showClickHeatmap()">🔥 Click Heatmap</button>
      <button class="action-btn btn-scroll" onclick="showScrollHeatmap()">📜 Scroll Heatmap</button>
      <button class="action-btn btn-seed" onclick="seedSampleData()">🎯 Seed Contoh</button>
      <button class="action-btn btn-reset" onclick="resetDbData()">🗑️ Reset DB</button>
      <button class="action-btn btn-clear" onclick="clearHeatmap()">🧹 Clear</button>
    </div>
  </div>

  <div class="toast-pill" id="click-toast">🎯 Target Clicked</div>

  <!-- Page Content with Explicit IDs on Every Element -->
  <header id="hero-header">
    <h1 id="hero-title">Skalpl Heatmap Playground</h1>
    <p id="hero-subtitle">
      Silakan klik di mana saja (di teks ini, di background ungu, di kartu paket, atau tombol). Setiap klik akan memunculkan efek ripple merah dan dicatat koordinat presisinya!
    </p>
    <button class="cta-btn" id="hero-cta">🚀 Coba Klik Tombol Ini!</button>
  </header>

  <div class="info-banner" id="helper-banner">
    💡 <strong>Mode Record Aktif:</strong> Coba klik di berbagai sudut (misal: sisi kiri tombol, sisi kanan tombol, teks judul kartu). Kemudian klik <strong>"🔥 Mode Visualize"</strong> untuk melihat titik panas tepat di posisi Anda mengklik!
  </div>

  <div class="container" id="main-container">
    <h2 id="pricing-title">Pilihan Paket (Coba Klik Teks Judul, Kartu, atau Tombol)</h2>
    <div class="grid" id="pricing-grid">
      <div class="card" id="card-starter">
        <h3 id="card-starter-title">Paket Starter</h3>
        <p id="card-starter-desc">Cocok untuk UMKM pemula yang baru merintis toko online di Skalpl.</p>
        <button id="btn-starter">Pilih Starter</button>
      </div>
      <div class="card" id="card-pro">
        <h3 id="card-pro-title">Paket Pro</h3>
        <p id="card-pro-desc">Fitur analitik lengkap, heatmap, dan kustom domain tanpa batas.</p>
        <button id="btn-pro" style="background: #8b5cf6;">Pilih Pro</button>
      </div>
      <div class="card" id="card-enterprise">
        <h3 id="card-enterprise-title">Paket Enterprise</h3>
        <p id="card-enterprise-desc">Dukungan dedicated server, prioritas SLA 99.9%, dan tim teknis 24/7.</p>
        <button id="btn-enterprise" style="background: #0f172a;">Hubungi Sales</button>
      </div>
    </div>

    <div class="scroll-section" id="section-fold">
      <h2 id="fold-title">Section Pertengahan Halaman</h2>
      <p id="fold-desc">Scroll terus ke bawah untuk merekam metrik scroll reach (50%, 75%, 100%).</p>
      <button id="btn-fold" style="padding: 12px 22px; font-size: 15px; background: #3b82f6; color: white; border: none; border-radius: 8px; cursor: pointer;">Tombol Tengah Halaman</button>
    </div>

    <div class="scroll-section" id="section-deep" style="min-height: 520px; background: #fdf2f8;">
      <h2 id="deep-title">Bagian Bawah Halaman (Deep Scroll)</h2>
      <p id="deep-desc">Hanya pengunjung yang scroll sampai bawah yang akan tercatat di scroll reach 100%.</p>
      <button id="btn-deep" style="padding: 14px 24px; background: #ec4899; color: white; border: none; border-radius: 8px; font-weight: bold; cursor: pointer;">Tombol Bawah</button>
    </div>
  </div>

  <footer id="page-footer">
    <p id="footer-text">&copy; 2026 Skalpl Analytics Engine. Whitelabel Behavioral Intelligence.</p>
  </footer>

  <script>
    let localClickCount = 0;
    let activeMode = 'record';
    let currentHeatmapType = 'none';
    let cachedDbActivity = [];
    let liveLocalActivity = [];
    const currentUrl = window.location.origin + window.location.pathname;

    function getVisualizer() {
      return window.clarityVisualize || (window.skalplHeatmap && window.skalplHeatmap.visualize);
    }

    // Global Click Listener: Catat klik DI MANA SAJA (teks, kartu, background, tombol)
    document.addEventListener('click', (e) => {
      // Abaikan klik pada bilah navigasi kontrol di atas
      if (e.target && e.target.closest('.top-command-bar')) return;

      localClickCount++;
      document.getElementById('click-stats').innerText = 'Clicks Lokal: ' + localClickCount;

      // Efek animasi ripple merah di koordinat klik nyata
      renderClickRipple(e.pageX, e.pageY);

      // Identifikasi target elemen dan posisi relatifnya
      const el = e.target.nodeType === Node.TEXT_NODE ? e.target.parentElement : e.target;
      const targetName = el.id ? '#' + el.id : el.tagName.toLowerCase();
      
      const r = el.getBoundingClientRect();
      const eX = Math.max(0, Math.min(32767, Math.round(((e.clientX - r.left) / (r.width || 1)) * 32767)));
      const eY = Math.max(0, Math.min(32767, Math.round(((e.clientY - r.top) / (r.height || 1)) * 32767)));

      // Catat ke live local activity untuk visualisasi seketika (0ms delay)
      let existing = liveLocalActivity.find(a => a.selector === targetName);
      if (!existing) {
        existing = {
          hash: 'live_' + targetName,
          selector: targetName,
          totalclicks: 0,
          points: 0,
          x: [],
          y: [],
          clicks: []
        };
        liveLocalActivity.push(existing);
      }
      existing.totalclicks++;
      existing.points++;
      existing.x.push(eX);
      existing.y.push(eY);
      existing.clicks.push(1);

      const relX = Math.round((eX / 32767) * 100);
      const relY = Math.round((eY / 32767) * 100);

      const toast = document.getElementById('click-toast');
      if (toast) {
        toast.innerText = '🎯 Klik terekam di <' + targetName + '> pos: (' + relX + '%, ' + relY + '%)';
        toast.style.opacity = '1';
        clearTimeout(toast._timer);
        toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2000);
      }

      // Jika sedang di mode Visualize dan Clickmap aktif, render langsung saat itu juga!
      if (activeMode === 'visualize' && currentHeatmapType === 'click') {
        renderMergedHeatmap();
      }

      // Refresh DB count setelah beacon terkirim (delay 700ms)
      setTimeout(refreshDbStats, 700);
    }, true);

    function renderClickRipple(pageX, pageY) {
      const ripple = document.createElement('div');
      ripple.className = 'click-ripple';
      ripple.style.left = pageX + 'px';
      ripple.style.top = pageY + 'px';
      document.body.appendChild(ripple);
      setTimeout(() => { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 650);
    }

    async function refreshDbStats() {
      try {
        const res = await fetch('/api/v1/demo/heatmaps/click?projectId=demo_local&pageUrl=' + encodeURIComponent(currentUrl));
        const data = await res.json();
        document.getElementById('db-stats').innerText = 'Klik di DB: ' + (data.totalClicks || 0);
      } catch (e) {}
    }

    function setMode(mode) {
      activeMode = mode;
      const tabRecord = document.getElementById('tab-record');
      const tabVisualize = document.getElementById('tab-visualize');
      const ctrlRecord = document.getElementById('controls-record');
      const ctrlVisualize = document.getElementById('controls-visualize');
      const banner = document.getElementById('helper-banner');

      if (mode === 'record') {
        tabRecord.className = 'mode-btn active record';
        tabVisualize.className = 'mode-btn visualize';
        ctrlRecord.style.display = 'flex';
        ctrlVisualize.style.display = 'none';
        clearHeatmap();
        banner.innerHTML = '💡 <strong>Mode Record Aktif:</strong> Klik di mana saja (kartu, teks, sisi tombol). Efek ripple merah menunjukkan lokasi persis klik Anda!';
      } else {
        tabRecord.className = 'mode-btn record';
        tabVisualize.className = 'mode-btn active visualize';
        ctrlRecord.style.display = 'none';
        ctrlVisualize.style.display = 'flex';
        banner.innerHTML = '🔥 <strong>Mode Visualize Aktif:</strong> Heatmap dirender langsung di atas elemen. Kanvas transparan klik, jadi Anda tetap bisa berinteraksi!';
        showClickHeatmap();
      }
      refreshDbStats();
    }

    async function showClickHeatmap() {
      currentHeatmapType = 'click';
      clearHeatmap();
      try {
        const res = await fetch('/api/v1/demo/heatmaps/click?projectId=demo_local&pageUrl=' + encodeURIComponent(currentUrl));
        const data = await res.json();
        cachedDbActivity = data.activity || [];
        await renderMergedHeatmap();
      } catch (err) {
        alert('Gagal memuat click heatmap: ' + err.message);
      }
    }

    async function renderMergedHeatmap() {
      try {
        const viz = getVisualizer();
        if (!viz) return;

        // Gabungkan riwayat klik dari DB + klik realtime lokal yang baru saja diklik
        const mergedMap = new Map();
        for (const item of cachedDbActivity) {
          mergedMap.set(item.selector, {
            hash: item.hash,
            selector: item.selector,
            totalclicks: item.totalclicks,
            points: item.points,
            x: [...item.x],
            y: [...item.y],
            clicks: [...item.clicks]
          });
        }

        for (const live of liveLocalActivity) {
          let item = mergedMap.get(live.selector);
          if (!item) {
            item = {
              hash: live.hash,
              selector: live.selector,
              totalclicks: 0,
              points: 0,
              x: [],
              y: [],
              clicks: []
            };
            mergedMap.set(live.selector, item);
          }
          item.totalclicks += live.totalclicks;
          item.points += live.points;
          item.x.push(...live.x);
          item.y.push(...live.y);
          item.clicks.push(...live.clicks);
        }

        const combinedActivity = Array.from(mergedMap.values());
        await viz.setup(window, { version: "0.8.76" });
        viz.clickmap(combinedActivity);
      } catch (e) {
        console.error("renderMergedHeatmap error:", e);
      }
    }

    async function showScrollHeatmap() {
      currentHeatmapType = 'scroll';
      clearHeatmap();
      try {
        const res = await fetch('/api/v1/demo/heatmaps/scroll?projectId=demo_local&pageUrl=' + encodeURIComponent(currentUrl));
        const data = await res.json();
        
        const viz = getVisualizer();
        if (!viz) throw new Error("Visualizer library is not loaded yet");
        await viz.setup(window, { version: "0.8.76" });
        viz.scrollmap(data.scrollMap, data.averageFoldY, true);
      } catch (err) {
        alert('Gagal memuat scrollmap: ' + err.message);
      }
    }

    async function seedSampleData() {
      try {
        const res = await fetch('/api/v1/demo/seed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'demo_local', pageUrl: currentUrl })
        });
        const data = await res.json();
        await refreshDbStats();
        if (activeMode === 'visualize') {
          await showClickHeatmap();
        }
      } catch (err) {
        alert('Gagal seeding data: ' + err.message);
      }
    }

    async function resetDbData() {
      if (!confirm('Kosongkan semua data klik & scroll di DB untuk mulai merekam dari nol?')) return;
      try {
        await fetch('/api/v1/demo/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: 'demo_local', pageUrl: currentUrl })
        });
        localClickCount = 0;
        liveLocalActivity = [];
        cachedDbActivity = [];
        document.getElementById('click-stats').innerText = 'Clicks Lokal: 0';
        clearHeatmap();
        await refreshDbStats();
      } catch (err) {
        alert('Gagal reset DB: ' + err.message);
      }
    }

    function clearHeatmap() {
      currentHeatmapType = 'none';
      try {
        const viz = getVisualizer();
        if (viz && viz.clearmap) viz.clearmap();
      } catch (e) {}
    }

    // Initial check on load
    window.addEventListener('load', () => {
      refreshDbStats();
    });
  </script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8").status(200).send(html);
  });

}
