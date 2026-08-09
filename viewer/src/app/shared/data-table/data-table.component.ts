import { CommonModule } from '@angular/common';
import { Component, computed, Input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

export interface ColumnDef {
  key: string;
  label: string;
  width?: string;
  json?: boolean;
}

@Component({
  selector: 'app-data-table',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './data-table.component.html',
  styleUrl: './data-table.component.scss',
})
export class DataTableComponent {
  @Input({ required: true }) columns!: ColumnDef[];
  @Input({ required: true }) rows: any[] = [];

  filterText = '';
  private filterSig = signal('');

  filtered = computed(() => {
    const q = this.filterSig().trim().toLowerCase();
    if (!q) return this.rows;
    return this.rows.filter((r) =>
      this.columns.some((c) => this.stringify(r[c.key]).toLowerCase().includes(q)),
    );
  });

  onFilterChange(v: string) {
    this.filterSig.set(v);
  }

  stringify(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  formatJson(value: unknown): string {
    if (value === null || value === undefined) return '';
    try {
      const v = typeof value === 'string' ? JSON.parse(value) : value;
      return JSON.stringify(v, null, 2);
    } catch {
      return this.stringify(value);
    }
  }

  copyRow(row: unknown) {
    navigator.clipboard?.writeText(JSON.stringify(row, null, 2));
  }

  trackByIdx(i: number) {
    return i;
  }
}
