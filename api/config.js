// Expone la configuración pública de Supabase al frontend.
// Las claves anon/URL son seguras para exponer (son públicas por diseño).
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Configuración de Supabase incompleta en el servidor' });
  }

  return res.status(200).json({
    supabaseUrl:     process.env.SUPABASE_URL,
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY,
  });
}
