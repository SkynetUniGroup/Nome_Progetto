import { create } from "zustand";
import { Report, TaskEntry, OperationCode } from "../types";

interface AnalysisContext {
  id: string;
  repoOwner: string;
  repoName: string;
  ref: string;
  scope: string;
}

interface AppState {
  contexts: AnalysisContext[];
  tasks: TaskEntry[];
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
  setTasks: (tasks: TaskEntry[]) => void;
  addTask: (task: TaskEntry) => void;
  updateTask: (taskId: string, updates: Partial<TaskEntry>) => void;
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
  addContext: (context) =>
    set((state) => ({
      contexts: [...state.contexts, context],
    })),

  setTasks: (tasks) => set({ tasks }),

  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, task],
    })),

  updateTask: (taskId, updates) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === taskId ? { ...t, ...updates } : t)),
    })),

  setCurrentTask: (taskId) => set({ currentTaskId: taskId }),

  addReport: (report) =>
    set((state) => ({
      reports: { ...state.reports, [report.id]: report },
    })),

  setWebSocketConnected: (connected) => set({ websocketConnected: connected }),

  setConfigured: (status) => set({ isConfigured: status }),

  setFormData: (data) => set({ formData: data }),
}));
