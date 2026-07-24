// 绑定 D1 数据库：DB
export default {
  async fetch(request, env) {
    await ensureTable(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    try {
      // ----- Mojang API 模拟 -----
      const userMatch = path.match(/^\/users\/profiles\/minecraft\/(.+)$/);
      if (userMatch && method === 'GET') {
        const username = userMatch[1];
        const user = await env.DB.prepare('SELECT uuid FROM users WHERE username = ?').bind(username).first();
        if (!user) return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');
        return jsonResponse({ id: user.uuid.replace(/-/g, ''), name: username });
      }

      const profileMatch = path.match(/^\/session\/minecraft\/profile\/([a-f0-9]{32})$/i);
      if (profileMatch && method === 'GET') {
        const uuidNoDash = profileMatch[1];
        const uuidWithDash = uuidNoDash.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
        const user = await env.DB.prepare(
          'SELECT username, skin_url, cape_url, model FROM users WHERE uuid = ?'
        ).bind(uuidWithDash).first();
        if (!user) return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');

        const textures = {
          timestamp: Date.now(),
          profileId: uuidNoDash,
          profileName: user.username,
          textures: {
            SKIN: {
              url: user.skin_url || 'https://example.com/default_skin.png',
              metadata: { model: user.model || 'classic' }
            }
          }
        };
        if (user.cape_url) textures.textures.CAPE = { url: user.cape_url };
        const value = btoa(unescape(encodeURIComponent(JSON.stringify(textures, null, 2))));
        return jsonResponse({
          id: uuidNoDash,
          name: user.username,
          properties: [{ name: 'textures', value }],
          profileActions: []
        });
      }

      if (path === '/profiles/minecraft' && method === 'POST') {
        let body;
        try { body = await request.json(); } catch { return errorResponse(400, 'JsonParseException', 'Invalid JSON payload'); }
        if (!Array.isArray(body)) return errorResponse(400, 'IllegalArgumentException', 'Request body must be a JSON array');
        if (body.length === 0 || body.length > 10) return errorResponse(400, 'IllegalArgumentException', 'size must be between 1 and 10');
        if (body.some(n => typeof n !== 'string' || n.trim() === '')) return errorResponse(400, 'IllegalArgumentException', 'Invalid profile name');
        const uniqueNames = [...new Set(body)];
        const placeholders = uniqueNames.map(() => '?').join(',');
        const stmt = await env.DB.prepare(`SELECT username, uuid FROM users WHERE username IN (${placeholders})`).bind(...uniqueNames);
        const { results } = await stmt.all();
        const map = {};
        results.forEach(r => { map[r.username.toLowerCase()] = { id: r.uuid.replace(/-/g, ''), name: r.username }; });
        return jsonResponse(uniqueNames.map(n => map[n.toLowerCase()] || null).filter(Boolean));
      }

      // ----- 管理 API -----
      if (path === '/api/users' && method === 'GET') {
        const { results } = await env.DB.prepare('SELECT uuid, username, skin_url, cape_url, model FROM users ORDER BY username').all();
        return jsonResponse(results);
      }

      const singleUserMatch = path.match(/^\/api\/user\/(.+)$/);
      if (singleUserMatch && method === 'GET') {
        const username = singleUserMatch[1];
        const user = await env.DB.prepare('SELECT uuid, username, skin_url, cape_url, model FROM users WHERE username = ?').bind(username).first();
        if (!user) return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');
        return jsonResponse(user);
      }

      if (path === '/api/register' && method === 'POST') {
        let body; try { body = await request.json(); } catch { return errorResponse(400, 'JsonParseException', 'Invalid JSON payload'); }
        const { username, uuid: customUuid, skin_url, cape_url, model } = body;
        if (!username) return errorResponse(400, 'IllegalArgumentException', 'Username required');
        const exist = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
        if (exist) return errorResponse(409, 'Conflict', 'Username already exists');

        let uuid;
        if (customUuid) {
          const cleaned = customUuid.replace(/-/g, '');
          if (!/^[0-9a-f]{32}$/i.test(cleaned)) return errorResponse(400, 'IllegalArgumentException', `Invalid UUID string: ${customUuid}`);
          const formatted = `${cleaned.substr(0,8)}-${cleaned.substr(8,4)}-${cleaned.substr(12,4)}-${cleaned.substr(16,4)}-${cleaned.substr(20,12)}`;
          const existUuid = await env.DB.prepare('SELECT uuid FROM users WHERE uuid = ?').bind(formatted).first();
          if (existUuid) return errorResponse(409, 'Conflict', 'UUID already exists');
          uuid = formatted;
        } else {
          const resp = await fetch('https://www.uuidtools.com/api/generate/v4');
          const data = await resp.json();
          uuid = data[0];
        }
        await env.DB.prepare('INSERT INTO users (uuid, username, skin_url, cape_url, model) VALUES (?, ?, ?, ?, ?)')
          .bind(uuid, username, skin_url || null, cape_url || null, model || 'classic').run();
        return jsonResponse({ success: true, uuid, username });
      }

      if (path === '/api/update' && method === 'PUT') {
        let body; try { body = await request.json(); } catch { return errorResponse(400, 'JsonParseException', 'Invalid JSON payload'); }
        const { username, skin_url, cape_url, model } = body;
        if (!username) return errorResponse(400, 'IllegalArgumentException', 'Username required');
        const exist = await env.DB.prepare('SELECT username FROM users WHERE username = ?').bind(username).first();
        if (!exist) return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');
        const updates = [], params = [];
        if (skin_url !== undefined) { updates.push('skin_url = ?'); params.push(skin_url); }
        if (cape_url !== undefined) { updates.push('cape_url = ?'); params.push(cape_url); }
        if (model !== undefined) { updates.push('model = ?'); params.push(model); }
        if (updates.length === 0) return errorResponse(400, 'IllegalArgumentException', 'No fields to update');
        params.push(username);
        await env.DB.prepare(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`).bind(...params).run();
        return jsonResponse({ success: true, username });
      }

      if (singleUserMatch && method === 'DELETE') {
        const username = singleUserMatch[1];
        const result = await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
        if (result.changes === 0) return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');
        return jsonResponse({ success: true, username });
      }

      // 管理面板
      if (path === '/' || path === '/admin') {
        return new Response(ADMIN_HTML, {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      return errorResponse(404, 'Not Found', 'The server has not found anything matching the request URI');
    } catch (e) {
      return errorResponse(500, 'Internal Server Error', e.message);
    }
  }
};

async function ensureTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS users (
      uuid TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      skin_url TEXT,
      cape_url TEXT,
      model TEXT DEFAULT 'classic'
    )`
  ).run();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

function errorResponse(status, error, errorMessage, cause = null) {
  const body = { error, errorMessage };
  if (cause) body.cause = cause;
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
  });
}

// ---------- 管理面板 HTML（移除了“离线支持”标签）----------
const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>皮肤管理面板</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
      background: linear-gradient(145deg, #f0f4f8 0%, #d9e2ec 100%);
      min-height: 100vh;
      padding: 30px 20px;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
    }
    .app-title {
      font-size: 2rem;
      font-weight: 600;
      color: #0f172a;
      margin-bottom: 24px;
      letter-spacing: -0.02em;
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .app-title .badge {
      background: #3b82f6;
      color: #fff;
      font-size: 0.75rem;
      padding: 4px 14px;
      border-radius: 30px;
      font-weight: 500;
      letter-spacing: 0.3px;
    }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 24px;
      margin-bottom: 24px;
    }
    .card {
      background: rgba(255,255,255,0.85);
      backdrop-filter: blur(4px);
      border-radius: 20px;
      padding: 28px 24px;
      box-shadow: 0 8px 30px rgba(0,0,0,0.04), 0 2px 6px rgba(0,0,0,0.02);
      border: 1px solid rgba(255,255,255,0.8);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .card:hover {
      transform: translateY(-3px);
      box-shadow: 0 20px 40px -12px rgba(0,0,0,0.08);
    }
    .card h2 {
      font-weight: 600;
      font-size: 1.25rem;
      color: #0f172a;
      margin-bottom: 20px;
      padding-bottom: 12px;
      border-bottom: 2px solid #e9edf2;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .form-group {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      margin-bottom: 16px;
      gap: 8px 12px;
    }
    .form-group label {
      width: 110px;
      font-weight: 500;
      color: #1e293b;
      font-size: 0.9rem;
      flex-shrink: 0;
    }
    .form-group input, .form-group select {
      flex: 1;
      min-width: 180px;
      padding: 8px 14px;
      border: 1px solid #d1d9e6;
      border-radius: 10px;
      font-size: 0.95rem;
      background: #fafcff;
      transition: border 0.2s, box-shadow 0.2s;
      outline: none;
    }
    .form-group input:focus, .form-group select:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,0.15);
    }
    .form-group input[type="checkbox"] {
      width: 20px;
      height: 20px;
      min-width: 20px;
      flex: 0 0 auto;
      accent-color: #3b82f6;
      cursor: pointer;
    }
    .form-group .hint {
      font-size: 0.75rem;
      color: #64748b;
      margin-left: 4px;
      flex: 0 0 auto;
    }
    .form-group .hint-check {
      font-size: 0.85rem;
      color: #334155;
      margin-left: 4px;
    }
    button {
      background: #3b82f6;
      color: #fff;
      border: none;
      padding: 10px 28px;
      border-radius: 30px;
      font-weight: 500;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background 0.2s, transform 0.15s;
    }
    button:hover {
      background: #2563eb;
      transform: scale(1.02);
    }
    button:active {
      transform: scale(0.97);
    }
    .message {
      margin-top: 12px;
      padding: 10px 16px;
      border-radius: 12px;
      font-size: 0.9rem;
      display: none;
    }
    .message.success {
      display: block;
      background: #d1fae5;
      color: #065f46;
    }
    .message.error {
      display: block;
      background: #fee2e2;
      color: #991b1b;
    }
    .user-list {
      overflow-x: auto;
    }
    .user-list table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9rem;
    }
    .user-list th {
      text-align: left;
      padding: 12px 8px;
      background: #f8fafc;
      border-bottom: 2px solid #e2e8f0;
      color: #334155;
      font-weight: 600;
    }
    .user-list td {
      padding: 10px 8px;
      border-bottom: 1px solid #edf2f7;
      vertical-align: middle;
    }
    .user-list .actions button {
      padding: 4px 14px;
      font-size: 0.8rem;
      border-radius: 20px;
      margin-right: 6px;
      background: #e2e8f0;
      color: #1e293b;
    }
    .user-list .actions button:hover {
      background: #cbd5e1;
      transform: none;
    }
    .user-list .actions .delete {
      background: #fecaca;
      color: #991b1b;
    }
    .user-list .actions .delete:hover {
      background: #fca5a5;
    }
    .url-cell {
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .url-cell a {
      color: #3b82f6;
      text-decoration: none;
    }
    .url-cell a:hover {
      text-decoration: underline;
    }
    @media (max-width: 768px) {
      .grid { grid-template-columns: 1fr; }
      .form-group label { width: 100%; }
      .app-title { font-size: 1.5rem; flex-wrap: wrap; }
    }
  </style>
</head>
<body>
<div class="container">
  <div class="app-title">
    皮肤管理面板
    <span class="badge">v1.0</span>
  </div>
  <div class="grid">
    <!-- 注册卡片 -->
    <div class="card">
      <h2>注册新用户</h2>
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="regUsername" placeholder="输入玩家名" />
      </div>
      <div class="form-group">
        <label>离线模式</label>
        <input type="checkbox" id="offlineCheck" />
        <span class="hint-check">勾选后根据用户名自动生成离线UUID</span>
      </div>
      <div class="form-group">
        <label>UUID（选填）</label>
        <input type="text" id="regUuid" placeholder="32位十六进制，可带或不带连字符" readonly />
        <span class="hint">留空自动生成</span>
      </div>
      <div class="form-group">
        <label>皮肤 URL</label>
        <input type="url" id="regSkin" placeholder="https://example.com/skin.png" />
      </div>
      <div class="form-group">
        <label>披风 URL</label>
        <input type="url" id="regCape" placeholder="https://example.com/cape.png" />
      </div>
      <div class="form-group">
        <label>模型</label>
        <select id="regModel">
          <option value="classic">Classic (Steve)</option>
          <option value="slim">Slim (Alex)</option>
        </select>
      </div>
      <button id="regBtn">注册</button>
      <div id="regMessage" class="message"></div>
    </div>

    <!-- 更新卡片 -->
    <div class="card">
      <h2>更新用户信息</h2>
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="updUsername" placeholder="输入玩家名" />
      </div>
      <div class="form-group">
        <label>皮肤 URL</label>
        <input type="url" id="updSkin" placeholder="https://example.com/skin.png" />
      </div>
      <div class="form-group">
        <label>披风 URL</label>
        <input type="url" id="updCape" placeholder="https://example.com/cape.png" />
      </div>
      <div class="form-group">
        <label>模型</label>
        <select id="updModel">
          <option value="classic">Classic (Steve)</option>
          <option value="slim">Slim (Alex)</option>
        </select>
      </div>
      <button id="updBtn">更新</button>
      <div id="updMessage" class="message"></div>
    </div>
  </div>

  <!-- 用户列表 -->
  <div class="card user-list">
    <h2>已注册用户</h2>
    <table>
      <thead><tr><th>UUID</th><th>用户名</th><th>模型</th><th>皮肤</th><th>披风</th><th>操作</th></tr></thead>
      <tbody id="userTableBody"></tbody>
    </table>
  </div>
</div>

<script>
  const API_BASE = window.location.origin;

  function showMsg(container, msg, isError = false) {
    container.textContent = msg;
    container.className = 'message ' + (isError ? 'error' : 'success');
  }

  // ----- 标准 MD5 实现（RFC 1321）-----
  function md5(string) {
    function md5cycle(x, k) {
      var a = x[0], b = x[1], c = x[2], d = x[3];
      a = ff(a, b, c, d, k[0], 7, -680876936);
      d = ff(d, a, b, c, k[1], 12, -389564586);
      c = ff(c, d, a, b, k[2], 17, 606105819);
      b = ff(b, c, d, a, k[3], 22, -1044525330);
      a = ff(a, b, c, d, k[4], 7, -176418897);
      d = ff(d, a, b, c, k[5], 12, 1200080426);
      c = ff(c, d, a, b, k[6], 17, -1473231341);
      b = ff(b, c, d, a, k[7], 22, -45705983);
      a = ff(a, b, c, d, k[8], 7, 1770035416);
      d = ff(d, a, b, c, k[9], 12, -1958414417);
      c = ff(c, d, a, b, k[10], 17, -42063);
      b = ff(b, c, d, a, k[11], 22, -1990404162);
      a = ff(a, b, c, d, k[12], 7, 1804603682);
      d = ff(d, a, b, c, k[13], 12, -40341101);
      c = ff(c, d, a, b, k[14], 17, -1502002290);
      b = ff(b, c, d, a, k[15], 22, 1236535329);
      a = gg(a, b, c, d, k[1], 5, -165796510);
      d = gg(d, a, b, c, k[6], 9, -1069501632);
      c = gg(c, d, a, b, k[11], 14, 643717713);
      b = gg(b, c, d, a, k[0], 20, -373897302);
      a = gg(a, b, c, d, k[5], 5, -701558691);
      d = gg(d, a, b, c, k[10], 9, 38016083);
      c = gg(c, d, a, b, k[15], 14, -660478335);
      b = gg(b, c, d, a, k[4], 20, -405537848);
      a = gg(a, b, c, d, k[9], 5, 568446438);
      d = gg(d, a, b, c, k[14], 9, -1019803690);
      c = gg(c, d, a, b, k[3], 14, -187363961);
      b = gg(b, c, d, a, k[8], 20, 1163531501);
      a = gg(a, b, c, d, k[13], 5, -1444681467);
      d = gg(d, a, b, c, k[2], 9, -51403784);
      c = gg(c, d, a, b, k[7], 14, 1735328473);
      b = gg(b, c, d, a, k[12], 20, -1926607734);
      a = hh(a, b, c, d, k[5], 4, -378558);
      d = hh(d, a, b, c, k[8], 11, -2022574463);
      c = hh(c, d, a, b, k[11], 16, 1839030562);
      b = hh(b, c, d, a, k[14], 23, -35309556);
      a = hh(a, b, c, d, k[1], 4, -1530992060);
      d = hh(d, a, b, c, k[4], 11, 1272893353);
      c = hh(c, d, a, b, k[7], 16, -155497632);
      b = hh(b, c, d, a, k[10], 23, -1094730640);
      a = hh(a, b, c, d, k[13], 4, 681279174);
      d = hh(d, a, b, c, k[0], 11, -358537222);
      c = hh(c, d, a, b, k[3], 16, -722521979);
      b = hh(b, c, d, a, k[6], 23, 76029189);
      a = hh(a, b, c, d, k[9], 4, -640364487);
      d = hh(d, a, b, c, k[12], 11, -421815835);
      c = hh(c, d, a, b, k[15], 16, 530742520);
      b = hh(b, c, d, a, k[2], 23, -995338651);
      a = ii(a, b, c, d, k[0], 6, -198630844);
      d = ii(d, a, b, c, k[7], 10, 1126891415);
      c = ii(c, d, a, b, k[14], 15, -1416354905);
      b = ii(b, c, d, a, k[5], 21, -57434055);
      a = ii(a, b, c, d, k[12], 6, 1700485571);
      d = ii(d, a, b, c, k[3], 10, -1894986606);
      c = ii(c, d, a, b, k[10], 15, -1051523);
      b = ii(b, c, d, a, k[1], 21, -2054922799);
      a = ii(a, b, c, d, k[8], 6, 1873313359);
      d = ii(d, a, b, c, k[15], 10, -30611744);
      c = ii(c, d, a, b, k[6], 15, -1560198380);
      b = ii(b, c, d, a, k[13], 21, 1309151649);
      a = ii(a, b, c, d, k[4], 6, -145523070);
      d = ii(d, a, b, c, k[11], 10, -1120210379);
      c = ii(c, d, a, b, k[2], 15, 718787259);
      b = ii(b, c, d, a, k[9], 21, -343485551);
      x[0] = add32(a, x[0]);
      x[1] = add32(b, x[1]);
      x[2] = add32(c, x[2]);
      x[3] = add32(d, x[3]);
    }

    function add32(a, b) {
      return (a + b) & 0xFFFFFFFF;
    }

    function cmn(q, a, b, x, s, t) {
      a = add32(add32(a, q), add32(x, t));
      return add32((a << s) | (a >>> (32 - s)), b);
    }

    function ff(a, b, c, d, x, s, t) {
      return cmn((b & c) | ((~b) & d), a, b, x, s, t);
    }

    function gg(a, b, c, d, x, s, t) {
      return cmn((b & d) | (c & (~d)), a, b, x, s, t);
    }

    function hh(a, b, c, d, x, s, t) {
      return cmn(b ^ c ^ d, a, b, x, s, t);
    }

    function ii(a, b, c, d, x, s, t) {
      return cmn(c ^ (b | (~d)), a, b, x, s, t);
    }

    function md5blk(s) {
      var md5blks = [], i;
      for (i = 0; i < 64; i += 4) {
        md5blks[i >> 2] = s.charCodeAt(i) + (s.charCodeAt(i + 1) << 8) + (s.charCodeAt(i + 2) << 16) + (s.charCodeAt(i + 3) << 24);
      }
      return md5blks;
    }

    function md5blk_array(s) {
      var md5blks = [], i;
      for (i = 0; i < s.length; i += 4) {
        md5blks[i >> 2] = s[i] + (s[i + 1] << 8) + (s[i + 2] << 16) + (s[i + 3] << 24);
      }
      return md5blks;
    }

    var x = [1732584193, -271733879, -1732584194, 271733878];
    var i, j, data, len, pos;

    // 将字符串转换为字节数组（UTF-8）
    var bytes = [];
    for (i = 0; i < string.length; i++) {
      var code = string.charCodeAt(i);
      if (code < 0x80) bytes.push(code);
      else if (code < 0x800) { bytes.push(0xC0 | (code >> 6)); bytes.push(0x80 | (code & 0x3F)); }
      else if (code < 0xD800 || code >= 0xE000) { bytes.push(0xE0 | (code >> 12)); bytes.push(0x80 | ((code >> 6) & 0x3F)); bytes.push(0x80 | (code & 0x3F)); }
      else { i++; code = 0x10000 + (((code & 0x3FF) << 10) | (string.charCodeAt(i) & 0x3FF)); bytes.push(0xF0 | (code >> 18)); bytes.push(0x80 | ((code >> 12) & 0x3F)); bytes.push(0x80 | ((code >> 6) & 0x3F)); bytes.push(0x80 | (code & 0x3F)); }
    }
    len = bytes.length;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    for (i = 0; i < 8; i++) bytes.push((len * 8) & 0xFF, ((len * 8) >> 8) & 0xFF, ((len * 8) >> 16) & 0xFF, ((len * 8) >> 24) & 0xFF);

    for (i = 0; i < bytes.length; i += 64) {
      var chunk = bytes.slice(i, i + 64);
      var k = md5blk_array(chunk);
      md5cycle(x, k);
    }

    function toHex(n) {
      var s = "", v;
      for (i = 0; i < 4; i++) {
        v = (n >>> (i * 8)) & 0xFF;
        s += ((v >> 4) & 0xF).toString(16) + (v & 0xF).toString(16);
      }
      return s;
    }

    return toHex(x[0]) + toHex(x[1]) + toHex(x[2]) + toHex(x[3]);
  }

  function generateOfflineUUID(username) {
    var hash = md5("OfflinePlayer:" + username);
    return hash.substr(0,8) + '-' + hash.substr(8,4) + '-' + hash.substr(12,4) + '-' + hash.substr(16,4) + '-' + hash.substr(20,12);
  }

  // 测试用例：验证 ctn32 -> 7bcd7cac-982e-3be6-8446-1ed3b7364c42
  console.log("ctn32 UUID:", generateOfflineUUID("ctn32"));

  const offlineCheck = document.getElementById('offlineCheck');
  const regUsername = document.getElementById('regUsername');
  const regUuid = document.getElementById('regUuid');

  function updateOfflineUuid() {
    if (offlineCheck.checked) {
      const username = regUsername.value.trim();
      if (username) {
        const uuid = generateOfflineUUID(username);
        regUuid.value = uuid;
        regUuid.readOnly = true;
      } else {
        regUuid.value = '';
        regUuid.readOnly = false;
      }
    } else {
      regUuid.value = '';
      regUuid.readOnly = false;
    }
  }

  offlineCheck.addEventListener('change', updateOfflineUuid);
  regUsername.addEventListener('input', updateOfflineUuid);

  async function loadUsers() {
    const resp = await fetch(API_BASE + '/api/users');
    if (!resp.ok) return;
    const users = await resp.json();
    const tbody = document.getElementById('userTableBody');
    tbody.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = \`
        <td>\${u.uuid}</td>
        <td>\${u.username}</td>
        <td>\${u.model || 'classic'}</td>
        <td class="url-cell">\${u.skin_url ? \`<a href="\${u.skin_url}" target="_blank">链接</a>\` : '-'}</td>
        <td class="url-cell">\${u.cape_url ? \`<a href="\${u.cape_url}" target="_blank">链接</a>\` : '-'}</td>
        <td class="actions">
          <button onclick="editUser('\${u.username}')">编辑</button>
          <button class="delete" onclick="deleteUser('\${u.username}')">删除</button>
        </td>
      \`;
      tbody.appendChild(tr);
    });
  }

  window.editUser = function(username) {
    document.getElementById('updUsername').value = username;
    fetch(API_BASE + '/api/user/' + username)
      .then(r => r.json())
      .then(user => {
        document.getElementById('updSkin').value = user.skin_url || '';
        document.getElementById('updCape').value = user.cape_url || '';
        document.getElementById('updModel').value = user.model || 'classic';
      });
  };

  window.deleteUser = async function(username) {
    if (!confirm('确认删除用户 ' + username + ' 吗？')) return;
    const resp = await fetch(API_BASE + '/api/user/' + username, { method: 'DELETE' });
    const data = await resp.json();
    if (resp.ok) {
      showMsg(document.getElementById('updMessage'), '删除成功', false);
      loadUsers();
    } else {
      showMsg(document.getElementById('updMessage'), data.errorMessage || data.error || '删除失败', true);
    }
  };

  // 注册
  document.getElementById('regBtn').onclick = async function() {
    const username = regUsername.value.trim();
    if (!username) {
      showMsg(document.getElementById('regMessage'), '请输入用户名', true);
      return;
    }
    let uuid = regUuid.value.trim() || undefined;
    if (offlineCheck.checked && !uuid) {
      updateOfflineUuid();
      uuid = regUuid.value.trim() || undefined;
    }
    const skin_url = document.getElementById('regSkin').value.trim() || undefined;
    const cape_url = document.getElementById('regCape').value.trim() || undefined;
    const model = document.getElementById('regModel').value;
    const payload = { username };
    if (uuid) payload.uuid = uuid;
    if (skin_url) payload.skin_url = skin_url;
    if (cape_url) payload.cape_url = cape_url;
    if (model) payload.model = model;

    const resp = await fetch(API_BASE + '/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (resp.ok) {
      showMsg(document.getElementById('regMessage'), '注册成功！UUID: ' + data.uuid, false);
      regUsername.value = '';
      regUuid.value = '';
      regUuid.readOnly = false;
      offlineCheck.checked = false;
      document.getElementById('regSkin').value = '';
      document.getElementById('regCape').value = '';
      loadUsers();
    } else {
      showMsg(document.getElementById('regMessage'), data.errorMessage || data.error || '注册失败', true);
    }
  };

  // 更新
  document.getElementById('updBtn').onclick = async function() {
    const username = document.getElementById('updUsername').value.trim();
    if (!username) {
      showMsg(document.getElementById('updMessage'), '请输入用户名', true);
      return;
    }
    const skin_url = document.getElementById('updSkin').value.trim() || undefined;
    const cape_url = document.getElementById('updCape').value.trim() || undefined;
    const model = document.getElementById('updModel').value;
    const payload = { username };
    if (skin_url !== undefined) payload.skin_url = skin_url;
    if (cape_url !== undefined) payload.cape_url = cape_url;
    if (model) payload.model = model;

    const resp = await fetch(API_BASE + '/api/update', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await resp.json();
    if (resp.ok) {
      showMsg(document.getElementById('updMessage'), '更新成功！', false);
      loadUsers();
    } else {
      showMsg(document.getElementById('updMessage'), data.errorMessage || data.error || '更新失败', true);
    }
  };

  loadUsers();
</script>
</body>
</html>`;
