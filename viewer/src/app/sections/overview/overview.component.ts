import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import {
  ContextSummary,
  Project,
  ProjectPath,
  Relation,
  SessionRow,
  WorkingState,
} from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { SectionCardComponent } from '../../shared/section-card/section-card.component';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';

interface OverviewSnapshot {
  project: Project;
  sessions: SessionRow[];
  pendingRelations: Relation[];
  workingStates: WorkingState[];
  paths: ProjectPath[];
  counts: {
    notes: number;
    decisions: number;
    artifacts: number;
    code_entities: number;
    relations: number;
  };
}

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [CommonModule, SectionCardComponent, DateAbsPipe, DateRelPipe],
  templateUrl: './overview.component.html',
  styleUrl: './overview.component.scss',
})
export class OverviewComponent {
  snapshot = signal<OverviewSnapshot | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  contextSummary = computed<ContextSummary | null>(() => {
    const p = this.snapshot()?.project;
    if (!p) return null;
    return (p.context_summary as ContextSummary) ?? null;
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
      const [sessions, pendingRelations, workingStates, notes, decisions, artifacts, code, paths] =
        await Promise.all([
          this.tauri.listSessions(p.id),
          this.tauri.getPendingJudgments(p.id, 50),
          this.tauri.listWorkingStates(),
          this.tauri.listNotes(p.id),
          this.tauri.listDecisions(p.id),
          this.tauri.listArtifacts(p.id),
          this.tauri.listCodeEntities(p.id),
          this.tauri.listProjectPaths(p.id),
        ]);
      const sessionIds = new Set(sessions.map((s) => s.id));
      this.snapshot.set({
        project: p,
        sessions: sessions.slice(0, 8),
        pendingRelations,
        workingStates: workingStates.filter((w) => sessionIds.has(w.session_id)),
        paths,
        counts: {
          notes: notes.length,
          decisions: decisions.length,
          artifacts: artifacts.length,
          code_entities: code.length,
          relations: pendingRelations.length,
        },
      });
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  sessionGoal(s: SessionRow): string {
    const sum = s.summary as any;
    return sum?.goal || '';
  }

  sessionOutcome(s: SessionRow): string {
    const sum = s.summary as any;
    return sum?.outcome || '';
  }

  async copyPath(path: string) {
    try {
      await navigator.clipboard.writeText(path);
    } catch { /* silent */ }
  }

  pinnedCount(states: WorkingState[]): number {
    return states.reduce((n, ws) => n + (ws.pinned_ids?.length ?? 0), 0);
  }
}
