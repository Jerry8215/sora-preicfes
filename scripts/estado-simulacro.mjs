/**
 * Radiografía de un simulacro: en qué sesión va cada estudiante, cuánto lleva
 * respondido y cómo está su reloj. Útil cuando alguien reporta que "no lo deja
 * entrar" o que "lo mandó a la sesión equivocada".
 *
 *   npx tsx scripts/estado-simulacro.mjs
 */
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

import { PrismaClient } from '../src/generated/prisma/client.ts'

const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) })

const assessments = await db.assessment.findMany({
  where: { type: 'SIMULACRO' },
  include: { questions: { select: { order: true, part: true } } },
})

for (const a of assessments) {
  const partOf = new Map(a.questions.map((q) => [q.order, q.part]))
  const totalParts = a.questions.reduce((max, q) => Math.max(max, q.part), 1)
  const porParte = {}
  for (const q of a.questions) porParte[q.part] = (porParte[q.part] ?? 0) + 1

  console.log(`\n=== ${a.title} — ${totalParts} sesión(es):`, porParte)

  const attempts = await db.attempt.findMany({
    where: { assessmentId: a.id },
    include: { user: { select: { email: true } }, answers: { select: { order: true, selected: true } } },
    orderBy: { startedAt: 'asc' },
  })

  for (const t of attempts) {
    const cuenta = {}
    for (const ans of t.answers) {
      if (ans.selected === null) continue
      const p = partOf.get(ans.order) ?? 1
      cuenta[p] = (cuenta[p] ?? 0) + 1
    }
    const detalle = Object.keys(porParte)
      .sort()
      .map((p) => `S${p} ${String(cuenta[p] ?? 0).padStart(3)}/${porParte[p]}`)
      .join('  ')
    const reloj = t.expiresAt
      ? t.expiresAt.getTime() <= Date.now()
        ? 'VENCIDO'
        : `${Math.round((t.expiresAt.getTime() - Date.now()) / 60000)} min`
      : t.remainingMs != null
        ? `pausado (${Math.round(t.remainingMs / 60000)} min)`
        : 'sin reloj'
    console.log(
      `  ${t.user.email.padEnd(42)} ${t.status.padEnd(11)} sesión ${t.currentPart}  ${detalle}  reloj: ${reloj}`,
    )
  }
}

await db.$disconnect()
