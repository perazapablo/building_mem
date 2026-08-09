import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'overview' },
  {
    path: 'overview',
    loadComponent: () =>
      import('./sections/overview/overview.component').then((m) => m.OverviewComponent),
  },
  {
    path: 'knowledge',
    loadComponent: () =>
      import('./sections/knowledge/knowledge.component').then((m) => m.KnowledgeComponent),
  },
  {
    path: 'code',
    loadComponent: () =>
      import('./sections/code/code.component').then((m) => m.CodeComponent),
  },
  {
    path: 'history',
    loadComponent: () =>
      import('./sections/history/history.component').then((m) => m.HistoryComponent),
  },
  {
    path: 'graph',
    loadComponent: () =>
      import('./sections/graph/graph.component').then((m) => m.GraphComponent),
  },
  {
    path: 'context',
    loadComponent: () =>
      import('./sections/context-builder/context-builder.component').then(
        (m) => m.ContextBuilderComponent,
      ),
  },
];
