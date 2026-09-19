import { Component, computed, input, output, signal } from '@angular/core';

import { Artifact } from '../../core/models';
import { ArtefactoFila, NOMBRE_TIPO } from '../artefacto-fila/artefacto-fila';

@Component({
  selector: 'mv-panel-artefactos',
  imports: [ArtefactoFila],
  templateUrl: './panel-artefactos.html',
  styleUrl: './panel-artefactos.scss',
})
export class PanelArtefactos {
  readonly artefactos = input.required<Artifact[]>();
  readonly cargando = input(false);
  readonly abiertaId = input<string | null>(null);
  readonly alternar = output<string>();

  readonly busqueda = signal('');
  readonly tipo = signal<string | null>(null);
  readonly verObsoletos = signal(false);

  /** Sin tags en ningún artefacto de la base, el tipo es el único índice que hay. */
  readonly tipos = computed(() => {
    const cuenta = new Map<string, number>();
    for (const a of this.artefactos()) {
      if (a.status !== 'active' && !this.verObsoletos()) continue;
      cuenta.set(a.type, (cuenta.get(a.type) ?? 0) + 1);
    }
    return [...cuenta.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([id, cantidad]) => ({ id, nombre: NOMBRE_TIPO[id] ?? id, cantidad }));
  });

  readonly visibles = computed(() => {
    const q = this.busqueda().trim().toLowerCase();
    const tipo = this.tipo();
    return this.artefactos()
      .filter((a) => a.status === 'active' || this.verObsoletos())
      .filter((a) => !tipo || a.type === tipo)
      .filter((a) => !q || a.content.toLowerCase().includes(q))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  });

  readonly obsoletos = computed(
    () => this.artefactos().filter((a) => a.status !== 'active').length,
  );

  elegirTipo(t: string): void {
    this.tipo.update((actual) => (actual === t ? null : t));
  }

  limpiar(): void {
    this.tipo.set(null);
    this.busqueda.set('');
  }
}
