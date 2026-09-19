import { Component, computed, input, output } from '@angular/core';

import { DiaPipe } from '../../core/fecha.pipe';
import { Artifact } from '../../core/models';

/** `sql-migration` y `migration` son el mismo tipo escrito de dos formas. */
export const NOMBRE_TIPO: Record<string, string> = {
  design: 'diseño',
  schema: 'esquema',
  plan: 'plan',
  api: 'contrato api',
  config: 'configuración',
  'sql-migration': 'migración',
  migration: 'migración',
  component: 'componente',
};

/**
 * Un artefacto: contrato de API, esquema, plan, migración. Contenido más largo
 * que una nota (1.755 caracteres de promedio, picos de 6.000) y casi siempre
 * estructurado, así que abierto se muestra tal cual se guardó.
 */
@Component({
  selector: 'mv-artefacto-fila',
  imports: [DiaPipe],
  templateUrl: './artefacto-fila.html',
  styleUrl: './artefacto-fila.scss',
  host: { '[class.desplegada]': 'desplegada()' },
})
export class ArtefactoFila {
  readonly artefacto = input.required<Artifact>();
  readonly desplegada = input(false);
  readonly alternar = output<string>();

  readonly tipo = computed(() => {
    const t = this.artefacto().type;
    return NOMBRE_TIPO[t] ?? t;
  });

  readonly resumen = computed(() => {
    const limpio = this.artefacto().content.replace(/\s+/g, ' ').trim();
    const corte = limpio.search(/[.:]\s/);
    if (corte > 25 && corte < 140) return limpio.slice(0, corte + 1);
    return limpio.length > 140 ? limpio.slice(0, 139) + '…' : limpio;
  });

  readonly obsoleto = computed(() => this.artefacto().status !== 'active');
  readonly revisiones = computed(() => Math.max(this.artefacto().revision_count - 1, 0));
  readonly lineas = computed(() => this.artefacto().content.split('\n').length);
}
