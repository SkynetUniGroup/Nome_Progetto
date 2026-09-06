import { isReadmeNonEnglish } from "./readme-language";
import { FrancFn } from "./franc.provider";

describe("isReadmeNonEnglish", () => {
  let franc: vi.fn<string, [string]>;

  beforeEach(() => {
    franc = vi.fn<string, [string]>();
  });

  it("returns false when franc detects English", () => {
    franc.mockReturnValue("eng");
    const result = isReadmeNonEnglish(
      "This project is a small command line tool for managing daily tasks.",
      franc as FrancFn,
    );
    expect(result).toBe(false);
  });

  it("returns true when franc detects a non-English language", () => {
    franc.mockReturnValue("ita");
    const result = isReadmeNonEnglish(
      "Questo progetto e uno strumento a riga di comando per gestire le attivita quotidiane.",
      franc as FrancFn,
    );
    expect(result).toBe(true);
  });

  it('treats "und" (undetermined) as not a positive non-English signal', () => {
    franc.mockReturnValue("und");
    const result = isReadmeNonEnglish(
      "xyzzy plugh xyzzy plugh xyzzy plugh xyzzy plugh",
      franc as FrancFn,
    );
    expect(result).toBe(false);
    expect(franc).toHaveBeenCalled();
  });

  it("returns false without calling franc when the excerpt is too short", () => {
    expect(isReadmeNonEnglish("# Title", franc as FrancFn)).toBe(false);
    expect(isReadmeNonEnglish("", franc as FrancFn)).toBe(false);
    expect(franc).not.toHaveBeenCalled();
  });

  it("only passes the first 1000 characters to franc", () => {
    franc.mockReturnValue("eng");
    const longContent = "a".repeat(2000);

    isReadmeNonEnglish(longContent, franc as FrancFn);

    expect(franc).toHaveBeenCalledWith("a".repeat(1000));
  });
});
