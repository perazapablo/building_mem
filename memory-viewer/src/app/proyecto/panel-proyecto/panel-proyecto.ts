import { Component, computed, input, output, signal } from '@angular/core';

import { PanelArtefactos } from '../../artefactos/panel-artefactos/panel-artefactos';
import { DiaPipe } from '../../core/fecha.pipe';
import { Artifact, DecisionRecord, Note, ProjectPath, ProjectThread } from '../../core/models';
import { PanelDecisiones } from '../../decisiones/panel-decisiones/panel-decisiones';
import { PanelNotas } from '../../notas/panel-notas/panel-notas';
import { Solapa, Solapas } from '../../ui/solapas/solapas';

export interface AperturaSeccion {
  seccion: string;
  id: string;
}

export interface CierreHilo {
  id: string;
  /** 'done' = se terminó; 'dropped' = se descartó. El repo no acepta otra cosa. */
  status: string;
  razon: string;
}

/**
 * El proyecto por dentro: dónde vive, qué quedó abierto, y el conocimiento
 * guardado. Las tres secciones de conocimiento eran solapas de primer nivel;
 * acá bajan un escalón, porque lo primero que se mira de un proyecto es su
 * estado, no su inventario.
 */
@Component({
  selector: 'mv-panel-proyecto',
  imports: [PanelNotas, PanelDecisiones, PanelArtefactos, Solapas, DiaPipe],
  templateUrl: './panel-proyecto.html',
  styleUrl: './panel-proyecto.scss',
})
export class PanelProyecto {
  readonly paths = input<ProjectPath[]>([]);
  readonly hilos = input<ProjectThread[]>([]);
  readonly notas = input<Note[]>([]);
  readonly decisiones = input<DecisionRecord[]>([]);
  readonly artefactos = input<Artifact[]>([]);
  readonly cargando = input(false);
  readonly abiertas = input<Record<string, string | null>>({});

  readonly alternar = output<AperturaSeccion>();
  readonly abrirHilo = output<string>();
  readonly cerrarHilo = output<CierreHilo>();

  readonly seccion = signal<string>('notas');
  readonly verCerrados = signal(false);

  /** Texto del hilo nuevo, y el hilo que se está cerrando con su razón. */
  readonly nuevo = signal('');
  readonly cerrandoId = signal<string | null>(null);
  readonly estadoCierre = signal<'done' | 'dropped'>('done');
  readonly razon = signal('');

  readonly abiertos = computed(() => this.hilos().filter((h) => h.status === 'open'));
  readonly cerrados = computed(() => this.hilos().filter((h) => h.status !== 'open'));

  readonly subsolapas = computed<Solapa[]>(() => [
    { id: 'notas', etiqueta: 'Notas', cantidad: this.notas().length },
    { id: 'decisiones', etiqueta: 'Decisiones', cantidad: this.decisiones().length },
    { id: 'artefactos', etiqueta: 'Artefactos', cantidad: this.artefactos().length },
  ]);

  abiertaEn(seccion: string): string | null {
    return this.abiertas()[seccion] ?? null;
  }

  /** Un hilo abierto desde el viewer no tiene sesión: se dice, no se disfraza. */
  deQuien(sessionId: string | null): string {
    if (!sessionId) return '';
    return sessionId === 'viewer' ? 'desde el viewer' : `en la sesión ${sessionId.slice(0, 8)}`;
  }

  comoTermino(status: string): string {
    return status === 'done' ? 'terminado' : status === 'dropped' ? 'descartado' : status;
  }

  empezarCierre(id: string, estado: 'done' | 'dropped'): void {
    this.cerrandoId.set(id);
    this.estadoCierre.set(estado);
    this.razon.set('');
  }

  cancelarCierre(): void {
    this.cerrandoId.set(null);
    this.razon.set('');
  }

  confirmarCierre(): void {
    const id = this.cerrandoId();
    if (!id) return;
    this.cerrarHilo.emit({ id, status: this.estadoCierre(), razon: this.razon().trim() });
    this.cancelarCierre();
  }

  crear(): void {
    const texto = this.nuevo().trim();
    if (!texto) return;
    this.abrirHilo.emit(texto);
    this.nuevo.set('');
  }
}
