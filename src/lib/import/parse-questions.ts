/**
 * Validación del Excel de preguntas — SORA PREICFES
 *
 * Las preguntas del cliente vienen de un OCR sobre documentos de Word y Excel.
 * El OCR deja errores: tildes rotas, ceros donde iban letras, opciones vacías.
 * Si esas preguntas entran a la plataforma sin revisar, el estudiante ve una
 * pregunta rota en pleno simulacro.
 *
 * Este módulo no importa nada: solo lee, valida y reporta. La carga real solo
 * ocurre después de que el administrador revisa la vista previa y confirma.
 *
 * Puro: sin base de datos, sin exceljs. El lector de Excel vive en read-workbook.ts
 * y le entrega filas ya normalizadas.
 */

import { AREAS, type Area } from '../scoring'

// Hasta 8 opciones: A-D es lo normal, pero el emparejamiento del ICFES de inglés
// llega a 8 (A-H). Una pregunta usa un rango contiguo desde A (A-D, A-H, o A-B…).
export const OPTIONS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const
export type OptionKey = (typeof OPTIONS)[number]

/** Los nombres de área tal como aparecen en la plantilla que usa el cliente. */
const AREA_BY_LABEL: Record<string, Area> = {
  'lectura critica': 'LECTURA_CRITICA',
  matematicas: 'MATEMATICAS',
  'sociales y ciudadanas': 'SOCIALES_CIUDADANAS',
  'ciencias naturales': 'CIENCIAS_NATURALES',
  ingles: 'INGLES',
}

/** Una fila cruda del Excel: todo string, tal como la escribió el administrador. */
export type RawRow = {
  /** Número de fila en el Excel, para que el administrador sepa dónde corregir. */
  rowNumber: number
  area?: string
  competencia?: string
  simulacro?: string
  taller?: string
  id_contexto?: string
  contexto?: string
  enunciado?: string
  opcion_a?: string
  opcion_b?: string
  opcion_c?: string
  opcion_d?: string
  /** Opciones extra E-H, para las preguntas de emparejamiento de inglés. */
  opcion_e?: string
  opcion_f?: string
  opcion_g?: string
  opcion_h?: string
  /** Nombre del archivo de imagen de cada opción, cuando la opción es una tabla/gráfica. */
  imagen_a?: string
  imagen_b?: string
  imagen_c?: string
  imagen_d?: string
  imagen_e?: string
  imagen_f?: string
  imagen_g?: string
  imagen_h?: string
  respuesta_correcta?: string
  peso?: string | number
  parte?: string | number
  imagen?: string
  explicacion?: string
}

export type IssueSeverity = 'error' | 'warning'

export type Issue = {
  rowNumber: number
  /** Columna del Excel donde está el problema, si aplica. */
  column?: keyof RawRow
  severity: IssueSeverity
  message: string
}

export type ParsedQuestion = {
  rowNumber: number
  area: Area
  competencia: string
  simulacro: string | null
  taller: string | null
  contextKey: string | null
  contextText: string | null
  stem: string
  options: Record<OptionKey, string>
  /** Nombre del archivo de imagen de cada opción, si la opción es una imagen. */
  optionImages: Record<OptionKey, string | null>
  correctOption: OptionKey
  weight: number
  /** La parte del simulacro (1 o 2). Vacía en el Excel = 1. */
  part: number
  imageName: string | null
  explanation: string | null
}

export type ParseResult = {
  /** Filas que pasaron todas las validaciones bloqueantes. */
  questions: ParsedQuestion[]
  /** Todos los hallazgos, de error y de advertencia, en orden de fila. */
  issues: Issue[]
  /** Resumen para la vista previa. */
  summary: {
    totalRows: number
    valid: number
    withErrors: number
    withWarnings: number
  }
}

// ---------------------------------------------------------------------------
// Detección de basura del OCR
// ---------------------------------------------------------------------------

/** Mojibake: UTF-8 leído como Latin-1. "función" -> "funciÃ³n" */
const MOJIBAKE = /[\u00C3\u00C2][\u0080-\u00BF]/
/** El carácter de reemplazo que deja un decodificador cuando no entiende un byte. */
const REPLACEMENT_CHAR = /\uFFFD/
/** Un dígito en medio de letras: "H0LA", "so1uci0n". El OCR confunde O/0 y l/1. */
const DIGIT_INSIDE_WORD = /\p{L}[01]\p{L}/u
/** Caracteres de control que no deberían existir en texto escrito a mano. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/

/**
 * Señales de que el OCR probablemente se equivocó. No bloquean la carga:
 * marcan la fila para que el administrador la mire en la vista previa.
 */
export function detectOcrNoise(text: string): string[] {
  const found: string[] = []
  if (MOJIBAKE.test(text)) found.push('las tildes o eñes se ven corruptas (parece un problema de codificación)')
  if (REPLACEMENT_CHAR.test(text)) found.push('hay caracteres que no se pudieron leer')
  if (DIGIT_INSIDE_WORD.test(text)) found.push('hay un 0 o un 1 en medio de una palabra (el OCR suele confundir O/0 y l/1)')
  if (CONTROL_CHARS.test(text)) found.push('hay caracteres invisibles')
  return found
}

// ---------------------------------------------------------------------------
// Normalización
// ---------------------------------------------------------------------------

/**
 * Une las palabras que el OCR partió con un guion al final del renglón.
 *
 * Los textos vienen de documentos maquetados a dos columnas, donde las palabras
 * se cortan: "corres-\nponde". Si no se unen, el estudiante lee
 * "corres- ponde" en pleno simulacro.
 *
 * Solo se unen cuando el guion queda al final de línea entre dos minúsculas,
 * que es la firma del corte tipográfico. Un guion legítimo entre palabras
 * ("teórico-práctico") se escribe seguido, sin salto, y no se toca.
 */
export function joinHyphenated(text: string): string {
  return text.replace(/(\p{Ll})-[ \t]*\r?\n[ \t]*(\p{Ll})/gu, '$1$2')
}

const clean = (value: unknown): string =>
  typeof value === 'string' || typeof value === 'number'
    ? joinHyphenated(String(value)).replace(/\s+/g, ' ').trim()
    : ''

/**
 * Como `clean`, pero conservando los párrafos.
 *
 * Los textos de contexto son lecturas de varios párrafos, con su título y su
 * fuente. Aplastarlos en una sola línea los volvía un ladrillo ilegible. Aquí se
 * unen los renglones dentro de cada párrafo (el OCR corta las líneas donde
 * terminaba la columna, no donde termina la frase) y se conservan los saltos
 * entre párrafos.
 */
/**
 * El identificador de un contexto compartido, normalizado.
 *
 * "CTX 8" y "CTX8" son lo mismo, y "ctx8" también. Un espacio de más al escribir
 * el id en una fila y no en otra no puede romper la carga: es justo lo que pasó
 * con el archivo del cliente, donde cinco preguntas quedaron huérfanas de su
 * lectura por un espacio.
 */
export function normalizeContextKey(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const key = String(value).replace(/\s+/g, '').toUpperCase().trim()
  return key || null
}

export function cleanParagraphs(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return ''

  return joinHyphenated(String(value))
    .replace(/\r\n/g, '\n')
    // Dos o más saltos separan párrafos: se marcan para no perderlos.
    .split(/\n\s*\n+/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
}

/** Minúsculas y sin tildes, para comparar contra las tablas de área y dificultad. */
const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()

/**
 * Palabras vacías que no distinguen una competencia de otra. Se descartan al
 * comparar nombres.
 */
const STOPWORDS = new Set([
  'a', 'al', 'de', 'del', 'e', 'el', 'en', 'la', 'las', 'lo', 'los', 'para',
  'por', 'que', 'se', 'su', 'sus', 'un', 'una', 'y',
])

/** Las palabras significativas de un nombre de competencia, sin puntuación. */
function competencyTokens(name: string): Set<string> {
  return new Set(
    fold(name)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((word) => word && !STOPWORDS.has(word)),
  )
}

const isSubset = (small: Set<string>, big: Set<string>) =>
  small.size > 0 && [...small].every((word) => big.has(word))

/**
 * Encuentra la competencia del área que corresponde al nombre escrito.
 *
 * El ICFES usa nombres oficiales largos ("Identificar y entender los contenidos
 * locales que conforman un texto.") que la gente escribe abreviados
 * ("Identificar y entender contenidos locales"). Un cotejo literal rechazaría
 * media plantilla, así que:
 *
 *  1. Coincidencia exacta por palabras significativas (sin tildes ni puntuación).
 *  2. Si no la hay, se acepta cuando las palabras de uno están contenidas en las
 *     del otro y eso ocurre con UNA sola competencia del área. Si encaja con
 *     varias es ambiguo, y se rechaza.
 */
function matchCompetency(
  written: string,
  candidates: string[],
): { name: string; exact: boolean } | null {
  const writtenTokens = competencyTokens(written)
  const writtenKey = [...writtenTokens].sort().join(' ')

  for (const candidate of candidates) {
    const key = [...competencyTokens(candidate)].sort().join(' ')
    if (key === writtenKey) return { name: candidate, exact: true }
  }

  const loose = candidates.filter((candidate) => {
    const tokens = competencyTokens(candidate)
    return isSubset(writtenTokens, tokens) || isSubset(tokens, writtenTokens)
  })

  return loose.length === 1 ? { name: loose[0]!, exact: false } : null
}

// ---------------------------------------------------------------------------
// Validación de una fila
// ---------------------------------------------------------------------------

function parseRow(
  raw: RawRow,
  competenciesByArea: Record<Area, string[]>,
  issues: Issue[],
): ParsedQuestion | null {
  const at = (severity: IssueSeverity, message: string, column?: keyof RawRow) =>
    issues.push({ rowNumber: raw.rowNumber, column, severity, message })

  let blocked = false
  const block = (message: string, column?: keyof RawRow) => {
    at('error', message, column)
    blocked = true
  }

  // --- Área ---
  const areaRaw = clean(raw.area)
  const area = AREA_BY_LABEL[fold(areaRaw)]
  if (!areaRaw) block('Falta el área.', 'area')
  else if (!area) block(`Área desconocida: "${areaRaw}". Use una de la lista desplegable.`, 'area')

  // --- Competencia ---
  // Se guarda el nombre canónico de la base, no el que escribió el administrador:
  // así una abreviatura queda registrada como la competencia oficial.
  const competenciaRaw = clean(raw.competencia)
  let competencia = competenciaRaw
  if (!competenciaRaw) block('Falta la competencia.', 'competencia')
  else if (area) {
    const match = matchCompetency(competenciaRaw, competenciesByArea[area])
    if (!match) {
      block(`La competencia "${competenciaRaw}" no pertenece al área "${areaRaw}".`, 'competencia')
    } else {
      competencia = match.name
      if (!match.exact) {
        at(
          'warning',
          `La competencia se escribió como "${competenciaRaw}"; se registrará como "${match.name}".`,
          'competencia',
        )
      }
    }
  }

  // --- Simulacro / taller: una pregunta pertenece a uno, no a los dos ---
  const simulacro = clean(raw.simulacro) || null
  const taller = clean(raw.taller) || null
  if (simulacro && taller) {
    block('Una pregunta no puede pertenecer a un simulacro y a un taller a la vez.', 'simulacro')
  }

  // --- Enunciado ---
  // El enunciado puede ir vacío: en las preguntas de completar un texto (cloze)
  // el "espacio" ES la pregunta, y la lectura va en el contexto. No se bloquea,
  // solo se avisa, por si de verdad se le olvidó.
  const stem = clean(raw.enunciado)
  if (!stem) at('warning', 'Esta pregunta no tiene enunciado. Solo déjalo así si es de completar un texto (cloze); si no, escríbelo.', 'enunciado')
  else if (stem.length < 10) at('warning', 'El enunciado es muy corto. ¿Quedó cortado por el OCR?', 'enunciado')

  // --- Opciones (texto o imagen, de A hasta H) ---
  // Una opción vale si trae texto O una imagen (hay opciones que son tablas o
  // gráficas). La pregunta usa un rango CONTIGUO desde A hasta la última opción
  // presente: 4 (A-D) para lo normal, hasta 8 (A-H) para el emparejamiento de
  // inglés. Un hueco (p. ej. C vacía con D llena) es un error.
  const options = {} as Record<OptionKey, string>
  const optionImages = {} as Record<OptionKey, string | null>
  const present: boolean[] = []
  for (const key of OPTIONS) {
    const lower = key.toLowerCase()
    const text = clean(raw[`opcion_${lower}` as keyof RawRow])
    const image = clean(raw[`imagen_${lower}` as keyof RawRow]) || null
    options[key] = text
    optionImages[key] = image
    present.push(Boolean(text || image))
  }

  const lastPresent = present.lastIndexOf(true)
  // Las opciones activas de esta pregunta: de A hasta la última presente.
  const active = lastPresent >= 0 ? OPTIONS.slice(0, lastPresent + 1) : []
  if (active.length < 2) {
    block('La pregunta necesita al menos las opciones A y B.', 'opcion_a')
  } else {
    for (let i = 0; i <= lastPresent; i++) {
      if (!present[i]) block(`Falta la opción ${OPTIONS[i]} (ni texto ni imagen).`, `opcion_${OPTIONS[i]!.toLowerCase()}` as keyof RawRow)
    }
  }

  // Opciones idénticas: solo tiene sentido comparar las de texto entre las activas.
  const filledText = active.filter((k) => options[k])
  const distinct = new Set(filledText.map((k) => fold(options[k])))
  if (filledText.length >= 2 && distinct.size < filledText.length) {
    at('warning', 'Hay dos o más opciones de respuesta idénticas.', 'opcion_a')
  }

  // --- Respuesta correcta: una de las opciones activas ---
  const correctRaw = clean(raw.respuesta_correcta).toUpperCase()
  const correctOption = OPTIONS.find((k) => k === correctRaw)
  const lastLetter = active.length ? active[active.length - 1] : 'D'
  if (!correctRaw) block('Falta la respuesta correcta.', 'respuesta_correcta')
  else if (!correctOption) block(`La respuesta correcta debe ser una letra de A a ${lastLetter}. Se encontró "${correctRaw}".`, 'respuesta_correcta')
  else if (active.length >= 2 && !active.includes(correctOption)) {
    block(`La respuesta correcta es "${correctRaw}", pero esa opción no existe en la pregunta (va de A a ${lastLetter}).`, 'respuesta_correcta')
  }

  // --- Peso (opcional, por defecto 1) ---
  const pesoRaw = clean(raw.peso)
  let weight = 1
  if (pesoRaw) {
    const parsed = Number(pesoRaw)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10) {
      at('warning', `Peso inválido: "${pesoRaw}". Debe ser un entero entre 1 y 10. Se usará 1.`, 'peso')
    } else {
      weight = parsed
    }
  }

  // --- Parte (opcional, por defecto 1). Solo aplica a simulacros en dos partes. ---
  const parteRaw = clean(raw.parte)
  let part = 1
  if (parteRaw) {
    const parsed = Number(parteRaw)
    if (parsed !== 1 && parsed !== 2) {
      at('warning', `Parte inválida: "${parteRaw}". Solo puede ser 1 o 2. Se usará 1.`, 'parte')
    } else {
      part = parsed
    }
  }

  // --- Contexto compartido ---
  const contextKey = normalizeContextKey(raw.id_contexto)
  // El contexto conserva sus párrafos: es una lectura, no una línea suelta.
  const contextText = cleanParagraphs(raw.contexto) || null
  if (contextText && !contextKey) {
    block('Escribió un contexto pero no le puso un id_contexto.', 'id_contexto')
  }

  // --- Ruido del OCR: revisa todo el texto visible de la fila ---
  const visibleText = [stem, contextText ?? '', ...OPTIONS.map((k) => options[k]), clean(raw.explicacion)]
    .filter(Boolean)
    .join(' ')
  for (const noise of detectOcrNoise(visibleText)) {
    at('warning', `Revise el texto: ${noise}.`)
  }

  if (blocked || !area || !correctOption) return null

  return {
    rowNumber: raw.rowNumber,
    area,
    competencia,
    simulacro,
    taller,
    contextKey,
    contextText,
    stem,
    options,
    optionImages,
    correctOption,
    weight,
    part,
    imageName: clean(raw.imagen) || null,
    explanation: clean(raw.explicacion) || null,
  }
}

// ---------------------------------------------------------------------------
// Validación del archivo completo
// ---------------------------------------------------------------------------

/**
 * @param rows           filas del Excel, ya leídas
 * @param competencies   competencias válidas por área, tal como están en la base
 */
export function parseQuestions(
  rows: RawRow[],
  competencies: Array<{ area: Area; name: string }>,
): ParseResult {
  const competenciesByArea = Object.fromEntries(
    AREAS.map((a) => [a, [] as string[]]),
  ) as Record<Area, string[]>
  for (const { area, name } of competencies) competenciesByArea[area].push(name)

  const issues: Issue[] = []
  const questions: ParsedQuestion[] = []

  for (const row of rows) {
    const parsed = parseRow(row, competenciesByArea, issues)
    if (parsed) questions.push(parsed)
  }

  // --- Coherencia entre filas ---

  // Un mismo id_contexto debe tener el texto escrito una sola vez.
  const contextTexts = new Map<string, { text: string; rowNumber: number }>()
  for (const q of questions) {
    if (!q.contextKey || !q.contextText) continue
    const seen = contextTexts.get(q.contextKey)
    if (!seen) {
      contextTexts.set(q.contextKey, { text: q.contextText, rowNumber: q.rowNumber })
    } else if (seen.text !== q.contextText) {
      issues.push({
        rowNumber: q.rowNumber,
        column: 'contexto',
        severity: 'warning',
        message: `El id_contexto "${q.contextKey}" ya tiene otro texto en la fila ${seen.rowNumber}. Se usará el de la fila ${seen.rowNumber}.`,
      })
    }
  }

  // Una fila que referencia un id_contexto que nadie definió.
  for (const q of questions) {
    if (q.contextKey && !contextTexts.has(q.contextKey)) {
      issues.push({
        rowNumber: q.rowNumber,
        column: 'id_contexto',
        severity: 'error',
        message: `Ninguna fila define el texto del contexto "${q.contextKey}".`,
      })
    }
  }

  // Enunciados duplicados: casi siempre es una fila pegada dos veces.
  const stems = new Map<string, number>()
  for (const q of questions) {
    const key = fold(q.stem)
    const first = stems.get(key)
    if (first !== undefined) {
      issues.push({
        rowNumber: q.rowNumber,
        column: 'enunciado',
        severity: 'warning',
        message: `Este enunciado es idéntico al de la fila ${first}. ¿Se duplicó?`,
      })
    } else {
      stems.set(key, q.rowNumber)
    }
  }

  const errorRows = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.rowNumber))
  const warningRows = new Set(issues.filter((i) => i.severity === 'warning').map((i) => i.rowNumber))

  return {
    // Una fila con un error de coherencia detectado arriba también queda fuera.
    questions: questions.filter((q) => !errorRows.has(q.rowNumber)),
    issues: issues.sort((a, b) => a.rowNumber - b.rowNumber),
    summary: {
      totalRows: rows.length,
      valid: rows.length - errorRows.size,
      withErrors: errorRows.size,
      withWarnings: warningRows.size,
    },
  }
}
