import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { resolveTarget, suggestTarget } from '@/lib/import/target'

describe('destino de una carga de preguntas', () => {
  it('sin destino en la pantalla, manda el Excel', () => {
    assert.deepEqual(resolveTarget({ simulacro: 'Simulacro 01' }, '', 'SIMULACRO'), {
      simulacro: 'Simulacro 01',
      taller: '',
    })
    assert.deepEqual(resolveTarget({ taller: 'Taller 1' }, '', 'SIMULACRO'), {
      simulacro: '',
      taller: 'Taller 1',
    })
  })

  it('un taller elegido en la pantalla NO se convierte en simulacro', () => {
    // El error que llegó a producción: el destino se escribía siempre en la
    // columna `simulacro`, así que "Taller 1" nacía como simulacro.
    assert.deepEqual(resolveTarget({ taller: 'Taller 1' }, 'Taller 1', 'TALLER'), {
      simulacro: '',
      taller: 'Taller 1',
    })
  })

  it('el destino de la pantalla pisa lo que diga el Excel, con su tipo', () => {
    assert.deepEqual(resolveTarget({ simulacro: 'Simulacro 01' }, 'Taller 5', 'TALLER'), {
      simulacro: '',
      taller: 'Taller 5',
    })
    assert.deepEqual(resolveTarget({ taller: 'Taller 1' }, 'Simulacro 02', 'SIMULACRO'), {
      simulacro: 'Simulacro 02',
      taller: '',
    })
  })

  it('los espacios sobrantes no cuentan como destino', () => {
    assert.deepEqual(resolveTarget({ simulacro: 'Simulacro 01' }, '   ', 'TALLER'), {
      simulacro: 'Simulacro 01',
      taller: '',
    })
  })

  it('una pregunta suelta, sin simulacro ni taller, va solo al banco', () => {
    assert.deepEqual(resolveTarget({}, '', 'SIMULACRO'), { simulacro: '', taller: '' })
  })
})

describe('destino que sugiere el archivo', () => {
  it('sugiere el taller cuando el Excel trae la columna taller', () => {
    // Antes solo se miraba `simulacro`: el campo salía vacío y el aviso de
    // "no van a ningún simulacro" empujaba a escribirlo a mano y mal.
    assert.deepEqual(suggestTarget([{ taller: 'Taller 1 - Lectura Crítica' }]), {
      name: 'Taller 1 - Lectura Crítica',
      type: 'TALLER',
    })
  })

  it('sugiere el simulacro cuando el Excel trae la columna simulacro', () => {
    assert.deepEqual(suggestTarget([{ simulacro: 'Simulacro 01' }]), {
      name: 'Simulacro 01',
      type: 'SIMULACRO',
    })
  })

  it('se salta las preguntas sin destino y toma la primera que sí lo tenga', () => {
    assert.deepEqual(suggestTarget([{}, { taller: 'Taller 2' }]), {
      name: 'Taller 2',
      type: 'TALLER',
    })
  })

  it('un archivo sin ningún destino no sugiere nada', () => {
    assert.deepEqual(suggestTarget([{}, {}]), { name: '', type: 'SIMULACRO' })
  })
})
