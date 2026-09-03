import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ArtifactRow,
  DecisionRow,
  EventRow,
  NoteRow,
  Project,
  Relation,
} from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';
import { AuditTrailComponent } from '../../shared/audit-trail/audit-trail.component';

type KnowledgeKind = 'decisions' | 'artifacts' | 'notes';

interface Selection {
  type: string;
  id: string;
  data: NoteRow | DecisionRow | ArtifactRow;
}

@Component({
  selector: 'app-knowledge',
  standalone: true,
  imports: [CommonModule, FormsModule, DateAbsPipe, DateRelPipe, AuditTrailComponent],
  templateUrl: './knowledge.component.html',
  styleUrl: './knowledge.component.scss',
})
export class KnowledgeComponent {
  kind = signal<KnowledgeKind>('decisions');
  filter = signal<string>('');
  statusFilter = signal<'active' | 'all'>('active');
  minImportance = signal<number>(1);

  decisions = signal<DecisionRow[]>([]);
  artifacts = signal<ArtifactRow[]>([]);
  notes = signal<NoteRow[]>([]);

  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  selection = signal<Selection | null>(null);
  relations = signal<Relation[]>([]);
  audit = signal<EventRow[]>([]);

  filtered = computed(() => {
    const q = this.filter().trim().toLowerCase();
    const min = this.minImportance();
    const onlyActive = this.statusFilter() === 'active';
    const match = (text: string, status: string, importance: number) =>
      importance >= min &&
      (!onlyActive || status === 'active') &&
      (!q || text.toLowerCase().includes(q));

    switch (this.kind()) {
      case 'decisions':
        return this.decisions().filter((d) =>
          match(`${d.decision} ${d.reasoning} ${d.topic_key ?? ''}`, d.status, d.importance),
        );
      case 'artifacts':
        return this.artifacts().filter((a) =>
          match(`${a.type} ${a.content} ${a.topic_key ?? ''}`, a.status, a.importance),
        );
      case 'notes':
        return this.notes().filter((n) =>
          match(`${n.content} ${(n.tags || []).join(' ')} ${n.topic_key ?? ''}`, n.status, n.importance),
        );
    }
  });

  constructor(public ws: WorkspaceService, private tauri: TauriService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.load(p);
    });
  }

  async load(p: Project) {
    this.loading.set(true);
    this.error.set(null);
    this.selection.set(null);
    try {
      const [d, a, n] = await Promise.all([
        this.tauri.listDecisions(p.id),
        this.tauri.listArtifacts(p.id),
        this.tauri.listNotes(p.id),
      ]);
      this.decisions.set(d);
      this.artifacts.set(a);
      this.notes.set(n);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  setKind(k: KnowledgeKind) {
    this.kind.set(k);
    this.selection.set(null);
  }

  async select(type: string, id: string, data: any) {
    this.selection.set({ type, id, data });
    this.relations.set([]);
    this.audit.set([]);
    try {
      const [rels, aud] = await Promise.all([
        this.tauri.getRelationsForEntity(type, id),
        this.tauri.getAuditTrail(type, id),
      ]);
      this.relations.set(rels);
      this.audit.set(aud);
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

  isNote(d: any): d is NoteRow {
    return this.kind() === 'notes';
  }

  isDecision(d: any): d is DecisionRow {
    return this.kind() === 'decisions';
  }

  isArtifact(d: any): d is ArtifactRow {
    return this.kind() === 'artifacts';
  }

  importanceStars(n: number): string {
    return '★'.repeat(Math.max(0, Math.min(5, n))) + '☆'.repeat(5 - Math.max(0, Math.min(5, n)));
  }
}
