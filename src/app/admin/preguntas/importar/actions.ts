'use server'

import { revalidatePath } from 'next/cache'

import { requireAdmin } from '@/lib/auth/require'
import { db } from '@/lib/db'
import { parseQuestions, type ParseResult, type ParsedQuestion } from '@/lib/import/parse-questions'
import { persistQuestions } from '@/lib/import/persist-questions'
import { readQuestionRows, WorkbookFormatError } from '@/lib/import/read-workbook'
import type { Area } from '@/lib/scoring'
import { MAX_BYTES as UPLOAD_MAX_BYTES, MAX_MB } from '@/lib/upload-limits'

export type PreviewState = { result: ParseResult | null; error: string | null }

// Mismo tope que las imágenes: por encima de esto la petición ni llega al
// servidor (Vercel corta el cuerpo en 4.5 MB). Un banco de preguntas cabe de
// sobra: el Excel del cliente, con 66 preguntas, pesa menos de 100 KB.
const MAX_BYTES = UPLOAD_MAX_BYTES

async function loadCompetencies(): Promise<Array<{ area: Area; name: string }>> {
  const rows = await db.competency.findMany({ select: { area: true, name: true } })
  return rows.map((r) => ({ area: r.area as Area, name: r.name }))
}

/** Paso 1: subir el Excel y ver la vista previa. No escribe nada en la base. */
export async function previewImportAction(
  _prev: PreviewState,
  formData: FormData,
): Promise<PreviewState> {
  await requireAdmin()

  const file = formData.get('file')
  if (!(file instanceof File) || file.size === 0) {
    return { result: null, error: 'Elige un archivo Excel (.xlsx).' }
  }
  if (file.size > MAX_BYTES) {
    return { result: null, error: `El archivo es demasiado grande (máximo ${MAX_MB} MB).` }
  }
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    return { result: null, error: 'El archivo debe ser .xlsx. Guárdelo como Excel, no como CSV.' }
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer())
    const rows = await readQuestionRows(buffer)
    const result = parseQuestions(rows, await loadCompetencies())

    // Avisar si un id_contexto ya existe con OTRO texto (típico al subir la
    // sesión 2 reusando un id de la sesión 1): si no se avisa, esas preguntas
    // terminarían mostrando el texto viejo.
    await warnAboutContextConflicts(result)

    // Avisar de las imágenes que el Excel menciona pero que aún no se han
    // subido. Mejor enterarse ahora que cuando un estudiante abra la pregunta y
    // no vea la gráfica. (Reordena y recuenta las advertencias al final.)
    await warnAboutMissingImages(result)

    return { result, error: null }
  } catch (error) {
    if (error instanceof WorkbookFormatError) return { result: null, error: error.message }
    return { result: null, error: 'No se pudo leer el archivo. ¿Está usando la plantilla de SORA?' }
  }
}

/**
 * Un id_contexto que ya existe en la plataforma con un texto DISTINTO al que
 * trae este archivo. Pasa sobre todo al subir la segunda sesión reusando ids de
 * la primera: el importador reaprovecha el contexto que ya existe, así que las
 * preguntas nuevas mostrarían el texto viejo. Mejor avisar y que use un id
 * nuevo.
 */
async function warnAboutContextConflicts(result: ParseResult): Promise<void> {
  const collapse = (t: string) => t.replace(/\s+/g, ' ').trim()

  // El texto de cada contexto que este archivo define, por su id.
  const defined = new Map<string, { text: string; rowNumber: number }>()
  for (const q of result.questions) {
    if (q.contextKey && q.contextText && !defined.has(q.contextKey)) {
      defined.set(q.contextKey, { text: collapse(q.contextText), rowNumber: q.rowNumber })
    }
  }
  if (defined.size === 0) return

  const existing = await db.context.findMany({
    where: { externalId: { in: [...defined.keys()] } },
    select: { externalId: true, text: true },
  })

  for (const e of existing) {
    const here = defined.get(e.externalId!)
    if (here && collapse(e.text) !== here.text) {
      result.issues.push({
        rowNumber: here.rowNumber,
        column: 'id_contexto',
        severity: 'warning',
        message:
          `El id_contexto "${e.externalId}" ya existe en la plataforma con OTRO texto. ` +
          'Si esta es una lectura distinta (por ejemplo, de la segunda sesión), usa un id NUEVO ' +
          `(como "${e.externalId}B"): de lo contrario estas preguntas mostrarían el texto anterior.`,
      })
    }
  }
}

async function warnAboutMissingImages(result: ParseResult): Promise<void> {
  // Todas las imágenes que menciona el archivo: la del enunciado y las de las opciones.
  const names = [
    ...new Set(
      result.questions
        .flatMap((q) => [q.imageName, ...Object.values(q.optionImages)])
        .filter((n): n is string => !!n),
    ),
  ]
  if (names.length === 0) return

  const uploaded = await db.upload.findMany({
    where: { filename: { in: names } },
    select: { filename: true },
  })
  const have = new Set(uploaded.map((u) => u.filename))

  const warnMissing = (rowNumber: number, name: string, dónde: string) => {
    result.issues.push({
      rowNumber,
      column: 'imagen',
      severity: 'warning',
      message:
        `La imagen "${name}" (${dónde}) todavía no está subida. La pregunta se carga igual, ` +
        'pero el estudiante no la verá hasta que la subas en Imágenes con ese mismo nombre.',
    })
  }

  for (const q of result.questions) {
    if (q.imageName && !have.has(q.imageName)) warnMissing(q.rowNumber, q.imageName, 'del enunciado')
    for (const key of ['A', 'B', 'C', 'D'] as const) {
      const name = q.optionImages[key]
      if (name && !have.has(name)) warnMissing(q.rowNumber, name, `opción ${key}`)
    }
  }

  result.issues.sort((a, b) => a.rowNumber - b.rowNumber)
  result.summary.withWarnings = new Set(
    result.issues.filter((i) => i.severity === 'warning').map((i) => i.rowNumber),
  ).size
}

export type CommitState = {
  ok: boolean
  error: string | null
  summary: { questions: number; contexts: number; assessments: string[] } | null
}

/**
 * Paso 2: confirmar. Recibe las preguntas válidas que la vista previa mostró y
 * las guarda. Se re-validan contra la base antes de escribir: nunca se confía
 * en el JSON que llega del navegador.
 */
export async function commitImportAction(
  _prev: CommitState,
  formData: FormData,
): Promise<CommitState> {
  await requireAdmin()

  const payload = formData.get('questions')
  if (typeof payload !== 'string') {
    return { ok: false, error: 'No hay preguntas para cargar.', summary: null }
  }

  let candidates: ParsedQuestion[]
  try {
    candidates = JSON.parse(payload) as ParsedQuestion[]
  } catch {
    return { ok: false, error: 'Los datos de la carga llegaron dañados. Vuelva a subir el archivo.', summary: null }
  }

  // Destino elegido en la pantalla: si el admin escribió un nombre, TODAS las
  // preguntas van a ese simulacro (se crea si es nuevo, se agrega si ya existe),
  // sin importar lo que diga la columna del Excel. Así decide desde la interfaz
  // si crea otro o amplía uno, y no se sobreescribe por accidente.
  const targetRaw = formData.get('targetSimulacro')
  const target = typeof targetRaw === 'string' ? targetRaw.trim() : ''

  // Re-validación: se reconstruyen filas crudas desde el candidato y se pasan
  // por el mismo validador. Así una manipulación del JSON no mete basura.
  const rebuilt = candidates.map((q, index) => ({
    rowNumber: q.rowNumber ?? index + 2,
    area: labelForArea(q.area),
    competencia: q.competencia,
    // El destino de la pantalla manda sobre la columna del Excel.
    simulacro: target || q.simulacro || '',
    taller: target ? '' : (q.taller ?? ''),
    id_contexto: q.contextKey ?? '',
    contexto: q.contextText ?? '',
    enunciado: q.stem,
    opcion_a: q.options?.A,
    opcion_b: q.options?.B,
    opcion_c: q.options?.C,
    opcion_d: q.options?.D,
    opcion_e: q.options?.E ?? '',
    opcion_f: q.options?.F ?? '',
    opcion_g: q.options?.G ?? '',
    opcion_h: q.options?.H ?? '',
    imagen_a: q.optionImages?.A ?? '',
    imagen_b: q.optionImages?.B ?? '',
    imagen_c: q.optionImages?.C ?? '',
    imagen_d: q.optionImages?.D ?? '',
    imagen_e: q.optionImages?.E ?? '',
    imagen_f: q.optionImages?.F ?? '',
    imagen_g: q.optionImages?.G ?? '',
    imagen_h: q.optionImages?.H ?? '',
    respuesta_correcta: q.correctOption,
    peso: q.weight,
    parte: q.part,
    // Sin esto, el nombre de la imagen se perdía al confirmar la carga y las
    // preguntas quedaban sin su gráfica.
    imagen: q.imageName ?? '',
    explicacion: q.explanation ?? '',
  }))

  const revalidated = parseQuestions(rebuilt, await loadCompetencies())
  if (revalidated.questions.length === 0) {
    return { ok: false, error: 'No quedaron preguntas válidas para cargar.', summary: null }
  }

  const result = await persistQuestions(revalidated.questions)
  revalidatePath('/admin')

  return {
    ok: true,
    error: null,
    summary: {
      questions: result.questionsCreated,
      contexts: result.contextsCreated,
      assessments: result.assessmentsTouched,
    },
  }
}

const AREA_LABEL: Record<Area, string> = {
  LECTURA_CRITICA: 'Lectura Crítica',
  MATEMATICAS: 'Matemáticas',
  SOCIALES_CIUDADANAS: 'Sociales y Ciudadanas',
  CIENCIAS_NATURALES: 'Ciencias Naturales',
  INGLES: 'Inglés',
}
function labelForArea(area: Area): string {
  return AREA_LABEL[area] ?? area
}
