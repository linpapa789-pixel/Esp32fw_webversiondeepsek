let ws, reconnectTimer;
const term = document.getElementById('term');
const seqLog = document.getElementById('seq-log');
let autoScroll = true, paused = false, hexMode = false;
const MAX_TERM_LINES = 500;
const MAX_SEQ_EVENTS = 200;

function initWS() {
  ws = new WebSocket('ws://' + location.hostname + '/ws');
  ws.onopen = () => {
    document.getElementById('ws-status').className = 'status online';
    document.getElementById('ws-status').innerText = 'ONLINE';
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
  ws.onclose = () => {
    document.getElementById('ws-status').className = 'status offline';
    document.getElementById('ws-status').innerText = 'OFFLINE';
    reconnectTimer = setTimeout(initWS, 2000);
  };
  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (ex) {}
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'v':
      document.getElementById('v-val').innerText = parseFloat(msg.val).toFixed(2) + ' V';
      break;
    case 'clk':
      let hz = msg.val, out = hz + ' Hz';
      if (hz >= 1e6) out = (hz/1e6).toFixed(3) + ' MHz';
      else if (hz >= 1e3) out = (hz/1e3).toFixed(2) + ' kHz';
      document.getElementById('clk-val').innerText = out;
      break;
    case 'usb':
      updateBadge('usb-dp', msg.dp);
      updateBadge('usb-dn', msg.dn);
      break;
    case 'sys':
      document.getElementById('heap').innerText = msg.heap + ' B';
      document.getElementById('min-heap').innerText = msg.min_heap + ' B';
      document.getElementById('psram').innerText = msg.psram_free + ' / ' + msg.psram_total + ' B';
      document.getElementById('temp').innerText = msg.temp.toFixed(1) + ' °C';
      document.getElementById('clients').innerText = msg.wifi_clients;
      break;
    case 'uart':
      if (paused) return;
      let text = msg.val;
      if (hexMode) text = [...text].map(c => c.charCodeAt(0).toString(16).padStart(2,'0')).join(' ');
      appendTermLine(text);
      break;
    case 'i2c':
      document.getElementById('i2c-res').innerHTML = msg.val;
      break;
    case 'seq':
      updateBadge('log-' + msg.pin.toLowerCase(), msg.state);
      appendSeqLine(`[${msg.time}] ${msg.pin}: ${msg.state ? 'HIGH' : 'LOW'}`);
      break;
    case 'msg':
      alert(msg.val);
      break;
  }
}

function updateBadge(id, state) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = state ? 'badge high' : 'badge low';
  el.innerText = state ? 'H' : 'L';
}

function appendTermLine(text) {
  const lines = term.innerHTML.split('<br>');
  lines.push(text);
  while (lines.length > MAX_TERM_LINES) lines.shift();
  term.innerHTML = lines.join('<br>');
  if (autoScroll) term.scrollTop = term.scrollHeight;
}

function appendSeqLine(text) {
  const lines = seqLog.innerHTML.split('<br>');
  lines.push(text);
  while (lines.length > MAX_SEQ_EVENTS) lines.shift();
  seqLog.innerHTML = lines.join('<br>');
  seqLog.scrollTop = seqLog.scrollHeight;
}

function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

// Navigation
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('view-' + btn.dataset.view).classList.add('active');
  });
});

// UART controls
document.getElementById('btn-baud').onclick = () => send({cmd:'baud', val:parseInt(document.getElementById('baud').value)});
document.getElementById('auto-scroll').onchange = (e) => autoScroll = e.target.checked;
document.getElementById('btn-pause').onclick = function() {
  paused = !paused;
  this.innerText = paused ? 'Resume' : 'Pause';
};
document.getElementById('btn-clear').onclick = () => term.innerHTML = '';
document.getElementById('btn-hex').onclick = function() { hexMode = !hexMode; this.classList.toggle('active', hexMode); };
document.getElementById('btn-download').onclick = () => {
  const blob = new Blob([term.innerText], {type:'text/plain'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'uart_log.txt';
  a.click();
};

// I2C
document.getElementById('btn-scan').onclick = () => {
  document.getElementById('i2c-res').innerHTML = 'Scanning...';
  send({cmd:'i2c'});
};

// PWM
let pwmOn = false;
document.getElementById('btn-pwm').onclick = () => {
  if (!pwmOn) {
    if (!confirm('SAFETY: Output 3.3V?')) return;
    pwmOn = true;
    document.getElementById('btn-pwm').innerText = 'Disable PWM';
    send({cmd:'pwm', en:1, f:parseInt(document.getElementById('pwm-freq').value), d:parseInt(document.getElementById('pwm-duty').value)});
  } else {
    pwmOn = false;
    document.getElementById('btn-pwm').innerText = 'Enable PWM';
    send({cmd:'pwm', en:0});
  }
};

// Settings
document.getElementById('btn-save').onclick = () => {
  const ssid = document.getElementById('cfg-ssid').value.trim();
  const pass = document.getElementById('cfg-pass').value;
  if (!ssid || pass.length < 8) return alert('SSID and password (min 8 chars) required.');
  send({cmd:'saveconfig', ssid, pass});
};
document.getElementById('btn-restart').onclick = () => { if (confirm('Restart device?')) send({cmd:'restart'}); };
document.getElementById('btn-factory').onclick = () => { if (confirm('Factory reset? All settings will be lost.')) send({cmd:'factoryreset'}); };

// Load settings on page load (request config)
window.addEventListener('load', () => {
  initWS();
  send({cmd:'getconfig'});
  // prefill SSID when config arrives (handle config message)
  ws.addEventListener('message', function handler(e) {
    try {
      const m = JSON.parse(e.data);
      if (m.type === 'config') {
        document.getElementById('cfg-ssid').value = m.ssid || '';
        ws.removeEventListener('message', handler);
      }
    } catch(ignore){}
  });
});
