import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Component, computed, effect, signal } from '@angular/core';
import { Project, ProjectThread, SessionFocus, ThreadStatus } from '../../core/models';
import { TauriService } from '../../core/tauri.service';
import { WorkspaceService } from '../../core/workspace.service';
import { AgeDaysPipe, DateAbsPipe, DateFullPipe, DateRelPipe } from '../../core/date.pipes';

type StatusFilter = 'all' | ThreadStatus;

const STALE_DAYS_KEY = 'viewer.threads.staleDays';

interface FocusInfo {
  session_id: string;
  focus: string;
  updated_at: string;
}

interface ModalPayload {
  title: string;
  subtitle?: string;
  body: string;
  meta?: { k: string; v: string }[];
}

@Component({
  selector: 'app-threads',
  standalone: true,
  imports: [CommonModule, FormsModule, DateAbsPipe, DateRelPipe, DateFullPipe, AgeDaysPipe],
  templateUrl: './threads.component.html',
  styleUrl: './threads.component.scss',
})
export class ThreadsComponent {
  threads = signal<ProjectThread[]>([]);
  loading = signal<boolean>(false);
  error = signal<string | null>(null);
  filter = signal<StatusFilter>('open');
  newText = signal<string>('');
  staleDays = signal<number>(Number(localStorage.getItem(STALE_DAYS_KEY)) || 30);
  busyId = signal<string | null>(null);

  // Active session (used to open new threads and close from viewer).
  // Resolved from session_focus.get_latest_for_project.
  activeSession = signal<SessionFocus | null>(null);

  // session_id → focus (used to enrich each card with the focus of the
  // session that opened / closed it).
  focusMap = signal<Map<string, FocusInfo>>(new Map());

  modal = signal<ModalPayload | null>(null);

  openModal(t: ProjectThread) {
    const meta: { k: string; v: string }[] = [
      { k: 'status', v: t.status },
      { k: 'opened_in', v: t.opened_in },
      { k: 'created_at', v: t.created_at },
      { k: 'updated_at', v: t.updated_at },
    ];
    if (t.closed_in) meta.push({ k: 'closed_in', v: t.closed_in });
    if (t.closed_at) meta.push({ k: 'closed_at', v: t.closed_at });
    this.modal.set({
      title: 'Thread ' + t.status,
      subtitle: t.id,
      body: t.thread + (t.close_reason ? '\n\n— Razón de cierre —\n' + t.close_reason : ''),
      meta,
    });
  }

  closeModal() { this.modal.set(null); }

  readonly filters: StatusFilter[] = ['all', 'open', 'done', 'dropped', 'stale'];

  private readonly labels: Record<StatusFilter, string> = {
    all: 'Todos',
    open: 'Abiertos',
    done: 'Hechos',
    dropped: 'Descartados',
    stale: 'Rancios',
  };

  private readonly help: Record<StatusFilter, string> = {
    all: 'Todos los hilos, sin filtrar',
    open: 'Activos: en trabajo o esperando ser retomados',
    done: 'Terminados: se completó lo que había que hacer',
    dropped: 'Abandonados: se decidió que no se hace más',
    stale: 'Rancios: sin actualizar hace mucho, necesitan decisión',
  };

  statusLabel(s: StatusFilter): string { return this.labels[s]; }
  statusHelp(s: StatusFilter): string { return this.help[s]; }

  countFor(f: StatusFilter): number {
    return f === 'all' ? this.threads().length : this.counts()[f];
  }

  filtered = computed<ProjectThread[]>(() => {
    const f = this.filter();
    const all = this.threads();
    return f === 'all' ? all : all.filter((t) => t.status === f);
  });

  counts = computed(() => {
    const by: Record<ThreadStatus, number> = { open: 0, done: 0, dropped: 0, stale: 0 };
    for (const t of this.threads()) by[t.status]++;
    return by;
  });

  constructor(public ws: WorkspaceService, private tauri: TauriService) {
    effect(() => {
      const p = this.ws.current();
      if (p) this.load(p);
      else { this.threads.set([]); this.activeSession.set(null); this.focusMap.set(new Map()); }
    });
  }

  async load(p: Project) {
    this.loading.set(true);
    this.error.set(null);
    try {
      const [rows, active] = await Promise.all([
        this.tauri.listProjectThreads(p.id),
        this.tauri.getLatestFocusForProject(p.id),
      ]);
      this.threads.set(rows);
      this.activeSession.set(active);
      await this.hydrateFocusMap(rows);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.loading.set(false);
    }
  }

  private async hydrateFocusMap(rows: ProjectThread[]) {
    const ids = new Set<string>();
    for (const t of rows) {
      if (t.opened_in) ids.add(t.opened_in);
      if (t.closed_in) ids.add(t.closed_in);
    }
    const results = await Promise.all(
      Array.from(ids).map(async (sid) => {
        try {
          const f = await this.tauri.getFocus(sid);
          return f ? [sid, { session_id: sid, focus: f.focus, updated_at: f.updated_at }] as const : null;
        } catch { return null; }
      })
    );
    const map = new Map<string, FocusInfo>();
    for (const r of results) if (r) map.set(r[0], r[1]);
    this.focusMap.set(map);
  }

  focusOf(sessionId: string | null | undefined): FocusInfo | null {
    if (!sessionId) return null;
    return this.focusMap().get(sessionId) ?? null;
  }

  setFilter(f: StatusFilter) { this.filter.set(f); }

  persistStaleDays() {
    localStorage.setItem(STALE_DAYS_KEY, String(this.staleDays()));
  }

  private requireActiveSid(): string | null {
    const s = this.activeSession();
    if (!s) {
      this.error.set(
        'No hay sesión activa para este proyecto. Iniciá una sesión Claude/opencode y llamá set_focus antes de operar hilos desde el viewer.'
      );
      return null;
    }
    return s.session_id;
  }

  async openNew() {
    const p = this.ws.current();
    if (!p) return;
    const text = this.newText().trim();
    if (!text) { this.error.set('Falta la descripción del hilo.'); return; }
    const sid = this.requireActiveSid();
    if (!sid) return;
    this.error.set(null);
    try {
      await this.tauri.openThread(p.id, text, sid);
      this.newText.set('');
      await this.load(p);
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

  async close(t: ProjectThread, status: 'done' | 'dropped') {
    const sid = this.requireActiveSid();
    if (!sid) return;
    const label = status === 'done' ? 'hecho' : 'descartado';
    const reason = prompt(`Razón del cierre (${label}, opcional):`) ?? undefined;
    this.busyId.set(t.id);
    try {
      await this.tauri.closeThread(t.id, status, sid, reason || undefined);
      const p = this.ws.current();
      if (p) await this.load(p);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.busyId.set(null);
    }
  }

  async touch(t: ProjectThread) {
    this.busyId.set(t.id);
    try {
      await this.tauri.touchThread(t.id);
      const p = this.ws.current();
      if (p) await this.load(p);
    } catch (e: any) {
      this.error.set(String(e));
    } finally {
      this.busyId.set(null);
    }
  }

  async markStale() {
    const p = this.ws.current();
    if (!p) return;
    const days = this.staleDays();
    if (!Number.isFinite(days) || days <= 0) { this.error.set('Los días tienen que ser mayor a 0.'); return; }
    try {
      const n = await this.tauri.markStaleThreads(p.id, days);
      await this.load(p);
      this.error.set(null);
      if (n === 0) this.error.set(`No había hilos abiertos con más de ${days} días sin tocar.`);
    } catch (e: any) {
      this.error.set(String(e));
    }
  }

}
