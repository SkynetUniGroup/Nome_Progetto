import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { RepoResolverService } from "./repo-resolver.service";
import { GithubClientService } from "../github/github-client.service";

describe("RepoResolverService", () => {
  let service: RepoResolverService;
  let github: { getRepository: vi.fn };

  beforeEach(async () => {
    github = { getRepository: vi.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RepoResolverService, { provide: GithubClientService, useValue: github }],
    }).compile();

    service = module.get(RepoResolverService);
  });

  it("extracts owner/repo from the URL and returns isPrivate from GitHub", async () => {
    github.getRepository.mockResolvedValue({
      owner: "owner",
      name: "repo",
      isPrivate: true,
      defaultBranch: "main",
      primaryLanguage: "TypeScript",
    });

    const result = await service.resolve("token", "https://github.com/owner/repo");

    expect(result).toEqual({ owner: "owner", repo: "repo", isPrivate: true });
    expect(github.getRepository).toHaveBeenCalledWith("token", "owner", "repo");
  });

  it("throws a combined NotFoundException on a GitHub 404 (nonexistent or inaccessible)", async () => {
    github.getRepository.mockRejectedValue({ status: 404 });

    await expect(service.resolve("token", "https://github.com/owner/repo")).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("propagates any other failure uncaught", async () => {
    github.getRepository.mockRejectedValue({ status: 500 });

    await expect(
      service.resolve("token", "https://github.com/owner/repo"),
    ).rejects.not.toBeInstanceOf(NotFoundException);
  });
});
