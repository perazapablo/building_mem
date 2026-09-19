import { Component, input, output } from '@angular/core';

import { DecisionRecord } from '../../core/models';
import { DecisionFila } from '../decision-fila/decision-fila';

@Component({
  selector: 'mv-panel-decisiones',
  imports: [DecisionFila],
  templateUrl: './panel-decisiones.html',
  styleUrl: './panel-decisiones.scss',
})
export class PanelDecisiones {
  readonly decisiones = input.required<DecisionRecord[]>();
  readonly cargando = input(false);
  readonly abiertaId = input<string | null>(null);
  readonly alternar = output<string>();
}
