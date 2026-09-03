import { CommonModule } from '@angular/common';
import { Component, effect, OnInit, signal } from '@angular/core';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { SessionFocus, TableCounts } from '../../core/models';
import { DateFullPipe } from '../../core/date.pipes';
import { GlobalSearchComponent } from '../../shared/global-search/global-search.component';

@Component({
  selector: 'app-shell-header',
  standalone: true,
  imports: [CommonModule, DateFullPipe, GlobalSearchComponent],
  templateUrl: './shell-header.component.html',
  styleUrl: './shell-header.component.scss',
})
export class ShellHeaderComponent implements OnInit {
  dbPath = signal<string>('');
  counts = signal<TableCounts | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  focus = signal<SessionFocus | null>(null);

  constructor(private tauri: TauriService, public ws: WorkspaceService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.loadFocus(p.id);
      else this.focus.set(null);
    });
  }

  async ngOnInit() {
    await this.refresh();
  }

  async refresh() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.dbPath.set(await this.tauri.getDbPath());
      this.counts.set(await this.tauri.getTableCounts());
      const p = this.ws.current();
      if (p) await this.loadFocus(p.id);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  async pickDb() {
    try {
      const picked = await this.tauri.pickDbAndOpen();
      if (picked) {
        this.dbPath.set(picked);
        this.counts.set(await this.tauri.getTableCounts());
      }
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

  private async loadFocus(projectId: string) {
    try {
      this.focus.set(await this.tauri.getLatestFocusForProject(projectId));
    } catch {
      this.focus.set(null);
    }
  }
}
