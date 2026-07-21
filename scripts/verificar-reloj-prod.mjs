/**
 * Verifica en PRODUCCIÓN que el reloj nuevo esté vivo: un estudiante de prueba
 * abre el simulacro y el servidor debe marcarle `lastSeenAt` (el latido). Si esa
 * columna se queda en nulo, el despliegue todavía trae el código viejo.
 *
 * Al terminar borra el estudiante de prueba y su intento.
 *
 *   node --import tsx scripts/verificar-reloj-prod.mjs
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
  args: ['--no-sandbox', '--window-size=1280,1000'],
})

const stamp = Date.now().toString().slice(-6)
const user = `reloj${stamp}`
const email = `${user}@sora.test`

try {
  const page = await browser.newPage()
  page.setDefaultNavigationTimeout(60000)
  page.setDefaultTimeout(60000)

  // El estudiante de prueba se crea directo en la base: así no se gasta un
  // código de acceso ni pasa por el formulario de registro.
  // Se le pone el mismo grupo que el simulacro exige (si exige alguno) y el
  // avatar ya elegido, para entrar derecho al examen.
  const simulacro = await db.assessment.findFirstOrThrow({
    where: { type: 'SIMULACRO', published: true },
    include: { groups: { select: { groupId: true } } },
  })
  await db.user.create({
    data: {
      email,
      username: user,
      fullName: 'Prueba del reloj',
      passwordHash: await bcrypt.hash('Prueba2026', 12),
      avatarChosen: true,
      groupId: simulacro.groups[0]?.groupId ?? null,
    },
  })
  console.log(`0. Simulacro objetivo: ${simulacro.title} (grupos: ${simulacro.groups.length})`)

  await page.goto(`${BASE}/ingresar`, { waitUntil: 'domcontentloaded' })
  await page.type('input[name="identifier"]', email)
  await page.type('input[name="password"]', 'Prueba2026')
  await page.click('button[type="submit"]')
  await page.waitForFunction(
    () => location.pathname !== '/ingresar' || !!document.querySelector('[role="alert"]'),
    { timeout: 45000 },
  )
  const alerta = await page.evaluate(() => document.querySelector('[role="alert"]')?.textContent?.trim())
  if (alerta) throw new Error(`El ingreso no pasó: ${alerta}`)
  console.log('1. Estudiante de prueba dentro ->', new URL(page.url()).pathname)

  await page.goto(`${BASE}/simulacros`, { waitUntil: 'domcontentloaded' })
  const iniciado = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /Iniciar|Continuar/.test(x.textContent))
    if (!b) return false
    b.click()
    return true
  })
  if (!iniciado) throw new Error('No hay ningún simulacro que este estudiante pueda iniciar.')
  await page.waitForFunction(() => location.pathname.startsWith('/simulacro/'), { timeout: 45000 })
  await page.waitForSelector('article', { timeout: 30000 })

  const cabecera = await page.evaluate(() => document.querySelector('header p')?.textContent?.trim())
  const reloj = await page.evaluate(() => document.querySelector('[role="timer"]')?.textContent?.trim())
  console.log(`2. Examen abierto — ${cabecera} — reloj ${reloj}`)

  const attempt = await db.attempt.findFirst({
    where: { user: { email } },
    select: { id: true, currentPart: true, lastSeenAt: true, expiresAt: true },
  })
  console.log(`3. En la base: parte=${attempt?.currentPart} lastSeenAt=${attempt?.lastSeenAt?.toISOString() ?? 'NULO'}`)

  if (!attempt?.lastSeenAt) {
    console.log('\n✗ Todavía corre el código viejo (no se registró `lastSeenAt`). Espera al despliegue.')
  } else {
    console.log('   El servidor registra la presencia: el código nuevo está arriba.')

    // Se finge que cerró el examen y volvió UN DÍA DESPUÉS, con el reloj
    // vencido de sobra. Antes, esto lo mandaba de cabeza a la Sesión 2.
    const unDia = 24 * 60 * 60_000
    await db.attempt.update({
      where: { id: attempt.id },
      data: {
        lastSeenAt: new Date(Date.now() - unDia),
        expiresAt: new Date(Date.now() - unDia + 10 * 60_000), // le quedaban 10 min
      },
    })

    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForSelector('article', { timeout: 30000 })
    const cabecera2 = await page.evaluate(() => document.querySelector('header p')?.textContent?.trim())
    const reloj2 = await page.evaluate(() => document.querySelector('[role="timer"]')?.textContent?.trim())
    const aviso = await page.evaluate(() => document.querySelector('.fixed h3')?.textContent?.trim())
    console.log(`4. Vuelve un día después — ${cabecera2} — reloj ${reloj2}${aviso ? ` — aviso: "${aviso}"` : ''}`)

    const sigueEnSesion1 = cabecera2?.includes('Sesión 1')
    // Le quedaban 10 minutos: el reloj debe marcar "09:5x", no cero.
    const conservaTiempo = /^0?9:5\d$/.test(reloj2 ?? '')
    console.log(
      sigueEnSesion1 && conservaTiempo
        ? '\n✔ Sigue en la Sesión 1 y conserva los 10 minutos que le quedaban. El día ausente no se le cobró.'
        : `\n✗ Algo no cuadra: sesión="${cabecera2}" reloj="${reloj2}"`,
    )
  }
} finally {
  await browser.close()
  // Limpieza: fuera el estudiante de prueba y todo lo suyo.
  const test = await db.user.findUnique({ where: { email }, select: { id: true } })
  if (test) {
    await db.attempt.deleteMany({ where: { userId: test.id } })
    await db.user.delete({ where: { id: test.id } })
    console.log('4. Estudiante de prueba eliminado')
  }
  await db.$disconnect()
}
