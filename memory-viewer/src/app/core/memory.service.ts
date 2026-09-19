import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';

import {
  Artifact,
  Dashboard,
  DecisionRecord,
  FocusEntry,
  Note,
  Project,
  ProjectGraph,
  ProjectPath,
  ProjectThread,
  SessionBundle,
  SessionIndexRow,
  SessionRow,
} from './models';

/**
 * Único punto por el que el cliente habla con el servidor Rust.
 * Ningún componente llama a `invoke` por su cuenta.
 */
@Injectable({ providedIn: 'root' })
export class MemoryService {
  dbPath(): Promise<string> {
    return invoke<string>('get_db_path');
  }

  listProjects(): Promise<Project[]> {
    return invoke<Project[]>('list_projects');
  }

  getProject(id: string): Promise<Project | null> {
    return invoke<Project | null>('get_project', { id });
  }

  listSessions(projectId: string, limit = 50): Promise<SessionIndexRow[]> {
    return invoke<SessionIndexRow[]>('list_sessions', { projectId, limit });
  }

  getSession(sessionId: string): Promise<SessionRow | null> {
    return invoke<SessionRow | null>('get_session', { sessionId });
  }

  listDecisionTips(projectId: string): Promise<DecisionRecord[]> {
    return invoke<DecisionRecord[]>('list_decision_tips', { projectId });
  }

  getProjectGraph(projectId: string): Promise<ProjectGraph> {
    return invoke<ProjectGraph>('get_project_graph', { projectId });
  }

  getDashboard(projectId: string): Promise<Dashboard> {
    return invoke<Dashboard>('get_dashboard', { projectId });
  }

  listNotes(projectId: string): Promise<Note[]> {
    return invoke<Note[]>('list_notes', { projectId });
  }

  listArtifacts(projectId: string): Promise<Artifact[]> {
    return invoke<Artifact[]>('list_artifacts', { projectId });
  }

  /** El recorrido de una sesión: todos los focus que declaró, en orden. */
  getFocusHistory(sessionId: string): Promise<FocusEntry[]> {
    return invoke<FocusEntry[]>('get_focus_history', { sessionId });
  }

  /** Todo lo que dejó una sesión, en una sola llamada. */
  getSessionBundle(sessionId: string): Promise<SessionBundle> {
    return invoke<SessionBundle>('get_session_bundle', { sessionId });
  }

  listPaths(projectId: string): Promise<ProjectPath[]> {
    return invoke<ProjectPath[]>('list_paths', { projectId });
  }

  /** Escritura: el viewer es de lectura salvo lo que se pide desde la UI. */
  openThread(projectId: string, thread: string): Promise<ProjectThread> {
    return invoke<ProjectThread>('open_thread', { projectId, thread });
  }

  /** `status`: 'done' (terminado) o 'dropped' (descartado). */
  closeThread(threadId: string, status: string, reason: string): Promise<ProjectThread> {
    return invoke<ProjectThread>('close_thread', { threadId, status, reason });
  }

  listThreads(projectId: string, status?: string): Promise<ProjectThread[]> {
    return invoke<ProjectThread[]>('list_threads', { projectId, status: status ?? null });
  }
}
