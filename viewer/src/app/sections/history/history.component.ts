import { CommonModule } from '@angular/common';
import { Component, effect, signal } from '@angular/core';
import { Project, SessionRow, SessionSummary, WorkingState } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';

interface SessionView extends SessionRow {
  parsedSummary: SessionSummary | null;
}

@Component({
  selector: 'app-history',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './history.component.html',
  styleUrl: './history.component.scss',
})
export class HistoryComponent {
  sessions = signal<SessionView[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  selected = signal<SessionView | null>(null);
  workingState = signal<WorkingState | null>(null);

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
      const rows = await this.tauri.listSessions(p.id);
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
}
