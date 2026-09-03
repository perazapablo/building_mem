import { CommonModule } from '@angular/common';
import { Component, effect, signal } from '@angular/core';
import { ArtifactRow, DecisionRow, Project, ProjectThread, SessionRow, SessionStats, SessionSummary, WorkingState } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { DateAbsPipe, DateFullPipe, DateRelPipe } from '../../core/date.pipes';

interface SessionView extends SessionRow {
  parsedSummary: SessionSummary | null;
}

interface RefRow {
  id: string;
  preview: string;
  meta?: string;
}

interface ModalPayload {
  title: string;
  subtitle?: string;
  body: string;
  meta?: { k: string; v: string }[];
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule, DateAbsPipe, DateRelPipe, DateFullPipe],
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss',
})
export class HistoryComponent {
  sessions = signal<SessionView[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  selected = signal<SessionView | null>(null);
  workingState = signal<WorkingState | null>(null);

  decisionsById = signal<Map<string, DecisionRow>>(new Map());
  artifactsById = signal<Map<string, ArtifactRow>>(new Map());
  threadsById = signal<Map<string, ProjectThread>>(new Map());

  modal = signal<ModalPayload | null>(null);

  constructor(public ws: WorkspaceService, private tauri: TauriService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.load(p);
    });
  }

  async load(p: Project) {
    this.loading.set(true);
    this.error.set(null);
    this.selected.set(null);
    this.workingState.set(null);
    try {
      const [rows, decisions, artifacts, threads] = await Promise.all([
        this.tauri.listSessions(p.id),
        this.tauri.listDecisions(p.id),
        this.tauri.listArtifacts(p.id),
        this.tauri.listProjectThreads(p.id),
      ]);
      this.decisionsById.set(new Map(decisions.map((d) => [d.id, d])));
      this.artifactsById.set(new Map(artifacts.map((a) => [a.id, a])));
      this.threadsById.set(new Map(threads.map((t) => [t.id, t])));

      const views: SessionView[] = rows.map((r) => ({
        ...r,
        parsedSummary: (r.summary as SessionSummary) || null,
      }));
      this.sessions.set(views);
      if (views.length) this.select(views[0]);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async select(s: SessionView) {
    this.selected.set(s);
    this.workingState.set(null);
    try {
      this.workingState.set(await this.tauri.getWorkingState(s.id));
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

  decisionRows(ids: string[] | undefined): RefRow[] {
    if (!ids) return [];
    const map = this.decisionsById();
    return ids.map((id) => {
      const d = map.get(id);
      if (!d) return { id, preview: '(no encontrada)', meta: id.slice(0, 8) };
      return {
        id,
        preview: this.oneLine(d.decision) || '(sin texto)',
        meta: d.topic_key || undefined,
      };
    });
  }

  artifactRows(ids: string[] | undefined): RefRow[] {
    if (!ids) return [];
    const map = this.artifactsById();
    return ids.map((id) => {
      const a = map.get(id);
      if (!a) return { id, preview: '(no encontrado)', meta: id.slice(0, 8) };
      return {
        id,
        preview: this.oneLine(a.content) || '(sin contenido)',
        meta: a.type,
      };
    });
  }

  threadRows(ids: string[] | undefined): RefRow[] {
    if (!ids) return [];
    const map = this.threadsById();
    return ids.map((id) => {
      const t = map.get(id);
      if (!t) return { id, preview: '(no encontrado)', meta: id.slice(0, 8) };
      return {
        id,
        preview: this.oneLine(t.thread) || '(sin texto)',
        meta: t.status,
      };
    });
  }

  openDecision(id: string) {
    const d = this.decisionsById().get(id);
    if (!d) {
      this.modal.set({ title: 'Decision no encontrada', body: id });
      return;
    }
    this.modal.set({
      title: d.topic_key || 'Decision',
      subtitle: id,
      body: d.decision + (d.reasoning ? '\n\n— Reasoning —\n' + d.reasoning : ''),
      meta: [
        { k: 'status', v: d.status },
        { k: 'importance', v: String(d.importance) },
        { k: 'creada', v: d.created_at },
      ],
    });
  }

  openArtifact(id: string) {
    const a = this.artifactsById().get(id);
    if (!a) {
      this.modal.set({ title: 'Artifact no encontrado', body: id });
      return;
    }
    this.modal.set({
      title: a.topic_key || a.type,
      subtitle: id,
      body: a.content,
      meta: [
        { k: 'type', v: a.type },
        { k: 'status', v: a.status },
        { k: 'importance', v: String(a.importance) },
        { k: 'creada', v: a.created_at },
      ],
    });
  }

  openThread(id: string) {
    const t = this.threadsById().get(id);
    if (!t) {
      this.modal.set({ title: 'Thread no encontrado', body: id });
      return;
    }
    this.modal.set({
      title: 'Thread ' + t.status,
      subtitle: id,
      body: t.thread + (t.close_reason ? '\n\n— Razón de cierre —\n' + t.close_reason : ''),
      meta: [
        { k: 'status', v: t.status },
        { k: 'opened_in', v: t.opened_in },
        { k: 'closed_in', v: t.closed_in || '—' },
        { k: 'closed_at', v: t.closed_at || '—' },
      ],
    });
  }

  closeModal() {
    this.modal.set(null);
  }

  private oneLine(s: string, max = 140): string {
    const flat = s.replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
  }

  memoryWritesTotal(st: SessionStats): number {
    const w = st.memory_writes;
    if (!w) return 0;
    return Object.values(w).reduce((a, b) => a + (b || 0), 0);
  }

  memoryWritesEntries(st: SessionStats): { name: string; count: number }[] {
    const w = st.memory_writes;
    if (!w) return [];
    return Object.entries(w)
      .map(([name, count]) => ({ name, count: count || 0 }))
      .sort((a, b) => b.count - a.count);
  }
}
