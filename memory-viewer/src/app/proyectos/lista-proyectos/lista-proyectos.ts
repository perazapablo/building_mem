import { Component, input, output } from '@angular/core';

import { Project } from '../../core/models';

@Component({
  selector: 'mv-lista-proyectos',
  imports: [],
  templateUrl: './lista-proyectos.html',
  styleUrl: './lista-proyectos.scss',
})
export class ListaProyectos {
  readonly proyectos = input.required<Project[]>();
  readonly seleccionadoId = input<string | null>(null);
  readonly seleccionar = output<Project>();
}
