'use client'

import Link from 'next/link'
import { useActionState, useEffect, useState } from 'react'

import {
  commitImportAction,
  previewImportAction,
  type CommitState,
  type PreviewState,
} from '@/app/admin/preguntas/importar/actions'
import { MathText } from '@/components/math/MathText'
import type { Issue } from '@/lib/import/parse-questions'

const previewInitial: PreviewState = { result: null, error: null }
const commitInitial: CommitState = { ok: false, error: null, summary: null }

type ExistingSimulacro = { title: string; count: number }

export function ImportQuestions({ existing = [] }: { existing?: ExistingSimulacro[] }) {
  const [preview, previewAction, previewing] = useActionState(previewImportAction, previewInitial)
  const [commit, commitAction, committing] = useActionState(commitImportAction, commitInitial)

  // Ya se cargó: mostramos el resumen y no el formulario.
  if (commit.ok && commit.summary) {
    return (
      <div className="rounded-card bg-card p-6 shadow-sm">
        <h2 className="text-xl font-semibold text-success">✔ Carga completada</h2>
        <p className="mt-2 text-navy-900">
          Se cargaron <strong>{commit.summary.questions}</strong> preguntas
          {commit.summary.contexts > 0 && <> y {commit.summary.contexts} textos de contexto</>}.
        </p>
        {commit.summary.assessments.length > 0 && (
          <p className="mt-1 text-muted-600">
            Se armaron o ampliaron: {commit.summary.assessments.join(', ')}.
          </p>
        )}
        <div className="mt-5 flex gap-3">
          <Link href="/admin" className="rounded-lg bg-navy-900 px-4 py-2 text-white">
            Volver al panel
          </Link>
          <Link href="/admin/preguntas/importar" className="rounded-lg border border-brand-200 px-4 py-2 text-navy-900">
            Cargar otro archivo
          </Link>
        </div>
      </div>
    )
  }

  const result = preview.result

  // El nombre de simulacro que trae el Excel (el de la primera pregunta que lo
  // tenga). Es solo la sugerencia inicial: el admin puede cambiarlo abajo.
  const excelName = result?.questions.find((q) => q.simulacro)?.simulacro ?? ''
  const [target, setTarget] = useState('')
  // Cuando llega una vista previa nueva, arranca con el nombre del Excel.
  useEffect(() => {
    setTarget(excelName)
  }, [excelName])

  const trimmed = target.trim()
  const match = existing.find((e) => e.title.toLowerCase() === trimmed.toLowerCase())

  return (
    <div className="flex flex-col gap-6">
      {/* Paso 1: subir */}
      <form action={previewAction} className="rounded-card bg-card p-6 shadow-sm">
        <h2 className="text-lg font-semibold text-navy-900">1. Sube tu archivo de preguntas</h2>
        <p className="mt-1 text-sm text-muted-600">
          Usa la plantilla de SORA (.xlsx). Primero verás una vista previa; nada se guarda hasta que confirmes.
        </p>
        <p className="mt-2 rounded-lg bg-brand-100/60 px-3 py-2 text-sm text-navy-800">
          <strong>¿Preguntas con fórmulas?</strong> Escríbelas entre dobles signos de dólar, como en
          LaTeX: <code className="rounded bg-white px-1">$$\frac&#123;1&#125;&#123;13&#125;$$</code> se
          ve como una fracción, <code className="rounded bg-white px-1">$$x^2$$</code> como x al
          cuadrado, <code className="rounded bg-white px-1">$$\sqrt&#123;2&#125;$$</code> como raíz de
          2. Los precios con un solo <code className="rounded bg-white px-1">$</code> (como $5.000) se
          quedan tal cual.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            type="file"
            name="file"
            accept=".xlsx"
            required
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-100 file:px-4 file:py-2 file:font-medium file:text-brand-600"
          />
          <button
            type="submit"
            disabled={previewing}
            className="rounded-lg bg-brand-600 px-5 py-2 font-medium text-white disabled:opacity-60"
          >
            {previewing ? 'Leyendo…' : 'Ver vista previa'}
          </button>
        </div>
        {preview.error && (
          <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {preview.error}
          </p>
        )}
      </form>

      {/* Paso 2: vista previa */}
      {result && (
        <div className="rounded-card bg-card p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-navy-900">2. Revisa antes de confirmar</h2>

          <div className="mt-3 flex flex-wrap gap-3 text-sm">
            <Badge tone="success" label={`${result.summary.valid} se cargarían`} />
            <Badge tone="danger" label={`${result.summary.withErrors} bloqueadas`} />
            <Badge tone="warning" label={`${result.summary.withWarnings} para revisar`} />
          </div>

          {result.issues.length > 0 && <IssueList issues={result.issues} />}

          {/* Vista de las preguntas que entrarían */}
          <div className="mt-5 flex flex-col gap-3">
            {result.questions.slice(0, 50).map((q) => (
              <article key={q.rowNumber} className="rounded-lg border border-brand-100 p-3">
                <p className="text-xs font-semibold uppercase text-brand-600">
                  Fila {q.rowNumber} · {q.competencia} · {q.simulacro ?? q.taller ?? 'banco'}
                </p>
                <p className="mt-1 font-medium text-navy-900">
                  <MathText text={q.stem} />
                </p>
                <ul className="mt-2 grid gap-1 text-sm sm:grid-cols-2">
                  {(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'] as const)
                    .filter((k) => q.options[k] || q.optionImages?.[k])
                    .map((k) => (
                    <li
                      key={k}
                      className={
                        k === q.correctOption ? 'font-semibold text-success' : 'text-navy-800'
                      }
                    >
                      {k === q.correctOption ? '✔ ' : ''}
                      {k}. {q.options[k] && <MathText text={q.options[k]} />}
                      {q.optionImages?.[k] && (
                        // Se resuelve por nombre; si aún no la subes, saldrá rota
                        // (la lista de advertencias arriba ya te lo avisa).
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={`/api/imagen/nombre/${encodeURIComponent(q.optionImages[k]!)}`}
                          alt={`Opción ${k}`}
                          className="mt-1 max-h-40 w-auto max-w-full rounded ring-1 ring-brand-200"
                        />
                      )}
                    </li>
                  ))}
                </ul>
              </article>
            ))}
            {result.questions.length > 50 && (
              <p className="text-sm text-muted-600">… y {result.questions.length - 50} preguntas más.</p>
            )}
          </div>

          {/* Confirmar */}
          {result.questions.length > 0 ? (
            <form action={commitAction} className="mt-6">
              <input type="hidden" name="questions" value={JSON.stringify(result.questions)} />

              {/* Destino: crea uno nuevo o agrega a uno existente, según el nombre. */}
              <div className="mb-5 rounded-lg border border-brand-200 bg-brand-50/60 p-4">
                <label htmlFor="targetSimulacro" className="block font-semibold text-navy-900">
                  ¿A qué simulacro van estas preguntas?
                </label>
                <p className="mt-1 text-sm text-muted-600">
                  Escribe un nombre <strong>nuevo</strong> para crear otro simulacro, o el de uno que{' '}
                  <strong>ya existe</strong> para agregarle estas preguntas.
                </p>
                <input
                  id="targetSimulacro"
                  name="targetSimulacro"
                  type="text"
                  list="simulacros-existentes"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                  placeholder="Ej: Simulacro 02"
                  className="mt-3 w-full rounded-lg border border-brand-200 px-3 py-2 text-navy-900"
                />
                <datalist id="simulacros-existentes">
                  {existing.map((e) => (
                    <option key={e.title} value={e.title} />
                  ))}
                </datalist>
                {trimmed === '' ? (
                  <p className="mt-2 text-sm text-warning">
                    ⚠️ Sin nombre, las preguntas van al banco pero no a ningún simulacro.
                  </p>
                ) : match ? (
                  <p className="mt-2 text-sm text-warning">
                    ➕ «{match.title}» <strong>ya existe</strong> ({match.count} preguntas). Estas se
                    le <strong>agregarán</strong> (no se borra nada).
                  </p>
                ) : (
                  <p className="mt-2 text-sm text-success">
                    ✔ Se <strong>creará un simulacro nuevo</strong> llamado «{trimmed}».
                  </p>
                )}
                {existing.length > 0 && (
                  <p className="mt-2 text-xs text-muted-600">
                    Ya existen: {existing.map((e) => `${e.title} (${e.count})`).join(' · ')}
                  </p>
                )}
              </div>

              <button
                type="submit"
                disabled={committing}
                className="rounded-lg bg-success px-6 py-2.5 font-semibold text-white disabled:opacity-60"
              >
                {committing
                  ? 'Cargando…'
                  : `Confirmar y cargar ${result.questions.length} preguntas${trimmed ? ` en «${trimmed}»` : ''}`}
              </button>
              {commit.error && (
                <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
                  {commit.error}
                </p>
              )}
            </form>
          ) : (
            <p className="mt-6 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
              Ninguna pregunta se puede cargar todavía. Corrige los errores marcados arriba y vuelve a subir el archivo.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function Badge({ tone, label }: { tone: 'success' | 'danger' | 'warning'; label: string }) {
  const cls = {
    success: 'bg-success/15 text-success',
    danger: 'bg-danger/15 text-danger',
    warning: 'bg-warning/15 text-warning',
  }[tone]
  return <span className={`rounded-full px-3 py-1 font-medium ${cls}`}>{label}</span>
}

function IssueList({ issues }: { issues: Issue[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-1.5 text-sm">
      {issues.map((issue, i) => (
        <li
          key={`${issue.rowNumber}-${i}`}
          className={`rounded-lg px-3 py-2 ${
            issue.severity === 'error' ? 'bg-danger/10 text-danger' : 'bg-warning/10 text-warning'
          }`}
        >
          <strong>Fila {issue.rowNumber}</strong>
          {issue.column ? ` · ${issue.column}` : ''}: {issue.message}
        </li>
      ))}
    </ul>
  )
}
