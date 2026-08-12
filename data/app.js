// ==================== GLOBAL STATE ====================
let ws;
let currentView = 'dashboard';
let uptime = 0;
let uartPaused = false;
let hexMode = false;
let scopeFreezed = false;
let scopeData = [];
let pwmEnabled = false;
const MAX_TERM_LINES = 500;
const MAX_EVENTS = 200;
let eventCounter = 0;
let autoScroll = true;

// ==================== INITIALIZATION ====================
function initApp() {
    initWebSocket();
    setupEventListeners();
    setupI2CGrid();
    updateUptime();
    setInterval(updateUptime, 1000);
    
    // Hide splash after 2 seconds
    setTimeout(() => {
        document.getElementById('splash').classList.add('hide');
        document.getElementById('app').classList.remove('hidden');
        setTimeout(() => document.getElementById('splash').remove(), 500);
    }, 2000);
}

function initWebSocket() {
    ws = new WebSocket(`ws://${location.hostname}/ws`);
    ws.onopen = () => {
        updateConnectionStatus(true);
        requestConfig();
    };
    ws.onclose = () => {
        updateConnectionStatus(false);
        setTimeout(initWebSocket, 2000);
    };
    ws.onmessage = (e) => {
        try {
            const msg = JSON.parse(e.data);
            handleMessage(msg);
        } catch (ex) {}
    };
}

function updateConnectionStatus(connected) {
    const dot = document.querySelector('.status-dot');
    const text = document.getElementById('status-text');
    if (connected) {
        dot.classList.add('connected');
        text.textContent = 'Connected';
    } else {
        dot.classList.remove('connected');
        text.textContent = 'Disconnected';
    }
}

function setupEventListeners() {
    // Handle terminal auto-scroll
    const terminal = document.getElementById('terminal');
    terminal.addEventListener('scroll', () => {
        autoScroll = terminal.scrollHeight - terminal.scrollTop === terminal.clientHeight;
        document.getElementById('auto-scroll-indicator').textContent = 
            `Auto-scroll: ${autoScroll ? 'ON' : 'OFF'}`;
    });
}

// ==================== VIEW SWITCHING ====================
function switchView(viewName, btn) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    
    const view = document.getElementById(`view-${viewName}`);
    if (view) view.classList.add('active');
    if (btn) btn.classList.add('active');
    
    currentView = viewName;
    
    // Initialize specific views
    if (viewName === 'oscilloscope') initScope();
    if (viewName === 'logic') initLogicAnalyzer();
}

// ==================== MESSAGE HANDLER ====================
function handleMessage(msg) {
    switch (msg.type) {
        case 'v':
            updateDashboard('v-val', msg.val.toFixed(2));
            addScopeData(msg.val);
            break;
        case 'clk':
            updateDashboard('clk-val', formatFrequency(msg.val));
            break;
        case 'usb':
            updateUSB(msg);
            break;
        case 'sys':
            updateSystem(msg);
            break;
        case 'uart':
            appendTerminal(msg.val);
            break;
        case 'seq':
            updateLogic(msg);
            break;
        case 'i2c':
            updateI2CResults(msg.val);
            break;
        case 'config':
            document.getElementById('cfg-ssid').value = msg.ssid || '';
            break;
        case 'msg':
            showNotification(msg.val);
            break;
    }
}

function updateDashboard(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
}

function formatFrequency(hz) {
    if (hz >= 1e6) return (hz/1e6).toFixed(2) + ' MHz';
    if (hz >= 1e3) return (hz/1e3).toFixed(2) + ' kHz';
    return hz + ' Hz';
}

function updateUSB(msg) {
    updateBadge('usb-dp', msg.dp);
    updateBadge('usb-dn', msg.dn);
}

function updateBadge(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = state ? 'badge high' : 'badge low';
    el.textContent = state ? 'HIGH' : 'LOW';
}

function updateSystem(msg) {
    document.getElementById('heap-val').textContent = (msg.heap / 1024).toFixed(1);
    document.getElementById('temp-val').textContent = msg.temp.toFixed(1);
    document.getElementById('psram-free').textContent = formatBytes(msg.psram_free);
    document.getElementById('psram-total').textContent = formatBytes(msg.psram_total);
    document.getElementById('wifi-clients').textContent = msg.wifi_clients;
    
    // Update bars
    const heapPercent = 100 - (msg.heap / (msg.heap + 100000)) * 100; // rough estimate
    document.getElementById('heap-bar').style.width = Math.max(heapPercent, 5) + '%';
    
    if (msg.psram_total > 0) {
        const psramPercent = (msg.psram_free / msg.psram_total) * 100;
        document.getElementById('psram-bar').style.width = psramPercent + '%';
    }
    
    // Temperature status
    const tempStatus = document.getElementById('temp-status');
    if (msg.temp > 60) {
        tempStatus.className = 'metric-status danger';
        tempStatus.textContent = 'HOT';
    } else if (msg.temp > 45) {
        tempStatus.className = 'metric-status warn';
        tempStatus.textContent = 'WARM';
    } else {
        tempStatus.className = 'metric-status safe';
        tempStatus.textContent = 'OK';
    }
}

function formatBytes(bytes) {
    if (bytes >= 1048576) return (bytes/1048576).toFixed(1) + ' MB';
    return (bytes/1024).toFixed(1) + ' KB';
}

// ==================== UPTIME ====================
function updateUptime() {
    uptime++;
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    document.getElementById('uptime').textContent = 
        `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ==================== TERMINAL ====================
function appendTerminal(text) {
    if (uartPaused) return;
    const terminal = document.getElementById('terminal');
    const lines = terminal.innerHTML.split('<br>');
    lines.push(escapeHTML(text));
    while (lines.length > MAX_TERM_LINES) lines.shift();
    terminal.innerHTML = lines.join('<br>');
    if (autoScroll) terminal.scrollTop = terminal.scrollHeight;
    
    document.getElementById('uart-status').textContent = 
        `RX | ${document.getElementById('baud-rate').value}-8N1 | Lines: ${lines.length}`;
}

function escapeHTML(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function toggleHexMode() {
    hexMode = !hexMode;
    document.getElementById('btn-hex').classList.toggle('active', hexMode);
}

function togglePauseUART() {
    uartPaused = !uartPaused;
    document.getElementById('btn-pause-uart').textContent = uartPaused ? '▶' : '⏯';
}

function clearTerminal() {
    document.getElementById('terminal').innerHTML = '';
}

function downloadLog() {
    const text = document.getElementById('terminal').innerText;
    const blob = new Blob([text], {type: 'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `uart_log_${Date.now()}.txt`;
    a.click();
}

function setBaudRate() {
    const baud = parseInt(document.getElementById('baud-rate').value);
    send({cmd: 'baud', val: baud});
}

// ==================== OSCILLOSCOPE ====================
function initScope() {
    const canvas = document.getElementById('scope-canvas');
    canvas.width = canvas.offsetWidth * 2;
    canvas.height = canvas.offsetHeight * 2;
    drawScopeGrid();
}

function addScopeData(value) {
    if (scopeFreezed || currentView !== 'oscilloscope') return;
    scopeData.push(value);
    if (scopeData.length > 200) scopeData.shift();
    drawScope();
}

function drawScopeGrid() {
    const canvas = document.getElementById('scope-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    
    ctx.strokeStyle = 'rgba(48,54,61,0.5)';
    ctx.lineWidth = 1;
    
    for (let i = 0; i < 10; i++) {
        const x = (w / 10) * i;
        const y = (h / 10) * i;
        ctx.beginPath();
        ctx.moveTo(x, 0); ctx.lineTo(x, h);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, y); ctx.lineTo(w, y);
        ctx.stroke();
    }
}

function drawScope() {
    const canvas = document.getElementById('scope-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const timebase = parseInt(document.getElementById('scope-timebase').value) || 200;
    
    ctx.fillStyle = 'rgba(0,0,0,0.1)';
    ctx.fillRect(0, 0, w, h);
    
    if (scopeData.length < 2) return;
    
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 2;
    ctx.shadowColor = '#58a6ff';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    
    const step = w / scopeData.length;
    const maxVal = 3.3;
    
    scopeData.forEach((val, i) => {
        const x = i * step;
        const y = h - (val / maxVal) * h;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    });
    
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function toggleScopeFreeze() {
    scopeFreezed = !scopeFreezed;
    document.getElementById('btn-freeze').classList.toggle('active', scopeFreezed);
}

function clearScope() {
    scopeData = [];
    drawScopeGrid();
}

function updateScopeConfig() {
    drawScopeGrid();
    drawScope();
}

// ==================== LOGIC ANALYZER ====================
let logicEvents = [];

function initLogicAnalyzer() {
    ['boot', 'reset', 'enable'].forEach(signal => {
        const canvas = document.getElementById(`canvas-${signal}`);
        canvas.width = canvas.offsetWidth * 2;
        canvas.height = canvas.offsetHeight * 2;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    });
}

function updateLogic(msg) {
    eventCounter++;
    logicEvents.push(msg);
    while (logicEvents.length > MAX_EVENTS) logicEvents.shift();
    
    // Update state badge
    const stateEl = document.getElementById(`state-${msg.pin.toLowerCase()}`);
    if (stateEl) {
        stateEl.className = msg.state ? 'signal-state badge high' : 'signal-state badge low';
        stateEl.textContent = msg.state ? 'H' : 'L';
    }
    
    // Update event log
    const log = document.getElementById('logic-event-log');
    log.innerHTML += `<div>[${msg.time}] ${msg.pin}: ${msg.state ? '<span style="color:var(--secondary)">HIGH</span>' : '<span style="color:var(--danger)">LOW</span>'}</div>`;
    if (log.children.length > 50) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
    
    document.getElementById('event-count').textContent = `Events: ${eventCounter}`;
    
    // Draw signal
    drawSignal(msg.pin.toLowerCase(), msg.state);
}

function drawSignal(pin, state) {
    const canvas = document.getElementById(`canvas-${pin}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    
    // Draw last 50 events
    const signalEvents = logicEvents.filter(e => e.pin.toLowerCase() === pin).slice(-50);
    if (signalEvents.length < 2) return;
    
    const step = w / signalEvents.length;
    ctx.strokeStyle = '#3fb950';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    signalEvents.forEach((ev, i) => {
        const x = i * step;
        const y = ev.state ? h * 0.3 : h * 0.7;
        if (i === 0) ctx.moveTo(x, y);
        else {
            ctx.lineTo(x, signalEvents[i-1].state ? h * 0.3 : h * 0.7);
            ctx.lineTo(x, y);
        }
    });
    
    ctx.stroke();
}

function clearLogicEvents() {
    logicEvents = [];
    eventCounter = 0;
    document.getElementById('logic-event-log').innerHTML = '';
    document.getElementById('event-count').textContent = 'Events: 0';
    initLogicAnalyzer();
}

// ==================== I2C ====================
function setupI2CGrid() {
    const grid = document.getElementById('i2c-grid');
    for (let i = 0; i < 128; i++) {
        const cell = document.createElement('div');
        cell.className = 'i2c-cell';
        cell.textContent = i.toString(16).toUpperCase().padStart(2, '0');
        cell.onclick = () => scanSingleAddress(i);
        grid.appendChild(cell);
    }
}

function scanI2CBus() {
    document.querySelectorAll('.i2c-cell').forEach(c => c.classList.remove('found'));
    document.getElementById('i2c-info').textContent = 'Scanning bus...';
    send({cmd: 'i2c'});
}

function scanSingleAddress(addr) {
    send({cmd: 'i2c_addr', val: addr});
}

function updateI2CResults(result) {
    document.getElementById('i2c-info').innerHTML = result;
    
    // Parse found addresses from HTML
    const matches = result.match(/0x([0-9A-Fa-f]{2})/g);
    if (matches) {
        matches.forEach(addr => {
            const index = parseInt(addr, 16);
            const cell = document.querySelector(`.i2c-cell:nth-child(${index + 1})`);
            if (cell) cell.classList.add('found');
        });
    }
}

// ==================== PWM ====================
function updatePWMLabels() {
    const freq = document.getElementById('pwm-freq-slider').value;
    const duty = document.getElementById('pwm-duty-slider').value;
    document.getElementById('pwm-freq-label').textContent = formatFrequency(freq);
    document.getElementById('pwm-duty-label').textContent = duty + '%';
    drawPWMWaveform(freq, duty);
}

function drawPWMWaveform(freq, duty) {
    const canvas = document.getElementById('pwm-canvas');
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#f85149';
    ctx.lineWidth = 2;
    ctx.beginPath();
    
    const cycles = 5;
    const cycleWidth = w / cycles;
    const highWidth = (duty / 100) * cycleWidth;
    
    for (let i = 0; i < cycles; i++) {
        const x = i * cycleWidth;
        ctx.moveTo(x, h * 0.2);
        ctx.lineTo(x, h * 0.8); // rising edge
        ctx.lineTo(x + highWidth, h * 0.8); // high
        ctx.lineTo(x + highWidth, h * 0.2); // falling edge
        ctx.lineTo(x + cycleWidth, h * 0.2); // low
    }
    
    ctx.stroke();
}

function togglePWM() {
    const btn = document.getElementById('btn-pwm-toggle');
    const safety = document.getElementById('pwm-safety');
    
    if (!pwmEnabled) {
        if (!confirm('⚠️ SAFETY CHECK: Output 3.3V to PWM pin?\nEnsure target is disconnected from power.')) return;
        const freq = parseInt(document.getElementById('pwm-freq-slider').value);
        const duty = Math.round((parseInt(document.getElementById('pwm-duty-slider').value) / 100) * 255);
        send({cmd: 'pwm', en: 1, f: freq, d: duty});
        pwmEnabled = true;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12"/></svg> Disable PWM';
        safety.className = 'safety-badge active';
        safety.textContent = 'LIVE';
    } else {
        send({cmd: 'pwm', en: 0});
        pwmEnabled = false;
        btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg> Enable PWM';
        safety.className = 'safety-badge';
        safety.textContent = 'SAFE';
    }
}

// ==================== SETTINGS ====================
function saveWiFiSettings() {
    const ssid = document.getElementById('cfg-ssid').value.trim();
    const pass = document.getElementById('cfg-pass').value;
    if (!ssid || pass.length < 8) {
        showNotification('SSID and password (min 8 chars) required.');
        return;
    }
    send({cmd: 'saveconfig', ssid, pass});
}

function restartDevice() {
    if (confirm('Restart device?')) send({cmd: 'restart'});
}

function factoryReset() {
    if (confirm('Factory reset? All settings will be lost.')) send({cmd: 'factoryreset'});
}

function setTheme(theme) {
    document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');
    // Theme switching logic can be extended
    document.body.className = `theme-${theme}`;
}

// ==================== NOTIFICATIONS ====================
function showNotification(msg) {
    // Simple alert for now, could be toast notification
    alert(msg);
}

// ==================== WEBSOCKET SEND ====================
function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
    }
}

function requestConfig() {
    send({cmd: 'getconfig'});
}

// ==================== INITIALIZE ====================
window.addEventListener('load', initApp);
