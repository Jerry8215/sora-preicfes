/**
 * A dónde van las preguntas de una carga: al simulacro/taller que dice el Excel,
 * o al que el administrador eligió en la pantalla.
 *
 * Vive aparte porque aquí se coló un error que llegó a producción: el destino de
 * la pantalla era SIEMPRE un simulacro, así que escribir ahí el nombre de un
 * taller creaba un simulacro llamado "Taller 1" y borraba la columna `taller`
 * del Excel. El taller acababa listado entre los simulacros.
 */

export type AssessmentType = 'SIMULACRO' | 'TALLER'

export type Destino = { simulacro: string; taller: string }

/**
 * Decide las dos columnas de destino de una pregunta.
 *
 * Sin destino escrito en la pantalla, manda el Excel. Con destino escrito, manda
 * la pantalla —nombre Y tipo—: es lo que permite crear uno nuevo o ampliar uno
 * existente sin depender de lo que traiga el archivo.
 */
export function resolveTarget(
  fromExcel: { simulacro?: string | null; taller?: string | null },
  target: string,
  targetType: AssessmentType,
): Destino {
  const elegido = target.trim()
  if (!elegido) {
    return { simulacro: fromExcel.simulacro ?? '', taller: fromExcel.taller ?? '' }
  }
  return targetType === 'TALLER'
    ? { simulacro: '', taller: elegido }
    : { simulacro: elegido, taller: '' }
}

/**
 * El destino que sugiere un archivo ya leído: el de la primera pregunta que
 * traiga uno, sea de la columna `simulacro` o de la columna `taller`.
 *
 * Mirar solo `simulacro` —como se hacía— dejaba el campo vacío al subir un
 * archivo de talleres, y el aviso de "no van a ningún simulacro" empujaba a
 * escribir el nombre a mano, con el tipo equivocado.
 */
export function suggestTarget(
  questions: Array<{ simulacro?: string | null; taller?: string | null }>,
): { name: string; type: AssessmentType } {
  const first = questions.find((q) => q.simulacro || q.taller)
  if (first?.taller) return { name: first.taller, type: 'TALLER' }
  return { name: first?.simulacro ?? '', type: 'SIMULACRO' }
}
