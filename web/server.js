'use strict';
/**
 * web/server.js
 * High-performance, zero-dependency HTTP Web Server & REST API.
 * Binds to 0.0.0.0:3000 for preview in Arena.
 */

const http = require('node:http');
const url  = require('node:url');
const config = require('../config.json');
const queries = require('../database/queries');
const { getBankStats, getAllQuestions } = require('../utils/questionBank');
const sm = require('../utils/sessionManager');

function createWebServer(client = null) {
  const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.query;

    // ── API ROUTES ──────────────────────────────────────────────────────────
    if (pathname.startsWith('/api/v1/')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');

      // GET /api/v1/stats
      if (pathname === '/api/v1/stats') {
        const bankStats = getBankStats();
        const activeSessions = sm.getAllActiveSessions();
        const totalSessions = queries.getTotalSessionsCount();
        const totalPlayers = queries.getTotalGlobalPlayers();

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          stats: {
            totalQuestions: bankStats.totalQuestions,
            categoryCounts: bankStats.categoryCounts,
            activeGames: activeSessions.length,
            totalSessionsArchived: totalSessions,
            totalUniquePlayers: totalPlayers,
            uptimeSeconds: Math.floor(process.uptime()),
            connectedGuilds: client?.guilds?.cache?.size ?? 1,
          }
        }));
        return;
      }

      // GET /api/v1/questions
      if (pathname === '/api/v1/questions') {
        const all = getAllQuestions();
        let filtered = all;

        if (query.category && query.category !== 'all') {
          filtered = filtered.filter(q => q.category === query.category);
        }
        if (query.difficulty && query.difficulty !== 'all') {
          filtered = filtered.filter(q => q.difficulty === query.difficulty);
        }
        if (query.search) {
          const s = query.search.toLowerCase();
          filtered = filtered.filter(q => q.text.toLowerCase().includes(s) || q.options.some(o => o.toLowerCase().includes(s)));
        }

        const page = parseInt(query.page, 10) || 1;
        const limit = parseInt(query.limit, 10) || 20;
        const total = filtered.length;
        const startIndex = (page - 1) * limit;
        const results = filtered.slice(startIndex, startIndex + limit);

        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          total,
          page,
          totalPages: Math.ceil(total / limit),
          questions: results,
        }));
        return;
      }

      // GET /api/v1/categories
      if (pathname === '/api/v1/categories') {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          categories: config.categories,
        }));
        return;
      }

      // GET /api/v1/leaderboard
      if (pathname === '/api/v1/leaderboard') {
        const limit = parseInt(query.limit, 10) || 10;
        const leaderboard = queries.getGlobalLeaderboard(limit);
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          leaderboard,
        }));
        return;
      }

      // GET /api/v1/shop
      if (pathname === '/api/v1/shop') {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          items: config.shopItems || [],
        }));
        return;
      }

      // 404 for unknown API
      res.writeHead(404);
      res.end(JSON.stringify({ success: false, error: 'API endpoint not found' }));
      return;
    }

    // ── WEB DASHBOARD UI (HTML / CSS / JS) ───────────────────────────────────
    if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.writeHead(200);
      res.end(renderDashboardHtml());
      return;
    }

    // Default 404
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  });

  return server;
}

/**
 * Render the full modern Dashboard UI with Arabic RTL styling & glassmorphism
 */
function renderDashboardHtml() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>بوت مسابقات المعرفة العربي — المنصة الشاملة</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;900&family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #0f172a;
      --bg-card: #1e293b;
      --bg-card-hover: #334155;
      --primary: #6366f1;
      --primary-hover: #4f46e5;
      --accent-gold: #f59e0b;
      --accent-green: #10b981;
      --accent-red: #ef4444;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --border: #334155;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Cairo', 'Tajawal', sans-serif;
    }

    body {
      background-color: var(--bg-dark);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Navbar */
    header {
      background: rgba(30, 41, 59, 0.85);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 50;
    }

    .nav-container {
      max-width: 1300px;
      margin: 0 auto;
      padding: 0.85rem 1.5rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      font-weight: 900;
      font-size: 1.35rem;
      color: #fff;
      text-decoration: none;
    }

    .brand-badge {
      background: linear-gradient(135deg, var(--primary), #a855f7);
      padding: 0.2rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      color: #fff;
    }

    .nav-links {
      display: flex;
      gap: 0.5rem;
      list-style: none;
    }

    .nav-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 0.5rem 1rem;
      border-radius: 0.5rem;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }

    .nav-btn:hover, .nav-btn.active {
      color: #fff;
      background: var(--bg-card-hover);
    }

    /* Container */
    .container {
      max-width: 1300px;
      margin: 2rem auto;
      padding: 0 1.5rem;
      flex: 1;
      width: 100%;
    }

    /* Hero */
    .hero {
      background: linear-gradient(135deg, rgba(99, 102, 241, 0.15), rgba(168, 85, 247, 0.15));
      border: 1px solid rgba(99, 102, 241, 0.3);
      border-radius: 1.25rem;
      padding: 2.5rem;
      margin-bottom: 2rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: 1.5rem;
    }

    .hero-title {
      font-size: 2.2rem;
      font-weight: 900;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #fff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    .hero-subtitle {
      color: var(--text-muted);
      font-size: 1.1rem;
      max-width: 650px;
      line-height: 1.6;
    }

    /* KPI Cards */
    .grid-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 1.25rem;
      margin-bottom: 2rem;
    }

    .stat-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.5rem;
      display: flex;
      align-items: center;
      gap: 1.25rem;
      transition: transform 0.2s, border-color 0.2s;
    }

    .stat-card:hover {
      transform: translateY(-3px);
      border-color: var(--primary);
    }

    .stat-icon {
      width: 54px;
      height: 54px;
      border-radius: 0.85rem;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.75rem;
      background: rgba(99, 102, 241, 0.15);
      color: var(--primary);
    }

    .stat-val {
      font-size: 1.8rem;
      font-weight: 800;
      color: #fff;
    }

    .stat-lbl {
      color: var(--text-muted);
      font-size: 0.9rem;
      font-weight: 600;
    }

    /* Section Cards */
    .card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 1rem;
      padding: 1.75rem;
      margin-bottom: 2rem;
    }

    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--border);
      padding-bottom: 1rem;
    }

    .card-title {
      font-size: 1.35rem;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    /* Table */
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: right;
    }

    th, td {
      padding: 1rem;
      border-bottom: 1px solid var(--border);
    }

    th {
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.9rem;
    }

    tbody tr:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .badge {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 0.4rem;
      font-size: 0.8rem;
      font-weight: 700;
    }

    .badge-easy { background: rgba(16, 185, 129, 0.2); color: #34d399; }
    .badge-medium { background: rgba(245, 158, 11, 0.2); color: #fbbf24; }
    .badge-hard { background: rgba(239, 68, 68, 0.2); color: #f87171; }

    /* Inputs */
    .form-control {
      background: var(--bg-dark);
      border: 1px solid var(--border);
      border-radius: 0.5rem;
      padding: 0.65rem 1rem;
      color: #fff;
      font-size: 0.95rem;
      width: 100%;
    }

    .form-control:focus {
      outline: none;
      border-color: var(--primary);
    }

    .btn {
      background: var(--primary);
      color: #fff;
      border: none;
      border-radius: 0.5rem;
      padding: 0.65rem 1.25rem;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
    }

    .btn:hover {
      background: var(--primary-hover);
    }

    .btn-gold {
      background: var(--accent-gold);
      color: #000;
    }
    .btn-gold:hover {
      background: #d97706;
    }

    /* Grid Modes */
    .modes-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 1.25rem;
    }

    .mode-card {
      background: var(--bg-dark);
      border: 1px solid var(--border);
      border-radius: 0.85rem;
      padding: 1.25rem;
      transition: border-color 0.2s;
    }

    .mode-card:hover {
      border-color: var(--primary);
    }

    .mode-title {
      font-size: 1.15rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
    }

    .mode-desc {
      color: var(--text-muted);
      font-size: 0.9rem;
      line-height: 1.5;
    }

    /* Footer */
    footer {
      background: var(--bg-card);
      border-top: 1px solid var(--border);
      padding: 1.5rem;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.9rem;
      margin-top: auto;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }
  </style>
</head>
<body>

  <!-- Navbar -->
  <header>
    <div class="nav-container">
      <a href="#" class="brand">
        🎯 <span>بوت مسابقات المعرفة</span>
        <span class="brand-badge">النسخة الضخمة v5.0</span>
      </a>
      <ul class="nav-links">
        <li><button class="nav-btn active" onclick="switchTab('overview')">📊 النظرة العامة</button></li>
        <li><button class="nav-btn" onclick="switchTab('questions')">❓ بنك الأسئلة (5000+)</button></li>
        <li><button class="nav-btn" onclick="switchTab('modes')">⚔️ الأطوار والألعاب</button></li>
        <li><button class="nav-btn" onclick="switchTab('economy')">🛍️ المتجر والاقتصاد</button></li>
        <li><button class="nav-btn" onclick="switchTab('api')">📡 REST API</button></li>
      </ul>
    </div>
  </header>

  <!-- Main Content -->
  <main class="container">

    <!-- TAB 1: OVERVIEW -->
    <div id="tab-overview" class="tab-content active">
      <!-- Hero -->
      <section class="hero">
        <div>
          <h1 class="hero-title">المنصة الشاملة لمسابقات الديسكورد العربية</h1>
          <p class="hero-subtitle">
            نظام متكامل يضم بنكاً عملاقاً بأكثر من 5,000 سؤال موثق، أطوار لعب تفاعلية (كلاسيكي، البقاء، حرب الفرق، مبارزات 1v1)، ونظام اقتصاد وRPG متقدم!
          </p>
        </div>
        <div>
          <button class="btn btn-gold" onclick="switchTab('questions')">🔍 تصفح بنك الأسئلة</button>
        </div>
      </section>

      <!-- KPI Grid -->
      <section class="grid-stats">
        <div class="stat-card">
          <div class="stat-icon">📚</div>
          <div>
            <div class="stat-val" id="stat-total-q">5,001</div>
            <div class="stat-lbl">إجمالي الأسئلة المعتمدة</div>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">🎮</div>
          <div>
            <div class="stat-val" id="stat-active-games">0</div>
            <div class="stat-lbl">الجلسات النشطة الآن</div>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">👥</div>
          <div>
            <div class="stat-val" id="stat-total-players">100%</div>
            <div class="stat-lbl">جاهزية النظام وتوافقه</div>
          </div>
        </div>

        <div class="stat-card">
          <div class="stat-icon">🛡️</div>
          <div>
            <div class="stat-val">10</div>
            <div class="stat-lbl">فئات وتصنيفات متنوعة</div>
          </div>
        </div>
      </section>

      <!-- Categories Breakdown -->
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">📂 توزيع الأسئلة حسب التصنيفات الرئيسية</h2>
        </div>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem;" id="cat-distribution">
          <div class="stat-card"><div><strong>🎮 الألعاب</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>⚽ الرياضة</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>🎬 الأفلام</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>🗺️ الجغرافيا</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>📜 التاريخ</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>🔬 العلوم والتقنية</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>☪️ الثقافة الإسلامية</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
          <div class="stat-card"><div><strong>🌍 الثقافة العامة</strong><p style="color:var(--text-muted)">500 سؤال</p></div></div>
        </div>
      </section>
    </div>

    <!-- TAB 2: QUESTIONS BANK CMS -->
    <div id="tab-questions" class="tab-content">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">❓ مستكشف ومكتبة الأسئلة المباشرة</h2>
          <span style="color:var(--text-muted)" id="q-count-indicator">جاري التحميل...</span>
        </div>

        <div style="display: flex; gap: 1rem; margin-bottom: 1.5rem; flex-wrap: wrap;">
          <input type="text" id="search-q" class="form-control" style="flex: 2; min-width: 250px;" placeholder="🔍 ابحث في نص السؤال أو الخيارات..." oninput="fetchQuestions()">
          <select id="filter-cat" class="form-control" style="flex: 1; min-width: 180px;" onchange="fetchQuestions()">
            <option value="all">كل التصنيفات (10)</option>
            <option value="gaming">🎮 الألعاب</option>
            <option value="sports">⚽ الرياضة</option>
            <option value="movies">🎬 الأفلام</option>
            <option value="geography">🗺️ الجغرافيا</option>
            <option value="history">📜 التاريخ</option>
            <option value="science_tech">🔬 العلوم والتكنولوجيا</option>
            <option value="islam">☪️ الثقافة الإسلامية</option>
            <option value="general">🌍 الثقافة العامة</option>
            <option value="guess">🤔 خمّن...</option>
            <option value="competitive">⚡ التنافسي</option>
          </select>
          <select id="filter-diff" class="form-control" style="flex: 1; min-width: 140px;" onchange="fetchQuestions()">
            <option value="all">كل المستويات</option>
            <option value="easy">سهل 🟢</option>
            <option value="medium">متوسط 🟡</option>
            <option value="hard">صعب 🔴</option>
          </select>
        </div>

        <div style="overflow-x: auto;">
          <table>
            <thead>
              <tr>
                <th style="width: 80px;">المعرف</th>
                <th>نص السؤال</th>
                <th style="width: 140px;">الفئة</th>
                <th style="width: 100px;">الصعوبة</th>
                <th style="width: 220px;">الإجابة الصحيحة</th>
              </tr>
            </thead>
            <tbody id="questions-tbody">
              <tr><td colspan="5" style="text-align:center; padding: 2rem;">جاري تحميل الأسئلة...</td></tr>
            </tbody>
          </table>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 1.5rem;">
          <button class="btn" id="prev-page-btn" onclick="changePage(-1)">السابق</button>
          <span id="page-num-display" style="font-weight: 700;">صفحة 1</span>
          <button class="btn" id="next-page-btn" onclick="changePage(1)">التالي</button>
        </div>
      </section>
    </div>

    <!-- TAB 3: GAME MODES -->
    <div id="tab-modes" class="tab-content">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">⚔️ أطوار اللعب التفاعلية المتوفرة</h2>
        </div>
        <div class="modes-grid">
          <div class="mode-card">
            <div class="mode-title">🎮 النمط الكلاسيكي (Classic Trivia)</div>
            <div class="mode-desc">
              مسابقة متعددة اللاعبين بأزرار تفاعلية، حساب فوري لنقاط السرعة والسلاسل ومكافأة الإكمال، مع لوحة صدارة حية تُحدّث تلقائياً.
            </div>
            <div style="margin-top: 1rem;"><span class="badge badge-easy">/trivia-start</span></div>
          </div>

          <div class="mode-card">
            <div class="mode-title">❤️ طور البقاء (Survival Battle Royale)</div>
            <div class="mode-desc">
              يبدأ جميع اللاعبين بـ 3 قلوب (❤️❤️❤️). الإجابة الخاطئة تخصم قلباً، وآخر لاعب صامد على قيد الحياة يفوز بالجائزة الكبرى!
            </div>
            <div style="margin-top: 1rem;"><span class="badge badge-hard">/trivia-survival</span></div>
          </div>

          <div class="mode-card">
            <div class="mode-title">⚔️ حرب الفرق (Team Battle)</div>
            <div class="mode-desc">
              مواجهة بين الفرق الثلاثة (🔴 الصقور vs 🔵 النمور vs 🟢 الأبطال). تجميع نقاط جماعي وتتويج الفريق البطل وأفضل لاعب (MVP).
            </div>
            <div style="margin-top: 1rem;"><span class="badge badge-medium">/trivia-teams</span></div>
          </div>

          <div class="mode-card">
            <div class="mode-title">🥊 مبارزة 1 ضد 1 (1v1 Duels)</div>
            <div class="mode-desc">
              تحدي مباشر بين لاعبين برهان نقود ودنانير ذهبية على 5 أسئلة سريعة. الفائز يحصد وعاء الرهان كاملاً!
            </div>
            <div style="margin-top: 1rem;"><span class="badge badge-easy">/trivia-duel</span></div>
          </div>
        </div>
      </section>
    </div>

    <!-- TAB 4: ECONOMY & SHOP -->
    <div id="tab-economy" class="tab-content">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">🛍️ متجر القدرات والعناصر الخاصة</h2>
        </div>
        <div class="modes-grid">
          <div class="mode-card">
            <div class="mode-title">💡 حذف إجابتين (50:50)</div>
            <div class="mode-desc">يحذف خيارين خاطئين في السؤال القادم لزيادة فرصة إجابتك الصحيحة.</div>
            <div style="margin-top: 1rem; font-weight: bold; color: var(--accent-gold);">💰 120 دينار</div>
          </div>
          <div class="mode-card">
            <div class="mode-title">⚡ مضاعف النقاط (Double Points 2x)</div>
            <div class="mode-desc">يضاعف نقاطك المكتسبة من الإجابة الصحيحة التالية في المسابقة.</div>
            <div style="margin-top: 1rem; font-weight: bold; color: var(--accent-gold);">💰 180 دينار</div>
          </div>
          <div class="mode-card">
            <div class="mode-title">🛡️ درع السلسلة (Streak Shield)</div>
            <div class="mode-desc">يحمي سلسلتك المكتسبة من الانكسار عند أول إجابة خاطئة.</div>
            <div style="margin-top: 1rem; font-weight: bold; color: var(--accent-gold);">💰 220 دينار</div>
          </div>
          <div class="mode-card">
            <div class="mode-title">⏳ تجميد الوقت (+5s)</div>
            <div class="mode-desc">يمنحك وقتاً إضافياً للتفكير قبل انتهاء عداد السؤال.</div>
            <div style="margin-top: 1rem; font-weight: bold; color: var(--accent-gold);">💰 100 دينار</div>
          </div>
        </div>
      </section>
    </div>

    <!-- TAB 5: REST API DOCS -->
    <div id="tab-api" class="tab-content">
      <section class="card">
        <div class="card-header">
          <h2 class="card-title">📡 واجهة التطبيقات البرمجية (REST API v1)</h2>
        </div>
        <p style="color:var(--text-muted); margin-bottom: 1.5rem;">
          توفر المنصة نقاط نهاية REST API سريعة ومتوافقة مع JSON للتكامل مع لوحات التحكم والأنظمة الخارجية.
        </p>

        <div style="display: flex; flex-direction: column; gap: 1rem;">
          <div style="background:var(--bg-dark); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span class="badge" style="background:#0284c7; color:#fff;">GET</span>
              <code style="font-size: 1rem;">/api/v1/stats</code>
            </div>
            <p style="color:var(--text-muted); font-size: 0.9rem;">إرجاع إحصائيات البنك، الجلسات الحية، والأسئلة.</p>
          </div>

          <div style="background:var(--bg-dark); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span class="badge" style="background:#0284c7; color:#fff;">GET</span>
              <code style="font-size: 1rem;">/api/v1/questions?category=gaming&page=1&limit=20</code>
            </div>
            <p style="color:var(--text-muted); font-size: 0.9rem;">البحث والتصفح المفوتر لأسئلة المسابقة.</p>
          </div>

          <div style="background:var(--bg-dark); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span class="badge" style="background:#0284c7; color:#fff;">GET</span>
              <code style="font-size: 1rem;">/api/v1/leaderboard?limit=10</code>
            </div>
            <p style="color:var(--text-muted); font-size: 0.9rem;">إرجاع المتصدرين العالميين ونقاطهم.</p>
          </div>

          <div style="background:var(--bg-dark); padding: 1rem; border-radius: 0.5rem; border: 1px solid var(--border);">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.5rem;">
              <span class="badge" style="background:#0284c7; color:#fff;">GET</span>
              <code style="font-size: 1rem;">/api/v1/shop</code>
            </div>
            <p style="color:var(--text-muted); font-size: 0.9rem;">قائمة عناصر المتجر وأسعارها.</p>
          </div>
        </div>
      </section>
    </div>

  </main>

  <!-- Footer -->
  <footer>
    <p>مشروع مسابقات المعرفة العربي الضخم — تم التطوير بأعلى معايير الأداء والموثوقية 🚀</p>
  </footer>

  <script>
    let currentPage = 1;

    function switchTab(tabId) {
      document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(el => el.classList.remove('active'));

      const target = document.getElementById('tab-' + tabId);
      if (target) target.classList.add('active');

      const btn = Array.from(document.querySelectorAll('.nav-btn')).find(b => b.getAttribute('onclick')?.includes(tabId));
      if (btn) btn.classList.add('active');

      if (tabId === 'questions') {
        fetchQuestions();
      }
    }

    async function fetchQuestions() {
      const search = document.getElementById('search-q').value;
      const cat = document.getElementById('filter-cat').value;
      const diff = document.getElementById('filter-diff').value;
      const tbody = document.getElementById('questions-tbody');

      try {
        const res = await fetch(\`/api/v1/questions?page=\${currentPage}&limit=15&search=\${encodeURIComponent(search)}&category=\${cat}&difficulty=\${diff}\`);
        const data = await res.json();

        if (!data.success) return;

        document.getElementById('q-count-indicator').innerText = \`عرض \${data.questions.length} من أصل \${data.total.toLocaleString('ar-EG')} سؤال\`;
        document.getElementById('page-num-display').innerText = \`صفحة \${data.page} من \${data.totalPages || 1}\`;

        if (data.questions.length === 0) {
          tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 2rem;">لا توجد أسئلة تطابق البحث.</td></tr>';
          return;
        }

        tbody.innerHTML = data.questions.map(q => {
          const diffBadge = q.difficulty === 'easy' ? 'badge-easy' : q.difficulty === 'medium' ? 'badge-medium' : 'badge-hard';
          const diffText = q.difficulty === 'easy' ? 'سهل' : q.difficulty === 'medium' ? 'متوسط' : 'صعب';
          const correct = q.options[q.correctAnswer] || '';

          return \`<tr>
            <td><code style="color:var(--text-muted)">\${q.id}</code></td>
            <td><strong>\${q.text}</strong></td>
            <td><span class="badge" style="background:rgba(99,102,241,0.2); color:#818cf8;">\${q.category}</span></td>
            <td><span class="badge \${diffBadge}">\${diffText}</span></td>
            <td style="color:var(--accent-green)">\${correct}</td>
          </tr>\`;
        }).join('');

      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding: 2rem; color:var(--accent-red)">فشل جلب الأسئلة.</td></tr>';
      }
    }

    function changePage(delta) {
      if (currentPage + delta < 1) return;
      currentPage += delta;
      fetchQuestions();
    }

    // Initial load
    fetch('/api/v1/stats')
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          document.getElementById('stat-total-q').innerText = d.stats.totalQuestions.toLocaleString('ar-EG');
          document.getElementById('stat-active-games').innerText = d.stats.activeGames;
        }
      })
      .catch(() => {});
  </script>
</body>
</html>`;
}

module.exports = {
  createWebServer,
};
