import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import {
  ArtifactRow, CodeEntity, DecisionRow, NoteRow, Project, Relation,
} from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';

// Discriminated union to normalize any entity we can fetch.
type EntityView =
  | { type: 'note';        data: NoteRow }
  | { type: 'decision';    data: DecisionRow }
  | { type: 'artifact';    data: ArtifactRow }
  | { type: 'code_entity'; data: CodeEntity };

@Component({
  selector: 'app-judgments',
  standalone: true,
  imports: [CommonModule, DateAbsPipe, DateRelPipe],
  templateUrl: './judgments.component.html',
  styleUrl: './judgments.component.scss',
})
export class JudgmentsComponent {
  pending = signal<Relation[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  busyId = signal<string | null>(null);
  expanded = signal<Set<string>>(new Set());
  // Cache: `${type}:${id}` → EntityView | 'loading' | 'error'
  entityCache = signal<Map<string, EntityView | 'loading' | 'error'>>(new Map());

  sorted = computed<Relation[]>(() =>
    [...this.pending()].sort((a, b) => b.confidence - a.confidence),
  );

  constructor(public ws: WorkspaceService, private tauri: TauriService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.load(p);
      else this.pending.set([]);
    });
  }

  async load(p: Project) {
    this.loading.set(true);
    this.error.set(null);
    this.expanded.set(new Set());
    this.entityCache.set(new Map());
    try {
      this.pending.set(await this.tauri.getPendingJudgments(p.id, 200));
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async toggle(r: Relation) {
    const s = new Set(this.expanded());
    if (s.has(r.sync_id)) {
      s.delete(r.sync_id);
      this.expanded.set(s);
      return;
    }
    s.add(r.sync_id);
    this.expanded.set(s);
    // Fetch source + target if not cached.
    await Promise.all([
      this.hydrate(r.source_type, r.source_id),
      this.hydrate(r.target_type, r.target_id),
    ]);
  }

  private async hydrate(type: string, id: string) {
    const key = `${type}:${id}`;
    const cache = this.entityCache();
    if (cache.has(key)) return;
    const next = new Map(cache);
    next.set(key, 'loading');
    this.entityCache.set(next);
    try {
      let data: any = null;
      switch (type) {
        case 'note':        data = await this.tauri.getNote(id); break;
        case 'decision':    data = await this.tauri.getDecision(id); break;
        case 'artifact':    data = await this.tauri.getArtifact(id); break;
        case 'code_entity': data = await this.tauri.getCodeEntity(id); break;
      }
      const done = new Map(this.entityCache());
      if (data) done.set(key, { type, data } as EntityView);
      else done.set(key, 'error');
      this.entityCache.set(done);
    } catch {
      const failed = new Map(this.entityCache());
      failed.set(key, 'error');
      this.entityCache.set(failed);
    }
  }

  entityOf(type: string, id: string): EntityView | 'loading' | 'error' | null {
    return this.entityCache().get(`${type}:${id}`) ?? null;
  }

  isEntity(v: EntityView | 'loading' | 'error' | null): v is EntityView {
    return v !== null && v !== 'loading' && v !== 'error';
  }

  isExpanded(sync_id: string): boolean { return this.expanded().has(sync_id); }

  async judge(r: Relation, status: 'accepted' | 'rejected', ev?: Event) {
    ev?.stopPropagation();
    this.busyId.set(r.sync_id);
    try {
      await this.tauri.judgeRelation(r.sync_id, status);
      this.pending.set(this.pending().filter((x) => x.sync_id !== r.sync_id));
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.busyId.set(null);
    }
  }

  confidenceClass(c: number): string {
    if (c >= 0.85) return 'hi';
    if (c >= 0.6) return 'mid';
    return 'lo';
  }

  entityLabel(type: string): string {
    return type === 'note' ? 'Nota'
      : type === 'decision' ? 'Decisión'
      : type === 'artifact' ? 'Artefacto'
      : type === 'code_entity' ? 'Code entity'
      : type;
  }

  entityTitle(v: EntityView): string {
    switch (v.type) {
      case 'note':        return v.data.topic_key || v.data.content.slice(0, 80);
      case 'decision':    return v.data.topic_key || v.data.decision.slice(0, 80);
      case 'artifact':    return v.data.topic_key || `${v.data.type}`;
      case 'code_entity': return v.data.qualified_name || v.data.name;
    }
  }

  entityBody(v: EntityView): string {
    switch (v.type) {
      case 'note':        return v.data.content;
      case 'decision':    return v.data.decision + (v.data.reasoning ? '\n\nRazonamiento:\n' + v.data.reasoning : '');
      case 'artifact':    return v.data.content;
      case 'code_entity': {
        const d = v.data;
        const parts = [
          d.kind && `kind: ${d.kind}`,
          d.path && `path: ${d.path}`,
          d.signature && `signature: ${d.signature}`,
          d.summary && `summary: ${d.summary}`,
        ].filter(Boolean);
        return parts.join('\n');
      }
    }
  }
}
