import express from 'express';
import zlib from 'zlib';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── TAR builder (POSIX ustar) ──────────────────────────────
function tarHeader(name, size, type = '0', mode = 0o644) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => Buffer.from(String(s), 'ascii').copy(h, off, 0, len);
  const oct = (n, off, len) => put(n.toString(8).padStart(len - 1, '0') + '\0', off, len);

  put(name, 0, 100);
  oct(type === '5' ? 0o755 : mode, 100, 8);
  oct(0, 108, 8);  // uid
  oct(0, 116, 8);  // gid
  oct(size, 124, 12);
  oct(Math.floor(Date.now() / 1000), 136, 12);
  h[156] = type.charCodeAt(0);
  put('ustar', 257, 6);
  put('00', 263, 2);
  put('root', 265, 32);
  put('root', 297, 32);

  // Compute checksum with field as 8 spaces
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}

function buildTar(entries) {
  const blocks = [];
  for (const { name, content = Buffer.alloc(0), type = '0', mode = 0o644 } of entries) {
    blocks.push(tarHeader(name, content.length, type, mode));
    if (content.length > 0) {
      blocks.push(content);
      const pad = (512 - (content.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive marker
  return Buffer.concat(blocks);
}

// ── AR archive builder (.deb outer wrapper) ────────────────
function buildAr(entries) {
  const parts = [Buffer.from('!<arch>\n', 'ascii')];
  for (const { name, content } of entries) {
    // AR header: fields are ASCII, fixed widths, right-padded with spaces
    const header = Buffer.from(
      name.padEnd(16) +
      '0'.padEnd(12) +             // mtime
      '0'.padEnd(6) +              // uid
      '0'.padEnd(6) +              // gid
      '100644'.padEnd(8) +         // mode
      content.length.toString().padEnd(10) +
      '`\n',                       // magic
      'ascii'
    );
    parts.push(header, content);
    if (content.length % 2 !== 0) parts.push(Buffer.from('\n')); // even-byte padding
  }
  return Buffer.concat(parts);
}

// ── .deb package builder ───────────────────────────────────
function buildDeb({ pkgName, version, tailNumber, tableVersion, jsonContent }) {
  const jsonBuf = Buffer.from(jsonContent, 'utf8');

  // data.tar.gz — the files to install
  const dataTar = buildTar([
    { name: './HD0/',                              type: '5' },
    { name: './HD0/SW/',                           type: '5' },
    { name: './HD0/SW/Align/',                     type: '5' },
    { name: './HD0/SW/Align/alignment.json',       content: jsonBuf, mode: 0o644 },
  ]);
  const dataGz = zlib.gzipSync(dataTar);

  // control file
  const control = [
    `Package: ${pkgName}`,
    `Version: ${version}`,
    `Architecture: all`,
    `Maintainer: Sensor Alignment Tool`,
    `Installed-Size: ${Math.ceil(jsonBuf.length / 1024)}`,
    `X-Table-Version: ${tableVersion}`,
    `X-Tail-Number: ${tailNumber}`,
    `Description: Sensor Alignment Table`,
    ` Table version ${tableVersion} for aircraft tail number ${tailNumber}.`,
    ` Installs alignment data to /HD0/SW/Align/alignment.json.`,
    '',
  ].join('\n');

  // postinst — ensure directory exists on target
  const postinst = [
    '#!/bin/bash',
    'set -e',
    'mkdir -p /HD0/SW/Align',
    'chmod 755 /HD0 /HD0/SW /HD0/SW/Align',
    'chmod 644 /HD0/SW/Align/alignment.json',
  ].join('\n') + '\n';

  const controlTar = buildTar([
    { name: './control',  content: Buffer.from(control,  'ascii'), mode: 0o644 },
    { name: './postinst', content: Buffer.from(postinst, 'ascii'), mode: 0o755 },
  ]);
  const controlGz = zlib.gzipSync(controlTar);

  return buildAr([
    { name: 'debian-binary',  content: Buffer.from('2.0\n') },
    { name: 'control.tar.gz', content: controlGz },
    { name: 'data.tar.gz',    content: dataGz },
  ]);
}

// Sanitize a string to be safe in a Debian version field.
// Debian upstream versions: start with digit, allow [A-Za-z0-9.+~-]
function toDebVersion(s) {
  const safe = s.trim().replace(/[^A-Za-z0-9.+~-]/g, '.').replace(/\.{2,}/g, '.');
  return /^[0-9]/.test(safe) ? safe : '0.' + safe;
}

// ── Routes ─────────────────────────────────────────────────

// Preview the JSON that would be generated
app.post('/api/preview', (req, res) => {
  const { tableVersion, tailNumber, sensors, turrets } = req.body;
  const payload = buildPayload(tableVersion, tailNumber, sensors, turrets);
  res.json(payload);
});

// Generate and return the .deb binary
app.post('/api/generate', (req, res) => {
  const { tableVersion, tailNumber, sensors, turrets } = req.body;

  const err = validate(sensors, turrets, tableVersion, tailNumber);
  if (err) return res.status(400).json({ error: err });

  const payload = buildPayload(tableVersion, tailNumber, sensors, turrets);
  const jsonContent = JSON.stringify(payload, null, 2);

  const verPart  = toDebVersion(tableVersion);
  // Tail part follows '+' so full version already starts with a digit — no '0.' prefix needed
  const tailPart = tailNumber.trim().replace(/[^A-Za-z0-9.~]/g, '.').replace(/\.{2,}/g, '.');
  const version  = `${verPart}+${tailPart}`;
  const pkgName  = 'sensor-alignment';
  const filename = `${pkgName}_${version}_all.deb`;

  const debBuf = buildDeb({ pkgName, version, tailNumber, tableVersion, jsonContent });

  res.setHeader('Content-Type', 'application/vnd.debian.binary-package');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('X-Filename', filename);
  res.send(debBuf);
});

function buildPayload(tableVersion, tailNumber, sensors, turrets) {
  return {
    table_version: tableVersion,
    tail_number:   tailNumber,
    created_at:    new Date().toISOString(),
    sensors: sensors.map((s, i) => ({
      id:    i + 1,
      yaw:   parseFloat(s.yaw)   || 0,
      pitch: parseFloat(s.pitch) || 0,
      roll:  parseFloat(s.roll)  || 0,
    })),
    turrets: turrets.map((t, i) => ({
      id:    i + 1,
      yaw:   parseFloat(t.yaw)   || 0,
      pitch: parseFloat(t.pitch) || 0,
      roll:  parseFloat(t.roll)  || 0,
    })),
  };
}

function validate(sensors, turrets, tableVersion, tailNumber) {
  if (!tableVersion?.trim()) return 'Table version is required.';
  if (!tailNumber?.trim())   return 'Tail number is required.';
  if (!Array.isArray(sensors) || sensors.length !== 4) return 'Exactly 4 sensors required.';
  if (!Array.isArray(turrets) || turrets.length !== 2) return 'Exactly 2 turrets required.';
  return null;
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Sensor Alignment Tool → http://localhost:${PORT}`));
