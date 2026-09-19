import { Component, input, output } from '@angular/core';

import { DiaPipe } from '../../core/fecha.pipe';
import { DecisionRecord } from '../../core/models';

/**
 * Una decisión vigente. Colapsada muestra qué se decidió; desplegada, cómo se
 * llegó: qué restringía, qué se descartó y con qué consecuencias.
 */
@Component({
  selector: 'mv-decision-fila',
  imports: [DiaPipe],
  templateUrl: './decision-fila.html',
  styleUrl: './decision-fila.scss',
  host: { '[class.desplegada]': 'desplegada()' },
})
export class DecisionFila {
  readonly decision = input.required<DecisionRecord>();
  readonly desplegada = input(false);
  readonly alternar = output<string>();

  /** `user_explicit` → `explícita`: el origen es la defensa contra rationale inventado. */
  get origen(): string {
    switch (this.decision().origin) {
      case 'user_explicit':
        return 'la pediste';
      case 'user_implicit':
        return 'se dedujo de vos';
      case 'agent_inferred':
        return 'la infirió el agente';
      default:
        return this.decision().origin;
    }
  }
}
