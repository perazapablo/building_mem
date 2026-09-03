import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, ElementRef, HostListener, computed, effect, signal } from '@angular/core';
import { Router } from '@angular/router';
import { CodeEntity, SearchAllResponse, SearchAllResult } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { DateAbsPipe, DateRelPipe } from '../../core/date.pipes';

interface Group {
  type: SearchAllResult['type'];
  label: string;
  results: SearchAllResult[];
}

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

@Component({
  selector: 'app-global-search',
  standalone: true,
  imports: [CommonModule, FormsModule, DateAbsPipe, DateRelPipe],
  templateUrl: './global-search.component.html',
  styleUrl: './global-search.component.scss',
})
export class GlobalSearchComponent {
  query = signal<string>('');
  results = signal<SearchAllResult[] | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  open = signal<boolean>(false);

  private debounceTimer: number | null = null;
  private currentToken = 0;

  private readonly typeLabels: Record<SearchAllResult['type'], string> = {
    note: 'Notas',
    decision: 'Decisiones',
    artifact: 'Artefactos',
    code_entity: 'Code entities',
  };

  private readonly routeByType: Record<SearchAllResult['type'], string> = {
    note: 'knowledge',
    decision: 'knowledge',
    artifact: 'knowledge',
    code_entity: 'code',
  };

  grouped = computed<Group[]>(() => {
    const list = this.results();
    if (!list) return [];
    const by = new Map<SearchAllResult['type'], SearchAllResult[]>();
    for (const r of list) {
      if (!by.has(r.type)) by.set(r.type, []);
      by.get(r.type)!.push(r);
    }
    return Array.from(by.entries()).map(([type, results]) => ({
      type,
      label: this.typeLabels[type],
      results,
    }));
  });

  totalCount = computed(() => this.results()?.length ?? 0);

  constructor(
    public ws: WorkspaceService,
    private tauri: TauriService,
    private router: Router,
    private host: ElementRef,
  ) {
    // Reset when project changes.
    effect(() => {
      this.ws.current();
      this.clear();
    });
  }

  onInput(v: string) {
    this.query.set(v);
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (v.trim().length < MIN_CHARS) {
      this.results.set(null);
      this.open.set(false);
      return;
    }
    this.debounceTimer = window.setTimeout(() => this.runSearch(), DEBOUNCE_MS);
  }

  onFocus() {
    if (this.query().trim().length >= MIN_CHARS) this.open.set(true);
  }

  async runSearch() {
    const p = this.ws.current();
    const q = this.query().trim();
    if (!p || q.length < MIN_CHARS) return;
    const token = ++this.currentToken;
    this.loading.set(true);
    this.error.set(null);
    this.open.set(true);
    try {
      const res: SearchAllResponse = await this.tauri.searchAll(q, p.id, 30);
      if (token !== this.currentToken) return; // stale
      this.results.set(res.results);
    } catch (e: any) {
      if (token !== this.currentToken) return;
      this.error.set(String(e));
      this.results.set(null);
    } finally {
      if (token === this.currentToken) this.loading.set(false);
    }
  }

  // Modal state
  selected = signal<SearchAllResult | null>(null);
  detailExtras = signal<CodeEntity | null>(null); // hydrated for code_entity

  async openDetail(r: SearchAllResult) {
    this.selected.set(r);
    this.detailExtras.set(null);
    this.open.set(false);
    if (r.type === 'code_entity') {
      try {
        this.detailExtras.set(await this.tauri.getCodeEntity(r.id));
      } catch { /* ignore, we fall back to the snippet data */ }
    }
  }

  closeDetail() {
    this.selected.set(null);
    this.detailExtras.set(null);
  }

  goToSection() {
    const r = this.selected();
    if (!r) return;
    const route = this.routeByType[r.type];
    this.router.navigate([route], { queryParams: { highlight: r.id, type: r.type } });
    this.closeDetail();
  }

  async copyId(id: string) {
    try { await navigator.clipboard.writeText(id); } catch { /* silent */ }
  }

  clear() {
    this.query.set('');
    this.results.set(null);
    this.open.set(false);
    this.error.set(null);
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = null; }
  }

  snippet(r: SearchAllResult, max = 140): string {
    let s = '';
    switch (r.type) {
      case 'note':        s = r.content; break;
      case 'decision':    s = r.decision; break;
      case 'artifact':    s = r.content; break;
      case 'code_entity': s = `${r.kind} ${r.qualified_name}${r.path ? ' · ' + r.path : ''}`; break;
    }
    s = (s ?? '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) + '…' : s;
  }

  @HostListener('document:keydown.escape')
  onEscape() {
    if (this.selected()) this.closeDetail();
    else this.open.set(false);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(ev: MouseEvent) {
    if (this.selected()) return; // modal handles its own close
    if (!this.host.nativeElement.contains(ev.target as Node)) this.open.set(false);
  }
}
