'use client'

import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState, useTransition } from 'react'

import {
  advancePartAction,
  pauseAttemptAction,
  saveAnswerAction,
  submitAttemptAction,
} from '@/app/simulacro/[attemptId]/actions'
import { ContextIntro, ContextSource, parseContext } from '@/components/exam/ContextBlock'
import { MathText } from '@/components/math/MathText'
import { hasImageMarker } from '@/lib/context-format'
import type { ExamView } from '@/lib/attempts'
import {
  clampIndex,
  countdownUrgency,
  formatCountdown,
  navProgress,
  type QuestionState,
} from '@/lib/exam-ui'

type OptionKey = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H'

const URGENCY_CLASS: Record<ReturnType<typeof countdownUrgency>, string> = {
  calm: 'bg-card text-navy-900',
  warning: 'bg-warning/15 text-warning',
  critical: 'bg-danger/15 text-danger animate-pulse',
}

export function ExamRunner({ view }: { view: ExamView }) {
  const router = useRouter()
  const [current, setCurrent] = useState(0)
  const [answers, setAnswers] = useState<Record<number, OptionKey | null>>(() =>
    Object.fromEntries(view.questions.map((q) => [q.order, q.selected])),
  )
  const [remaining, setRemaining] = useState<number | null>(view.secondsRemaining)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [exitOpen, setExitOpen] = useState(false)
  const [submitting, startSubmit] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // Momento en que se mostró la pregunta actual, para medir el tiempo por pregunta.
  const shownAt = useRef<number>(performance.now())
  useEffect(() => {
    shownAt.current = performance.now()
  }, [current])

  const questionStates: QuestionState[] = view.questions.map((q) => ({
    order: q.order,
    answered: answers[q.order] != null,
  }))
  const progress = navProgress(questionStates)

  // Un simulacro de dos partes: al terminar la primera se pasa a la segunda, con
  // su propio cronómetro, en vez de calificar.
  const hasNextPart = view.currentPart < view.totalParts

  const submit = useCallback(() => {
    startSubmit(async () => {
      const result = await submitAttemptAction(view.attemptId)
      if (result.ok) router.replace(`/resultados/${view.attemptId}`)
      else setError(result.error)
    })
  }, [router, view.attemptId])

  const advance = useCallback(() => {
    startSubmit(async () => {
      const result = await advancePartAction(view.attemptId)
      // El servidor abre la parte siguiente; `refresh` recarga la página, que
      // vuelve a montar el examen (nueva `key` de parte) con la parte 2.
      if (result.ok) router.refresh()
      else setError(result.error)
    })
  }, [router, view.attemptId])

  // Al agotarse el tiempo: si quedan partes, se pasa a la siguiente; si es la
  // última, se envía. En ambos casos el servidor manda: esto solo lo dispara.
  const finish = hasNextPart ? advance : submit

  // Cronómetro visual. El de verdad está en el servidor: esto solo cuenta hacia
  // abajo, y al llegar a cero dispara el cierre de la parte, que el servidor confirma.
  useEffect(() => {
    if (remaining === null) return
    if (remaining <= 0) {
      finish()
      return
    }
    const id = setTimeout(() => setRemaining((r) => (r === null ? null : r - 1)), 1000)
    return () => clearTimeout(id)
  }, [remaining, finish])

  async function choose(order: number, key: OptionKey) {
    setAnswers((prev) => ({ ...prev, [order]: key }))
    const spent = Math.round(performance.now() - shownAt.current)
    shownAt.current = performance.now()
    const result = await saveAnswerAction(view.attemptId, order, key, spent)
    if (!result.ok) setError(result.error)
  }

  const question = view.questions[clampIndex(current, view.questions.length)]
  if (!question) return null

  const context = question.contextText ? parseContext(question.contextText) : null
  // Si la lectura trae la marca [IMAGEN], la gráfica va DENTRO del contexto, en
  // ese punto exacto; si no, se muestra debajo del enunciado como siempre.
  const imageInContext = !!question.imageUrl && hasImageMarker(question.contextText)
  // ¿Esta pregunta abre un área? Lo es la primera de todas y cada vez que el área
  // cambia respecto a la anterior.
  const index = clampIndex(current, view.questions.length)
  const startsArea = index === 0 || view.questions[index - 1]?.area !== question.area
  const urgency = countdownUrgency(remaining)

  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-4 p-4">
      {/* Encabezado: salir, título, progreso y cronómetro */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setExitOpen(true)}
            className="rounded-lg border border-brand-200 px-3 py-1.5 text-sm font-medium text-navy-900 hover:bg-brand-100"
          >
            ← Salir
          </button>
          <div>
            <h1 className="text-lg font-semibold text-navy-900">{view.assessmentTitle}</h1>
            <p className="text-sm text-muted-600">
              {view.totalParts > 1 && (
                <span className="mr-2 font-semibold text-brand-600">
                  Sesión {view.currentPart} de {view.totalParts} ·
                </span>
              )}
              {progress.answered} de {progress.total} respondidas
            </p>
          </div>
        </div>
        {remaining !== null && (
          <div
            className={`rounded-card px-4 py-2 text-2xl font-bold tabular-nums ${URGENCY_CLASS[urgency]}`}
            role="timer"
            aria-live={urgency === 'critical' ? 'assertive' : 'off'}
          >
            {formatCountdown(remaining)}
          </div>
        )}
      </header>

      {/* La portada, como la cabecera de un formulario de Google. */}
      {view.coverUrl && (
        <Image
          src={view.coverUrl}
          alt=""
          width={1200}
          height={300}
          className="max-h-44 w-full rounded-card object-cover shadow-sm sm:max-h-56"
          priority
        />
      )}

      {/* Barra de progreso */}
      <div className="h-2 overflow-hidden rounded-full bg-brand-200">
        <div
          className="h-full rounded-full bg-brand-600 transition-all"
          style={{ width: `${progress.percent}%` }}
        />
      </div>

      <div className="flex flex-1 flex-col gap-4 md:flex-row">
        {/* Navegador de preguntas */}
        <nav
          aria-label="Preguntas"
          className="order-2 flex flex-wrap gap-2 md:order-1 md:w-40 md:flex-col md:content-start"
        >
          <div className="flex flex-wrap gap-2">
            {view.questions.map((q, index) => {
              const answered = answers[q.order] != null
              const isCurrent = index === current
              return (
                <button
                  key={q.order}
                  type="button"
                  onClick={() => setCurrent(index)}
                  aria-current={isCurrent}
                  className={[
                    'h-9 w-9 rounded-lg text-sm font-semibold transition',
                    isCurrent
                      ? 'ring-2 ring-brand-600 ring-offset-2'
                      : 'ring-1 ring-brand-200',
                    answered ? 'bg-brand-600 text-white' : 'bg-card text-navy-900',
                  ].join(' ')}
                >
                  {q.order}
                </button>
              )
            })}
          </div>
        </nav>

        {/* Pregunta actual */}
        <section className="order-1 flex-1 md:order-2">
          {/* Al empezar cada área se anuncia con su nombre, como en el cuadernillo
              real: el estudiante sabe que cambió de materia y no se pierde. */}
          {startsArea && (
            <div className="mb-3 flex items-center gap-3 rounded-card bg-brand-600 px-5 py-3 text-white shadow-sm">
              <span aria-hidden className="text-2xl">
                📘
              </span>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-brand-100">
                  Comienza el área de
                </p>
                <p className="text-lg font-bold leading-tight">{question.areaLabel}</p>
              </div>
            </div>
          )}

          <article className="rounded-card bg-card p-5 shadow-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-brand-600">
              {question.areaLabel} · {question.competency}
            </p>

            {/* La lectura: instrucción, título y párrafos arriba; la fuente va
                aparte, al final, debajo de la imagen que cita. */}
            {context && (
              <ContextIntro
                context={context}
                imageUrl={imageInContext ? question.imageUrl : null}
              />
            )}
            {question.contextImageUrl && <QuestionImage src={question.contextImageUrl} />}

            <h2 className="mb-4 text-lg font-medium text-navy-900">
              <span className="mr-2 text-brand-600">{question.order}.</span>
              {question.stem ? (
                <MathText text={question.stem} />
              ) : (
                // Preguntas de completar un texto (cloze): el enunciado va vacío.
                <span className="text-muted-600">Elige la opción correcta.</span>
              )}
            </h2>

            {/* La imagen del enunciado va aquí, salvo cuando ya se mostró dentro
                de la lectura (marca [IMAGEN]): así nunca aparece dos veces. */}
            {question.imageUrl && !imageInContext && <QuestionImage src={question.imageUrl} />}

            {/* "Tomado de...": la fuente, al pie de todo lo que cita. */}
            {context && <ContextSource source={context.source} />}

            <ul className="flex flex-col gap-2">
              {question.options.map((option) => {
                const selected = answers[question.order] === option.key
                return (
                  <li key={option.key}>
                    <button
                      type="button"
                      onClick={() => choose(question.order, option.key)}
                      className={[
                        'flex w-full items-center gap-3 rounded-lg border p-3 text-left transition',
                        selected
                          ? 'border-brand-600 bg-brand-100'
                          : 'border-brand-200 bg-white hover:border-brand-500',
                      ].join(' ')}
                    >
                      <span
                        className={[
                          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold',
                          selected ? 'bg-brand-600 text-white' : 'bg-brand-100 text-brand-600',
                        ].join(' ')}
                      >
                        {option.key}
                      </span>
                      {/* La opción puede ser texto, imagen (tabla/gráfica), o ambos. */}
                      <span className="flex min-w-0 flex-col gap-2 text-navy-900">
                        {option.text && <MathText text={option.text} />}
                        {option.imageUrl && <OptionImage src={option.imageUrl} />}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </article>

          {/* Controles */}
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setCurrent((c) => clampIndex(c - 1, view.questions.length))}
              disabled={current === 0}
              className="rounded-lg px-4 py-2 font-medium text-navy-900 disabled:opacity-40"
            >
              ← Anterior
            </button>

            {current < view.questions.length - 1 ? (
              <button
                type="button"
                onClick={() => setCurrent((c) => clampIndex(c + 1, view.questions.length))}
                className="rounded-lg bg-navy-900 px-6 py-2 font-medium text-white"
              >
                Siguiente →
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmOpen(true)}
                className="rounded-lg bg-brand-600 px-6 py-2 font-semibold text-white"
              >
                {hasNextPart ? `Terminar sesión ${view.currentPart} →` : 'Finalizar'}
              </button>
            )}
          </div>
        </section>
      </div>

      {error && (
        <p className="rounded-lg bg-danger/10 p-3 text-center text-sm text-danger" role="alert">
          {error}
        </p>
      )}

      <ConfirmSubmit
        open={confirmOpen}
        unanswered={progress.unanswered}
        submitting={submitting}
        hasNextPart={hasNextPart}
        currentPart={view.currentPart}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={finish}
      />

      <ConfirmExit
        open={exitOpen}
        timed={view.secondsRemaining !== null}
        onCancel={() => setExitOpen(false)}
        onConfirm={async () => {
          // Se pausa el reloj (las respuestas ya están guardadas) y se sale.
          await pauseAttemptAction(view.attemptId)
          router.push('/simulacros')
        }}
      />
    </div>
  )
}

/**
 * La imagen de una pregunta: una gráfica, un mapa, una infografía.
 *
 * Se muestra lo más grande que quepa y se puede abrir a tamaño completo en otra
 * pestaña: una infografía tiene texto pequeño, y sin poder ampliarla el
 * estudiante no puede responder.
 */
function QuestionImage({ src }: { src: string }) {
  return (
    <figure className="mb-4">
      <a
        href={src}
        target="_blank"
        rel="noreferrer"
        className="block rounded-lg ring-1 ring-brand-200 transition hover:ring-2 hover:ring-brand-500"
      >
        <Image
          src={src}
          alt="Imagen de la pregunta"
          width={1200}
          height={900}
          className="mx-auto max-h-[30rem] w-auto max-w-full rounded-lg"
          sizes="(max-width: 768px) 100vw, 700px"
        />
      </a>
      <figcaption className="mt-1 text-center text-xs text-brand-600">
        Toca la imagen para verla en grande
      </figcaption>
    </figure>
  )
}

/**
 * La imagen de una opción de respuesta (una tabla, una gráfica). Va DENTRO del
 * botón de la opción, así que no lleva enlace propio: al tocarla se selecciona
 * la opción, como con el texto.
 */
function OptionImage({ src }: { src: string }) {
  return (
    <Image
      src={src}
      alt="Opción de respuesta"
      width={800}
      height={600}
      className="max-h-72 w-auto max-w-full rounded-lg ring-1 ring-brand-200"
      sizes="(max-width: 768px) 85vw, 460px"
    />
  )
}

/**
 * Salir del simulacro sin terminarlo. Lo respondido queda guardado y se puede
 * retomar. Si el simulacro tiene cronómetro, se avisa: el reloj corre en el
 * servidor y no se detiene al salir.
 */
function ConfirmExit({
  open,
  timed,
  onCancel,
  onConfirm,
}: {
  open: boolean
  timed: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/50 p-4">
      <div className="w-full max-w-sm rounded-card bg-card p-6 text-center shadow-xl">
        <h3 className="text-lg font-semibold text-navy-900">¿Salir del simulacro?</h3>
        <p className="mt-2 text-sm text-muted-600">
          Lo que respondiste queda guardado y puedes continuar donde lo dejaste.
          {timed && (
            <>
              {' '}
              <strong className="text-success">
                El tiempo se pausa hasta que vuelvas a entrar.
              </strong>
            </>
          )}
        </p>
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-brand-200 px-4 py-2 font-medium text-navy-900"
          >
            Seguir aquí
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="flex-1 rounded-lg bg-navy-900 px-4 py-2 font-semibold text-white"
          >
            {timed ? 'Pausar y salir' : 'Salir'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ConfirmSubmit({
  open,
  unanswered,
  submitting,
  hasNextPart,
  currentPart,
  onCancel,
  onConfirm,
}: {
  open: boolean
  unanswered: number[]
  submitting: boolean
  hasNextPart: boolean
  currentPart: number
  onCancel: () => void
  onConfirm: () => void
}) {
  if (!open) return null

  // Cerrar una parte intermedia no califica: abre la siguiente. Solo la última
  // parte finaliza el simulacro. El texto lo deja claro para que el estudiante
  // no crea que ya terminó cuando apenas va por la mitad.
  const nextPart = currentPart + 1
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-navy-950/50 p-4">
      <div className="w-full max-w-sm rounded-card bg-card p-6 text-center shadow-xl">
        <h3 className="text-lg font-semibold text-navy-900">
          {hasNextPart ? `¿Terminar la sesión ${currentPart}?` : '¿Finalizar el simulacro?'}
        </h3>
        {unanswered.length > 0 ? (
          <p className="mt-2 text-sm text-muted-600">
            Te faltan {unanswered.length} pregunta{unanswered.length > 1 ? 's' : ''} sin responder
            ({unanswered.join(', ')}).{' '}
            {hasNextPart
              ? `Al continuar pasarás a la sesión ${nextPart}, con su propio tiempo, y no podrás volver a esta.`
              : 'Una vez que finalices, no podrás volver a presentarlo.'}
          </p>
        ) : (
          <p className="mt-2 text-sm text-muted-600">
            Respondiste todas las preguntas.{' '}
            {hasNextPart
              ? `Al continuar pasarás a la sesión ${nextPart}, con su propio tiempo, y no podrás volver a esta.`
              : 'Una vez que finalices, no podrás volver a presentarlo.'}
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="flex-1 rounded-lg border border-brand-200 px-4 py-2 font-medium text-navy-900"
          >
            Seguir
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="flex-1 rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white disabled:opacity-60"
          >
            {submitting
              ? hasNextPart
                ? 'Pasando…'
                : 'Enviando…'
              : hasNextPart
                ? `Ir a la sesión ${nextPart} →`
                : 'Finalizar'}
          </button>
        </div>
      </div>
    </div>
  )
}
