/**
 * Reparación puntual (21/07/2026): devolver la Sesión 1 a quien el sistema le
 * saltó a la Sesión 2 sin haberla presentado.
 *
 * Qué había pasado: el reloj del simulacro corría aunque el estudiante cerrara
 * la pestaña, y al volver, con el tiempo vencido, el examen pasaba SOLO a la
 * sesión siguiente. Quien entraba un rato, cerraba y volvía al día siguiente se
 * encontraba en la Sesión 2 con la 1 perdida.
 *
 * Qué hace: a todo intento con la Sesión 1 incompleta lo devuelve a la Sesión 1
 * con reloj nuevo, conservando cada respuesta ya guardada (las de la sesión 2
 * también). No toca a quien sí terminó la Sesión 1.
 *
 *   node --import tsx scripts/reparar-sesion1.mjs          (en seco, no escribe)
 *   node --import tsx scripts/reparar-sesion1.mjs --apply  (aplica)
 */
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const apply = process.argv.includes('--apply')
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

const assessments = await db.assessment.findMany({
  where: { type: 'SIMULACRO' },
  include: { questions: { select: { order: true, part: true } } },
})

for (const a of assessments) {
  const part1 = a.questions.filter((q) => q.part === 1)
  const totalParts = a.questions.reduce((max, q) => Math.max(max, q.part), 1)
  if (totalParts < 2) continue

  const ordersPart1 = new Set(part1.map((q) => q.order))
  const minutes = a.durationMinutes ?? 60

  const attempts = await db.attempt.findMany({
    where: { assessmentId: a.id },
    include: { user: { select: { email: true } }, answers: { select: { order: true, selected: true } } },
    orderBy: { startedAt: 'asc' },
  })

  console.log(`\n=== ${a.title} — Sesión 1: ${part1.size ?? part1.length} preguntas, ${minutes} min\n`)

  for (const t of attempts) {
    const respondidas = t.answers.filter((x) => x.selected !== null && ordersPart1.has(x.order)).length
    const completa = respondidas >= part1.length
    if (completa) {
      // Terminó la Sesión 1: se queda donde está. Lo único que se le repara es
      // el reloj de la Sesión 2 si se quedó sin ninguno (los intentos viejos,
      // de cuando el simulacro todavía no tenía duración configurada, pasaron a
      // la sesión 2 sin cronómetro).
      const sinReloj =
        t.status === 'IN_PROGRESS' &&
        t.currentPart > 1 &&
        t.expiresAt === null &&
        t.remainingMs === null
      console.log(
        `  ok     ${t.user.email} — Sesión 1 completa (${respondidas}/${part1.length})` +
          (sinReloj ? ' — se le pone reloj a la Sesión 2' : ''),
      )
      if (sinReloj && apply) {
        await db.attempt.update({
          where: { id: t.id },
          data: {
            expiresAt: new Date(Date.now() + (a.durationMinutesPart2 ?? minutes) * 60_000),
            lastSeenAt: new Date(),
          },
        })
      }
      continue
    }

    console.log(
      `  ARREGLA ${t.user.email} — Sesión 1 ${respondidas}/${part1.length}, estaba en parte ${t.currentPart} (${t.status})`,
    )
    if (!apply) continue

    await db.attempt.update({
      where: { id: t.id },
      data: {
        status: 'IN_PROGRESS',
        currentPart: 1,
        // Reloj nuevo para la Sesión 1. `lastSeenAt` se pone AHORA, no en nulo:
        // así el tiempo que pase hasta que vuelva a abrir el examen cuenta como
        // ausencia y se le devuelve. Entre a la hora que entre, tendrá sus
        // 270 minutos completos.
        expiresAt: new Date(Date.now() + minutes * 60_000),
        remainingMs: null,
        lastSeenAt: new Date(),
        // El intento vuelve a estar en curso: la calificación anterior (parcial,
        // de un simulacro que no había presentado) se descarta.
        submittedAt: null,
        globalScore: null,
        percent: null,
        correctCount: null,
        totalWeight: null,
      },
    })
  }
}

console.log(apply ? '\nAplicado.' : '\nEn seco: no se escribió nada. Repite con --apply.')
await db.$disconnect()
