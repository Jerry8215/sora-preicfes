/**
 * Comprueba contra PRODUCCIÓN que al importar eligiendo "Taller" como destino
 * se cree un TALLER —y no un simulacro, como pasaba antes—.
 *
 * Sube un .xlsx de 3 preguntas de una sola área, elige Taller, confirma, y
 * revisa en la base qué tipo quedó. Al terminar borra el taller de prueba, sus
 * preguntas y su contexto: no deja rastro.
 *
 *   npx tsx scripts/verificar-importar-taller-prod.mjs
 */
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'
import ExcelJS from 'exceljs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import puppeteer from 'puppeteer-core'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.PROD_URL ?? 'https://simulation-education-platform.vercel.app'

const stamp = Date.now().toString().slice(-6)
const TITULO = `ZZ Taller de prueba ${stamp}`

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

// El .xlsx con las mismas columnas que la plantilla de SORA.
const competencia = await db.competency.findFirstOrThrow({
  where: { area: 'LECTURA_CRITICA' },
  select: { name: true },
})

const dir = await mkdtemp(join(tmpdir(), 'sora-'))
const xlsx = join(dir, 'taller.xlsx')
const wb = new ExcelJS.Workbook()
const ws = wb.addWorksheet('Preguntas')
ws.addRow([
  'Área', 'Competencia', 'Simulacro', 'taller', 'id_contexto', 'Contexto', 'enunciado',
  'opcion_a', 'opcion_b', 'opcion_c', 'opcion_d', 'respuesta_correcta', 'peso', 'parte',
  'imagen', 'explicacion',
])
for (let i = 1; i <= 3; i++) {
  ws.addRow([
    'Lectura Crítica', competencia.name, '', TITULO, '', '', `Pregunta de prueba ${i}: ¿cuál es la correcta?`,
    'Opción A', 'Opción B', 'Opción C', 'Opción D', 'A', 1, 1, '', '',
  ])
}
await wb.xlsx.writeFile(xlsx)

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,1400'],
})

let creado = null
try {
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(60000)
  page.setDefaultTimeout(60000)

  await page.goto(`${BASE}/ingresar`, { waitUntil: 'domcontentloaded' })
  await page.type('input[name="identifier"]', process.env.SEED_ADMIN_EMAIL)
  await page.type('input[name="password"]', process.env.SEED_ADMIN_PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => location.pathname !== '/ingresar', { timeout: 45000 })
  console.log('1. Admin dentro')

  await page.goto(`${BASE}/admin/preguntas/importar`, { waitUntil: 'domcontentloaded' })
  const input = await page.$('input[type="file"]')
  await input.uploadFile(xlsx)
  await Promise.all([
    page.waitForSelector('#targetSimulacro', { timeout: 60000 }),
    page.click('button[type="submit"]'),
  ])

  // Lo que el importador propone solo: debe venir con el taller ya elegido.
  const sugerido = await page.$eval('#targetSimulacro', (el) => el.value)
  const tipoSugerido = await page.$eval(
    'input[name="targetType"]:checked',
    (el) => el.value,
  )
  console.log(`2. Propone destino: "${sugerido}" como ${tipoSugerido}`)

  const bien = sugerido === TITULO && tipoSugerido === 'TALLER'
  console.log(
    bien
      ? '   ✔ Se prellenó desde la columna `taller` del Excel, con el tipo correcto.'
      : `   ✗ Esperaba "${TITULO}" como TALLER.`,
  )

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) =>
      x.textContent.includes('Confirmar y cargar'),
    )
    b?.click()
  })
  await page.waitForSelector('h2.text-success', { timeout: 60000 })
  console.log('3. Carga confirmada')

  creado = await db.assessment.findFirst({
    where: { title: TITULO },
    select: { id: true, type: true, area: true, durationMinutes: true },
  })
  console.log(`4. En la base: tipo=${creado?.type} área=${creado?.area} reloj=${creado?.durationMinutes ?? 'ninguno'}`)

  console.log(
    creado?.type === 'TALLER' && creado.area === 'LECTURA_CRITICA'
      ? '\n✔ El importador ya crea talleres de verdad.'
      : `\n✗ Se creó como ${creado?.type}. El error sigue ahí.`,
  )
} finally {
  await browser.close()
  // Limpieza: fuera el taller de prueba y sus preguntas.
  if (creado) {
    const links = await db.assessmentQuestion.findMany({
      where: { assessmentId: creado.id },
      select: { questionId: true },
    })
    const questionIds = links.map((l) => l.questionId)
    await db.assessmentQuestion.deleteMany({ where: { assessmentId: creado.id } })
    await db.assessment.delete({ where: { id: creado.id } })
    await db.question.updateMany({ where: { id: { in: questionIds } }, data: { currentVersionId: null } })
    await db.questionVersion.deleteMany({ where: { questionId: { in: questionIds } } })
    await db.question.deleteMany({ where: { id: { in: questionIds } } })
    console.log(`5. Taller de prueba y sus ${questionIds.length} preguntas eliminados`)
  }
  await rm(dir, { recursive: true, force: true })
  await db.$disconnect()
}
