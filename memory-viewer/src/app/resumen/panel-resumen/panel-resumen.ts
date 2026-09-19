import { Component, computed, input, signal } from '@angular/core';

import { Dashboard, DiaActividad } from '../../core/models';

interface Celda {
  fecha: string;
  sesiones: number;
  minutos: number;
  /** 0 = sin actividad; 1..4 = intensidad creciente. */
  nivel: number;
  futuro: boolean;
}

interface Tramo {
  nombre: string;
  cantidad: number;
  porcentaje: number;
  clase: string;
}

const MES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

/** 'YYYY-MM-DD' → Date en hora local, sin que la zona corra el día. */
function comoDia(fecha: string): Date {
  const [a, m, d] = fecha.split('-').map(Number);
  return new Date(a, m - 1, d);
}

function clave(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'mv-panel-resumen',
  imports: [],
  templateUrl: './panel-resumen.html',
  styleUrl: './panel-resumen.scss',
})
export class PanelResumen {
  readonly datos = input.required<Dashboard | null>();
  readonly cargando = input(false);

  /** El día que el mouse está tocando en el calendario. */
  readonly diaTocado = signal<Celda | null>(null);

  readonly horas = computed(() => Math.round((this.datos()?.minutos_totales ?? 0) / 60));

  readonly medianaHoras = computed(() => {
    const m = this.datos()?.minutos_mediana ?? 0;
    return m >= 60 ? `${(m / 60).toFixed(1)} h` : `${m} min`;
  });

  /** Cuánto hace de la última sesión, en palabras. */
  readonly desdeUltima = computed(() => {
    const u = this.datos()?.ultima;
    if (!u) return '';
    const dias = Math.round((Date.now() - comoDia(u.slice(0, 10)).getTime()) / 86400000);
    if (dias <= 0) return 'hoy';
    if (dias === 1) return 'ayer';
    if (dias < 31) return `hace ${dias} días`;
    const meses = Math.round(dias / 30);
    return meses === 1 ? 'hace un mes' : `hace ${meses} meses`;
  });

  readonly rango = computed(() => {
    const d = this.datos();
    if (!d?.primera || !d?.ultima) return '';
    const f = (s: string) => {
      const x = comoDia(s.slice(0, 10));
      return `${MES[x.getMonth()]} ${x.getFullYear()}`;
    };
    const desde = f(d.primera);
    const hasta = f(d.ultima);
    return desde === hasta ? desde : `${desde} → ${hasta}`;
  });

  /**
   * El calendario: una columna por semana, de la primera sesión hasta hoy.
   * Los días sin actividad están igual — los huecos son parte de la lectura.
   */
  readonly semanas = computed<Celda[][]>(() => {
    const d = this.datos();
    if (!d || !d.dias.length) return [];

    const porFecha = new Map<string, DiaActividad>(d.dias.map((x) => [x.fecha, x]));
    const maximo = Math.max(...d.dias.map((x) => x.sesiones));

    const inicio = comoDia(d.dias[0].fecha);
    inicio.setDate(inicio.getDate() - inicio.getDay()); // atrás hasta el domingo
    const hoy = new Date();
    const fin = comoDia(clave(hoy));
    fin.setDate(fin.getDate() + (6 - fin.getDay())); // adelante hasta el sábado

    const semanas: Celda[][] = [];
    let semana: Celda[] = [];
    for (const cursor = new Date(inicio); cursor <= fin; cursor.setDate(cursor.getDate() + 1)) {
      const k = clave(cursor);
      const act = porFecha.get(k);
      const sesiones = act?.sesiones ?? 0;
      semana.push({
        fecha: k,
        sesiones,
        minutos: act?.minutos ?? 0,
        // Cuatro escalones sobre el máximo real del proyecto: un día de 5
        // sesiones y uno de 1 no pueden pintarse igual.
        nivel: sesiones === 0 ? 0 : Math.max(1, Math.ceil((sesiones / maximo) * 4)),
        futuro: comoDia(k) > comoDia(clave(hoy)),
      });
      if (semana.length === 7) {
        semanas.push(semana);
        semana = [];
      }
    }
    if (semana.length) semanas.push(semana);
    return semanas;
  });

  /** Etiqueta de mes sobre la columna donde ese mes empieza. */
  readonly meses = computed(() =>
    this.semanas().map((semana, i, todas) => {
      const primero = semana[0];
      if (!primero) return '';
      const mes = comoDia(primero.fecha).getMonth();
      const anterior = i > 0 ? comoDia(todas[i - 1][0].fecha).getMonth() : -1;
      return mes === anterior ? '' : MES[mes];
    }),
  );

  /** Cómo cerró cada sesión: lo que narró el modelo vs lo que salvó el harness. */
  readonly cierre = computed<Tramo[]>(() => {
    const d = this.datos();
    if (!d || !d.sesiones) return [];
    return this.tramos([
      { nombre: 'cerradas con relato', cantidad: d.con_cierre, clase: 'bueno' },
      { nombre: 'auto-guardadas', cantidad: d.auto_guardadas, clase: 'aviso' },
    ]);
  });

  /** De dónde salió cada decisión. Es la defensa contra rationale inventado. */
  readonly origen = computed<Tramo[]>(() => {
    const o = this.datos()?.origen;
    if (!o || !this.datos()?.decisiones) return [];
    return this.tramos([
      { nombre: 'las pediste vos', cantidad: o.explicito, clase: 'bueno' },
      { nombre: 'se dedujeron de vos', cantidad: o.implicito, clase: 'medio' },
      { nombre: 'las infirió el agente', cantidad: o.inferido, clase: 'aviso' },
    ]);
  });

  private tramos(items: Array<{ nombre: string; cantidad: number; clase: string }>): Tramo[] {
    const total = items.reduce((a, b) => a + b.cantidad, 0) || 1;
    return items
      .filter((i) => i.cantidad > 0)
      .map((i) => ({ ...i, porcentaje: Math.round((i.cantidad / total) * 100) }));
  }

  tocar(c: Celda): void {
    if (!c.futuro) this.diaTocado.set(c);
  }

  soltar(): void {
    this.diaTocado.set(null);
  }

  /** "12 SEP 2026 · 2 sesiones · 3 h" para el día que se está tocando. */
  readonly detalleDia = computed(() => {
    const c = this.diaTocado();
    if (!c) return '';
    const d = comoDia(c.fecha);
    const fecha = `${d.getDate()} ${MES[d.getMonth()]} ${d.getFullYear()}`;
    if (!c.sesiones) return `${fecha} · sin trabajo`;
    const ses = c.sesiones === 1 ? '1 sesión' : `${c.sesiones} sesiones`;
    const tiempo = c.minutos >= 60 ? ` · ${Math.round(c.minutos / 60)} h` : '';
    return `${fecha} · ${ses}${tiempo}`;
  });
}
