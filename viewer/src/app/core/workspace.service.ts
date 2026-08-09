import { Injectable, signal } from '@angular/core';
import { DeleteProjectCounts, MergeProjectCounts, Project } from './models';
import { TauriService } from './tauri.service';

@Injectable({ providedIn: 'root' })
export class WorkspaceService {
  projects = signal<Project[]>([]);
  current = signal<Project | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  constructor(private tauri: TauriService) {}

  async loadProjects() {
    this.loading.set(true);
    this.error.set(null);
    try {
      const ps = await this.tauri.listProjects();
      this.projects.set(ps);
      if (!this.current() && ps.length) {
        this.current.set(ps[0]);
      }
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  select(p: Project) {
    this.current.set(p);
  }

  async mergeProject(sourceId: string, targetId: string): Promise<MergeProjectCounts> {
    const counts = await this.tauri.mergeProject(sourceId, targetId);
    const remaining = this.projects().filter((p) => p.id !== sourceId);
    this.projects.set(remaining);
    if (this.current()?.id === sourceId) {
      const tgt = remaining.find((p) => p.id === targetId) ?? remaining[0] ?? null;
      this.current.set(tgt);
    }
    return counts;
  }

  async deleteProject(id: string): Promise<DeleteProjectCounts> {
    const counts = await this.tauri.deleteProject(id);
    const remaining = this.projects().filter((p) => p.id !== id);
    this.projects.set(remaining);
    if (this.current()?.id === id) {
      this.current.set(remaining[0] ?? null);
    }
    return counts;
  }
}
