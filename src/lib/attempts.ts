import 'server-only'

import { db } from '@/lib/db'
import {
  AREA_LABELS,
  gradeAttempt,
  goalProgress,
  qualitativeLabel,
  type Area,
  type GradableAnswer,
} from '@/lib/scoring'

/**
 * Servicio de presentación de simulacros y talleres.
 *
 * Reglas de seguridad que este archivo hace cumplir (MODELO_DE_CALIFICACION §10, §11):
 *
 *  - La respuesta correcta NUNCA se incluye en lo que se devuelve al navegador.
 *    Las funciones que arman la vista del estudiante seleccionan solo el
 *    enunciado y las opciones, jamás `correctOption`.
 *  - El reloj corre en el servidor. `expiresAt` se fija al iniciar y se compara
 *    contra la hora del servidor. Cerrar la pestaña no detiene el tiempo.
 *  - La calificación ocurre aquí, en el servidor. El navegador recibe el
 *    resultado ya calculado.
 */

export class AttemptError extends Error {}

// ---------------------------------------------------------------------------
// Lo que ve el estudiante mientras presenta (sin la respuesta correcta)
// ---------------------------------------------------------------------------

export type ExamOption = {
  key: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
  text: string
  /** Si la opción es una imagen (tabla/gráfica) en vez de —o además de— texto. */
  imageUrl: string | null
}

/**
 * Arma la lista de opciones de una versión, dejando solo las que existen (texto
 * o imagen). Una pregunta normal devuelve 4 (A-D); una de emparejamiento del
 * ICFES de inglés, hasta 8 (A-H). Las opciones vacías E-H no se muestran.
 */
function buildExamOptions(v: {
  optionA: string; optionB: string; optionC: string; optionD: string
  optionE: string | null; optionF: string | null; optionG: string | null; optionH: string | null
  optionAImageUrl: string | null; optionBImageUrl: string | null
  optionCImageUrl: string | null; optionDImageUrl: string | null
  optionEImageUrl: string | null; optionFImageUrl: string | null
  optionGImageUrl: string | null; optionHImageUrl: string | null
}): ExamOption[] {
  const all: ExamOption[] = [
    { key: 'A', text: v.optionA, imageUrl: v.optionAImageUrl },
    { key: 'B', text: v.optionB, imageUrl: v.optionBImageUrl },
    { key: 'C', text: v.optionC, imageUrl: v.optionCImageUrl },
    { key: 'D', text: v.optionD, imageUrl: v.optionDImageUrl },
    { key: 'E', text: v.optionE ?? '', imageUrl: v.optionEImageUrl },
    { key: 'F', text: v.optionF ?? '', imageUrl: v.optionFImageUrl },
    { key: 'G', text: v.optionG ?? '', imageUrl: v.optionGImageUrl },
    { key: 'H', text: v.optionH ?? '', imageUrl: v.optionHImageUrl },
  ]
  return all.filter((o) => o.text || o.imageUrl)
}

export type ExamQuestion = {
  order: number
  area: Area
  areaLabel: string
  competency: string
  contextText: string | null
  contextImageUrl: string | null
  stem: string
  imageUrl: string | null
  options: ExamOption[]
  /** La opción que el estudiante ya marcó, si retomó el intento. Nunca la correcta. */
  selected: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | null
}

export type ExamView = {
  attemptId: string
  assessmentTitle: string
  type: 'SIMULACRO' | 'TALLER'
  /** La portada, arriba del todo, como la cabecera de un formulario de Google. */
  coverUrl: string | null
  /** Segundos que faltan según el reloj del servidor. null en talleres (sin cronómetro). */
  secondsRemaining: number | null
  /** La parte que está presentando (1 o 2). */
  currentPart: number
  /** Cuántas partes tiene el simulacro en total (1 o 2). */
  totalParts: number
  /** Las preguntas de la parte EN CURSO (no las de la otra parte). */
  questions: ExamQuestion[]
}

// ---------------------------------------------------------------------------
// Iniciar (o retomar) un intento
// ---------------------------------------------------------------------------

/**
 * Devuelve el intento en curso del estudiante para este assessment, o crea uno.
 *
 * Un estudiante no puede tener dos intentos abiertos del mismo simulacro, ni
 * repetir uno ya enviado (§9): si ya existe un intento SUBMITTED o EXPIRED, se
 * rechaza.
 */
export async function startOrResumeAttempt(userId: string, assessmentId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { groupId: true } })

  const assessment = await db.assessment.findUnique({
    where: { id: assessmentId },
    include: { _count: { select: { questions: true } }, groups: { select: { groupId: true } } },
  })
  if (!assessment || !assessment.published) {
    throw new AttemptError('Este contenido no está disponible.')
  }
  // Control de acceso por grupo: no basta con adivinar el enlace. Un simulacro
  // sin grupos lo puede presentar cualquiera; con grupos, solo los de ese grupo.
  const restricted = assessment.groups.length > 0
  const inGroup = user?.groupId && assessment.groups.some((g) => g.groupId === user.groupId)
  if (restricted && !inGroup) {
    throw new AttemptError('Este simulacro no está disponible para tu grupo.')
  }
  if (assessment._count.questions === 0) {
    throw new AttemptError('Este simulacro todavía no tiene preguntas.')
  }

  const existing = await db.attempt.findFirst({
    where: { userId, assessmentId },
    orderBy: { startedAt: 'desc' },
  })

  if (existing) {
    if (existing.status === 'IN_PROGRESS') return existing.id

    // El intento ya cerró, PERO el simulacro pudo crecer: si tiene una sesión
    // más allá de la que este estudiante alcanzó, se REABRE en la siguiente
    // sesión, conservando las respuestas de la anterior. Pasa siempre que la
    // Sesión 2 se sube DESPUÉS de que el estudiante ya hizo la Sesión 1: sin
    // esto, el sistema le diría "ya completado" y no podría hacer la parte 2.
    const parts = await db.assessmentQuestion.findMany({
      where: { assessmentId },
      select: { part: true },
    })
    const totalParts = parts.reduce((max, q) => Math.max(max, q.part), 1)
    if (existing.currentPart < totalParts) {
      const minutes =
        assessment.durationMinutesPart2 ?? assessment.durationMinutes ?? 60
      await db.attempt.update({
        where: { id: existing.id },
        data: {
          status: 'IN_PROGRESS',
          currentPart: existing.currentPart + 1,
          expiresAt:
            assessment.type === 'SIMULACRO'
              ? new Date(Date.now() + minutes * 60_000)
              : null,
        },
      })
      return existing.id
    }

    // §9: ya hizo todas las sesiones; no se repite un simulacro terminado.
    throw new AttemptError('Ya presentaste este simulacro. No se puede repetir.')
  }

  const expiresAt =
    assessment.type === 'SIMULACRO' && assessment.durationMinutes
      ? new Date(Date.now() + assessment.durationMinutes * 60_000)
      : null

  const attempt = await db.attempt.create({
    data: { userId, assessmentId, status: 'IN_PROGRESS', expiresAt },
  })
  return attempt.id
}

// ---------------------------------------------------------------------------
// Armar la vista del examen (sin respuestas correctas)
// ---------------------------------------------------------------------------

export async function getExamView(userId: string, attemptId: string): Promise<ExamView> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    include: {
      assessment: {
        include: {
          questions: {
            orderBy: { order: 'asc' },
            include: {
              question: {
                include: {
                  currentVersion: true,
                  context: true,
                  competency: true,
                },
              },
            },
          },
        },
      },
      answers: true,
    },
  })

  if (!attempt || attempt.userId !== userId) {
    throw new AttemptError('Intento no encontrado.')
  }
  if (attempt.status !== 'IN_PROGRESS') {
    throw new AttemptError('Este intento ya fue enviado.')
  }

  // Estaba pausado (salió con "Pausar y salir"): al volver a abrir el examen, el
  // reloj se reanuda desde el tiempo que quedaba. Solo aplica a los cronometrados
  // (los talleres no tienen reloj y `remainingMs` es nulo).
  if (attempt.expiresAt === null && attempt.remainingMs != null) {
    const resumed = new Date(Date.now() + attempt.remainingMs)
    await db.attempt.update({
      where: { id: attemptId },
      data: { expiresAt: resumed, remainingMs: null },
    })
    attempt.expiresAt = resumed
    attempt.remainingMs = null
  }

  const totalParts = attempt.assessment.questions.reduce((max, aq) => Math.max(max, aq.part), 1)

  // Si el reloj del servidor dice que el tiempo de la parte en curso ya pasó:
  // en un simulacro de dos partes, la parte 1 vencida avanza a la parte 2; la
  // última parte vencida se envía y se cierra.
  if (attempt.expiresAt && attempt.expiresAt.getTime() <= Date.now()) {
    if (attempt.currentPart < totalParts) {
      await advanceToNextPart(userId, attemptId)
      return getExamView(userId, attemptId)
    }
    await submitAttempt(userId, attemptId, { expired: true })
    throw new AttemptError('Se acabó el tiempo de este simulacro.')
  }

  const selectedByVersion = new Map(attempt.answers.map((a) => [a.questionVersionId, a.selected]))

  const questions: ExamQuestion[] = attempt.assessment.questions
    // Solo las preguntas de la parte en curso.
    .filter((aq) => aq.part === attempt.currentPart)
    .map((aq) => {
      const version = aq.question.currentVersion
      if (!version) throw new AttemptError('Una pregunta del simulacro no tiene contenido publicado.')
      return {
        order: aq.order,
        area: aq.question.area as Area,
        areaLabel: AREA_LABELS[aq.question.area as Area],
        competency: aq.question.competency.name,
        contextText: aq.question.context?.text ?? null,
        contextImageUrl: aq.question.context?.imageUrl ?? null,
        stem: version.stem,
        imageUrl: version.imageUrl,
        // Solo el texto/imagen de cada opción. `correctOption` se queda en el servidor.
        options: buildExamOptions(version),
        selected: selectedByVersion.get(version.id) ?? null,
      }
    })

  const secondsRemaining = attempt.expiresAt
    ? Math.max(0, Math.floor((attempt.expiresAt.getTime() - Date.now()) / 1000))
    : null

  return {
    attemptId: attempt.id,
    assessmentTitle: attempt.assessment.title,
    type: attempt.assessment.type,
    coverUrl: attempt.assessment.coverUploadId
      ? `/api/imagen/${attempt.assessment.coverUploadId}`
      : null,
    secondsRemaining,
    currentPart: attempt.currentPart,
    totalParts,
    questions,
  }
}

/**
 * Pasa el intento a la siguiente parte, con su propio cronómetro. La segunda
 * parte dura `durationMinutesPart2`; si no se fijó, dura lo mismo que la primera.
 *
 * Se llama tanto cuando el estudiante pulsa "Continuar a la parte 2" como cuando
 * el reloj de la parte 1 se agota. Es idempotente frente a partes ya avanzadas:
 * si ya está en la última parte, no hace nada.
 */
export async function advanceToNextPart(userId: string, attemptId: string): Promise<void> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    include: {
      assessment: {
        select: {
          durationMinutes: true,
          durationMinutesPart2: true,
          questions: { select: { part: true } },
        },
      },
    },
  })

  if (!attempt || attempt.userId !== userId) throw new AttemptError('Intento no encontrado.')
  if (attempt.status !== 'IN_PROGRESS') throw new AttemptError('Este intento ya fue enviado.')

  const totalParts = attempt.assessment.questions.reduce((max, q) => Math.max(max, q.part), 1)
  if (attempt.currentPart >= totalParts) return

  const minutes = attempt.assessment.durationMinutesPart2 ?? attempt.assessment.durationMinutes ?? 60
  await db.attempt.update({
    where: { id: attemptId },
    data: {
      currentPart: attempt.currentPart + 1,
      expiresAt: new Date(Date.now() + minutes * 60_000),
    },
  })
}

/**
 * Pausa el cronómetro al salir: guarda el tiempo que quedaba y detiene el reloj
 * (`expiresAt = null`). Al volver a abrir el examen, `getExamView` lo reanuda
 * desde ahí. Salir NUNCA debe fallar, así que ante cualquier caso raro
 * (intento ajeno, ya enviado, sin cronómetro) simplemente no hace nada.
 */
export async function pauseAttempt(userId: string, attemptId: string): Promise<void> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    select: { userId: true, status: true, expiresAt: true },
  })
  if (!attempt || attempt.userId !== userId) return
  if (attempt.status !== 'IN_PROGRESS') return
  if (!attempt.expiresAt) return // taller sin reloj, o ya estaba pausado

  const remaining = Math.max(0, attempt.expiresAt.getTime() - Date.now())
  await db.attempt.update({
    where: { id: attemptId },
    data: { expiresAt: null, remainingMs: remaining },
  })
}

// ---------------------------------------------------------------------------
// Guardar una respuesta (§9: guardado automático, retomable)
// ---------------------------------------------------------------------------

export async function saveAnswer(
  userId: string,
  attemptId: string,
  order: number,
  selected: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | null,
  timeSpentMs = 0,
): Promise<void> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    include: {
      assessment: {
        include: {
          questions: {
            where: { order },
            include: { question: { include: { currentVersion: true } } },
          },
        },
      },
    },
  })

  if (!attempt || attempt.userId !== userId) throw new AttemptError('Intento no encontrado.')
  if (attempt.status !== 'IN_PROGRESS') throw new AttemptError('Este intento ya fue enviado.')

  // El servidor rechaza guardar en un intento cuyo tiempo ya venció.
  if (attempt.expiresAt && attempt.expiresAt.getTime() <= Date.now()) {
    throw new AttemptError('Se acabó el tiempo.')
  }

  const assessmentQuestion = attempt.assessment.questions[0]
  const version = assessmentQuestion?.question.currentVersion
  if (!assessmentQuestion || !version) throw new AttemptError('Pregunta no encontrada.')

  // La corrección se calcula aquí y se guarda; nunca viaja al navegador.
  const isCorrect = selected !== null && selected === version.correctOption

  await db.attemptAnswer.upsert({
    where: { attemptId_questionVersionId: { attemptId, questionVersionId: version.id } },
    create: {
      attemptId,
      questionVersionId: version.id,
      order,
      weight: assessmentQuestion.weight,
      selected,
      isCorrect,
      timeSpentMs,
      answeredAt: new Date(),
    },
    update: {
      selected,
      isCorrect,
      // El tiempo se acumula entre visitas a la misma pregunta.
      timeSpentMs: { increment: timeSpentMs },
      answeredAt: new Date(),
    },
  })
}

// ---------------------------------------------------------------------------
// Enviar y calificar
// ---------------------------------------------------------------------------

export type AttemptResult = {
  attemptId: string
  percent: number
  label: string
  globalScore: number | null
  goalPercent: number | null
  areaScores: Array<{ area: Area; areaLabel: string; score: number }>
}

export async function submitAttempt(
  userId: string,
  attemptId: string,
  { expired = false }: { expired?: boolean } = {},
): Promise<AttemptResult> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    include: {
      user: true,
      assessment: {
        include: {
          questions: {
            include: { question: { include: { currentVersion: true } } },
          },
        },
      },
      answers: true,
    },
  })

  if (!attempt || attempt.userId !== userId) throw new AttemptError('Intento no encontrado.')
  if (attempt.status !== 'IN_PROGRESS') {
    // Ya estaba calificado; devolvemos lo guardado en vez de recalcular.
    return storedResult(attemptId)
  }

  const answerByVersion = new Map(attempt.answers.map((a) => [a.questionVersionId, a]))

  // Toda pregunta del simulacro entra a la calificación. Las que el estudiante
  // no respondió cuentan como en blanco (incorrectas, sin restar).
  const gradable: Array<GradableAnswer & { versionId: string; order: number; weight: number }> = []
  for (const aq of attempt.assessment.questions) {
    const version = aq.question.currentVersion
    if (!version) continue
    const saved = answerByVersion.get(version.id)
    gradable.push({
      area: aq.question.area as Area,
      weight: aq.weight,
      selected: saved?.selected ?? null,
      correctOption: version.correctOption,
      versionId: version.id,
      order: aq.order,
    })
  }

  const graded = gradeAttempt(gradable)

  await db.$transaction(async (tx) => {
    // Persistir respuestas faltantes como en blanco, para dejar el intento completo.
    for (const g of gradable) {
      if (answerByVersion.has(g.versionId)) continue
      await tx.attemptAnswer.create({
        data: {
          attemptId,
          questionVersionId: g.versionId,
          order: g.order,
          weight: g.weight,
          selected: null,
          isCorrect: false,
        },
      })
    }

    await tx.attemptAreaScore.deleteMany({ where: { attemptId } })
    await tx.attemptAreaScore.createMany({
      data: graded.areaScores.map((a) => ({
        attemptId,
        area: a.area,
        score: a.score,
        obtained: a.obtained,
        possible: a.possible,
      })),
    })

    await tx.attempt.update({
      where: { id: attemptId },
      data: {
        status: expired ? 'EXPIRED' : 'SUBMITTED',
        submittedAt: new Date(),
        globalScore: graded.globalScore,
        percent: graded.percent,
        correctCount: graded.correctCount,
        totalWeight: graded.totalWeight,
      },
    })
  })

  const goalPercent =
    graded.globalScore !== null ? goalProgress(graded.globalScore, attempt.user.targetScore) : null

  return {
    attemptId,
    percent: graded.percent,
    label: graded.label,
    globalScore: graded.globalScore,
    goalPercent,
    areaScores: graded.areaScores.map((a) => ({
      area: a.area,
      areaLabel: AREA_LABELS[a.area],
      score: a.score,
    })),
  }
}

async function storedResult(attemptId: string): Promise<AttemptResult> {
  const attempt = await db.attempt.findUniqueOrThrow({
    where: { id: attemptId },
    include: { user: true, areaScores: true },
  })
  return {
    attemptId,
    percent: attempt.percent ?? 0,
    label: qualitativeLabel(attempt.percent ?? 0),
    globalScore: attempt.globalScore,
    goalPercent:
      attempt.globalScore !== null ? goalProgress(attempt.globalScore, attempt.user.targetScore) : null,
    areaScores: attempt.areaScores.map((a) => ({
      area: a.area as Area,
      areaLabel: AREA_LABELS[a.area as Area],
      score: a.score,
    })),
  }
}

// ---------------------------------------------------------------------------
// Lista de simulacros del estudiante
// ---------------------------------------------------------------------------

export type SimulacroCard = {
  assessmentId: string
  title: string
  questionCount: number
  durationMinutes: number | null
  /** Solo los talleres tienen área: son de una sola (§8). */
  areaLabel: string | null
  /** La portada, si el administrador le puso una. */
  coverUrl: string | null
  /** Estado del estudiante frente a este contenido. */
  status: 'NOT_STARTED' | 'IN_PROGRESS' | 'DONE'
  /** El intento que hay que retomar o ver, según el estado. */
  attemptId: string | null
  /**
   * Lo que se muestra si ya lo terminó (§9: no se repite). En simulacros es el
   * puntaje global sobre 500; en talleres, el porcentaje de aciertos, porque un
   * taller de una sola área no produce puntaje global.
   */
  score: number | null
}

/**
 * La condición de acceso por grupo: un estudiante ve un simulacro publicado si
 * el simulacro NO tiene grupos asignados (sin restricción, lo ven todos) O si su
 * grupo está entre los asignados. Un estudiante sin grupo solo ve los que no
 * tienen restricción.
 */
function groupAccessWhere(groupId: string | null) {
  return {
    OR: [
      { groups: { none: {} } },
      ...(groupId ? [{ groups: { some: { groupId } } }] : []),
    ],
  }
}

/** El contenido publicado de un tipo, con el estado de cada uno para el estudiante. */
export async function listStudentAssessments(
  userId: string,
  type: 'SIMULACRO' | 'TALLER',
): Promise<SimulacroCard[]> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { groupId: true } })

  const assessments = await db.assessment.findMany({
    where: { type, published: true, ...groupAccessWhere(user?.groupId ?? null) },
    orderBy: { createdAt: 'asc' },
    include: {
      _count: { select: { questions: true } },
      attempts: { where: { userId }, orderBy: { startedAt: 'desc' }, take: 1 },
      coverUpload: { select: { id: true } },
    },
  })

  return assessments.map((a) => {
    const attempt = a.attempts[0]
    let status: SimulacroCard['status'] = 'NOT_STARTED'
    if (attempt) status = attempt.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'DONE'

    const done = attempt && status === 'DONE'
    return {
      assessmentId: a.id,
      title: a.title,
      questionCount: a._count.questions,
      durationMinutes: a.durationMinutes,
      areaLabel: a.area ? AREA_LABELS[a.area as Area] : null,
      coverUrl: a.coverUpload ? `/api/imagen/${a.coverUpload.id}` : null,
      status,
      attemptId: attempt?.id ?? null,
      score: done ? (type === 'SIMULACRO' ? attempt.globalScore : attempt.percent) : null,
    }
  })
}

/** Los simulacros publicados con el estado de cada uno para este estudiante. */
export function listStudentSimulacros(userId: string): Promise<SimulacroCard[]> {
  return listStudentAssessments(userId, 'SIMULACRO')
}

/** Los talleres publicados con el estado de cada uno para este estudiante. */
export function listStudentTalleres(userId: string): Promise<SimulacroCard[]> {
  return listStudentAssessments(userId, 'TALLER')
}

// ---------------------------------------------------------------------------
// Resultado detallado de un intento (ya terminado)
// ---------------------------------------------------------------------------

export type ReviewQuestion = {
  order: number
  areaLabel: string
  stem: string
  options: ExamOption[]
  selected: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | null
  correct: 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'
  isCorrect: boolean
  explanation: string | null
}

export type AttemptReview = AttemptResult & {
  title: string
  correctCount: number
  totalQuestions: number
  /** El repaso pregunta por pregunta. Aquí SÍ se revela la correcta: ya terminó. */
  questions: ReviewQuestion[]
}

/**
 * El resultado completo de un intento terminado, con el repaso pregunta por
 * pregunta. Solo el dueño del intento puede verlo, y solo si ya lo envió: la
 * respuesta correcta se revela únicamente después de terminar.
 */
export async function getAttemptReview(userId: string, attemptId: string): Promise<AttemptReview> {
  const attempt = await db.attempt.findUnique({
    where: { id: attemptId },
    include: {
      user: true,
      assessment: true,
      areaScores: true,
      answers: {
        orderBy: { order: 'asc' },
        include: { questionVersion: { include: { question: { select: { area: true } } } } },
      },
    },
  })

  if (!attempt || attempt.userId !== userId) throw new AttemptError('Resultado no encontrado.')
  if (attempt.status === 'IN_PROGRESS') throw new AttemptError('Este simulacro todavía no ha terminado.')

  const questions: ReviewQuestion[] = attempt.answers.map((answer) => {
    const version = answer.questionVersion
    return {
      order: answer.order,
      areaLabel: AREA_LABELS[version.question.area as Area],
      stem: version.stem,
      options: buildExamOptions(version),
      selected: answer.selected,
      correct: version.correctOption,
      isCorrect: answer.isCorrect,
      explanation: version.explanation,
    }
  })

  return {
    attemptId,
    title: attempt.assessment.title,
    percent: attempt.percent ?? 0,
    label: qualitativeLabel(attempt.percent ?? 0),
    globalScore: attempt.globalScore,
    goalPercent:
      attempt.globalScore !== null ? goalProgress(attempt.globalScore, attempt.user.targetScore) : null,
    correctCount: attempt.correctCount ?? questions.filter((q) => q.isCorrect).length,
    totalQuestions: questions.length,
    areaScores: attempt.areaScores.map((a) => ({
      area: a.area as Area,
      areaLabel: AREA_LABELS[a.area as Area],
      score: a.score,
    })),
    questions,
  }
}
