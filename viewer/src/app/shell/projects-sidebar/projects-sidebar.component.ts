import { CommonModule } from '@angular/common';
import { Component, OnInit, computed, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DeleteProjectCounts, MergeProjectCounts, Project } from '../../core/models';
import { WorkspaceService } from '../../core/workspace.service';

@Component({
  selector: 'app-projects-sidebar',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './projects-sidebar.component.html',
  styleUrl: './projects-sidebar.component.scss',
})
export class ProjectsSidebarComponent implements OnInit {
  pendingDelete = signal<Project | null>(null);
  typedName = signal('');
  deleting = signal(false);
  deleteError = signal<string | null>(null);
  lastResult = signal<DeleteProjectCounts | null>(null);

  pendingMerge = signal<Project | null>(null);
  mergeTargetId = signal('');
  mergeTypedName = signal('');
  merging = signal(false);
  mergeError = signal<string | null>(null);
  lastMerge = signal<MergeProjectCounts | null>(null);

  mergeTargetCandidates = computed(() => {
    const src = this.pendingMerge();
    if (!src) return [] as Project[];
    return this.ws.projects().filter((p) => p.id !== src.id);
  });

  constructor(public ws: WorkspaceService) {}

  ngOnInit() {
    if (!this.ws.projects().length) {
      this.ws.loadProjects();
    }
  }

  select(p: Project) {
    this.ws.select(p);
  }

  askDelete(p: Project, ev: Event) {
    ev.stopPropagation();
    this.pendingDelete.set(p);
    this.typedName.set('');
    this.deleteError.set(null);
  }

  cancelDelete() {
    if (this.deleting()) return;
    this.pendingDelete.set(null);
    this.typedName.set('');
    this.deleteError.set(null);
  }

  canConfirm(): boolean {
    const p = this.pendingDelete();
    return !!p && this.typedName().trim() === p.name && !this.deleting();
  }

  async confirmDelete() {
    const p = this.pendingDelete();
    if (!p || !this.canConfirm()) return;
    this.deleting.set(true);
    this.deleteError.set(null);
    try {
      const counts = await this.ws.deleteProject(p.id);
      this.lastResult.set(counts);
      this.pendingDelete.set(null);
      this.typedName.set('');
    } catch (e: any) {
      this.deleteError.set(String(e));
    } finally {
      this.deleting.set(false);
    }
  }

  dismissResult() {
    this.lastResult.set(null);
  }

  askMerge(p: Project, ev: Event) {
    ev.stopPropagation();
    this.pendingMerge.set(p);
    this.mergeTargetId.set('');
    this.mergeTypedName.set('');
    this.mergeError.set(null);
  }

  cancelMerge() {
    if (this.merging()) return;
    this.pendingMerge.set(null);
    this.mergeTargetId.set('');
    this.mergeTypedName.set('');
    this.mergeError.set(null);
  }

  canConfirmMerge(): boolean {
    const src = this.pendingMerge();
    if (!src || this.merging()) return false;
    if (!this.mergeTargetId()) return false;
    return this.mergeTypedName().trim() === src.name;
  }

  async confirmMerge() {
    const src = this.pendingMerge();
    const tgtId = this.mergeTargetId();
    if (!src || !tgtId || !this.canConfirmMerge()) return;
    this.merging.set(true);
    this.mergeError.set(null);
    try {
      const counts = await this.ws.mergeProject(src.id, tgtId);
      this.lastMerge.set(counts);
      this.pendingMerge.set(null);
      this.mergeTargetId.set('');
      this.mergeTypedName.set('');
    } catch (e: any) {
      this.mergeError.set(String(e));
    } finally {
      this.merging.set(false);
    }
  }

  dismissMergeResult() {
    this.lastMerge.set(null);
  }
}
