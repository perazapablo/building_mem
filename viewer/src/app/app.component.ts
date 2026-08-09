import { CommonModule } from '@angular/common';
import { Component } from '@angular/core';
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
export class AppComponent {}
