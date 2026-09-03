import { CommonModule } from '@angular/common';
import { Component, effect, input, signal } from '@angular/core';
import { EventRow } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';

@Component({
  selector: 'app-audit-trail',
  standalone: true,
  imports: [CommonModule, DateAbsPipe, DateRelPipe],
  templateUrl: './audit-trail.component.html',
  styleUrl: './audit-trail.component.scss',
})
export class AuditTrailComponent {
  entityType = input.required<string>();
  entityId = input.required<string>();

  events = signal<EventRow[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  expanded = signal<Set<string>>(new Set());

  private readonly opLabels: Record<string, string> = {
    create: 'creado',
    update: 'actualizado',
    mark_obsolete: 'marcado obsoleto',
    delete: 'borrado',
    restore: 'restaurado',
  };

  constructor(private tauri: TauriService) {
    effect(() => {
      const t = this.entityType();
      const id = this.entityId();
      if (t && id) this.load(t, id);
    });
  }

  async load(entityType: string, entityId: string) {
    this.loading.set(true);
    this.error.set(null);
    this.events.set([]);
    this.expanded.set(new Set());
    try {
      const rows = await this.tauri.getAuditTrail(entityType, entityId);
      // Newest first: repo returns chronological typically; sort defensively.
      rows.sort((a, b) => (a.ts < b.ts ? 1 : -1));
      this.events.set(rows);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  opLabel(op: string): string {
    return this.opLabels[op] ?? op;
  }

  toggle(id: string) {
    const s = new Set(this.expanded());
    if (s.has(id)) s.delete(id); else s.add(id);
    this.expanded.set(s);
  }

  isExpanded(id: string): boolean { return this.expanded().has(id); }

  hasPayload(ev: EventRow): boolean {
    return !!(ev.payload_before || ev.payload_after);
  }

  formatPayload(p: unknown): string {
    if (p == null) return '—';
    try { return JSON.stringify(p, null, 2); } catch { return String(p); }
  }
}
