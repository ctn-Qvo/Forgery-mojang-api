// 绑定 D1 数据库：DB
export default {
  async fetch(request, env) {
    // 确保表存在（每次请求尝试创建，已存在则忽略）
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
      // ----- 核心 Mojang API -----
      // 1. 获取玩家 UUID
      const userMatch = path.match(/^\/users\/profiles\/minecraft\/(.+)$/);
      if (userMatch && method === 'GET') {
        const username = userMatch[1];
        const user = await env.DB.prepare(
          'SELECT uuid FROM users WHERE username = ?'
        ).bind(username).first();
        if (!user) {
          return jsonResponse({ error: 'User not found' }, 404);
        }
        const uuidNoDash = user.uuid.replace(/-/g, '');
        return jsonResponse({ id: uuidNoDash, name: username });
      }

      // 2. 获取玩家 profile（含纹理）
      const profileMatch = path.match(/^\/session\/minecraft\/profile\/([a-f0-9]{32})$/i);
      if (profileMatch && method === 'GET') {
        const uuidNoDash = profileMatch[1];
        const uuidWithDash = uuidNoDash.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
        const user = await env.DB.prepare(
          'SELECT username, skin_url, cape_url, model FROM users WHERE uuid = ?'
        ).bind(uuidWithDash).first();
        if (!user) {
          return jsonResponse({ error: 'Profile not found' }, 404);
        }
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
        if (user.cape_url) {
          textures.textures.CAPE = { url: user.cape_url };
        }
        // 美化 Base64 编码前的 JSON（缩进 2 个空格）
        const value = btoa(unescape(encodeURIComponent(JSON.stringify(textures, null, 2))));
        return jsonResponse({
          id: uuidNoDash,
          name: user.username,
          properties: [{ name: 'textures', value }],
          profileActions: []
        });
      }

      // ----- 拓展 API -----
      // 3. 批量获取 UUID
      if (path === '/profiles/minecraft' && method === 'POST') {
        const body = await request.json();
        if (!Array.isArray(body) || body.length === 0 || body.length > 10) {
          return jsonResponse({ error: 'Invalid request: must be an array of 1-10 usernames' }, 400);
        }
        const uniqueNames = [...new Set(body)];
        const placeholders = uniqueNames.map(() => '?').join(',');
        const stmt = await env.DB.prepare(
          `SELECT username, uuid FROM users WHERE username IN (${placeholders})`
        ).bind(...uniqueNames);
        const { results } = await stmt.all();
        const resultMap = {};
        results.forEach(row => {
          resultMap[row.username.toLowerCase()] = {
            id: row.uuid.replace(/-/g, ''),
            name: row.username
          };
        });
        const output = uniqueNames.map(name => {
          const lower = name.toLowerCase();
          return resultMap[lower] || null;
        }).filter(item => item !== null);
        return jsonResponse(output);
      }

      // ----- 管理 API -----
      // 4. 获取所有用户
      if (path === '/api/users' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT uuid, username, skin_url, cape_url, model FROM users ORDER BY username'
        ).all();
        return jsonResponse(results);
      }

      // 5. 获取单个用户
      const singleUserMatch = path.match(/^\/api\/user\/(.+)$/);
      if (singleUserMatch && method === 'GET') {
        const username = singleUserMatch[1];
        const user = await env.DB.prepare(
          'SELECT uuid, username, skin_url, cape_url, model FROM users WHERE username = ?'
        ).bind(username).first();
        if (!user) {
          return jsonResponse({ error: 'User not found' }, 404);
        }
        return jsonResponse(user);
      }

      // 6. 注册新用户（支持自定义UUID和URL）
      if (path === '/api/register' && method === 'POST') {
        const body = await request.json();
        const { username, uuid: customUuid, skin_url, cape_url, model } = body;
        if (!username) {
          return jsonResponse({ error: 'Username required' }, 400);
        }

        const exist = await env.DB.prepare(
          'SELECT username FROM users WHERE username = ?'
        ).bind(username).first();
        if (exist) {
          return jsonResponse({ error: 'Username already exists' }, 409);
        }

        let uuid;
        if (customUuid) {
          const cleaned = customUuid.replace(/-/g, '');
          if (!/^[0-9a-f]{32}$/i.test(cleaned)) {
            return jsonResponse({ error: 'Invalid UUID format (must be 32 hex chars, with or without dashes)' }, 400);
          }
          const formatted = `${cleaned.substr(0,8)}-${cleaned.substr(8,4)}-${cleaned.substr(12,4)}-${cleaned.substr(16,4)}-${cleaned.substr(20,12)}`;
          const existUuid = await env.DB.prepare(
            'SELECT uuid FROM users WHERE uuid = ?'
          ).bind(formatted).first();
          if (existUuid) {
            return jsonResponse({ error: 'UUID already exists' }, 409);
          }
          uuid = formatted;
        } else {
          const uuidResp = await fetch('https://www.uuidtools.com/api/generate/v4');
          const uuidData = await uuidResp.json();
          uuid = uuidData[0];
        }

        await env.DB.prepare(
          `INSERT INTO users (uuid, username, skin_url, cape_url, model)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(uuid, username, skin_url || null, cape_url || null, model || 'classic').run();

        return jsonResponse({ success: true, uuid, username });
      }

      // 7. 更新用户
      if (path === '/api/update' && method === 'PUT') {
        const body = await request.json();
        const { username, skin_url, cape_url, model } = body;
        if (!username) {
          return jsonResponse({ error: 'Username required' }, 400);
        }
        const exist = await env.DB.prepare(
          'SELECT username FROM users WHERE username = ?'
        ).bind(username).first();
        if (!exist) {
          return jsonResponse({ error: 'User not found' }, 404);
        }
        const updates = [];
        const params = [];
        if (skin_url !== undefined) {
          updates.push('skin_url = ?');
          params.push(skin_url);
        }
        if (cape_url !== undefined) {
          updates.push('cape_url = ?');
          params.push(cape_url);
        }
        if (model !== undefined) {
          updates.push('model = ?');
          params.push(model);
        }
        if (updates.length === 0) {
          return jsonResponse({ error: 'No fields to update' }, 400);
        }
        params.push(username);
        await env.DB.prepare(
          `UPDATE users SET ${updates.join(', ')} WHERE username = ?`
        ).bind(...params).run();
        return jsonResponse({ success: true, username });
      }

      // 8. 删除用户
      if (singleUserMatch && method === 'DELETE') {
        const username = singleUserMatch[1];
        const result = await env.DB.prepare(
          'DELETE FROM users WHERE username = ?'
        ).bind(username).run();
        if (result.changes === 0) {
          return jsonResponse({ error: 'User not found' }, 404);
        }
        return jsonResponse({ success: true, username });
      }

      // ----- 管理界面 -----
      if (path === '/' || path === '/admin') {
        return new Response(ADMIN_HTML, {
          headers: { 'Content-Type': 'text/html' }
        });
      }

      return new Response('Not Found', { status: 404 });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
};

// 确保 users 表存在
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
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ---------- 管理面板 HTML（无表情符号）----------
const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>皮肤管理面板</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #f0f2f5; margin: 0; padding: 30px; }
    .container { max-width: 1100px; margin: auto; }
    h1 { font-weight: 500; color: #1a1a2e; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; margin-top: 20px; }
    .card { background: white; border-radius: 12px; padding: 24px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
    .card h2 { margin-top: 0; font-weight: 500; color: #2d3748; border-bottom: 2px solid #e2e8f0; padding-bottom: 12px; }
    .form-group { margin-bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; }
    .form-group label { width: 110px; font-weight: 500; color: #4a5568; }
    .form-group input, .form-group select { flex: 1; min-width: 200px; padding: 8px 12px; border: 1px solid #cbd5e0; border-radius: 6px; font-size: 14px; }
    .form-group .hint { font-size: 12px; color: #a0aec0; margin-left: 8px; }
    button { background: #4299e1; color: white; border: none; padding: 8px 20px; border-radius: 6px; font-weight: 500; cursor: pointer; }
    button:hover { background: #3182ce; }
    .message { margin-top: 12px; padding: 8px 12px; border-radius: 6px; }
    .message.success { background: #c6f6d5; color: #22543d; }
    .message.error { background: #fed7d7; color: #9b2c2c; }
    .user-list table { width: 100%; border-collapse: collapse; font-size: 14px; }
    .user-list th { text-align: left; padding: 10px 8px; background: #f7fafc; border-bottom: 2px solid #e2e8f0; }
    .user-list td { padding: 10px 8px; border-bottom: 1px solid #edf2f7; vertical-align: middle; }
    .user-list .actions button { margin-right: 6px; font-size: 12px; padding: 4px 10px; }
    .user-list .actions .delete { background: #fc8181; }
    .user-list .actions .delete:hover { background: #f56565; }
    .url-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
<div class="container">
  <h1>皮肤管理面板</h1>
  <div class="grid">
    <!-- 注册卡片 -->
    <div class="card">
      <h2>注册新用户</h2>
      <div class="form-group">
        <label>用户名</label>
        <input type="text" id="regUsername" placeholder="输入玩家名" />
      </div>
      <div class="form-group">
        <label>UUID（选填）</label>
        <input type="text" id="regUuid" placeholder="32位十六进制，可带或不带连字符" />
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
  <div class="card user-list" style="margin-top: 24px;">
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
      showMsg(document.getElementById('updMessage'), data.error || '删除失败', true);
    }
  };

  // 注册
  document.getElementById('regBtn').onclick = async function() {
    const username = document.getElementById('regUsername').value.trim();
    if (!username) {
      showMsg(document.getElementById('regMessage'), '请输入用户名', true);
      return;
    }
    const uuid = document.getElementById('regUuid').value.trim() || undefined;
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
      document.getElementById('regUsername').value = '';
      document.getElementById('regUuid').value = '';
      document.getElementById('regSkin').value = '';
      document.getElementById('regCape').value = '';
      loadUsers();
    } else {
      showMsg(document.getElementById('regMessage'), data.error || '注册失败', true);
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
      showMsg(document.getElementById('updMessage'), data.error || '更新失败', true);
    }
  };

  loadUsers();
</script>
</body>
</html>`;
