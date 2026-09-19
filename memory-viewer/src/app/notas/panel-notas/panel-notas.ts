import { Component, computed, input, output, signal } from '@angular/core';

import { Note } from '../../core/models';
import { NotaFila } from '../nota-fila/nota-fila';

@Component({
  selector: 'mv-panel-notas',
  imports: [NotaFila],
  templateUrl: './panel-notas.html',
  styleUrl: './panel-notas.scss',
})
export class PanelNotas {
  readonly notas = input.required<Note[]>();
  readonly cargando = input(false);
  readonly abiertaId = input<string | null>(null);
  readonly alternar = output<string>();

  readonly busqueda = signal('');
  readonly tag = signal<string | null>(null);
  /** Las obsoletas arrancan ocultas: son 7 de 273 y ensucian la lectura normal. */
  readonly verObsoletas = signal(false);

  /** Los tags que de verdad agrupan algo, del más usado al menos. */
  readonly tags = computed(() => {
    const cuenta = new Map<string, number>();
    for (const n of this.notas()) {
      if (n.status !== 'active' && !this.verObsoletas()) continue;
      for (const t of n.tags) cuenta.set(t, (cuenta.get(t) ?? 0) + 1);
    }
    return [...cuenta.entries()]
      .filter(([, n]) => n > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([nombre, cantidad]) => ({ nombre, cantidad }));
  });

  readonly visibles = computed(() => {
    const q = this.busqueda().trim().toLowerCase();
    const tag = this.tag();
    return this.notas()
      .filter((n) => (n.status === 'active' || this.verObsoletas()))
      .filter((n) => !tag || n.tags.includes(tag))
      .filter((n) => !q || n.content.toLowerCase().includes(q))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  });

  readonly obsoletas = computed(() => this.notas().filter((n) => n.status !== 'active').length);

  elegirTag(t: string): void {
    this.tag.update((actual) => (actual === t ? null : t));
  }

  limpiar(): void {
    this.tag.set(null);
    this.busqueda.set('');
  }
}
