import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { NotFoundException } from "@nestjs/common";
import { CredentialsService } from "./credentials.service";
import { CredentialCipherService } from "./credential-cipher.service";
import { GithubClientService } from "../github/github-client.service";
import { ServiceCredential } from "./schemas/service-credential.schema";

describe("CredentialsService", () => {
  let service: CredentialsService;
  let model: {
    findOneAndUpdate: vi.fn;
    find: vi.fn;
    findOneAndDelete: vi.fn;
    findOne: vi.fn;
    exists: vi.fn;
  };
  let cipher: { encrypt: vi.fn; decrypt: vi.fn };
  let github: { verifyToken: vi.fn };

  beforeEach(async () => {
    model = {
      findOneAndUpdate: vi.fn(),
      find: vi.fn(),
      findOneAndDelete: vi.fn(),
      findOne: vi.fn(),
      exists: vi.fn(),
    };
    cipher = {
      encrypt: vi.fn().mockReturnValue({
        ciphertext: Buffer.from("c"),
        iv: Buffer.from("i"),
        salt: Buffer.from("s"),
        authTag: Buffer.from("a"),
      }),
      decrypt: vi.fn().mockReturnValue("ghp_decrypted"),
    };
    github = { verifyToken: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CredentialsService,
        { provide: getModelToken(ServiceCredential.name), useValue: model },
        { provide: CredentialCipherService, useValue: cipher },
        { provide: GithubClientService, useValue: github },
      ],
    }).compile();

    service = module.get(CredentialsService);
  });

  describe("create", () => {
    it("encrypts and upserts when GitHub accepts the token with repo scope", async () => {
      github.verifyToken.mockResolvedValue({ scopes: ["repo", "gist"] });
      model.findOneAndUpdate.mockResolvedValue({
        _id: "cred1",
        provider: "GITHUB",
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      const result = await service.create("user1", {
        provider: "GITHUB",
        token: "ghp_test",
      });

      expect(cipher.encrypt).toHaveBeenCalledWith("ghp_test");

      const [filter, update, options] = model.findOneAndUpdate.mock.calls[0] as [
        Record<string, unknown>,
        Record<string, unknown>,
        Record<string, unknown>,
      ];
      expect(filter).toEqual({ userId: "user1", provider: "GITHUB" });
      expect(update.ciphertext).toEqual(Buffer.from("c"));
      expect(update.connectedAt).toBeInstanceOf(Date);
      expect(options).toEqual({ upsert: true, new: true });

      expect(result).toEqual({
        id: "cred1",
        provider: "GITHUB",
        connectedAt: "2026-01-01T00:00:00.000Z",
      });
    });

    it("rejects with CREDENTIAL_INVALID when GitHub returns 401, without writing anything", async () => {
      github.verifyToken.mockRejectedValue({ status: 401 });

      await expect(
        service.create("user1", { provider: "GITHUB", token: "bad" }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects with CREDENTIAL_INVALID when the token lacks the repo scope", async () => {
      github.verifyToken.mockResolvedValue({ scopes: ["gist"] });

      await expect(
        service.create("user1", { provider: "GITHUB", token: "ghp_test" }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("accepts a fine-grained token even when GitHub reports no scopes", async () => {
      // Fine-grained PATs never populate X-OAuth-Scopes — an empty list here
      // is the normal, valid case for one, not a sign of missing access.
      github.verifyToken.mockResolvedValue({ scopes: [] });
      model.findOneAndUpdate.mockResolvedValue({
        _id: "cred1",
        provider: "GITHUB",
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      });

      await expect(
        service.create("user1", {
          provider: "GITHUB",
          token: "github_pat_11ABC_fakeFineGrainedToken",
        }),
      ).resolves.toMatchObject({ id: "cred1" });
      expect(model.findOneAndUpdate).toHaveBeenCalled();
    });

    it("still rejects a fine-grained token that GitHub itself rejects", async () => {
      github.verifyToken.mockRejectedValue({ status: 401 });

      await expect(
        service.create("user1", {
          provider: "GITHUB",
          token: "github_pat_11ABC_fakeFineGrainedToken",
        }),
      ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" });
      expect(model.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("propagates a non-401 failure instead of misreporting it as a bad credential", async () => {
      const networkError = new Error("getaddrinfo ENOTFOUND api.github.com");
      github.verifyToken.mockRejectedValue(networkError);

      await expect(service.create("user1", { provider: "GITHUB", token: "ghp_test" })).rejects.toBe(
        networkError,
      );
    });
  });

  describe("remove", () => {
    it("throws NotFoundException when nothing matches the id and owner", async () => {
      model.findOneAndDelete.mockResolvedValue(null);

      await expect(service.remove("user1", "cred1")).rejects.toThrow(NotFoundException);
    });

    it("resolves when the credential is found and deleted", async () => {
      model.findOneAndDelete.mockResolvedValue({ _id: "cred1" });

      await expect(service.remove("user1", "cred1")).resolves.toBeUndefined();
      expect(model.findOneAndDelete).toHaveBeenCalledWith({
        _id: "cred1",
        userId: "user1",
      });
    });
  });

  describe("revalidate", () => {
    it("updates connectedAt and returns the DTO on a successful re-check", async () => {
      const stored = {
        _id: "cred1",
        provider: "GITHUB",
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
        save: vi.fn().mockResolvedValue(undefined),
      };
      model.findOne.mockResolvedValue(stored);
      github.verifyToken.mockResolvedValue({ scopes: ["repo"] });

      const result = await service.revalidate("user1", "cred1");

      expect(cipher.decrypt).toHaveBeenCalledWith(stored);
      expect(stored.save).toHaveBeenCalled();
      expect(result.provider).toBe("GITHUB");
    });

    it("leaves the stored record untouched when the token no longer works", async () => {
      const stored = {
        _id: "cred1",
        provider: "GITHUB",
        connectedAt: new Date("2026-01-01T00:00:00.000Z"),
        save: vi.fn(),
      };
      model.findOne.mockResolvedValue(stored);
      github.verifyToken.mockRejectedValue({ status: 401 });

      await expect(service.revalidate("user1", "cred1")).rejects.toMatchObject({
        code: "CREDENTIAL_INVALID",
      });
      expect(stored.save).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the credential does not belong to the caller", async () => {
      model.findOne.mockResolvedValue(null);

      await expect(service.revalidate("user1", "cred1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("getDecryptedToken", () => {
    it("throws NotFoundException when no credential is configured for the provider", async () => {
      model.findOne.mockResolvedValue(null);

      await expect(service.getDecryptedToken("user1", "GITHUB")).rejects.toThrow(NotFoundException);
    });

    it("decrypts and returns the stored token", async () => {
      const stored = { ciphertext: Buffer.from("x") };
      model.findOne.mockResolvedValue(stored);

      const token = await service.getDecryptedToken("user1", "GITHUB");

      expect(cipher.decrypt).toHaveBeenCalledWith(stored);
      expect(token).toBe("ghp_decrypted");
    });
  });

  describe("hasCredential", () => {
    it("returns true when a credential exists for that provider", async () => {
      model.exists.mockResolvedValue({ _id: "cred1" });

      await expect(service.hasCredential("user1", "GITHUB")).resolves.toBe(true);
      expect(model.exists).toHaveBeenCalledWith({
        userId: "user1",
        provider: "GITHUB",
      });
    });

    it("returns false when none is configured, without decrypting anything", async () => {
      model.exists.mockResolvedValue(null);

      await expect(service.hasCredential("user1", "GITHUB")).resolves.toBe(false);
      expect(cipher.decrypt).not.toHaveBeenCalled();
    });
  });
});
