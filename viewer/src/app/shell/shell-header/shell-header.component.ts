import { CommonModule } from '@angular/common';
import { Component, OnInit, signal } from '@angular/core';
import { TauriService } from '../../core/tauri.service';
import { TableCounts } from '../../core/models';

@Component({
  selector: 'app-shell-header',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './shell-header.component.html',
  styleUrl: './shell-header.component.scss',
})
export class ShellHeaderComponent implements OnInit {
  dbPath = signal<string>('');
  counts = signal<TableCounts | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  constructor(private tauri: TauriService) {}

  async ngOnInit() {
    await this.refresh();
  }

  async refresh() {
    this.loading.set(true);
    this.error.set(null);
    try {
      this.dbPath.set(await this.tauri.getDbPath());
      this.counts.set(await this.tauri.getTableCounts());
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
}
