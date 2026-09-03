import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Project, SessionRow } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';

interface ProjectCard {
  project: Project;
  openThreads: number;
}

interface GlobalSession {
  session: SessionRow;
  projectName: string;
  goal: string;
}

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [CommonModule, DateAbsPipe, DateRelPipe],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  cards = signal<ProjectCard[]>([]);
  recent = signal<GlobalSession[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  totalProjects = computed(() => this.cards().length);
  totalOpenThreads = computed(() => this.cards().reduce((n, c) => n + c.openThreads, 0));

  constructor(
    public ws: WorkspaceService,
    private tauri: TauriService,
    private router: Router,
  ) {
    this.load();
  }

  async load() {
    this.loading.set(true);
    this.error.set(null);
    try {
      const projects = await this.tauri.listProjects();
      // In parallel: open thread counts per project + all sessions.
      const [threadCounts, allSessions] = await Promise.all([
        Promise.all(projects.map(async (p) => {
          try {
            const t = await this.tauri.listProjectThreads(p.id, 'open');
            return t.length;
          } catch { return 0; }
        })),
        this.tauri.listSessions(), // no project_id → global
      ]);

      const cards: ProjectCard[] = projects.map((project, i) => ({
        project,
        openThreads: threadCounts[i],
      }));
      this.cards.set(cards);

      const projById = new Map(projects.map((p) => [p.id, p]));
      const recent: GlobalSession[] = allSessions.slice(0, 5).map((s) => ({
        session: s,
        projectName: (s.project_id && projById.get(s.project_id)?.name) || '—',
        goal: (s.summary as any)?.goal || '',
      }));
      this.recent.set(recent);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  openProject(p: Project) {
    this.ws.select(p);
    this.router.navigate(['/overview']);
  }

  openSession(s: GlobalSession) {
    const p = this.cards().find((c) => c.project.id === s.session.project_id)?.project;
    if (p) this.ws.select(p);
    this.router.navigate(['/history']);
  }
}
