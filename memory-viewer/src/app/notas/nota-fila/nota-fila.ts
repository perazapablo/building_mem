import { Component, computed, input, output } from '@angular/core';

import { DiaPipe } from '../../core/fecha.pipe';
import { Note } from '../../core/models';

/**
 * Una nota del registro. Colapsada muestra su primera frase; desplegada, el
 * texto entero. El promedio son 800 caracteres y hay picos de 3.800: mostrarlo
 * todo de entrada convierte la lista en un muro.
 */
@Component({
  selector: 'mv-nota-fila',
  imports: [DiaPipe],
  templateUrl: './nota-fila.html',
  styleUrl: './nota-fila.scss',
  host: { '[class.desplegada]': 'desplegada()' },
})
export class NotaFila {
  readonly nota = input.required<Note>();
  readonly desplegada = input(false);
  readonly alternar = output<string>();
  readonly filtrarTag = output<string>();

  /** La primera frase alcanza para saber si es la que se busca. */
  readonly resumen = computed(() => {
    const limpio = this.nota().content.replace(/\s+/g, ' ').trim();
    const corte = limpio.search(/[.:]\s/);
    if (corte > 25 && corte < 150) return limpio.slice(0, corte + 1);
    return limpio.length > 150 ? limpio.slice(0, 149) + '…' : limpio;
  });

  readonly obsoleta = computed(() => this.nota().status !== 'active');

  /** Sólo se anuncia cuando pasó de verdad: una nota reescrita ya no dice lo mismo. */
  readonly revisiones = computed(() => Math.max(this.nota().revision_count - 1, 0));
}
