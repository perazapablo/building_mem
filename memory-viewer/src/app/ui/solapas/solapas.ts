import { Component, input, output } from '@angular/core';

export interface Solapa {
  id: string;
  etiqueta: string;
  cantidad?: number;
}

@Component({
  selector: 'mv-solapas',
  imports: [],
  templateUrl: './solapas.html',
  styleUrl: './solapas.scss',
})
export class Solapas {
  readonly solapas = input.required<Solapa[]>();
  readonly activa = input.required<string>();
  readonly cambiar = output<string>();
}
