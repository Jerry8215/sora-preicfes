import Link from 'next/link'

import { ImportQuestions } from '@/components/admin/ImportQuestions'
import { requireAdmin } from '@/lib/auth/require'
import { db } from '@/lib/db'

export default async function ImportarPreguntasPage() {
  await requireAdmin()

  // Los simulacros que ya existen, para que el admin vea a cuál agregaría las
  // preguntas (o elija un nombre nuevo y cree otro, en vez de sobreescribir).
  const rows = await db.assessment.findMany({
    where: { type: 'SIMULACRO' },
    select: { title: true, _count: { select: { questions: true } } },
    orderBy: { createdAt: 'asc' },
  })
  const existing = rows.map((r) => ({ title: r.title, count: r._count.questions }))

  return (
    <main className="mx-auto max-w-3xl p-8">
      <Link href="/admin" className="text-sm text-brand-600 hover:underline">
        ← Panel
      </Link>
      <h1 className="mb-1 mt-2 text-2xl font-bold text-navy-900">Cargar preguntas</h1>
      <p className="mb-6 text-muted-600">
        El sistema revisa cada pregunta y te marca las que tengan problemas antes de guardarlas.
      </p>
      <ImportQuestions existing={existing} />
    </main>
  )
}
