import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CodeEntity, Project } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';

interface KindGroup {
  kind: string;
  entities: CodeEntity[];
}

@Component({
  selector: 'app-code',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './code.component.html',
  styleUrl: './code.component.scss',
})
export class CodeComponent {
  entities = signal<CodeEntity[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  query = signal<string>('');
  filter = signal<string>('');
  selectedKind = signal<string | null>(null);

  selection = signal<CodeEntity | null>(null);

  groups = computed<KindGroup[]>(() => {
    const q = this.filter().trim().toLowerCase();
    const k = this.selectedKind();
    const filtered = this.entities().filter((e) => {
      if (k && e.kind !== k) return false;
      if (!q) return true;
      const t = `${e.name} ${e.qualified_name} ${e.path} ${e.summary} ${(e.tags || []).join(' ')}`;
      return t.toLowerCase().includes(q);
    });
    const map = new Map<string, CodeEntity[]>();
    for (const e of filtered) {
      if (!map.has(e.kind)) map.set(e.kind, []);
      map.get(e.kind)!.push(e);
    }
    return Array.from(map.entries())
      .map(([kind, entities]) => ({ kind, entities }))
      .sort((a, b) => a.kind.localeCompare(b.kind));
  });

  availableKinds = computed(() => {
    const set = new Set(this.entities().map((e) => e.kind));
    return Array.from(set).sort();
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
      const rows = await this.tauri.listCodeEntities(p.id);
      this.entities.set(rows);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async runSearch() {
    const p = this.ws.current();
    if (!p) return;
    const q = this.query().trim();
    if (!q) {
      await this.load(p);
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    try {
      const rows = await this.tauri.searchCodeEntities(q, p.id, 200);
      this.entities.set(rows);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  select(e: CodeEntity) {
    this.selection.set(e);
  }

  setKind(k: string | null) {
    this.selectedKind.set(k);
  }
}
