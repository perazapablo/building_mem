/**
 * Layout de fuerzas: acomoda los nodos solo, sin que nadie le diga dónde va
 * cada uno. Tres fuerzas y nada más — los nodos se repelen entre sí, las
 * aristas tiran como resortes, y un tirón suave hacia el centro evita que los
 * grupos sueltos se vayan al infinito.
 *
 * No sabe de SVG ni de Angular: recibe números, devuelve números. Quien dibuja
 * lee `nodos` después de cada `paso()`.
 */

export interface NodoSim {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radio en px; también pesa en la repulsión para que los grandes no se pisen. */
  r: number;
  /** Mientras el usuario lo arrastra no lo mueve la simulación. */
  anclado: boolean;
}

export interface AristaSim {
  source: string;
  target: string;
  /** 0..1 — una relación con más confianza tira más fuerte. */
  peso: number;
}

export interface OpcionesFuerzas {
  ancho: number;
  alto: number;
  /** Cuánto se empujan los nodos. Con cajas hace falta mucho más que con puntos. */
  repulsion?: number;
  /** Largo de reposo de las aristas. */
  largoResorte?: number;
}

const REPULSION = 5200;
const LARGO_RESORTE = 90;
const RIGIDEZ = 0.035;
const GRAVEDAD = 0.012;
const AMORTIGUACION = 0.82;
const VELOCIDAD_MAX = 12;
/** Debajo de esto el dibujo ya no cambia a ojo y conviene dejar de gastar CPU. */
const QUIETO = 0.35;

export class Simulacion {
  readonly nodos: NodoSim[];
  private readonly indice = new Map<string, NodoSim>();
  private readonly aristas: AristaSim[];
  private opciones: OpcionesFuerzas;
  /** Arranca caliente y se enfría: los primeros pasos mueven mucho, los últimos afinan. */
  private calor = 1;

  constructor(nodos: NodoSim[], aristas: AristaSim[], opciones: OpcionesFuerzas) {
    this.nodos = nodos;
    this.aristas = aristas;
    this.opciones = opciones;
    for (const n of nodos) this.indice.set(n.id, n);
  }

  redimensionar(opciones: OpcionesFuerzas): void {
    this.opciones = opciones;
  }

  /** Vuelve a agitar el grafo — al filtrar, o cuando el usuario suelta un nodo. */
  recalentar(valor = 0.6): void {
    this.calor = Math.max(this.calor, valor);
  }

  get quieto(): boolean {
    return this.calor < 0.02;
  }

  /** Un tick. Devuelve cuánto se movió el grafo, para saber si vale seguir. */
  paso(): number {
    const { ancho, alto } = this.opciones;
    const cx = ancho / 2;
    const cy = alto / 2;

    // Repulsión: todos contra todos. Con ~200 nodos son ~20k pares por tick,
    // que a 60fps sobra; un quadtree acá sería complejidad sin beneficio.
    for (let i = 0; i < this.nodos.length; i++) {
      const a = this.nodos[i];
      for (let j = i + 1; j < this.nodos.length; j++) {
        const b = this.nodos[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Superpuestos: los separo en una dirección cualquiera o la fuerza explota.
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 0.01;
        }
        const d = Math.sqrt(d2);
        const fuerza = ((this.opciones.repulsion ?? REPULSION) * (a.r + b.r)) / (d2 * 20);
        const fx = (dx / d) * fuerza;
        const fy = (dy / d) * fuerza;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Resortes: cada arista acerca sus puntas hasta el largo de reposo.
    for (const e of this.aristas) {
      const a = this.indice.get(e.source);
      const b = this.indice.get(e.target);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const estiramiento = d - (this.opciones.largoResorte ?? LARGO_RESORTE);
      const fuerza = estiramiento * RIGIDEZ * (0.4 + e.peso);
      const fx = (dx / d) * fuerza;
      const fy = (dy / d) * fuerza;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }

    let movimiento = 0;
    for (const n of this.nodos) {
      if (n.anclado) {
        n.vx = 0;
        n.vy = 0;
        continue;
      }
      n.vx += (cx - n.x) * GRAVEDAD;
      n.vy += (cy - n.y) * GRAVEDAD;
      n.vx *= AMORTIGUACION;
      n.vy *= AMORTIGUACION;

      const v = Math.hypot(n.vx, n.vy);
      if (v > VELOCIDAD_MAX) {
        n.vx = (n.vx / v) * VELOCIDAD_MAX;
        n.vy = (n.vy / v) * VELOCIDAD_MAX;
      }
      n.x += n.vx * this.calor;
      n.y += n.vy * this.calor;
      movimiento += Math.abs(n.vx) + Math.abs(n.vy);
    }

    this.calor *= 0.985;
    if (movimiento / Math.max(this.nodos.length, 1) < QUIETO) this.calor *= 0.9;
    return movimiento;
  }
}

/**
 * Reparte los nodos en una espiral antes del primer paso. Arrancar todos en el
 * centro hace que la repulsión los dispare de golpe y el grafo tarde el doble
 * en asentarse.
 */
export function posicionInicial(i: number, total: number, ancho: number, alto: number) {
  const angulo = i * 2.399963; // ángulo áureo: reparte sin formar radios visibles
  const radio = Math.sqrt(i / Math.max(total, 1)) * Math.min(ancho, alto) * 0.42;
  return {
    x: ancho / 2 + Math.cos(angulo) * radio,
    y: alto / 2 + Math.sin(angulo) * radio,
  };
}
