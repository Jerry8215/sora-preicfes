/**
 * Convierte en TALLER un contenido que se importó como SIMULACRO por error.
 *
 * Pasa cuando en el .xlsx el nombre se escribe en la columna "simulacro" en vez
 * de la columna "taller": el importador decide el tipo por esa columna, así que
 * un taller acaba listado entre los simulacros.
 *
 * Además del tipo, arregla lo que el tipo arrastra (§8): un taller es de UNA
 * sola área —que se toma de sus propias preguntas— y no tiene cronómetro, así
 * que se le quita la duración y se detiene el reloj de los intentos en curso.
 * Los intentos ya enviados no se tocan: su porcentaje sigue valiendo.
 *
 *   npx tsx scripts/mover-a-taller.mjs "Taller 1"           (en seco)
 *   npx tsx scripts/mover-a-taller.mjs "Taller 1" --apply   (aplica)
 *
 * El texto puede ser parte del título; se busca sin distinguir mayúsculas.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const needle = args.find((a) => !a.startsWith('--'))

if (!needle) {
  console.error('Falta el título. Ej: npx tsx scripts/mover-a-taller.mjs "Taller 1"')
  process.exit(1)
}

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

const found = await db.assessment.findMany({
  where: { type: 'SIMULACRO', title: { contains: needle, mode: 'insensitive' } },
  include: {
    questions: { include: { question: { select: { area: true } } } },
    attempts: { select: { id: true, status: true, expiresAt: true, remainingMs: true } },
  },
})

if (found.length === 0) {
  console.log(`No hay ningún simulacro cuyo título contenga "${needle}".`)
  await db.$disconnect()
  process.exit(0)
}

for (const a of found) {
  const areas = [...new Set(a.questions.map((q) => q.question.area))]
  console.log(`\n"${a.title}"`)
  console.log(`   ${a.questions.length} preguntas · áreas: ${areas.join(', ') || 'ninguna'}`)

  if (areas.length !== 1) {
    // Un taller cubre una sola área (§8). Si las preguntas son de varias, esto
    // no es un taller mal importado: es un simulacro. No se toca.
    console.log(`   ✗ SE OMITE: tiene ${areas.length} áreas, así que no es un taller.`)
    continue
  }

  const enCurso = a.attempts.filter(
    (t) => t.status === 'IN_PROGRESS' && (t.expiresAt !== null || t.remainingMs !== null),
  )
  console.log(`   → tipo TALLER · área ${areas[0]} · sin cronómetro (antes ${a.durationMinutes} min)`)
  console.log(
    `   → ${a.attempts.length} intento(s); se le detiene el reloj a ${enCurso.length} en curso, ` +
      `los enviados no se tocan`,
  )

  if (!apply) continue

  await db.$transaction([
    db.assessment.update({
      where: { id: a.id },
      data: {
        type: 'TALLER',
        area: areas[0],
        durationMinutes: null,
        durationMinutesPart2: null,
      },
    }),
    // El taller no tiene reloj: los intentos abiertos dejan de correr contra el
    // tiempo. Sin esto, un intento con el reloj ya vencido se enviaría —y se
    // calificaría en cero— la próxima vez que el estudiante lo abriera.
    db.attempt.updateMany({
      where: { assessmentId: a.id, status: 'IN_PROGRESS' },
      data: { expiresAt: null, remainingMs: null, lastSeenAt: null },
    }),
  ])
  console.log('   ✔ hecho')
}

console.log(apply ? '\nAplicado.' : '\nEn seco: no se escribió nada. Repite con --apply.')
await db.$disconnect()
