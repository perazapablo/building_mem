import {
  AfterViewInit,
  Component,
  ElementRef,
  Injector,
  OnDestroy,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { animate, stagger } from 'animejs';

import { GraphEdge, ProjectGraph } from '../../core/models';
import { AristaSim, NodoSim, Simulacion, posicionInicial } from '../fuerzas';

/** Nada de `topically_related` en pantalla: eso no significa nada para quien mira. */
const NOMBRE_RELACION: Record<string, string> = {
  semantically_related: 'texto parecido',
  structural_sibling: 'misma estructura',
  variant_of: 'variante de',
  implements: 'implementa',
  depends_on: 'depende de',
  references: 'menciona',
  conflicts_with: 'choca con',
  replaces: 'reemplaza',
  topically_related: 'mismo tema',
};

const NOMBRE_TIPO: Record<string, string> = {
  note: 'nota',
  decision: 'decisión',
  decision_record: 'decisión',
  artifact: 'artefacto',
  code_entity: 'código',
  tema: 'tema',
};

/** `topically_related` ya no se dibuja: lo reemplazan los nodos de tema. */
const RELACION_POR_TAGS = 'topically_related';
const CAJA_ANCHO = 168;
const CAJA_ALTO = 48;
const MUNDO_ANCHO = 3800;
const MUNDO_ALTO = 2800;
const PASOS_EN_FRIO = 340;

interface NodoVista extends NodoSim {
  kind: string;
  etiqueta: string;
  lineas: string[];
  tipo: string;
  grado: number;
  texto: string;
  clave: string;
  tags: string[];
  /** ISO de la base; cadena vacía en los temas, que no tienen fecha propia. */
  creado: string;
  fecha: string;
  antiguedad: string;
  /** Un tema es un nodo sintético: no existe en la base, sale de los tags. */
  esTema: boolean;
}

interface AristaVista {
  id: string;
  source: string;
  target: string;
  relacion: string;
  etiqueta: string;
  porque: string;
  confianza: number;
  estado: string;
  /** Verdadero para las líneas entidad→tema, que no vienen de `memory_relations`. */
  esTema: boolean;
}

interface Conexion {
  id: string;
  otroId: string;
  otroLabel: string;
  otroTexto: string;
  otroTipo: string;
  otraFecha: string;
  otroCreado: string;
  /** "12 días antes", "el mismo día": el salto en el tiempo entre las dos puntas. */
  salto: string;
  etiqueta: string;
  porque: string;
  confianza: number;
  estado: string;
  esTema: boolean;
}

@Component({
  selector: 'mv-panel-grafo',
  imports: [],
  templateUrl: './panel-grafo.html',
  styleUrl: './panel-grafo.scss',
})
export class PanelGrafo implements AfterViewInit, OnDestroy {
  readonly grafo = input.required<ProjectGraph | null>();
  readonly cargando = input(false);

  private readonly lienzo = viewChild<ElementRef<SVGSVGElement>>('lienzo');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);

  /** Las relaciones automáticas por parecido de texto arrancan apagadas: una de
      cada cuatro de las que alguien revisó terminó descartada. */
  readonly verParecidos = signal(false);
  readonly verDeclaradas = signal(true);

  readonly elegido = signal<string | null>(null);
  readonly busqueda = signal('');

  readonly nodos = signal<NodoVista[]>([]);
  readonly aristas = signal<AristaVista[]>([]);
  readonly zoom = signal(0.35);
  readonly desplazamiento = signal({ x: 0, y: 0 });
  readonly resumen = signal({ entidades: 0, temas: 0, sueltas: 0 });

  readonly cajaAncho = CAJA_ANCHO;
  readonly cajaAlto = CAJA_ALTO;

  private sim: Simulacion | null = null;
  private cuadro = 0;
  private readonly elementosNodo = new Map<string, SVGGElement>();
  private readonly elementosArista = new Map<string, SVGGElement>();
  private readonly vecinos = new Map<string, Set<string>>();
  private ancho = 800;
  private alto = 600;
  private arrastrando: { id: string | null; x: number; y: number } | null = null;
  private hubosArrastre = false;

  constructor() {
    effect(() => {
      const g = this.grafo();
      this.verParecidos();
      this.verDeclaradas();
      if (g) this.construir(g);
    });
  }

  ngAfterViewInit(): void {
    this.medir();
    window.addEventListener('resize', this.alRedimensionar);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.cuadro);
    window.removeEventListener('resize', this.alRedimensionar);
  }

  private readonly alRedimensionar = () => this.medir();

  private medir(): void {
    const caja = this.host.nativeElement.getBoundingClientRect();
    this.ancho = Math.max(caja.width, 320);
    this.alto = Math.max(caja.height - 96, 320);
  }

  // ---------------------------------------------------------------- datos

  /**
   * El grafo se arma sobre **temas**, no sobre pares. Antes, 58 entidades
   * marcadas con `facturacion` producían más de mil líneas que sólo repetían
   * "comparten tags"; ahora `facturacion` es una tarjeta y cada entidad cuelga
   * de ella. La razón del vínculo queda escrita en el nodo, no repetida en
   * cada arista.
   */
  private construir(g: ProjectGraph): void {
    cancelAnimationFrame(this.cuadro);
    this.medir();
    this.elegido.set(null);
    this.elementosNodo.clear();
    this.elementosArista.clear();

    // 1. Temas: cada tag con dos o más entidades. Uno solo no une nada.
    const porTema = new Map<string, string[]>();
    const tagsDe = new Map<string, string[]>();
    for (const n of g.nodes) {
      const tags = leerTags(n.tags);
      tagsDe.set(n.id, tags);
      for (const t of tags) {
        if (!porTema.has(t)) porTema.set(t, []);
        porTema.get(t)!.push(n.id);
      }
    }
    const temas = [...porTema.entries()].filter(([, ids]) => ids.length > 1);

    // 2. Relaciones directas: las que dicen algo por sí mismas. Las de tags
    //    quedan afuera — ya están representadas por los temas.
    const directas = g.edges.filter((e) => {
      if (e.relation === RELACION_POR_TAGS) return false;
      if (e.relation === 'semantically_related') return this.verParecidos();
      return this.verDeclaradas();
    });

    const aristas: AristaVista[] = [];
    for (const [tema, ids] of temas) {
      for (const id of ids) {
        aristas.push({
          id: `tema:${tema}->${id}`,
          source: `tema:${tema}`,
          target: id,
          relacion: 'tema',
          etiqueta: '',
          porque: `Marcada con ${tema}.`,
          confianza: 100,
          estado: 'tema',
          esTema: true,
        });
      }
    }
    for (const e of directas) {
      aristas.push({
        id: e.sync_id,
        source: e.source,
        target: e.target,
        relacion: e.relation,
        etiqueta: NOMBRE_RELACION[e.relation] ?? e.relation,
        porque: explicar(e.relation, e.reason, e.evidence),
        confianza: Math.round(e.confidence * 100),
        estado: e.judgment_status,
        esTema: false,
      });
    }

    // 3. Sólo entra lo que está atado a algo: una tarjeta suelta en el mapa no
    //    aporta y sí estorba.
    const conectados = new Set<string>();
    const grados = new Map<string, number>();
    for (const a of aristas) {
      conectados.add(a.source);
      conectados.add(a.target);
      grados.set(a.source, (grados.get(a.source) ?? 0) + 1);
      grados.set(a.target, (grados.get(a.target) ?? 0) + 1);
    }

    const crudos: Array<{
      id: string;
      kind: string;
      label: string;
      clave: string;
      texto: string;
      tags: string[];
      creado: string;
      esTema: boolean;
    }> = [];
    for (const [tema, ids] of temas) {
      crudos.push({
        id: `tema:${tema}`,
        kind: 'tema',
        label: tema,
        clave: '',
        texto: `${ids.length} cosas del proyecto están marcadas con “${tema}”.`,
        tags: [],
        creado: '',
        esTema: true,
      });
    }
    for (const n of g.nodes) {
      if (!conectados.has(n.id)) continue;
      crudos.push({
        id: n.id,
        kind: n.kind,
        label: n.label ?? '',
        clave: n.clave ?? '',
        texto: (n.texto ?? '').trim(),
        tags: tagsDe.get(n.id) ?? [],
        creado: n.creado ?? '',
        esTema: false,
      });
    }

    const nodos = crudos.map<NodoVista>((c, i) => {
      const p = posicionInicial(i, crudos.length, MUNDO_ANCHO, MUNDO_ALTO);
      const grado = grados.get(c.id) ?? 0;
      return {
        id: c.id,
        kind: c.kind,
        tipo: NOMBRE_TIPO[c.kind] ?? c.kind,
        etiqueta: c.label,
        lineas: partirEtiqueta(c.label),
        texto: c.texto,
        clave: c.clave,
        tags: c.tags,
        creado: c.creado,
        fecha: comoFecha(c.creado),
        antiguedad: antiguedadDe(c.creado),
        grado,
        esTema: c.esTema,
        // Un tema con muchas entidades ocupa más lugar y empuja más: es lo que
        // separa los grupos en el mapa.
        r: (c.esTema ? CAJA_ANCHO * 0.6 : CAJA_ANCHO * 0.5) * (1 + Math.min(grado / 40, 0.8)),
        x: p.x,
        y: p.y,
        vx: 0,
        vy: 0,
        anclado: false,
      };
    });

    this.vecinos.clear();
    for (const a of aristas) {
      if (!this.vecinos.has(a.source)) this.vecinos.set(a.source, new Set());
      if (!this.vecinos.has(a.target)) this.vecinos.set(a.target, new Set());
      this.vecinos.get(a.source)!.add(a.target);
      this.vecinos.get(a.target)!.add(a.source);
    }

    const aristasSim: AristaSim[] = aristas.map((e) => ({
      source: e.source,
      target: e.target,
      peso: e.esTema ? 1 : e.confianza / 100,
    }));
    const sim = new Simulacion(nodos, aristasSim, {
      ancho: MUNDO_ANCHO,
      alto: MUNDO_ALTO,
      repulsion: 46000,
      largoResorte: 260,
    });
    for (let i = 0; i < PASOS_EN_FRIO; i++) sim.paso();
    this.sim = sim;

    this.nodos.set(nodos);
    this.aristas.set(aristas);
    this.resumen.set({
      entidades: nodos.filter((n) => !n.esTema).length,
      temas: temas.length,
      sueltas: g.nodes.length - nodos.filter((n) => !n.esTema).length,
    });
    this.encuadrar(nodos);

    // `afterNextRender`: recién ahí las tarjetas existen en el DOM. Con
    // `queueMicrotask` el cacheo no encontraba nada y quedaban todas apiladas.
    afterNextRender(
      () => {
        this.cachearElementos();
        this.pintar();
        this.entrada();
      },
      { injector: this.injector },
    );
  }

  private encuadrar(nodos: NodoVista[]): void {
    if (!nodos.length) return;
    const xs = nodos.map((n) => n.x);
    const ys = nodos.map((n) => n.y);
    const minX = Math.min(...xs) - CAJA_ANCHO;
    const maxX = Math.max(...xs) + CAJA_ANCHO;
    const minY = Math.min(...ys) - CAJA_ALTO;
    const maxY = Math.max(...ys) + CAJA_ALTO;
    const z = Math.max(
      Math.min(this.ancho / (maxX - minX), this.alto / (maxY - minY), 1),
      0.12,
    );
    this.zoom.set(z);
    this.desplazamiento.set({
      x: this.ancho / 2 - ((minX + maxX) / 2) * z,
      y: this.alto / 2 - ((minY + maxY) / 2) * z,
    });
  }

  private cachearElementos(): void {
    const raiz = this.lienzo()?.nativeElement;
    this.elementosNodo.clear();
    this.elementosArista.clear();
    if (!raiz) return;
    raiz.querySelectorAll<SVGGElement>('g.caja').forEach((el) => {
      const id = el.dataset['id'];
      if (id) this.elementosNodo.set(id, el);
    });
    raiz.querySelectorAll<SVGGElement>('g.vinculo').forEach((el) => {
      const id = el.dataset['id'];
      if (id) this.elementosArista.set(id, el);
    });
  }

  // ------------------------------------------------------------- animación

  private entrada(): void {
    const cajas = [...this.elementosNodo.values()];
    if (!cajas.length) return;
    animate(cajas, { opacity: [0, 1], duration: 360, delay: stagger(3), ease: 'outQuad' });
  }

  private correr(): void {
    cancelAnimationFrame(this.cuadro);
    const tick = () => {
      if (!this.sim) return;
      this.sim.paso();
      this.pintar();
      if (!this.sim.quieto) this.cuadro = requestAnimationFrame(tick);
    };
    this.cuadro = requestAnimationFrame(tick);
  }

  private pintar(): void {
    const porId = new Map(this.nodos().map((n) => [n.id, n]));
    for (const [id, el] of this.elementosNodo) {
      const n = porId.get(id);
      if (n) el.setAttribute('transform', `translate(${n.x.toFixed(1)},${n.y.toFixed(1)})`);
    }
    for (const e of this.aristas()) {
      const el = this.elementosArista.get(e.id);
      const a = porId.get(e.source);
      const b = porId.get(e.target);
      if (!el || !a || !b) continue;
      const [ax, ay] = borde(a, b);
      const [bx, by] = borde(b, a);
      const linea = el.querySelector('line');
      linea?.setAttribute('x1', ax.toFixed(1));
      linea?.setAttribute('y1', ay.toFixed(1));
      linea?.setAttribute('x2', bx.toFixed(1));
      linea?.setAttribute('y2', by.toFixed(1));
      const texto = el.querySelector('text');
      if (texto) {
        texto.setAttribute('x', ((ax + bx) / 2).toFixed(1));
        texto.setAttribute('y', ((ay + by) / 2 - 4).toFixed(1));
      }
    }
  }

  // ------------------------------------------------------------ interacción

  readonly detalle = computed(() => {
    const id = this.elegido();
    if (!id) return null;
    const n = this.nodos().find((x) => x.id === id);
    if (!n) return null;
    const conexiones: Conexion[] = this.aristas()
      .filter((e) => e.source === id || e.target === id)
      .map((e) => {
        const otroId = e.source === id ? e.target : e.source;
        const otro = this.nodos().find((x) => x.id === otroId);
        return {
          id: e.id,
          otroId,
          otroLabel: otro?.etiqueta ?? otroId,
          otroTexto: recortar(otro?.texto ?? '', 150),
          otroTipo: otro?.tipo ?? '',
          otraFecha: otro?.fecha ?? '',
          otroCreado: otro?.creado ?? '',
          salto: saltoEntre(n.creado, otro?.creado ?? ''),
          etiqueta: e.etiqueta,
          porque:
            e.esTema || !otro
              ? e.porque
              : agregarCoincidencias(e.porque, e.relacion, n.texto, otro.texto),
          confianza: e.confianza,
          estado: e.estado,
          esTema: e.esTema,
        };
      })
      .sort((a, b) => {
        // Dentro de un tema el orden es cronológico, lo más nuevo arriba: el
        // tema es justamente donde se ve qué de ahora toca algo de antes.
        if (n.esTema) return (b.otroCreado || '').localeCompare(a.otroCreado || '');
        // Parado en una entidad: lo declarado primero, los temas después —
        // un vínculo que alguien afirmó pesa más que una etiqueta compartida.
        return Number(a.esTema) - Number(b.esTema) || b.confianza - a.confianza;
      });
    return {
      tipo: n.tipo,
      etiqueta: n.etiqueta,
      texto: n.texto,
      clave: n.clave,
      tags: n.tags,
      fecha: n.fecha,
      antiguedad: n.antiguedad,
      esTema: n.esTema,
      arco: n.esTema ? arcoDe(conexiones) : '',
      conexiones,
    };
  });

  readonly resultados = computed(() => {
    const q = this.busqueda().trim().toLowerCase();
    if (q.length < 2) return [];
    return this.nodos()
      .filter((n) => n.etiqueta.toLowerCase().includes(q))
      .sort((a, b) => Number(b.esTema) - Number(a.esTema) || b.grado - a.grado)
      .slice(0, 8)
      .map((n) => ({ id: n.id, label: n.etiqueta, tipo: n.tipo, grado: n.grado }));
  });

  readonly verRotulos = computed(() => this.zoom() > 0.55);

  elegir(id: string): void {
    if (this.hubosArrastre) return;
    this.elegido.update((a) => (a === id ? null : id));
    this.aplicarFoco();
  }

  cerrarDetalle(): void {
    this.elegido.set(null);
    this.aplicarFoco();
  }

  private aplicarFoco(): void {
    const id = this.elegido();
    const cerca = id ? (this.vecinos.get(id) ?? new Set<string>()) : null;
    for (const [nid, el] of this.elementosNodo) {
      const activo = !id || nid === id || cerca!.has(nid);
      animate(el, { opacity: activo ? 1 : 0.07, duration: 240, ease: 'outQuad' });
      el.classList.toggle('elegida', nid === id);
    }
    for (const e of this.aristas()) {
      const el = this.elementosArista.get(e.id);
      if (!el) continue;
      const activa = !id || e.source === id || e.target === id;
      animate(el, { opacity: activa ? 1 : 0.04, duration: 240, ease: 'outQuad' });
      el.classList.toggle('resaltada', !!id && activa);
    }
  }

  irA(id: string): void {
    const n = this.nodos().find((x) => x.id === id);
    if (!n) return;
    this.busqueda.set('');
    const z = Math.max(this.zoom(), 0.8);
    animate(
      { z: this.zoom(), x: this.desplazamiento().x, y: this.desplazamiento().y },
      {
        z,
        x: this.ancho / 2 - n.x * z,
        y: this.alto / 2 - n.y * z,
        duration: 520,
        ease: 'outCubic',
        onUpdate: (anim) => {
          const t = anim.targets[0] as { z: number; x: number; y: number };
          this.zoom.set(t.z);
          this.desplazamiento.set({ x: t.x, y: t.y });
        },
      },
    );
    this.elegido.set(id);
    this.aplicarFoco();
  }

  alPresionarNodo(ev: PointerEvent, id: string): void {
    ev.stopPropagation();
    const n = this.nodos().find((x) => x.id === id);
    if (!n) return;
    n.anclado = true;
    this.arrastrando = { id, x: ev.clientX, y: ev.clientY };
    this.hubosArrastre = false;
  }

  alPresionarFondo(ev: PointerEvent): void {
    this.arrastrando = { id: null, x: ev.clientX, y: ev.clientY };
    this.hubosArrastre = false;
  }

  alMover(ev: PointerEvent): void {
    if (!this.arrastrando) return;
    const dx = (ev.clientX - this.arrastrando.x) / this.zoom();
    const dy = (ev.clientY - this.arrastrando.y) / this.zoom();
    if (Math.abs(dx) + Math.abs(dy) > 1) this.hubosArrastre = true;
    this.arrastrando.x = ev.clientX;
    this.arrastrando.y = ev.clientY;

    if (this.arrastrando.id) {
      const n = this.nodos().find((x) => x.id === this.arrastrando!.id);
      if (n) {
        n.x += dx;
        n.y += dy;
        this.pintar();
      }
    } else {
      this.desplazamiento.update((d) => ({ x: d.x + dx * this.zoom(), y: d.y + dy * this.zoom() }));
    }
  }

  alSoltar(): void {
    if (this.arrastrando?.id) {
      const n = this.nodos().find((x) => x.id === this.arrastrando!.id);
      if (n) n.anclado = false;
      this.sim?.recalentar(0.2);
      this.correr();
    }
    this.arrastrando = null;
    setTimeout(() => (this.hubosArrastre = false), 0);
  }

  alRodar(ev: WheelEvent): void {
    ev.preventDefault();
    const caja = (ev.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = ev.clientX - caja.left;
    const py = ev.clientY - caja.top;
    const z0 = this.zoom();
    const z1 = Math.min(Math.max(z0 * (ev.deltaY < 0 ? 1.12 : 0.89), 0.1), 2.5);
    const d = this.desplazamiento();
    this.zoom.set(z1);
    this.desplazamiento.set({ x: px - ((px - d.x) / z0) * z1, y: py - ((py - d.y) / z0) * z1 });
  }

  encuadrarTodo(): void {
    this.encuadrar(this.nodos());
  }

  alternarParecidos(): void {
    this.verParecidos.update((v) => !v);
  }

  alternarDeclaradas(): void {
    this.verDeclaradas.update((v) => !v);
  }
}

const MES = [
  'ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN',
  'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC',
];

/** SQLite guarda `YYYY-MM-DD HH:MM:SS` en UTC, sin zona: hay que decírselo a Date. */
function comoDate(iso: string): Date | null {
  if (!iso) return null;
  const d = new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

/** Fecha concreta, no relativa: "3 SEP 2026" se ubica, "hace 34 días" no. */
function comoFecha(iso: string): string {
  const d = comoDate(iso);
  if (!d) return '';
  return `${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`;
}

function diasEntre(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86400000);
}

function antiguedadDe(iso: string): string {
  const d = comoDate(iso);
  if (!d) return '';
  const dias = diasEntre(d, new Date());
  if (dias === 0) return 'hoy';
  if (dias === 1) return 'ayer';
  if (dias < 31) return `hace ${dias} días`;
  const meses = Math.round(dias / 30);
  return meses === 1 ? 'hace un mes' : `hace ${meses} meses`;
}

/**
 * El salto en el tiempo entre las dos puntas — el dato que contesta "esto que
 * hice hoy, ¿con qué de antes engancha?". Dice también para qué lado va.
 */
function saltoEntre(propio: string, otro: string): string {
  const a = comoDate(propio);
  const b = comoDate(otro);
  if (!a || !b) return '';
  const dias = diasEntre(a, b);
  if (dias === 0) return 'el mismo día';
  const cuanto = dias === 1 ? '1 día' : dias < 31 ? `${dias} días` : `${Math.round(dias / 30)} meses`;
  return b < a ? `${cuanto} antes` : `${cuanto} después`;
}

/**
 * Cuánto tiempo abarca un tema, de lo más viejo a lo más nuevo. Es la respuesta
 * corta a "¿esto lo vengo tocando hace rato?".
 */
function arcoDe(conexiones: Array<{ otroCreado: string }>): string {
  const fechas = conexiones.map((c) => comoDate(c.otroCreado)).filter((d): d is Date => !!d);
  if (fechas.length < 2) return '';
  const desde = new Date(Math.min(...fechas.map((d) => d.getTime())));
  const hasta = new Date(Math.max(...fechas.map((d) => d.getTime())));
  const dias = diasEntre(desde, hasta);
  if (dias === 0) return `todo el mismo día (${comoFecha(desde.toISOString())})`;
  const lapso = dias < 31 ? `${dias} días` : `${Math.round(dias / 30)} meses`;
  return `${comoFecha(desde.toISOString())} → ${comoFecha(hasta.toISOString())} · ${lapso}`;
}

/** Palabras que aparecen en cualquier texto y no distinguen nada. */
const VACIAS = new Set([
  'para','como','este','esta','esto','esos','esas','desde','hasta','pero','porque','cuando',
  'donde','sobre','entre','todos','todas','cada','otro','otra','hace','tiene','tienen','debe',
  'ser','son','está','están','fue','han','hay','con','sin','por','del','las','los','una','uno',
  'que','the','and','for','with','from','this','that','not','are','was','其','null','true','false',
]);

function terminos(texto: string): Set<string> {
  const out = new Set<string>();
  for (const bruto of texto.toLowerCase().split(/[^a-záéíóúñ0-9_.]+/i)) {
    const t = bruto.replace(/^[._]+|[._]+$/g, '');
    if (t.length < 4 || VACIAS.has(t) || /^\d+$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

/**
 * "El texto se parece" no contesta en qué. Los términos que los dos textos
 * comparten sí — y son la evidencia de si el parecido es real o casual.
 */
function agregarCoincidencias(
  base: string,
  relacion: string,
  propio: string,
  otro: string,
): string {
  if (relacion !== 'semantically_related' || !propio || !otro) return base;
  const a = terminos(propio);
  const comunes: string[] = [];
  for (const t of terminos(otro)) {
    if (a.has(t)) comunes.push(t);
    if (comunes.length >= 8) break;
  }
  if (!comunes.length) return `${base} No comparten ninguna palabra distintiva.`;
  return `Coinciden en: ${comunes.join(', ')}.`;
}

/** Los tags viajan como JSON en una columna de texto; una base vieja puede traer basura. */
function leerTags(crudo: string): string[] {
  if (!crudo) return [];
  try {
    const v = JSON.parse(crudo);
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function recortar(texto: string, max: number): string {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  return limpio.length > max ? limpio.slice(0, max - 1) + '…' : limpio;
}

function partirEtiqueta(texto: string): string[] {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= 22) return [limpio];
  const corte = limpio.lastIndexOf(' ', 22);
  const primera = corte > 9 ? limpio.slice(0, corte) : limpio.slice(0, 22);
  const resto = limpio.slice(primera.length).trim();
  return [primera, resto.length > 23 ? resto.slice(0, 22) + '…' : resto];
}

/**
 * Traduce el porqué de una relación. La base guarda la huella del motor que la
 * propuso (`FTS5 content similarity`), no una explicación.
 */
function explicar(relacion: string, razon: string, evidencia: string): string {
  if (/fts5|content similarity/i.test(razon)) {
    return 'El texto de las dos se parece. Lo detectó la búsqueda por contenido, no una persona.';
  }
  const tags = /^Shared tags:\s*(.+)$/i.exec(razon.trim());
  if (tags) return `Comparten ${tags[1].trim()}.`;
  const extra = evidencia && !/rank:/i.test(evidencia) ? ` (${evidencia})` : '';
  return `${razon}${extra}`.trim() || `Relación ${relacion} sin explicación registrada.`;
}

function borde(
  desde: { x: number; y: number; esTema?: boolean },
  hacia: { x: number; y: number },
): [number, number] {
  const dx = hacia.x - desde.x;
  const dy = hacia.y - desde.y;
  if (!dx && !dy) return [desde.x, desde.y];
  const mx = CAJA_ANCHO / 2 + 3;
  const my = CAJA_ALTO / 2 + 3;
  const escala = Math.min(mx / Math.abs(dx || 0.001), my / Math.abs(dy || 0.001));
  return [desde.x + dx * escala, desde.y + dy * escala];
}
