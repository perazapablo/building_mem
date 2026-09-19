import { Pipe, PipeTransform } from '@angular/core';

/**
 * `datetime('now')` de SQLite guarda "YYYY-MM-DD HH:MM:SS" en UTC, sin T ni Z.
 * Sin este ajuste el navegador lo interpreta como hora local y corre el dato.
 */
function aFecha(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

@Pipe({ name: 'dia' })
export class DiaPipe implements PipeTransform {
  transform(raw: string | null | undefined): string {
    const d = aFecha(raw);
    return d
      ? d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
      : (raw ?? '—');
  }
}

@Pipe({ name: 'hora' })
export class HoraPipe implements PipeTransform {
  transform(raw: string | null | undefined): string {
    const d = aFecha(raw);
    return d ? d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  }
}
