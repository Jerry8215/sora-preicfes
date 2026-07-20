/**
 * Lector del Excel de preguntas.
 *
 * Única parte del importador que sabe que existe exceljs. Convierte la hoja
 * "Preguntas" en filas planas y se las entrega a parseQuestions, que es puro.
 *
 * Las columnas se reconocen por su NOMBRE, no por su posición. El cliente edita
 * la plantilla a su gusto —quita columnas que no usa, cambia el orden, escribe
 * "Área" con tilde y mayúscula— y el importador debe entenderlo igual. Solo un
 * puñado de columnas es obligatorio; las demás, si están, se leen, y si no,
 * simplemente no están.
 */

import ExcelJS from 'exceljs'

import type { RawRow } from './parse-questions'

const SHEET_NAME = 'Preguntas'

/** Las claves internas de una fila y los encabezados que las identifican. */
type ColumnKey = keyof Omit<RawRow, 'rowNumber'>

/**
 * Cada columna interna acepta varios nombres de encabezado. Se comparan ya
 * normalizados (sin tildes, en minúscula, con guiones bajos), así que aquí van
 * en esa forma.
 */
const COLUMN_ALIASES: Record<ColumnKey, string[]> = {
  area: ['area'],
  competencia: ['competencia'],
  simulacro: ['simulacro'],
  taller: ['taller'],
  id_contexto: ['id_contexto', 'idcontexto', 'contexto_id'],
  contexto: ['contexto', 'texto', 'texto_base'],
  enunciado: ['enunciado', 'pregunta'],
  opcion_a: ['opcion_a', 'a'],
  opcion_b: ['opcion_b', 'b'],
  opcion_c: ['opcion_c', 'c'],
  opcion_d: ['opcion_d', 'd'],
  opcion_e: ['opcion_e', 'e'],
  opcion_f: ['opcion_f', 'f'],
  opcion_g: ['opcion_g', 'g'],
  opcion_h: ['opcion_h', 'h'],
  imagen_a: ['imagen_a', 'opcion_a_imagen', 'a_imagen'],
  imagen_b: ['imagen_b', 'opcion_b_imagen', 'b_imagen'],
  imagen_c: ['imagen_c', 'opcion_c_imagen', 'c_imagen'],
  imagen_d: ['imagen_d', 'opcion_d_imagen', 'd_imagen'],
  imagen_e: ['imagen_e', 'opcion_e_imagen', 'e_imagen'],
  imagen_f: ['imagen_f', 'opcion_f_imagen', 'f_imagen'],
  imagen_g: ['imagen_g', 'opcion_g_imagen', 'g_imagen'],
  imagen_h: ['imagen_h', 'opcion_h_imagen', 'h_imagen'],
  respuesta_correcta: ['respuesta_correcta', 'respuesta', 'correcta', 'clave'],
  peso: ['peso', 'valor', 'ponderacion'],
  parte: ['parte', 'sesion', 'seccion'],
  imagen: ['imagen', 'imagen_nombre', 'grafica'],
  explicacion: ['explicacion', 'retroalimentacion', 'justificacion'],
}

/** Sin estas columnas no se puede armar una pregunta. */
const REQUIRED: ColumnKey[] = [
  'area',
  'competencia',
  'enunciado',
  'opcion_a',
  'opcion_b',
  'opcion_c',
  'opcion_d',
  'respuesta_correcta',
]

export class WorkbookFormatError extends Error {}

/** minúsculas, sin tildes, espacios/puntos -> guion bajo. "Opción A" -> "opcion_a". */
function normalizeHeader(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[\s.]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

/**
 * Una celda de Excel puede traer fórmulas, texto enriquecido o hipervínculos.
 *
 * OJO: un hipervínculo cuyo texto visible es texto enriquecido llega como
 * `{ text: { richText: [...] }, hyperlink }`. La versión anterior hacía
 * `String(value.text)` y, como `value.text` era un objeto, guardaba el literal
 * "[object Object]" —fue justo lo que pasó con dos lecturas del cliente—. Por eso
 * ahora se resuelve el texto de forma RECURSIVA y, si nada calza, se devuelve
 * cadena vacía: mejor vacío (que el validador detecta) que basura silenciosa.
 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') {
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
    }
    // Hipervínculo: el texto visible puede ser string o texto enriquecido.
    if ('text' in value) return cellToString(value.text as ExcelJS.CellValue)
    // Fórmula: el resultado también puede ser enriquecido.
    if ('result' in value) {
      return value.result == null ? '' : cellToString(value.result as ExcelJS.CellValue)
    }
    if ('formula' in value || 'sharedFormula' in value || 'error' in value) return ''
  }
  return ''
}

/**
 * La plantilla trae una nota amarilla ("...son EJEMPLOS...") que separa las
 * filas de muestra. NO se puede asumir que todo lo anterior a esa nota son
 * ejemplos: el administrador puede escribir sus preguntas encima de ella y
 * dejarla al final. Así que la nota simplemente se ignora como fila.
 */
const NOTE_MARKER = 'son EJEMPLOS'

/**
 * Los enunciados de las preguntas de muestra que trae la plantilla. Si el
 * administrador se olvida de borrarlas, no entran al banco como preguntas
 * reales. Se reconocen por su texto, no por su posición.
 */
const EXAMPLE_STEMS = [
  'Según el texto, la relación entre la abeja y la flor se describe como una relación en la que',
  'A partir del texto anterior, se puede inferir que la desaparición de las abejas afectaría principalmente',
  'Según la gráfica, ¿en qué mes se registró la mayor cantidad de lluvia?',
  'La relación entre el pez payaso y la anémona, donde ambos se benefician, se denomina',
  'Choose the option that best completes the sentence: "If I ____ more time, I would travel."',
]

const fold = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

const EXAMPLE_STEM_SET = new Set(EXAMPLE_STEMS.map(fold))

export async function readQuestionRows(source: string | Buffer): Promise<RawRow[]> {
  const workbook = new ExcelJS.Workbook()
  if (typeof source === 'string') await workbook.xlsx.readFile(source)
  else await workbook.xlsx.load(source as never)

  // Se busca la hoja "Preguntas". Pero al exportar desde Google Sheets la
  // pestaña puede tener otro nombre: si el archivo trae UNA sola hoja, se usa esa
  // (es lo que la persona quería subir). Con varias hojas sí se exige el nombre,
  // para no leer por error la de instrucciones o la de competencias.
  const sheet =
    workbook.getWorksheet(SHEET_NAME) ??
    (workbook.worksheets.length === 1 ? workbook.worksheets[0] : undefined)
  if (!sheet) {
    const nombres = workbook.worksheets.map((s) => `"${s.name}"`).join(', ')
    throw new WorkbookFormatError(
      `El archivo no tiene una hoja llamada "${SHEET_NAME}". Hojas encontradas: ${nombres}. ` +
        'Renombra la pestaña de las preguntas como "Preguntas".',
    )
  }

  // Mapear cada columna interna a su número de columna en el Excel, buscando el
  // encabezado por nombre. El orden y las tildes no importan.
  const header = sheet.getRow(1)
  const headerByNorm = new Map<string, number>()
  header.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const norm = normalizeHeader(cellToString(cell.value))
    if (norm && !headerByNorm.has(norm)) headerByNorm.set(norm, colNumber)
  })

  const columnAt = {} as Record<ColumnKey, number | undefined>
  for (const key of Object.keys(COLUMN_ALIASES) as ColumnKey[]) {
    const alias = COLUMN_ALIASES[key].find((a) => headerByNorm.has(a))
    columnAt[key] = alias ? headerByNorm.get(alias) : undefined
  }

  const missing = REQUIRED.filter((key) => columnAt[key] === undefined)
  if (missing.length > 0) {
    throw new WorkbookFormatError(
      `Al archivo le faltan columnas obligatorias: ${missing.join(', ')}. ` +
        'Revise que la primera fila tenga esos encabezados. El resto de columnas son opcionales.',
    )
  }

  const keys = Object.keys(COLUMN_ALIASES) as ColumnKey[]
  const rows: RawRow[] = []

  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return

    // La nota amarilla no es una pregunta: se salta, venga donde venga.
    const firstCell = cellToString(row.getCell(1).value)
    if (firstCell.includes(NOTE_MARKER)) return

    const parsed = { rowNumber } as RawRow
    for (const key of keys) {
      const col = columnAt[key]
      ;(parsed as Record<ColumnKey, string>)[key] = col ? cellToString(row.getCell(col).value) : ''
    }

    // Fila fantasma: solo trae columnas de clasificación (el área suele quedar
    // rellenada al arrastrar el desplegable hacia abajo), sin nada de la
    // pregunta en sí. No es una pregunta a medias: es una fila vacía. Se salta
    // en silencio, sin inundar al administrador de errores falsos.
    const hasQuestion = [
      parsed.enunciado,
      parsed.opcion_a,
      parsed.opcion_b,
      parsed.opcion_c,
      parsed.opcion_d,
      parsed.respuesta_correcta,
    ].some((v) => String(v ?? '').trim())
    if (!hasQuestion) return

    // Las preguntas de muestra de la plantilla no entran al banco.
    if (EXAMPLE_STEM_SET.has(fold(parsed.enunciado ?? ''))) return

    rows.push(parsed)
  })

  return rows
}
