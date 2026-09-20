const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs   = require('fs');
const express = require('express');
const cors    = require('cors');

let mainWindow;

// ─── PATHS ────────────────────────────────────────────────────────────────
// This file is written by the POS whenever the menu changes.
// The tablet always reads from this file — no IPC timing issues.
const MENU_CACHE_PATH     = path.join(__dirname, 'tablet_menu.json');
const SETTINGS_CACHE_PATH = path.join(__dirname, 'tablet_settings.json');

// ─── HELPERS ──────────────────────────────────────────────────────────────
function readJSON(filePath, fallback) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch (e) { return fallback; }
}

function writeJSON(filePath, data) {
    try { fs.writeFileSync(filePath, JSON.stringify(data), 'utf8'); }
    catch (e) { console.error('[Cache] Write error:', e.message); }
}

// ─── WINDOW ───────────────────────────────────────────────────────────────
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1280,
        height: 800,
        title: 'Mian Foods POS',
        icon: path.join(__dirname, 'logo.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.maximize();
    mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => {
    createWindow();
    startExpressServer();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

// ─── EXPRESS SERVER ────────────────────────────────────────────────────────
function startExpressServer() {
    const serverApp = express();
    const port = 8080;
    const BUILD_STAMP = Date.now(); // Changes every npm start

    serverApp.use(cors());
    serverApp.use(express.json());

    // ── NO-CACHE HEADERS ──
    const NO_CACHE = {
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
    };

    // ── Serve index.html — inject build stamp to force fresh JS load ──
    serverApp.get('/', (req, res) => {
        try {
            let html = fs.readFileSync(path.join(__dirname, 'tablet', 'index.html'), 'utf8');
            html = html.replace(/app\.js(\?[^"]*)?/, `app.js?v=${BUILD_STAMP}`);
            Object.entries(NO_CACHE).forEach(([k, v]) => res.setHeader(k, v));
            res.setHeader('Content-Type', 'text/html');
            res.send(html);
        } catch (e) {
            res.status(500).send('Error loading tablet page: ' + e.message);
        }
    });

    serverApp.get('/index.html', (req, res) => {
        res.redirect('/');
    });

    // ── No-cache for all other static files ──
    serverApp.use((req, res, next) => {
        Object.entries(NO_CACHE).forEach(([k, v]) => res.setHeader(k, v));
        next();
    });
    serverApp.use(express.static(path.join(__dirname, 'tablet')));

    // ── IPC: POS → main.js → disk file ──────────────────────────────
    ipcMain.on('update-menu', (event, menu) => {
        writeJSON(MENU_CACHE_PATH, menu);
        broadcastSSE('menu-update', menu);
        console.log(`[SYNC] Menu saved to disk. Items: ${menu.length}`);
    });

    ipcMain.on('update-settings', (event, settings) => {
        writeJSON(SETTINGS_CACHE_PATH, settings);
        broadcastSSE('settings-update', settings);
        console.log(`[SYNC] Settings saved to disk.`);
    });

    // ── SSE for instant push (bonus on top of polling) ───────────────
    const sseClients = new Set();

    function broadcastSSE(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        sseClients.forEach(client => {
            try { client.write(payload); }
            catch (e) { sseClients.delete(client); }
        });
    }

    serverApp.get('/api/events', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();

        // Send current state immediately
        const currentMenu     = readJSON(MENU_CACHE_PATH, []);
        const currentSettings = readJSON(SETTINGS_CACHE_PATH, {});
        res.write(`event: menu-update\ndata: ${JSON.stringify(currentMenu)}\n\n`);
        res.write(`event: settings-update\ndata: ${JSON.stringify(currentSettings)}\n\n`);

        sseClients.add(res);
        console.log(`[SSE] Tablet connected via SSE. Total: ${sseClients.size}`);

        const hb = setInterval(() => {
            try { res.write(': ping\n\n'); }
            catch (e) { clearInterval(hb); }
        }, 20000);

        req.on('close', () => {
            sseClients.delete(res);
            clearInterval(hb);
            console.log(`[SSE] Tablet disconnected. Total: ${sseClients.size}`);
        });
    });

    // ── REST API (tablet polls these) ────────────────────────────────
    serverApp.get('/api/menu', (req, res) => {
        // Always read from disk — guaranteed fresh, no IPC timing issues
        const menu = readJSON(MENU_CACHE_PATH, []);
        Object.entries(NO_CACHE).forEach(([k, v]) => res.setHeader(k, v));
        res.json(menu);
    });

    serverApp.get('/api/settings', (req, res) => {
        const settings = readJSON(SETTINGS_CACHE_PATH, {});
        Object.entries(NO_CACHE).forEach(([k, v]) => res.setHeader(k, v));
        res.json(settings);
    });

    // ── Tablet submits order to POS ──────────────────────────────────
    serverApp.post('/api/order', (req, res) => {
        const orderData = req.body;
        if (!orderData || !orderData.items || orderData.items.length === 0) {
            return res.status(400).json({ error: 'Empty order' });
        }
        if (mainWindow) {
            mainWindow.webContents.send('tablet-order', orderData);
            res.json({ success: true });
        } else {
            res.status(500).json({ error: 'POS window is closed' });
        }
    });

    serverApp.listen(port, '0.0.0.0', () => {
        console.log(`[Local Server] Tablet App is running at http://localhost:${port}`);
    });
}
