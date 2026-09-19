import { Component, input, output } from '@angular/core';

import { SessionBundle, SessionIndexRow, SessionRow } from '../../core/models';
import { SesionFila } from '../sesion-fila/sesion-fila';

@Component({
  selector: 'mv-panel-sesiones',
  imports: [SesionFila],
  templateUrl: './panel-sesiones.html',
  styleUrl: './panel-sesiones.scss',
})
export class PanelSesiones {
  readonly sesiones = input.required<SessionIndexRow[]>();
  readonly cargando = input(false);
  readonly abiertaId = input<string | null>(null);
  readonly detalles = input<Record<string, SessionRow | null>>({});
  readonly bundles = input<Record<string, SessionBundle>>({});
  readonly alternar = output<string>();

  detalle(id: string): SessionRow | null | undefined {
    return this.detalles()[id];
  }

  bundle(id: string): SessionBundle | undefined {
    return this.bundles()[id];
  }
}
