// ── Version preview ────────────────────────────────────────
function toDebVersion(s) {
  const safe = s.trim().replace(/[^A-Za-z0-9.+~-]/g, '.').replace(/\.{2,}/g, '.');
  return /^[0-9]/.test(safe) ? safe : '0.' + safe;
}

function updateVersionPreview() {
  const tv = document.getElementById('tableVersion').value.trim();
  const tn = document.getElementById('tailNumber').value.trim();
  const el = document.getElementById('pkg-version');
  if (tv && tn) {
    const ver  = toDebVersion(tv);
    const tail = tn.trim().replace(/[^A-Za-z0-9.~]/g, '.').replace(/\.{2,}/g, '.');
    el.textContent = `${ver}+${tail}`;
  } else {
    el.textContent = '—';
  }
}

document.getElementById('tableVersion').addEventListener('input', updateVersionPreview);
document.getElementById('tailNumber').addEventListener('input', updateVersionPreview);

// ── Collect form data ──────────────────────────────────────
function collectForm() {
  const sensors = [];
  const turrets = [];

  for (let i = 0; i < 4; i++) {
    sensors.push({
      yaw:   parseInput(`s${i}-yaw`),
      pitch: parseInput(`s${i}-pitch`),
      roll:  parseInput(`s${i}-roll`),
    });
  }
  for (let i = 0; i < 2; i++) {
    turrets.push({
      yaw:   parseInput(`t${i}-yaw`),
      pitch: parseInput(`t${i}-pitch`),
      roll:  parseInput(`t${i}-roll`),
    });
  }

  return {
    tableVersion: document.getElementById('tableVersion').value.trim(),
    tailNumber:   document.getElementById('tailNumber').value.trim(),
    sensors,
    turrets,
  };
}

function parseInput(name) {
  const el = document.querySelector(`[name="${name}"]`);
  return el ? (parseFloat(el.value) || 0) : 0;
}

// ── Status helpers ─────────────────────────────────────────
function setStatus(msg, type = '') {
  const el = document.getElementById('status-msg');
  el.textContent = msg;
  el.className = 'status-msg' + (type ? ` ${type}` : '');
}

// ── Preview JSON ───────────────────────────────────────────
document.getElementById('preview-btn').addEventListener('click', async () => {
  const payload = collectForm();
  if (!payload.tableVersion || !payload.tailNumber) {
    setStatus('Fill in Table Version and Tail Number first.', 'error');
    return;
  }

  setStatus('Loading preview…');
  try {
    const res  = await fetch('/api/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();

    document.getElementById('json-output').innerHTML = syntaxHighlight(JSON.stringify(data, null, 2));
    document.getElementById('preview-filename').textContent = 'alignment.json';
    document.getElementById('preview-panel').classList.remove('hidden');
    document.getElementById('preview-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setStatus('');
  } catch (e) {
    setStatus(`Preview failed: ${e.message}`, 'error');
  }
});

document.getElementById('close-preview').addEventListener('click', () => {
  document.getElementById('preview-panel').classList.add('hidden');
});

// ── Generate .deb ──────────────────────────────────────────
document.getElementById('align-form').addEventListener('submit', async e => {
  e.preventDefault();

  const payload = collectForm();
  const btn = document.getElementById('generate-btn');
  btn.disabled = true;
  setStatus('Building .deb package…');

  try {
    const res = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || res.statusText);
    }

    // Derive filename from response header or build it locally
    const disposition = res.headers.get('Content-Disposition') || '';
    const filenameMatch = disposition.match(/filename="([^"]+)"/);
    const filename = filenameMatch ? filenameMatch[1] : res.headers.get('X-Filename') || 'sensor-alignment.deb';

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus(`✓ Package "${filename}" downloaded successfully.`, 'success');
  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

// ── Syntax highlighting for JSON preview ──────────────────
function syntaxHighlight(json) {
  return json
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(
      /("(\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?|[{}\[\],:])/g,
      match => {
        if (/^"/.test(match)) {
          if (/:$/.test(match)) return `<span class="j-key">${match}</span>`;
          return `<span class="j-str">${match}</span>`;
        }
        if (/true|false/.test(match)) return `<span class="j-bool">${match}</span>`;
        if (/null/.test(match))       return `<span class="j-null">${match}</span>`;
        if (/[{}\[\],:]/.test(match)) return `<span class="j-punct">${match}</span>`;
        return `<span class="j-num">${match}</span>`;
      }
    );
}
