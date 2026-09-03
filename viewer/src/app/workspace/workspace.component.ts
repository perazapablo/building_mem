import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs/operators';
import { WorkspaceService } from '../core/workspace.service';

@Component({
  selector: 'app-workspace',
  standalone: true,
  imports: [CommonModule, RouterLink, RouterLinkActive, RouterOutlet],
  templateUrl: './workspace.component.html',
  styleUrl: './workspace.component.scss',
})
export class WorkspaceComponent {
  currentUrl = signal<string>('/');
  isDashboard = computed(() => this.currentUrl().startsWith('/dashboard'));
  copiedId = signal<string | null>(null);

  async copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      this.copiedId.set(id);
      setTimeout(() => {
        if (this.copiedId() === id) this.copiedId.set(null);
      }, 1400);
    } catch {
      /* ignore */
    }
  }

  constructor(public ws: WorkspaceService, private router: Router) {
    this.currentUrl.set(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentUrl.set(e.urlAfterRedirects));
  }
}
