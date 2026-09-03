import { CommonModule } from '@angular/common';
import { Component, computed, signal } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs/operators';
import { ShellHeaderComponent } from './shell/shell-header/shell-header.component';
import { ProjectsSidebarComponent } from './shell/projects-sidebar/projects-sidebar.component';
import { WorkspaceComponent } from './workspace/workspace.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, ShellHeaderComponent, ProjectsSidebarComponent, WorkspaceComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {
  private currentUrl = signal<string>('/');
  isDashboard = computed(() => this.currentUrl().startsWith('/dashboard'));

  constructor(private router: Router) {
    this.currentUrl.set(this.router.url);
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.currentUrl.set(e.urlAfterRedirects));
  }
}
