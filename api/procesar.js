import OpenAI    from 'openai';
import { jwtVerify } from 'jose';

// ─────────────────────────────────────────────────────────────────────────────
// DATOS FIJOS DE LA INSTITUCIÓN
// ─────────────────────────────────────────────────────────────────────────────
const EMPLEADOR = {
  razonSocial: 'A.C.D.P.S DYPS',
  cuit:        '30-71021062-0',
  cuitRaw:     '30710210620',
  direccion:   'ESPAÑA 843 (2000) - ROSARIO - SANTA FE',
};

// ─────────────────────────────────────────────────────────────────────────────
// TABLAS DE REFERENCIA ARCA/AFIP
// (Clave = código de 4 dígitos → primeros 4 chars del código de 6 dígitos)
// ─────────────────────────────────────────────────────────────────────────────
const CATEGORIA_ARCA = {
  '0004':'110000','0014':'110000','0024':'110000','0025':'110000',
  '0026':'110000','0027':'110000','0028':'110000','0029':'110000',
  '0032':'110000','0033':'110000','0038':'110000','0039':'110000',
  '0046':'110000','0047':'110000','0048':'110000','0054':'110000',
  '0059':'110000','0074':'110000',
  '0201':'170001','0224':'160001',
  '0034':'550000','0035':'550000','0036':'550000','0037':'550000',
  '0055':'550000','0057':'550000','0061':'550000','0062':'550000',
  '0100':'550000','0115':'550000',
  '0300':'810000','0302':'810001','0307':'810002','0310':'810002',
  '0315':'810002','0322':'810004','0323':'810004',
  '0800':'799999','0988':'810015',
};

// Categorías que cuentan como remunerativo para bases del F931
const CATS_REMUNERATIVAS = new Set(['110000', '160001', '170001']);

// ─────────────────────────────────────────────────────────────────────────────
// OPENAI (singleton lazy)
// ─────────────────────────────────────────────────────────────────────────────
let _openai;
const getOpenAI = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

// ─────────────────────────────────────────────────────────────────────────────
// HANDLER PRINCIPAL
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS siempre primero
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Método no permitido' });

  // ── Verificación de sesión ──────────────────────────────────────────────────
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!token) {
    return res.status(401).json({ error: 'Sesión requerida. Por favor iniciá sesión.' });
  }
  if (!process.env.SUPABASE_JWT_SECRET) {
    return res.status(500).json({ error: 'Configuración del servidor incompleta (SUPABASE_JWT_SECRET)' });
  }
  try {
    const secret = new TextEncoder().encode(process.env.SUPABASE_JWT_SECRET);
    await jwtVerify(token, secret, { algorithms: ['HS256'] });
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada. Por favor iniciá sesión nuevamente.' });
  }
  // ───────────────────────────────────────────────────────────────────────────

  const { utedyc, porteros, maestros } = req.body || {};

  if (!utedyc && !porteros && !maestros) {
    return res.status(400).json({ error: 'Se requiere al menos un archivo CSV' });
  }

  const totalLen = (utedyc?.length || 0) + (porteros?.length || 0) + (maestros?.length || 0);
  if (totalLen > 200_000) {
    return res.status(413).json({ error: 'Archivos demasiado grandes (máx. 200 KB total)' });
  }

  try {
    const tareas = [];
    if (utedyc)   tareas.push(procesarCSV('utedyc',   utedyc));
    if (porteros) tareas.push(procesarCSV('porteros', porteros));
    if (maestros) tareas.push(procesarCSV('maestros', maestros));

    const resultados = await Promise.all(tareas);
    let empleados = resultados.flat();

    if (!empleados.length) {
      return res.status(422).json({ error: 'No se encontraron empleados en los archivos enviados' });
    }

    empleados = empleados.map(calcularTotales);

    return res.status(200).json({ empleados, empleador: EMPLEADOR });

  } catch (err) {
    console.error('[procesar]', err.message);
    return res.status(500).json({ error: 'Error al procesar: ' + err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LLAMADA A OPENAI
// ─────────────────────────────────────────────────────────────────────────────
async function procesarCSV(tipo, csvText) {
  const ai = getOpenAI();

  const completion = await ai.chat.completions.create({
    model:           'gpt-4o-mini',
    temperature:     0,
    response_format: { type: 'json_object' },
    max_tokens:      4096,
    messages: [
      { role: 'system', content: buildSystemPrompt(tipo) },
      { role: 'user',   content: `Datos del CSV ${tipo.toUpperCase()}:\n\n${csvText}` },
    ],
  });

  let data;
  try {
    data = JSON.parse(completion.choices[0].message.content);
  } catch {
    throw new Error(`La IA devolvió JSON inválido para el CSV de tipo "${tipo}"`);
  }

  return (data.empleados || []).map(emp => ({ ...emp, tipo }));
}

// ─────────────────────────────────────────────────────────────────────────────
// SYSTEM PROMPTS
// ─────────────────────────────────────────────────────────────────────────────
function buildSystemPrompt(tipo) {
  const base = `Eres un extractor de datos contables de planillas de sueldo argentinas para el colegio A.C.D.P.S DYPS.

REGLAS ABSOLUTAS — incumplirlas invalida el resultado:
1. NO hagas ningún cálculo matemático. Extrae SOLO lo que ves literalmente.
2. Si un concepto tiene importe 0 o celda vacía, NO lo incluyas.
3. CÓDIGOS: siempre 6 dígitos. Si el dato tiene 4 dígitos (ej: 0014), añade "00" al final → "001400". Si tiene 2 dígitos, completa hasta 6 con ceros a la izquierda.
4. IMPORTES: número decimal exacto sin signo $, sin puntos de miles, sin comas de miles. Ej correcto: 679727.00 — Ej incorrecto: "679.727,00" o "$679.727".
5. PERÍODO: formato "MM/YYYY". Ej: "04/2026" para abril 2026.
6. CUIL: exactamente 11 dígitos, sin guiones ni espacios.
7. NOMBRES de empleados: en MAYÚSCULAS, formato "APELLIDO NOMBRE".
8. DESCRIPCIONES de conceptos: en MAYÚSCULAS tal como aparecen.

CÓDIGOS DE REFERENCIA MÁS COMUNES:
Haberes remunerativos: 001400=5-BÁSICO, 002400=370-SUPL.PLAN, 002500=372-ASIG.ESP.REM.NO, 002600=407-ADICIONAL, 002700=409-FUNCION, 002800=410-ASIG-REM-NO, 002900=412-AS.REM.NO BONIF, 003200=421-SUPL.REM.NO, 003300=422-ASIG.ESP.REM, 003800=190-ANTIGUEDAD, 003900=387-ESTADO DOCENTE, 004600=388-COMPLEM.AL BÁSICO, 004700=395-RECON.FUNC.DOCENTE, 004800=408-ADICIONAL, 005400=418-SUPL.REM.TRANSIT., 005900=388-1/389, 007400=405-SUPL.REM.NO, 020100=PRESENTISMO, 022400=ANTIGÜEDAD UTEDYC
Haberes no remunerativos: 003400=456-ASIG.NO REM.NO, 003500=470-PRESENTISMO D.2670/92, 003600=513-ASIG.NO REM NO, 003700=546-ASNRNB 2021 D.2172/21, 005500=480-ACT.ESPEF.DOCENTE, 005700=455-MATERIAL DIDACTICO, 006100=GARANTIA, 006200=FOPCID, 010000=CONEC NACIONAL, 011500=CONEC NACIONAL 2
Descuentos: 030000=JUBILACION, 030200=LEY 19032, 030700=O.SOC. JORNADA REDUCIDA, 031000=OBRA SOCIAL, 031500=OBRA SOCIAL, 032200=APORTE SOLIDARIO, 032300=CUOTA GREMIAL, 098800=JUB.CAJA

FORMATO DE RESPUESTA JSON estricto (sin comentarios, sin campos extra):
{
  "empleados": [
    {
      "nombre": "APELLIDO NOMBRE",
      "cuil": "27293973232",
      "legajo": "001",
      "funcion": "ADM DE 1°",
      "fechaIngreso": "01/10/2015",
      "periodo": "04/2026",
      "conceptos": [
        { "codigo": "001400", "descripcion": "5-BÁSICO", "importe": 679727.00 },
        { "codigo": "030000", "descripcion": "JUBILACION", "importe": 74870.00 }
      ]
    }
  ]
}
NOTA: legajo y fechaIngreso pueden ser null si no se encuentran en los datos.`;

  const hints = {
    utedyc: `

CONTEXTO — CSV UTEDYC:
Este CSV tiene UN SOLO empleado (personal UTEDYC) en formato VERTICAL tipo ficha.
- El CUIL aparece en una celda con etiqueta "CUIL", "C.U.I.L." o similar, en las primeras filas.
- El nombre está en una fila con etiqueta "Apellido y Nombre", "Nombre" o similar.
- Los conceptos están en filas sucesivas: columna con código/descripción e importe al lado.
- Haberes (códigos < 030000) aparecen primero; descuentos (030000–079999) después.
- Puede haber columnas de porcentaje o días — ignóralas, solo extrae el importe final.`,

    porteros: `

CONTEXTO — CSV PORTEROS:
Este CSV tiene UN SOLO empleado (personal de maestranza/portería).
- Formato vertical tipo ficha, similar a UTEDYC.
- Puede estar transpuesto: conceptos en columnas, empleado en fila. En ese caso, los encabezados de columna son los conceptos y la fila de datos contiene los importes.
- Busca CUIL, nombre, cargo/función y período en las primeras celdas o filas.`,

    maestros: `

CONTEXTO — CSV MAESTROS/DIRECTORES:
Este CSV tiene MÚLTIPLES empleados (aprox. 4–6), formato TABULAR HORIZONTAL — un empleado por fila.
- Las PRIMERAS FILAS son encabezados: cada columna corresponde a un concepto o dato del empleado.
- Los encabezados de concepto suelen ser códigos de 4 dígitos (ej: "0014") — convertirlos a 6 (→ "001400").
- Las filas de datos contienen: nombre, CUIL, legajo, cargo, fecha de ingreso, período, y luego los importes de cada concepto columna por columna.
- El período puede estar en los encabezados o en la primera columna de cada fila.
- Si una celda de importe está vacía o es 0, NO incluyas ese concepto para ese empleado.
- RETORNA TODOS los empleados que encuentres (pueden ser 4, 5 o 6).`,
  };

  return base + (hints[tipo] || '');
}

// ─────────────────────────────────────────────────────────────────────────────
// CLASIFICACIÓN DE CÓDIGOS
// ─────────────────────────────────────────────────────────────────────────────
function clasificarCodigo(codigo6) {
  const n = parseInt(codigo6, 10);
  if (codigo6 === '080000') return 'C'; // redondeo = haber especial
  if (n < 30000)            return 'C'; // haberes/créditos
  if (n <= 79999)           return 'D'; // descuentos/retenciones
  return 'C';                           // >= 80000: otros especiales = haber
}

// ─────────────────────────────────────────────────────────────────────────────
// ARITMÉTICA ENTERA + AJUSTE DE REDONDEO
// ─────────────────────────────────────────────────────────────────────────────
function calcularTotales(emp) {
  let haberesCents    = 0;
  let descuentosCents = 0;
  let remCents        = 0;
  let noRemCents      = 0;

  const conceptos = (emp.conceptos || [])
    .map(c => {
      // Normalizar código a 6 dígitos
      const codigo6   = String(c.codigo || '000000').replace(/\D/g, '').padStart(6, '0');
      const codigo4   = codigo6.slice(0, 4);
      const tipo      = clasificarCodigo(codigo6);

      // Parsear importe defensivamente (maneja "679.727,00", "679727.00", 679727)
      const raw     = String(c.importe ?? 0)
        .replace(/[$\s]/g, '')
        .replace(/\.(?=\d{3}(?:[.,]|$))/g, '') // quitar punto de miles si aplica
        .replace(',', '.');
      const importe = parseFloat(raw) || 0;
      const cents   = Math.round(Math.abs(importe) * 100);

      const categoria = CATEGORIA_ARCA[codigo4] || (tipo === 'C' ? '110000' : '810000');

      if (tipo === 'C') {
        haberesCents += cents;
        if (CATS_REMUNERATIVAS.has(categoria)) remCents   += cents;
        else                                    noRemCents += cents;
      } else {
        descuentosCents += cents;
      }

      return { ...c, codigo: codigo6, tipo, importeCents: cents, importe: cents / 100, categoria };
    })
    .filter(c => c.importeCents > 0);

  // Ajuste de redondeo: neto debe ser pesos enteros (sin centavos)
  // Si neto = $680,407.73 → centavosRem = 73 → ajuste = 27 centavos como haber
  // Nuevo neto = $680,407.73 + $0.27 = $680,408.00 ✓
  let netoCents     = haberesCents - descuentosCents;
  const centavosRem = netoCents % 100;

  if (centavosRem !== 0) {
    const ajuste = 100 - centavosRem;
    haberesCents += ajuste;
    remCents     += ajuste; // redondeo cuenta como remunerativo
    netoCents    += ajuste;
    conceptos.push({
      codigo:      '080000',
      descripcion: 'DIFERENCIA REDONDEO',
      tipo:        'C',
      importeCents: ajuste,
      importe:     ajuste / 100,
      categoria:   '799999',
    });
  }

  return {
    ...emp,
    conceptos,
    totalHaberes:        haberesCents    / 100,
    totalDescuentos:     descuentosCents / 100,
    totalRemunerativo:   remCents        / 100,
    totalNoRemunerativo: noRemCents      / 100,
    neto:                netoCents       / 100,
  };
}
