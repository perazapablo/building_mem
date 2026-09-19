import { Component, input } from '@angular/core';

@Component({
  selector: 'mv-barra-superior',
  imports: [],
  templateUrl: './barra-superior.html',
  styleUrl: './barra-superior.scss',
})
export class BarraSuperior {
  readonly rutaBase = input.required<string>();
  readonly totalProyectos = input.required<number>();
}
