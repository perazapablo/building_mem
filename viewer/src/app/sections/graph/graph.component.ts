import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  ArtifactRow,
  CodeEntity,
  DecisionRow,
  NoteRow,
  Project,
  Relation,
} from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';

interface EntityLabel {
  primary: string;
  secondary: string;
  missing: boolean;
}

@Component({
  selector: 'app-graph',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './graph.component.html',
  styleUrl: './graph.component.scss',
})
export class GraphComponent {
  pending = signal<Relation[]>([]);
  allRelations = signal<Relation[]>([]);
  index = signal<Map<string, EntityLabel>>(new Map());
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  view = signal<'pending' | 'accepted' | 'rejected' | 'all'>('pending');
  filter = signal<string>('');

  visible = computed(() => {
    const v = this.view();
    const q = this.filter().trim().toLowerCase();
    const base =
      v === 'pending'
        ? this.pending()
        : this.allRelations().filter((r) => v === 'all' || r.judgment_status === v);
    if (!q) return base;
    const idx = this.index();
    return base.filter((r) => {
      const src = idx.get(this.key(r.source_type, r.source_id));
      const tgt = idx.get(this.key(r.target_type, r.target_id));
      const hay = [
        r.relation,
        r.source_type,
        r.target_type,
        r.reason,
        src?.primary,
        src?.secondary,
        tgt?.primary,
        tgt?.secondary,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  });

  byRelationType = computed(() => {
    const map = new Map<string, number>();
    for (const r of this.allRelations()) {
      map.set(r.relation, (map.get(r.relation) || 0) + 1);
    }
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
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
    try {
      const [pendingRels, allRels, notes, decisions, artifacts, codeEntities] =
        await Promise.all([
          this.tauri.getPendingJudgments(p.id, 500),
          this.tauri.listRelations(2000),
          this.tauri.listNotes(p.id),
          this.tauri.listDecisions(p.id),
          this.tauri.listArtifacts(p.id),
          this.tauri.listCodeEntities(p.id),
        ]);
      this.pending.set(pendingRels);
      this.allRelations.set(allRels);
      this.index.set(this.buildIndex(notes, decisions, artifacts, codeEntities));
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private key(type: string, id: string): string {
    return `${type}:${id}`;
  }

  private buildIndex(
    notes: NoteRow[],
    decisions: DecisionRow[],
    artifacts: ArtifactRow[],
    code: CodeEntity[],
  ): Map<string, EntityLabel> {
    const m = new Map<string, EntityLabel>();
    for (const n of notes) {
      m.set(this.key('note', n.id), {
        primary: n.content.slice(0, 120).trim(),
        secondary: (n.tags || []).join(' · ') || n.topic_key || '',
        missing: false,
      });
    }
    for (const d of decisions) {
      m.set(this.key('decision', d.id), {
        primary: d.decision.slice(0, 120).trim(),
        secondary: d.topic_key || d.reasoning.slice(0, 80).trim(),
        missing: false,
      });
    }
    for (const a of artifacts) {
      m.set(this.key('artifact', a.id), {
        primary: `[${a.type}] ${a.content.slice(0, 100).trim()}`,
        secondary: a.topic_key || '',
        missing: false,
      });
    }
    for (const c of code) {
      m.set(this.key('code_entity', c.id), {
        primary: `${c.kind} · ${c.qualified_name || c.name}`,
        secondary: c.path || c.summary?.slice(0, 80) || '',
        missing: false,
      });
    }
    return m;
  }

  labelFor(type: string, id: string): EntityLabel {
    return (
      this.index().get(this.key(type, id)) ?? {
        primary: id.slice(0, 12) + '…',
        secondary: '(no encontrado en este proyecto)',
        missing: true,
      }
    );
  }

  confidencePct(c: number): number {
    return Math.round(c * 100);
  }
}
