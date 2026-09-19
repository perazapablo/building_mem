import { Component, OnInit, computed, signal } from '@angular/core';

import { MemoryService } from './core/memory.service';
import {
  Artifact,
  Dashboard,
  DecisionRecord,
  Note,
  Project,
  ProjectGraph,
  ProjectPath,
  ProjectThread,
  SessionBundle,
  SessionIndexRow,
  SessionRow,
} from './core/models';
import { PanelGrafo } from './grafo/panel-grafo/panel-grafo';
import {
  AperturaSeccion,
  CierreHilo,
  PanelProyecto,
} from './proyecto/panel-proyecto/panel-proyecto';
import { ListaProyectos } from './proyectos/lista-proyectos/lista-proyectos';
import { PanelResumen } from './resumen/panel-resumen/panel-resumen';
import { PanelSesiones } from './sesiones/panel-sesiones/panel-sesiones';
import { BarraSuperior } from './ui/barra-superior/barra-superior';
import { Solapa, Solapas } from './ui/solapas/solapas';

type Vista = 'resumen' | 'proyecto' | 'sesiones' | 'grafo';

/**
 * Shell: sostiene el estado y coordina los paneles. Los componentes de
 * abajo son de presentación — reciben datos y emiten intención.
 *
 * El orden de las solapas es el recorrido: qué pasó (resumen) → qué hay
 * (proyecto) → cuándo pasó (sesiones) → cómo se relaciona (grafo).
 */
@Component({
  selector: 'app-root',
  imports: [
    BarraSuperior,
    ListaProyectos,
    PanelResumen,
    PanelProyecto,
    PanelSesiones,
    PanelGrafo,
    Solapas,
  ],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit {
  readonly rutaBase = signal('');
  readonly proyectos = signal<Project[]>([]);
  readonly seleccionado = signal<Project | null>(null);
  readonly cargando = signal(false);
  readonly error = signal<string | null>(null);

  readonly sesiones = signal<SessionIndexRow[]>([]);
  readonly decisiones = signal<DecisionRecord[]>([]);
  readonly notas = signal<Note[]>([]);
  readonly artefactos = signal<Artifact[]>([]);
  readonly hilos = signal<ProjectThread[]>([]);
  readonly paths = signal<ProjectPath[]>([]);
  readonly resumen = signal<Dashboard | null>(null);
  readonly grafo = signal<ProjectGraph | null>(null);

  readonly vista = signal<Vista>('resumen');
  /** Una fila abierta por sección: cambiar de solapa no pierde lo desplegado. */
  readonly abiertas = signal<Record<string, string | null>>({});
  readonly detallesSesion = signal<Record<string, SessionRow | null>>({});
  readonly bundles = signal<Record<string, SessionBundle>>({});

  readonly hilosAbiertos = computed(() => this.hilos().filter((h) => h.status === 'open').length);

  readonly solapas = computed<Solapa[]>(() => [
    { id: 'resumen', etiqueta: 'Resumen' },
    { id: 'proyecto', etiqueta: 'Proyecto', cantidad: this.hilosAbiertos() },
    { id: 'sesiones', etiqueta: 'Sesiones', cantidad: this.sesiones().length },
    { id: 'grafo', etiqueta: 'Relaciones', cantidad: this.grafo()?.edges.length ?? 0 },
  ]);

  constructor(private readonly memory: MemoryService) {}

  async ngOnInit(): Promise<void> {
    try {
      this.rutaBase.set(await this.memory.dbPath());
      const proyectos = await this.memory.listProjects();
      this.proyectos.set(proyectos);
      if (proyectos.length) {
        await this.abrirProyecto(proyectos[0]);
      }
    } catch (e) {
      this.error.set(String(e));
    }
  }

  /** Todo el proyecto se trae junto: las solapas muestran conteos desde el arranque. */
  async abrirProyecto(proyecto: Project): Promise<void> {
    this.seleccionado.set(proyecto);
    this.abiertas.set({});
    this.cargando.set(true);
    this.error.set(null);
    try {
      const [sesiones, decisiones, notas, artefactos, hilos, paths, grafo, resumen] =
        await Promise.all([
          this.memory.listSessions(proyecto.id),
          this.memory.listDecisionTips(proyecto.id),
          this.memory.listNotes(proyecto.id),
          this.memory.listArtifacts(proyecto.id),
          this.memory.listThreads(proyecto.id),
          this.memory.listPaths(proyecto.id),
          this.memory.getProjectGraph(proyecto.id),
          this.memory.getDashboard(proyecto.id),
        ]);
      this.sesiones.set(sesiones);
      this.decisiones.set(decisiones);
      this.notas.set(notas);
      this.artefactos.set(artefactos);
      this.hilos.set(hilos);
      this.paths.set(paths);
      this.grafo.set(grafo);
      this.resumen.set(resumen);
    } catch (e) {
      this.error.set(String(e));
      this.sesiones.set([]);
      this.decisiones.set([]);
      this.notas.set([]);
      this.artefactos.set([]);
      this.hilos.set([]);
      this.paths.set([]);
      this.grafo.set(null);
      this.resumen.set(null);
    } finally {
      this.cargando.set(false);
    }
  }

  cambiarVista(id: string): void {
    this.vista.set(id as Vista);
  }

  abiertaEn(seccion: string): string | null {
    return this.abiertas()[seccion] ?? null;
  }

  alternarFila(seccion: string, id: string): void {
    const actual = this.abiertas()[seccion] ?? null;
    this.abiertas.update((a) => ({ ...a, [seccion]: actual === id ? null : id }));
    if (seccion === 'sesiones' && actual !== id) {
      void this.traerDetalleSesion(id);
    }
  }

  alternarSeccion(a: AperturaSeccion): void {
    this.alternarFila(a.seccion, a.id);
  }

  async abrirHilo(texto: string): Promise<void> {
    const p = this.seleccionado();
    if (!p || !texto.trim()) return;
    try {
      await this.memory.openThread(p.id, texto.trim());
      await this.refrescarHilos(p.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async cerrarHilo(c: CierreHilo): Promise<void> {
    const p = this.seleccionado();
    if (!p) return;
    try {
      await this.memory.closeThread(c.id, c.status, c.razon);
      await this.refrescarHilos(p.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  /** El resumen cuenta hilos abiertos: si cambian, esa ficha cambia también. */
  private async refrescarHilos(projectId: string): Promise<void> {
    const [hilos, resumen] = await Promise.all([
      this.memory.listThreads(projectId),
      this.memory.getDashboard(projectId),
    ]);
    this.hilos.set(hilos);
    this.resumen.set(resumen);
  }

  /** El detalle se pide una sola vez por sesión, al desplegarla. */
  private async traerDetalleSesion(id: string): Promise<void> {
    if (id in this.detallesSesion()) return;
    try {
      const [fila, bundle] = await Promise.all([
        this.memory.getSession(id),
        this.memory.getSessionBundle(id),
      ]);
      this.detallesSesion.update((d) => ({ ...d, [id]: fila }));
      this.bundles.update((b) => ({ ...b, [id]: bundle }));
    } catch (e) {
      this.error.set(String(e));
    }
  }
}
