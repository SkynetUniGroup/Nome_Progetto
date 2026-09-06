import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { useAppStore } from "../stores/useAppStore";
import type { Report } from "../types";

let currentReportId = "report-1";
vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ reportId: currentReportId }),
}));

const getReportMock = vi.fn();
vi.mock("../utils/api", () => ({
  getReport: (...args: any[]) => getReportMock(...args),
}));

const { default: ReportView } = await import("./ReportView");

const initialState = useAppStore.getState();

const makeReport = (overrides: Partial<Report> = {}): Report => ({
  id: "report-1",
  taskId: "task-1",
  agentId: "security",
  operation: "SECURITY_OWASP",
  status: "COMPLETED",
  body: [],
  generatedAt: "2026-08-18T10:00:00Z",
  title: "title",
  ...overrides,
});

beforeEach(() => {
  useAppStore.setState(initialState, true);
  currentReportId = "report-1";
  getReportMock.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("ReportView", () => {
  it("mostra lo spinner di caricamento mentre il report non e' ancora in store", () => {
    getReportMock.mockReturnValue(new Promise(() => {})); // mai risolta durante il test
    render(<ReportView />);
    expect(screen.getByText(/Caricamento report/i)).toBeInTheDocument();
  });

  it("recupera il report dal backend se non presente in store e lo renderizza", async () => {
    getReportMock.mockResolvedValueOnce(
      makeReport({ summary: "Nessuna vulnerabilita' critica trovata." }),
    );

    render(<ReportView />);

    await waitFor(() => expect(screen.getByText(/Analisi: SECURITY_OWASP/)).toBeInTheDocument());
    expect(getReportMock).toHaveBeenCalledWith("report-1");
    expect(screen.getByText("Nessuna vulnerabilita' critica trovata.")).toBeInTheDocument();
  });

  it("NON richiama il backend se il report e' gia' presente in store (dedup)", async () => {
    useAppStore.getState().addReport(makeReport());
    render(<ReportView />);

    await waitFor(() => expect(screen.getByText(/Analisi: SECURITY_OWASP/)).toBeInTheDocument());
    expect(getReportMock).not.toHaveBeenCalled();
  });

  it('mostra "Report non trovato" se il fetch fallisce e nessun report resta in store', async () => {
    getReportMock.mockRejectedValueOnce(new Error("404"));
    render(<ReportView />);

    await waitFor(() => expect(screen.getByText(/Report non trovato/)).toBeInTheDocument());
  });

  it('renderizza il blocco di errore quando il report contiene un "error" strutturato', async () => {
    useAppStore.getState().addReport(
      makeReport({
        status: "FAILED",
        error: { kind: "TIMEOUT", message: "Timeout del modello LLM", stage: "invoca_llm" },
      }),
    );

    render(<ReportView />);

    await waitFor(() => expect(screen.getByText(/Errore di Analisi/)).toBeInTheDocument());
    expect(screen.getByText(/Timeout del modello LLM/)).toBeInTheDocument();
    expect(screen.getByText(/invoca_llm/)).toBeInTheDocument();
  });

  it("renderizza i blocchi del corpo tramite ReportRenderer quando body non e' vuoto", async () => {
    useAppStore.getState().addReport(
      makeReport({
        body: [{ kind: "text", order: 0, markdown: "Contenuto del report" }],
      }),
    );

    render(<ReportView />);

    await waitFor(() => expect(screen.getByText("Contenuto del report")).toBeInTheDocument());
  });

  it('non mostra la sezione "Dettagli" quando il body e\' vuoto', async () => {
    useAppStore.getState().addReport(makeReport({ body: [] }));
    render(<ReportView />);

    await waitFor(() => expect(screen.getByText(/Analisi: SECURITY_OWASP/)).toBeInTheDocument());
    expect(screen.queryByText("Dettagli")).not.toBeInTheDocument();
  });

  it('DIFETTO RISCONTRATO: con reportId vuoto lo spinner resta bloccato per sempre invece di mostrare "Report non trovato"', async () => {
    // Il ramo `if (reportId)` dell'useEffect e' l'unico punto che chiama
    // `setLoading(false)`: se reportId e' falsy, quella chiamata non avviene
    // mai e la pagina resta bloccata sullo spinner iniziale. In pratica la
    // rotta 'reports/$reportId' di TanStack Router garantisce sempre un
    // segmento non vuoto, quindi il ramo e' verosimilmente irraggiungibile
    // a runtime: documentiamo comunque il comportamento reale (bacato) per
    // non lasciarlo silenziosamente non specificato.
    currentReportId = "";
    render(<ReportView />);

    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/Caricamento report/i)).toBeInTheDocument();
    expect(getReportMock).not.toHaveBeenCalled();
  });

  describe("DiffViewer (proposta di modifica)", () => {
    it("non renderizza nulla se la proposal e' assente", async () => {
      useAppStore.getState().addReport(makeReport({ proposal: undefined }));
      render(<ReportView />);

      await waitFor(() => expect(screen.getByText(/Analisi: SECURITY_OWASP/)).toBeInTheDocument());
      expect(screen.queryByText(/Proposta di modifica/)).not.toBeInTheDocument();
    });

    it("non renderizza nulla se la proposal e' presente ma priva di diffUnified", async () => {
      useAppStore.getState().addReport(
        makeReport({
          proposal: { targetPath: "src/main.ts", diffUnified: "", language: "typescript" },
        }),
      );
      render(<ReportView />);

      await waitFor(() => expect(screen.getByText(/Analisi: SECURITY_OWASP/)).toBeInTheDocument());
      expect(screen.queryByText(/Proposta di modifica/)).not.toBeInTheDocument();
    });

    it("renderizza uno spazio segnaposto per le righe vuote del diff, senza collassarle", async () => {
      useAppStore.getState().addReport(
        makeReport({
          proposal: {
            targetPath: "src/main.ts",
            diffUnified: "+riga aggiunta\n\n-riga rimossa",
            language: "typescript",
          },
        }),
      );

      const { container } = render(<ReportView />);

      await waitFor(() => expect(screen.getByText(/Proposta di modifica/)).toBeInTheDocument());
      const diffLines = container.querySelectorAll("pre > div");
      expect(diffLines).toHaveLength(3);
      expect(diffLines[1].textContent).toBe(" "); // riga vuota -> segnaposto, non collassata
    });

    it("mostra il target path, il linguaggio e classifica le righe +/-/@@/contesto del diff", async () => {
      const diffUnified = [
        "--- a/src/main.ts",
        "+++ b/src/main.ts",
        "@@ -1,2 +1,3 @@",
        " const a = 1;",
        "+const b = 2;",
        "-const old = 0;",
      ].join("\n");

      useAppStore.getState().addReport(
        makeReport({
          proposal: { targetPath: "src/main.ts", diffUnified, language: "typescript" },
        }),
      );

      render(<ReportView />);

      await waitFor(() => expect(screen.getByText(/Proposta di modifica/)).toBeInTheDocument());
      // "src/main.ts" compare sia nell'intestazione ("File: ...") sia nelle
      // righe --- / +++ del diff: verifichiamo l'intestazione con un match
      // mirato invece di un generico getByText, che risulterebbe ambiguo.
      expect(screen.getByText(/^File:/).textContent).toContain("src/main.ts");
      expect(screen.getByText("typescript")).toBeInTheDocument();
      expect(screen.getByText("+const b = 2;")).toBeInTheDocument();
      expect(screen.getByText("-const old = 0;")).toBeInTheDocument();
      expect(screen.getByText("@@ -1,2 +1,3 @@")).toBeInTheDocument();
    });

    it('non mostra il badge del linguaggio quando e\' "auto"', async () => {
      useAppStore.getState().addReport(
        makeReport({
          proposal: { targetPath: "src/main.ts", diffUnified: "+riga", language: "auto" },
        }),
      );

      render(<ReportView />);

      await waitFor(() => expect(screen.getByText(/Proposta di modifica/)).toBeInTheDocument());
      expect(screen.queryByText("auto")).not.toBeInTheDocument();
    });
  });
});
