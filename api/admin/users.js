import { jwtVerify } from 'jose';

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: verifica JWT y que el usuario sea el administrador
// ─────────────────────────────────────────────────────────────────────────────
async function checkAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    const e = new Error('Sesión requerida'); e.status = 401; throw e;
  }

  if (!process.env.SUPABASE_JWT_SECRET) {
    const e = new Error('Configuración del servidor incompleta (SUPABASE_JWT_SECRET)'); e.status = 500; throw e;
  }

  let payload;
  try {
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
    ({ payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] }));
  } catch {
    const e = new Error('Sesión inválida o expirada'); e.status = 401; throw e;
  }

  if (!payload.email || payload.email.toLowerCase() !== (process.env.ADMIN_EMAIL || '').toLowerCase()) {
    const e = new Error('Solo el administrador puede acceder a esta función'); e.status = 403; throw e;
  }

  return payload;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: headers para la Admin API de Supabase
// ─────────────────────────────────────────────────────────────────────────────
function adminHeaders() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return {
    'Authorization':  `Bearer ${key}`,
    'apikey':          key,
    'Content-Type':   'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verificar admin en todas las operaciones
  try {
    await checkAdmin(req);
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message });
  }

  const base  = `${process.env.SUPABASE_URL}/auth/v1/admin/users`;
  const hdrs  = adminHeaders();

  // ── GET: listar todos los usuarios ──────────────────────────────────────────
  if (req.method === 'GET') {
    const r = await fetch(`${base}?page=1&per_page=200`, { headers: hdrs });
    const d = await r.json();
    // Devolver solo campos necesarios (no exponer tokens internos)
    const users = (d.users || []).map(u => ({
      id:         u.id,
      email:      u.email,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at,
      confirmed_at: u.email_confirmed_at || u.confirmed_at,
    }));
    return res.status(200).json({ users });
  }

  // ── POST: crear usuario ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña son requeridos' });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'El email no tiene un formato válido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const r = await fetch(base, {
      method:  'POST',
      headers: hdrs,
      body:    JSON.stringify({
        email,
        password,
        email_confirm: true,  // confirmar email automáticamente (sin envío de correo)
      }),
    });
    const d = await r.json();

    if (!r.ok) {
      const msg = d.msg || d.message || d.error_description || 'Error al crear el usuario';
      return res.status(r.status).json({ error: msg });
    }

    return res.status(201).json({
      ok:    true,
      email: d.email,
      id:    d.id,
    });
  }

  // ── DELETE: eliminar usuario ────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const userId = req.query.id;
    if (!userId) return res.status(400).json({ error: 'ID de usuario requerido' });

    // Evitar que el admin se elimine a sí mismo
    if (req.query.email?.toLowerCase() === (process.env.ADMIN_EMAIL || '').toLowerCase()) {
      return res.status(400).json({ error: 'No podés eliminar tu propio usuario administrador' });
    }

    const r = await fetch(`${base}/${userId}`, { method: 'DELETE', headers: hdrs });
    if (r.status === 204 || r.status === 200) {
      return res.status(200).json({ ok: true });
    }
    const d = await r.json().catch(() => ({}));
    return res.status(r.status).json({ error: d.msg || d.message || 'Error al eliminar el usuario' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
