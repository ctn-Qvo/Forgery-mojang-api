// 绑定 D1 数据库：DB
export default {
  async fetch(request, env) {
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
        const value = btoa(unescape(encodeURIComponent(JSON.stringify(textures))));
        return jsonResponse({
          id: uuidNoDash,
          name: user.username,
          properties: [{ name: 'textures', value }],
          profileActions: []
        });
      }

      // ----- 拓展 API -----
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
      if (path === '/api/users' && method === 'GET') {
        const { results } = await env.DB.prepare(
          'SELECT uuid, username, skin_url, cape_url, model FROM users ORDER BY username'
        ).all();
        return jsonResponse(results);
      }

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

      // ----- 注册（支持自定义 UUID，自动格式化）-----
      if (path === '/api/register' && method === 'POST') {
        const body = await request.json();
        const { username, uuid: customUuid } = body;
        if (!username) {
          return jsonResponse({ error: 'Username required' }, 400);
        }

        // 检查用户名是否已存在
        const exist = await env.DB.prepare(
          'SELECT username FROM users WHERE username = ?'
        ).bind(username).first();
        if (exist) {
          return jsonResponse({ error: 'Username already exists' }, 409);
        }

        let uuid;
        if (customUuid) {
          // 移除所有连字符
          const cleaned = customUuid.replace(/-/g, '');
          // 检查是否为32位十六进制
          if (!/^[0-9a-f]{32}$/i.test(cleaned)) {
            return jsonResponse({ error: 'Invalid UUID format (must be 32 hex chars, with or without dashes)' }, 400);
          }
          // 格式化为标准带连字符格式
          const formatted = `${cleaned.substr(0,8)}-${cleaned.substr(8,4)}-${cleaned.substr(12,4)}-${cleaned.substr(16,4)}-${cleaned.substr(20,12)}`;
          // 检查 UUID 是否已被占用
          const existUuid = await env.DB.prepare(
            'SELECT uuid FROM users WHERE uuid = ?'
          ).bind(formatted).first();
          if (existUuid) {
            return jsonResponse({ error: 'UUID already exists' }, 409);
          }
          uuid = formatted;
        } else {
          // 自动生成
          const uuidResp = await fetch('https://www.uuidtools.com/api/generate/v4');
          const uuidData = await uuidResp.json();
          uuid = uuidData[0];
        }

        // 插入新用户
        await env.DB.prepare(
          'INSERT INTO users (uuid, username, model) VALUES (?, ?, ?)'
        ).bind(uuid, username, 'classic').run();

        return jsonResponse({ success: true, uuid, username });
      }

      // ----- 更新用户 -----
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

      // ----- 删除用户 -----
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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// ---------- 管理面板 HTML（更新提示） ----------
const ADMIN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>皮肤管理面板</title>
  <style>
    body { font-family: sans-serif; padding: 20px; background: #f5f5f5; }
    .container { max-width: 1200px; margin: auto; }
    .card { background: white; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
    h2 { margin-top: 0; }
    .form-group { margin-bottom: 10px; }
    label { display: inline-block; width: 100px; }
    input, select { padding: 6px 10px; width: 250px; }
    button { padding: 6px 15px; cursor: pointer; }
    .user-list table { width: 100%; border-collapse: collapse; }
    .user-list th, .user-list td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
    .actions button { margin-right: 5px; }
    .message { color: green; }
    .error { color: red; }
  </style>
</head>
<body>
<div class="container">
  <h1>皮肤管理面板</h1>

  <div class="card">
    <h2>注册新用户</h2>
    <div class="form-group">
      <label>用户名：</label>
      <input type="text" id="regUsername" placeholder="输入玩家名" />
    </div>
    <div class="form-group">
      <label>UUID（选填）：</label>
      <input type="text" id="regUuid" placeholder="32位十六进制，可带或不带连字符" />
      <span style="font-size:12px;color:#888;">留空则自动生成</span>
    </div>
    <button id="regBtn">注册</button>
    <div id="regMessage"></div>
  </div>

  <div class="card">
    <h2>更新用户信息</h2>
    <div class="form-group">
      <label>用户名：</label>
      <input type="text" id="updUsername" placeholder="输入玩家名" />
    </div>
    <div class="form-group">
      <label>皮肤 URL：</label>
      <input type="url" id="updSkin" placeholder="https://example.com/skin.png" />
    </div>
    <div class="form-group">
      <label>披风 URL：</label>
      <input type="url" id="updCape" placeholder="https://example.com/cape.png" />
    </div>
    <div class="form-group">
      <label>模型：</label>
      <select id="updModel">
        <option value="classic">Classic (Steve)</option>
        <option value="slim">Slim (Alex)</option>
      </select>
    </div>
    <button id="updBtn">更新</button>
    <div id="updMessage"></div>
  </div>

  <div class="card user-list">
    <h2>已注册用户</h2>
    <table>
      <thead><tr><th>UUID</th><th>用户名</th><th>模型</th><th>操作</th></tr></thead>
      <tbody id="userTableBody"></tbody>
    </table>
  </div>
</div>

<script>
  const API_BASE = window.location.origin;

  function showMsg(container, msg, isError = false) {
    container.textContent = msg;
    container.className = isError ? 'error' : 'message';
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
        <td class="actions">
          <button onclick="editUser('\${u.username}')">编辑</button>
          <button onclick="deleteUser('\${u.username}')">删除</button>
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

  document.getElementById('regBtn').onclick = async function() {
    const username = document.getElementById('regUsername').value.trim();
    if (!username) {
      showMsg(document.getElementById('regMessage'), '请输入用户名', true);
      return;
    }
    const uuid = document.getElementById('regUuid').value.trim() || undefined;
    const payload = { username };
    if (uuid) payload.uuid = uuid;

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
      loadUsers();
    } else {
      showMsg(document.getElementById('regMessage'), data.error || '注册失败', true);
    }
  };

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
