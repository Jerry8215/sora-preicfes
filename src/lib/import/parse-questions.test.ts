import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { detectOcrNoise, joinHyphenated, parseQuestions, type RawRow } from './parse-questions'
import type { Area } from '../scoring'

const COMPETENCIAS: Array<{ area: Area; name: string }> = [
  { area: 'LECTURA_CRITICA', name: 'Identificar y entender contenidos locales' },
  { area: 'LECTURA_CRITICA', name: 'Reflexionar y evaluar a partir de un texto' },
  { area: 'MATEMATICAS', name: 'Interpretación y representación' },
  { area: 'CIENCIAS_NATURALES', name: 'Explicación de fenómenos' },
  { area: 'INGLES', name: 'Uso del lenguaje en contexto' },
]

/** Una fila válida; cada prueba sobreescribe solo lo que le interesa. */
const row = (overrides: Partial<RawRow> = {}): RawRow => ({
  rowNumber: 2,
  area: 'Matemáticas',
  competencia: 'Interpretación y representación',
  simulacro: 'Simulacro 01',
  enunciado: '¿Cuál es el valor de x en la ecuación dada?',
  opcion_a: 'Dos',
  opcion_b: 'Tres',
  opcion_c: 'Cuatro',
  opcion_d: 'Cinco',
  respuesta_correcta: 'B',
  ...overrides,
})

const parse = (rows: RawRow[]) => parseQuestions(rows, COMPETENCIAS)

const errorsOf = (rows: RawRow[]) =>
  parse(rows).issues.filter((i) => i.severity === 'error').map((i) => i.message)
const warningsOf = (rows: RawRow[]) =>
  parse(rows).issues.filter((i) => i.severity === 'warning').map((i) => i.message)

describe('una fila correcta pasa limpia', () => {
  it('no reporta nada y produce una pregunta', () => {
    const result = parse([row()])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions.length, 1)
    assert.equal(result.questions[0]!.area, 'MATEMATICAS')
    assert.equal(result.questions[0]!.correctOption, 'B')
    assert.equal(result.questions[0]!.weight, 1)
    assert.deepEqual(result.summary, { totalRows: 1, valid: 1, withErrors: 0, withWarnings: 0 })
  })

  it('acepta el área sin tildes y en minúsculas', () => {
    const result = parse([row({ area: 'matematicas' })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0]!.area, 'MATEMATICAS')
  })

  it('normaliza los espacios sobrantes que deja el OCR', () => {
    const result = parse([row({ enunciado: '  ¿Cuál   es   el valor de x?  ' })])
    assert.equal(result.questions[0]!.stem, '¿Cuál es el valor de x?')
  })
})

describe('errores que bloquean la carga', () => {
  it('sin respuesta correcta', () => {
    assert.match(errorsOf([row({ respuesta_correcta: '' })]).join(), /Falta la respuesta correcta/)
    assert.equal(parse([row({ respuesta_correcta: '' })]).questions.length, 0)
  })

  it('una respuesta correcta que no es una letra de opción', () => {
    assert.match(errorsOf([row({ respuesta_correcta: 'Z' })]).join(), /debe ser una letra de A a D/)
  })

  it('la respuesta correcta apunta a una opción que no existe en la pregunta', () => {
    // "E" es una letra válida, pero esta pregunta solo tiene A-D.
    assert.match(errorsOf([row({ respuesta_correcta: 'E' })]).join(), /no existe en la pregunta/)
  })

  it('una opción vacía (hueco en el rango)', () => {
    // C vacía con D presente: es un hueco, se marca.
    assert.match(errorsOf([row({ opcion_c: '' })]).join(), /Falta la opción C/)
  })

  it('acepta una pregunta de emparejamiento con 8 opciones (A-H)', () => {
    const result = parse([
      row({
        opcion_e: 'armchair', opcion_f: 'bed', opcion_g: 'shower', opcion_h: 'towel',
        respuesta_correcta: 'H',
      }),
    ])
    assert.deepEqual(result.issues.filter((i) => i.severity === 'error'), [])
    assert.equal(result.questions[0]!.correctOption, 'H')
    assert.equal(result.questions[0]!.options.H, 'towel')
  })

  it('un área que no existe', () => {
    assert.match(errorsOf([row({ area: 'Filosofía' })]).join(), /Área desconocida/)
  })

  it('una competencia que no pertenece al área', () => {
    const rows = [row({ area: 'Inglés', competencia: 'Interpretación y representación' })]
    assert.match(errorsOf(rows).join(), /no pertenece al área/)
  })

  it('una pregunta que pertenece a un simulacro y a un taller a la vez', () => {
    const rows = [row({ simulacro: 'Simulacro 01', taller: 'Taller 1' })]
    assert.match(errorsOf(rows).join(), /no puede pertenecer a un simulacro y a un taller/)
  })

  it('un contexto escrito sin id_contexto', () => {
    const rows = [row({ contexto: 'Un texto largo sobre abejas.', id_contexto: '' })]
    assert.match(errorsOf(rows).join(), /no le puso un id_contexto/)
  })

  it('una fila que referencia un contexto que nadie definió', () => {
    const rows = [row({ id_contexto: 'CTX9', contexto: '' })]
    assert.match(errorsOf(rows).join(), /Ninguna fila define el texto del contexto "CTX9"/)
    assert.equal(parse(rows).questions.length, 0)
  })

  it('la respuesta correcta acepta minúscula, no es un error', () => {
    const result = parse([row({ respuesta_correcta: 'b' })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0]!.correctOption, 'B')
  })
})

describe('advertencias: la fila entra, pero el administrador debe mirarla', () => {
  it('dos opciones idénticas', () => {
    const rows = [row({ opcion_a: 'Dos', opcion_b: 'dos' })]
    assert.match(warningsOf(rows).join(), /opciones de respuesta idénticas/)
    assert.equal(parse(rows).questions.length, 1, 'la pregunta igual se carga')
  })

  it('un enunciado sospechosamente corto', () => {
    assert.match(warningsOf([row({ enunciado: '¿Cuál?' })]).join(), /muy corto/)
  })

  it('sin enunciado avisa pero NO bloquea (preguntas de completar un texto)', () => {
    const result = parse([row({ enunciado: '' })])
    assert.equal(result.issues.filter((i) => i.severity === 'error').length, 0)
    assert.equal(result.questions.length, 1, 'la pregunta cloze se carga igual')
    assert.match(warningsOf([row({ enunciado: '' })]).join(), /no tiene enunciado/)
  })

  it('un peso fuera de rango se ignora y la pregunta vale 1', () => {
    const result = parse([row({ peso: '99' })])
    assert.match(result.issues.map((i) => i.message).join(), /Peso inválido/)
    assert.equal(result.questions[0]!.weight, 1)
  })

  it('un peso válido se respeta', () => {
    assert.equal(parse([row({ peso: '3' })]).questions[0]!.weight, 3)
  })

  it('una opción puede ser solo imagen (sin texto), y no se marca error', () => {
    const result = parse([
      row({ opcion_a: '', imagen_a: 'tabla_a.png', respuesta_correcta: 'A' }),
    ])
    assert.deepEqual(
      result.issues.filter((i) => i.severity === 'error'),
      [],
      'una opción con imagen no debe pedir texto',
    )
    assert.equal(result.questions[0]!.optionImages.A, 'tabla_a.png')
    assert.equal(result.questions[0]!.options.A, '')
  })

  it('una opción sin texto NI imagen sí es error', () => {
    assert.match(errorsOf([row({ opcion_c: '' })]).join(), /Falta la opción C/)
  })

  it('sin columna "parte" la pregunta queda en la parte 1', () => {
    assert.equal(parse([row()]).questions[0]!.part, 1)
  })

  it('la columna "parte" con 2 pone la pregunta en la segunda parte', () => {
    const result = parse([row({ parte: '2' })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0]!.part, 2)
  })

  it('una parte distinta de 1 o 2 se avisa y la pregunta queda en la parte 1', () => {
    const result = parse([row({ parte: '3' })])
    assert.match(result.issues.map((i) => i.message).join(), /Parte inválida/)
    assert.equal(result.questions[0]!.part, 1)
  })

  it('un enunciado duplicado en otra fila', () => {
    const rows = [row({ rowNumber: 2 }), row({ rowNumber: 5 })]
    assert.match(warningsOf(rows).join(), /idéntico al de la fila 2/)
  })
})

describe('palabras partidas por el guion del renglón', () => {
  // Los textos del cliente vienen de documentos a dos columnas: el OCR conserva
  // los guiones de corte. Sin unirlos, el estudiante lee "corres- ponde".
  it('une una palabra cortada al final de línea', () => {
    assert.equal(
      joinHyphenated('el orden de su contenido no corres-\nponde con el de la infografía'),
      'el orden de su contenido no corresponde con el de la infografía',
    )
  })

  it('une aunque haya espacios o sangría alrededor del salto', () => {
    assert.equal(joinHyphenated('pre-  \n   sentada'), 'presentada')
  })

  it('funciona con saltos de línea de Windows', () => {
    assert.equal(joinHyphenated('infor-\r\nmación'), 'información')
  })

  it('no toca un guion legítimo entre palabras', () => {
    assert.equal(joinHyphenated('teórico-práctico'), 'teórico-práctico')
  })

  it('no une si después del guion viene mayúscula (es un nombre compuesto)', () => {
    assert.equal(joinHyphenated('García-\nMárquez'), 'García-\nMárquez')
  })

  it('el importador entrega el enunciado ya unido', () => {
    const result = parse([
      row({ enunciado: 'De acuerdo con la información pre-\nsentada sobre el porcentaje' }),
    ])
    assert.equal(
      result.questions[0]!.stem,
      'De acuerdo con la información presentada sobre el porcentaje',
    )
  })

  it('también une las opciones de respuesta', () => {
    const result = parse([row({ opcion_b: 'el orden no corres-\nponde con la infografía' })])
    assert.equal(result.questions[0]!.options.B, 'el orden no corresponde con la infografía')
  })
})

describe('competencias: el nombre oficial largo y el abreviado son la misma', () => {
  // El ICFES nombra las competencias con frases largas; la gente las abrevia.
  const OFICIALES: Array<{ area: Area; name: string }> = [
    { area: 'LECTURA_CRITICA', name: 'Identificar y entender los contenidos locales que conforman un texto.' },
    { area: 'LECTURA_CRITICA', name: 'Comprender cómo se articulan las partes de un texto para darle un sentido global.' },
    { area: 'LECTURA_CRITICA', name: 'Reflexionar a partir de un texto y evaluar su contenido.' },
    { area: 'MATEMATICAS', name: 'Interpretación y representación' },
  ]
  const parseOficial = (rows: RawRow[]) => parseQuestions(rows, OFICIALES)

  const lectura = (competencia: string): RawRow =>
    row({ area: 'Lectura Crítica', competencia, simulacro: 'Simulacro 01' })

  it('acepta el nombre oficial exacto, sin advertencia', () => {
    const result = parseOficial([lectura('Reflexionar a partir de un texto y evaluar su contenido.')])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions[0]!.competencia, 'Reflexionar a partir de un texto y evaluar su contenido.')
  })

  it('el punto final sobra o falta, da igual', () => {
    const result = parseOficial([lectura('Reflexionar a partir de un texto y evaluar su contenido')])
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions.length, 1)
  })

  it('acepta la forma abreviada y la registra con el nombre oficial', () => {
    const result = parseOficial([lectura('Identificar y entender contenidos locales')])
    assert.equal(result.questions.length, 1)
    assert.equal(
      result.questions[0]!.competencia,
      'Identificar y entender los contenidos locales que conforman un texto.',
      'se guarda el nombre oficial, no el que escribió el administrador',
    )
    assert.match(result.issues.map((i) => i.message).join(), /se registrará como/)
  })

  it('la abreviatura del otro nombre largo también encaja', () => {
    const result = parseOficial([lectura('Comprender cómo se articulan las partes de un texto')])
    assert.equal(result.questions.length, 1)
    assert.equal(
      result.questions[0]!.competencia,
      'Comprender cómo se articulan las partes de un texto para darle un sentido global.',
    )
  })

  it('una competencia de otra área sigue siendo un error', () => {
    const rows = [lectura('Interpretación y representación')]
    const errors = parseOficial(rows).issues.filter((i) => i.severity === 'error')
    assert.match(errors.map((e) => e.message).join(), /no pertenece al área/)
    assert.equal(parseOficial(rows).questions.length, 0)
  })

  it('un nombre que no se parece a ninguna se rechaza', () => {
    const rows = [lectura('Cualquier cosa inventada')]
    const errors = parseOficial(rows).issues.filter((i) => i.severity === 'error')
    assert.match(errors.map((e) => e.message).join(), /no pertenece al área/)
  })
})

describe('ruido del OCR', () => {
  it('detecta mojibake de tildes', () => {
    // "función" codificado en UTF-8 y leído como Latin-1.
    const roto = Buffer.from('la función celular', 'utf8').toString('latin1')
    assert.match(detectOcrNoise(roto).join(), /tildes o eñes se ven corruptas/)
  })

  it('detecta el carácter de reemplazo', () => {
    assert.match(detectOcrNoise('la c�lula').join(), /no se pudieron leer/)
  })

  it('detecta un cero en medio de una palabra', () => {
    assert.match(detectOcrNoise('la s0luci0n correcta').join(), /en medio de una palabra/)
  })

  it('detecta caracteres invisibles', () => {
    assert.match(detectOcrNoise('textoraro').join(), /caracteres invisibles/)
  })

  it('no se queja de texto limpio con tildes y eñes', () => {
    assert.deepEqual(detectOcrNoise('La niña resolvió la ecuación. ¿Cuál es el área?'), [])
  })

  it('no confunde un número legítimo con ruido', () => {
    assert.deepEqual(detectOcrNoise('El resultado es 10 y el área es 1 cm2.'), [])
  })

  it('marca la fila que trae ruido, sin bloquearla', () => {
    const rows = [row({ enunciado: 'Cual es la s0luci0n de la ecuacion?' })]
    const result = parse(rows)
    assert.match(warningsOf(rows).join(), /Revise el texto/)
    assert.equal(result.questions.length, 1)
    assert.equal(result.summary.withErrors, 0)
    assert.equal(result.summary.withWarnings, 1)
  })
})

describe('contexto compartido entre preguntas', () => {
  it('el texto se escribe una vez y las demás filas lo heredan por id', () => {
    const rows = [
      row({
        rowNumber: 2,
        area: 'Lectura Crítica',
        competencia: 'Identificar y entender contenidos locales',
        id_contexto: 'CTX1',
        contexto: 'Las abejas polinizan las flores.',
        enunciado: 'Según el texto, la abeja obtiene del proceso',
      }),
      row({
        rowNumber: 3,
        area: 'Lectura Crítica',
        competencia: 'Reflexionar y evaluar a partir de un texto',
        id_contexto: 'CTX1',
        contexto: '',
        enunciado: 'Del texto anterior se puede inferir que sin abejas',
      }),
    ]
    const result = parse(rows)
    assert.deepEqual(result.issues, [])
    assert.equal(result.questions.length, 2)
    assert.equal(result.questions[1]!.contextKey, 'CTX1')
    assert.equal(result.questions[1]!.contextText, null, 'la segunda fila no repite el texto')
  })

  it('"CTX 8" y "CTX8" son el mismo contexto: un espacio no puede romper la carga', () => {
    // El caso real: el cliente escribió "CTX 8" en la fila que trae el texto y
    // "CTX8" en la que lo referencia. Cinco preguntas se quedaron sin su lectura
    // por ese espacio.
    const rows = [
      row({
        rowNumber: 2,
        id_contexto: 'CTX 8',
        contexto: 'Los envases de Tetra Pak están hechos de varias capas.',
        enunciado: 'Según el texto, los envases se componen de',
      }),
      row({
        rowNumber: 3,
        id_contexto: 'CTX8',
        contexto: '',
        enunciado: 'Considere el siguiente enunciado sobre los envases',
      }),
    ]

    const result = parse(rows)
    assert.deepEqual(
      result.issues.filter((i) => i.severity === 'error'),
      [],
      'ninguna fila queda bloqueada por el espacio',
    )
    assert.equal(result.questions.length, 2)
    assert.equal(result.questions[0]!.contextKey, 'CTX8')
    assert.equal(result.questions[1]!.contextKey, 'CTX8', 'ambas apuntan al mismo contexto')
  })

  it('también da igual la mayúscula: "ctx1" es "CTX1"', () => {
    const rows = [
      row({ rowNumber: 2, id_contexto: 'ctx1', contexto: 'Un texto.', enunciado: 'Primera pregunta del texto' }),
      row({ rowNumber: 3, id_contexto: 'CTX1', contexto: '', enunciado: 'Segunda pregunta del texto' }),
    ]
    const result = parse(rows)
    assert.deepEqual(result.issues.filter((i) => i.severity === 'error'), [])
    assert.equal(result.questions[1]!.contextKey, 'CTX1')
  })

  it('avisa si el mismo id_contexto trae dos textos distintos', () => {
    const rows = [
      row({ rowNumber: 2, id_contexto: 'CTX1', contexto: 'Texto original de la lectura.' }),
      row({ rowNumber: 3, id_contexto: 'CTX1', contexto: 'Otro texto diferente.', enunciado: 'Segunda pregunta distinta' }),
    ]
    assert.match(warningsOf(rows).join(), /ya tiene otro texto en la fila 2/)
  })
})

describe('resumen del archivo completo', () => {
  it('cuenta filas válidas, con error y con advertencia', () => {
    const rows = [
      row({ rowNumber: 2 }),
      row({ rowNumber: 3, respuesta_correcta: '', enunciado: 'Una pregunta sin clave de respuesta' }),
      row({ rowNumber: 4, enunciado: 'Cual es la s0lucion?', peso: '2' }),
    ]
    const result = parse(rows)
    assert.equal(result.summary.totalRows, 3)
    assert.equal(result.summary.withErrors, 1)
    assert.equal(result.summary.withWarnings, 1)
    assert.equal(result.summary.valid, 2)
    assert.equal(result.questions.length, 2, 'solo la fila con error queda fuera')
  })

  it('los hallazgos vienen ordenados por fila, para leerlos de arriba abajo', () => {
    const rows = [
      row({ rowNumber: 7, area: 'Filosofía' }),
      row({ rowNumber: 3, opcion_b: '' }),
    ]
    const numbers = parse(rows).issues.map((i) => i.rowNumber)
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b))
  })
})
