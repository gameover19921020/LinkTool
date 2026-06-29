import http from 'http';
import https from 'https';
import { URL } from 'url';

const PORT = Number(process.env.DOWNLOAD_PROXY_PORT || 8787);
const HOST = '127.0.0.1';
const MAX_IMAGES = 200;
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const MAX_TOTAL_BYTES = 600 * 1024 * 1024;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Expose-Headers': 'Content-Disposition,Content-Type',
};

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function sanitizeFilename(name) {
  return String(name || 'image')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'image';
}

function extensionFrom(contentType, url) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  const byType = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/bmp': 'bmp',
    'image/tiff': 'tif',
  };
  if (byType[type]) return byType[type];
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return match[1].toLowerCase();
  } catch (_) {}
  return 'png';
}

function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const data = file.data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuffer, data);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0x0800, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosTime, 12);
    header.writeUInt16LE(dosDate, 14);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBuffer.length, 28);
    header.writeUInt16LE(0, 30);
    header.writeUInt16LE(0, 32);
    header.writeUInt16LE(0, 34);
    header.writeUInt16LE(0, 36);
    header.writeUInt32LE(0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, nameBuffer);

    offset += local.length + nameBuffer.length + data.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, ...central, end]);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function downloadImage(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error(`无效图片链接：${url}`));
      return;
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      reject(new Error(`仅支持 http/https 图片链接：${url}`));
      return;
    }

    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(parsed, {
      timeout: 60000,
      headers: {
        Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 DownloadProxy/1.0',
      },
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirectCount >= 5) {
          reject(new Error(`图片重定向次数过多：${url}`));
          return;
        }
        const nextUrl = new URL(res.headers.location, parsed).toString();
        downloadImage(nextUrl, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        reject(new Error(`图片服务器返回 ${res.statusCode}：${url}`));
        return;
      }

      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          req.destroy(new Error(`单张图片超过 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB：${url}`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          data: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || '',
          finalUrl: parsed.toString(),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`下载超时：${url}`)));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    ...corsHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handleZip(req, res) {
  try {
    const raw = await readRequestBody(req);
    const payload = JSON.parse(raw || '{}');
    const images = Array.isArray(payload.images) ? payload.images : [];
    if (!images.length) throw new Error('没有收到图片链接');
    if (images.length > MAX_IMAGES) throw new Error(`一次最多打包 ${MAX_IMAGES} 张图片`);

    const files = [];
    let totalBytes = 0;
    for (let i = 0; i < images.length; i++) {
      const image = images[i] || {};
      const url = String(image.url || '').trim();
      if (!url) throw new Error(`第 ${i + 1} 张缺少图片链接`);
      const downloaded = await downloadImage(url);
      totalBytes += downloaded.data.length;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(`图片总大小超过 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB`);
      }
      const index = Number.isFinite(Number(image.index)) ? Number(image.index) + 1 : i + 1;
      const ext = extensionFrom(downloaded.contentType, downloaded.finalUrl || url);
      files.push({
        name: `images-output/${sanitizeFilename(`image-${index}`)}.${ext}`,
        data: downloaded.data,
      });
    }

    const zip = makeZip(files);
    const filename = `images-${new Date().toISOString().slice(0, 10)}.zip`;
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': zip.length,
    });
    res.end(zip);
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : '打包失败' });
  }
}

async function handleImage(req, res) {
  try {
    const raw = await readRequestBody(req);
    const payload = JSON.parse(raw || '{}');
    const url = String(payload.url || '').trim();
    if (!url) throw new Error('没有收到图片链接');

    const downloaded = await downloadImage(url);
    const ext = extensionFrom(downloaded.contentType, downloaded.finalUrl || url);
    const index = Number.isFinite(Number(payload.index)) ? Number(payload.index) + 1 : Date.now();
    const filename = `${sanitizeFilename(`image-${index}`)}.${ext}`;
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': downloaded.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': downloaded.data.length,
    });
    res.end(downloaded.data);
  } catch (err) {
    sendJson(res, 500, { error: err && err.message ? err.message : '图片下载失败' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/zip') {
    await handleZip(req, res);
    return;
  }
  if (req.method === 'POST' && url.pathname === '/image') {
    await handleImage(req, res);
    return;
  }
  sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`下载代理已启动：http://${HOST}:${PORT}`);
  console.log('保持这个窗口打开，然后回到页面点击【全部下载】。');
});
