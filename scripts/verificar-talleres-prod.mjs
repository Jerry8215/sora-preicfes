/**
 * Comprueba contra PRODUCCIÓN que cada contenido salga en su pestaña: los
 * talleres en /talleres y los simulacros en /simulacros, y ninguno en la otra.
 *
 *   npx tsx scripts/verificar-talleres-prod.mjs
 */
import { PrismaPg } from '@prisma/adapter-pg'
import bcrypt from 'bcryptjs'
import 'dotenv/config'
import puppeteer from 'puppeteer-core'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const BASE = process.env.PROD_URL ?? 'https://simulation-education-platform.vercel.app'

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--window-size=1280,1400'],
})

const stamp = Date.now().toString().slice(-6)
const email = `pestanas${stamp}@sora.test`

try {
  const esperado = await db.assessment.findMany({
    where: { published: true },
    select: { title: true, type: true, area: true },
    orderBy: { createdAt: 'asc' },
  })
  console.log('Publicado en la base:')
  for (const a of esperado) console.log(`  [${a.type}] ${a.title} (área ${a.area ?? 'ninguna'})`)

  await db.user.create({
    data: {
      email,
      username: `pestanas${stamp}`,
      fullName: 'Prueba de pestañas',
      passwordHash: await bcrypt.hash('Prueba2026', 12),
      avatarChosen: true,
    },
  })

  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(60000)
  page.setDefaultTimeout(60000)

  await page.goto(`${BASE}/ingresar`, { waitUntil: 'domcontentloaded' })
  await page.type('input[name="identifier"]', email)
  await page.type('input[name="password"]', 'Prueba2026')
  await page.click('button[type="submit"]')
  await page.waitForFunction(() => location.pathname !== '/ingresar', { timeout: 45000 })

  const titulos = async (ruta) => {
    await page.goto(`${BASE}${ruta}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('article, p', { timeout: 30000 })
    return page.evaluate(() => [...document.querySelectorAll('article h3')].map((h) => h.textContent.trim()))
  }

  const enSimulacros = await titulos('/simulacros')
  const enTalleres = await titulos('/talleres')
  console.log('\n/simulacros muestra:', enSimulacros)
  console.log('/talleres  muestra:', enTalleres)

  // Para comparar se dejan solo letras, números y espacios: así los emojis del
  // título no estorban, pero las tildes —que sí son letras— se conservan.
  const clave = (s) => s.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

  const fuera = []
  for (const a of esperado) {
    const lista = a.type === 'SIMULACRO' ? enSimulacros : enTalleres
    const otra = a.type === 'SIMULACRO' ? enTalleres : enSimulacros
    if (!lista.some((t) => clave(t) === clave(a.title))) {
      fuera.push(`"${a.title}" (${a.type}) NO aparece en su pestaña`)
    }
    if (otra.some((t) => clave(t) === clave(a.title))) {
      fuera.push(`"${a.title}" (${a.type}) aparece en la pestaña equivocada`)
    }
  }

  console.log(fuera.length === 0 ? '\n✔ Cada contenido está en su pestaña.' : `\n✗ ${fuera.join('\n✗ ')}`)
} finally {
  await browser.close()
  const test = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (test) {
    await db.attempt.deleteMany({ where: { userId: test.id } })
    await db.user.delete({ where: { id: test.id } })
    console.log('Estudiante de prueba eliminado')
  }
  await db.$disconnect()
}
