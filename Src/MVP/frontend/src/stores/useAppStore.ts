import { create } from 'zustand';
// `Task` e `ReportStatus` non sono mai esistiti in ../types: erano rimasti
// indietro rispetto all'allineamento del client ai contratti del backend, e
// nessuno se n'era accorto perché la compilazione dei tipi non veniva
// eseguita da nessuna parte — Vitest cancella i tipi senza controllarli, e
// in CI il passo di build non esisteva.
import { Report, OperationCode, TaskStatus } from '../types';

/**
 * Una task come la tiene *questo* store.
 *
 * Non è `TaskEntry`: quello è il contratto di `GET /tasks`, che arriva già
 * completo di avanzamento, stadio corrente ed eventuale errore. Qui la task
 * nasce nel momento in cui l'interfaccia la avvia (RepositorySelection), con
 * i soli campi noti allora — più il `contextId`, che il contratto del
 * backend non riporta ma che serve alla navigazione locale — e si arricchisce
 * poi via `updateTask`.
 */
export interface StoredTask {
  id: string;
  contextId: string;
  operation: OperationCode;
  status: TaskStatus;
  progressPercent?: number;
  currentStage?: string | null;
  reportId?: string | null;
  error?: { code: string; message: string; stage: string } | null;
}

interface AnalysisContext {
  id: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  scope: string;
}

interface AppState {
  contexts: AnalysisContext[];
  tasks: StoredTask[];
  reports: Record<string, Report>;
  currentTaskId: string | null;
  websocketConnected: boolean;
  isConfigured: boolean;
  formData: {
    repoOwner: string;
    repoName: string;
    ref: string;
    scope: string;
  } | null;
}

interface AppActions {
  addContext: (context: AnalysisContext) => void;
  setTasks: (tasks: StoredTask[]) => void;
  addTask: (task: StoredTask) => void;
  updateTask: (taskId: string, updates: Partial<StoredTask>) => void;
  setCurrentTask: (taskId: string | null) => void;
  addReport: (report: Report) => void;
  setWebSocketConnected: (connected: boolean) => void;
  setConfigured: (status: boolean) => void;
  setFormData: (data: { repoOwner: string; repoName: string; ref: string; scope: string }) => void;
}

type AppStore = AppState & AppActions;

export const useAppStore = create<AppStore>((set) => ({
  // State
  contexts: [],
  tasks: [],
  reports: {},
  currentTaskId: null,
  websocketConnected: false,
  // Non deriva da un JWT eventualmente presente: il JWT del login silenzioso
  // non implica che il PAT GitHub sia stato salvato. Si riparte sempre dalla
  // schermata di setup, che è l'unica a impostarlo a true (dopo il salvataggio
  // riuscito della credenziale GitHub).
  isConfigured: false,
  formData: null,

  // Actions
  addContext: (context) => set((state) => ({
    contexts: [...state.contexts, context]
  })),

  setTasks: (tasks) => set({ tasks }),

  addTask: (task) => set((state) => ({
    tasks: [...state.tasks, task]
  })),

  updateTask: (taskId, updates) => set((state) => ({
    tasks: state.tasks.map(t =>
      t.id === taskId ? { ...t, ...updates } : t
    )
  })),

  setCurrentTask: (taskId) => set({ currentTaskId: taskId }),

  addReport: (report) => set((state) => ({
    reports: { ...state.reports, [report.id]: report }
  })),

  setWebSocketConnected: (connected) => set({ websocketConnected: connected }),

  setConfigured: (status) => set({ isConfigured: status }),
  
  setFormData: (data) => set({ formData: data }),
}));