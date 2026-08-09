import { CommonModule } from '@angular/common';
import { Component, computed, effect, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { BuildContextResponse, ContextItem, SessionRow } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';

interface Group {
  type: ContextItem['type'];
  items: ContextItem[];
  tokens: number;
}

const TOKENIZERS = [
  { value: 'generic:conservative', label: 'generic (default)' },
  { value: 'anthropic:claude', label: 'anthropic:claude' },
  { value: 'openai:o200k_base', label: 'openai:o200k_base' },
  { value: 'openai:cl100k_base', label: 'openai:cl100k_base' },
];

@Component({
  selector: 'app-context-builder',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './context-builder.component.html',
  styleUrl: './context-builder.component.scss',
})
export class ContextBuilderComponent {
  tokenBudget = signal<number>(4000);
  tokenizer = signal<string>('generic:conservative');
  sessionId = signal<string>('');
  sessions = signal<SessionRow[]>([]);
  tokenizers = TOKENIZERS;

  result = signal<BuildContextResponse | null>(null);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);

  groups = computed<Group[]>(() => {
    const res = this.result();
    if (!res) return [];
    const map = new Map<ContextItem['type'], Group>();
    for (const it of res.items) {
      let g = map.get(it.type);
      if (!g) {
        g = { type: it.type, items: [], tokens: 0 };
        map.set(it.type, g);
      }
      g.items.push(it);
      g.tokens += it.token_count;
    }
    const order: ContextItem['type'][] = ['decision', 'note', 'artifact', 'code_entity'];
    return order.filter((t) => map.has(t)).map((t) => map.get(t)!);
  });

  budgetPct = computed(() => {
    const res = this.result();
    if (!res || res.effective_budget === 0) return 0;
    return Math.min(100, Math.round((res.used_tokens / res.effective_budget) * 100));
  });

  constructor(public ws: WorkspaceService, private tauri: TauriService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.loadSessions(p.id);
    });
  }

  async loadSessions(projectId: string) {
    try {
      this.sessions.set(await this.tauri.listSessions(projectId));
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

  async build() {
    const p = this.ws.current();
    if (!p) return;
    this.loading.set(true);
    this.error.set(null);
    try {
      const res = await this.tauri.buildContext(
        p.id,
        this.tokenBudget(),
        this.sessionId() || undefined,
        this.tokenizer(),
      );
      this.result.set(res);
    } catch (e: any) {
      this.error.set(String(e));
      this.result.set(null);
    } finally {
      this.loading.set(false);
    }
  }

  itemPrimary(it: ContextItem): string {
    switch (it.type) {
      case 'note':
        return it.content;
      case 'decision':
        return it.decision;
      case 'artifact':
        return `[${it.artifact_type}] ${it.content}`;
      case 'code_entity':
        return `${it.kind} · ${it.qualified_name || it.name}`;
    }
  }

  itemSecondary(it: ContextItem): string {
    switch (it.type) {
      case 'decision':
        return it.reasoning;
      case 'code_entity':
        return `${it.path} — ${it.summary}`;
      default:
        return '';
    }
  }
}
