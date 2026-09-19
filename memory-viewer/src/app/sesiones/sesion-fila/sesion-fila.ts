import { Component, input, output } from '@angular/core';

import { DiaPipe, HoraPipe } from '../../core/fecha.pipe';
import { SessionBundle, SessionIndexRow, SessionRow } from '../../core/models';

/**
 * Una sesión del registro. Colapsada muestra una línea; desplegada, el cierre
 * que dejó. No pide datos: el detalle se lo pasa quien la contiene.
 */
@Component({
  selector: 'mv-sesion-fila',
  imports: [DiaPipe, HoraPipe],
  templateUrl: './sesion-fila.html',
  styleUrl: './sesion-fila.scss',
  host: { '[class.desplegada]': 'desplegada()' },
})
export class SesionFila {
  readonly sesion = input.required<SessionIndexRow>();
  readonly desplegada = input(false);
  /** `undefined` mientras viaja; `null` si el servidor no la encontró. */
  readonly detalle = input<SessionRow | null | undefined>(undefined);
  /** Lo que dejó la sesión: focus, decisiones, hilos, notas, artefactos. */
  readonly bundle = input<SessionBundle | undefined>(undefined);
  readonly alternar = output<string>();

  /** Primera frase: en la lista de lo producido alcanza para reconocerlo. */
  resumir(texto: string): string {
    const limpio = (texto || '').replace(/\s+/g, ' ').trim();
    const corte = limpio.search(/[.:]\s/);
    if (corte > 20 && corte < 120) return limpio.slice(0, corte + 1);
    return limpio.length > 120 ? limpio.slice(0, 119) + '…' : limpio;
  }

  /** `user_explicit` no significa nada para quien mira. */
  origenDe(origen: string): string {
    switch (origen) {
      case 'user_explicit':
        return 'la pediste';
      case 'user_implicit':
        return 'se dedujo de vos';
      case 'agent_inferred':
        return 'la infirió el agente';
      default:
        return origen;
    }
  }
}
