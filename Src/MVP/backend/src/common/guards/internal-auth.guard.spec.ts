import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, createHmac } from "crypto";
import { InternalAuthGuard } from "./internal-auth.guard";

const SECRET = "test-only-internal-shared-secret";

function sign(timestamp: string, method: string, path: string, body: Buffer): string {
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const message = `${timestamp}:${method}:${path}:${bodyHash}`;
  return createHmac("sha256", SECRET).update(message).digest("hex");
}

function makeContext(request: {
  headers: Record<string, string>;
  method: string;
  path: string;
  rawBody?: Buffer;
}): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

describe("InternalAuthGuard", () => {
  let guard: InternalAuthGuard;
  let config: { get: vi.fn };

  beforeEach(() => {
    config = {
      get: vi.fn((key: string) => {
        if (key === "INTERNAL_SHARED_SECRET") return SECRET;
        if (key === "HMAC_WINDOW_S") return 30;
        return undefined;
      }),
    };
    guard = new InternalAuthGuard(config as unknown as ConfigService);
  });

  it("accepts a correctly signed request", () => {
    const rawBody = Buffer.from(JSON.stringify({ taskId: "task1" }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, "POST", "/internal/github/tree", rawBody);

    const context = makeContext({
      headers: {
        "x-internal-timestamp": timestamp,
        "x-internal-signature": signature,
      },
      method: "POST",
      path: "/internal/github/tree",
      rawBody,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it("rejects a request signed with the wrong secret", () => {
    const rawBody = Buffer.from(JSON.stringify({ taskId: "task1" }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = createHash("sha256").update(rawBody).digest("hex");
    const message = `${timestamp}:POST:/internal/github/tree:${bodyHash}`;
    const wrongSignature = createHmac("sha256", "not-the-real-secret")
      .update(message)
      .digest("hex");

    const context = makeContext({
      headers: {
        "x-internal-timestamp": timestamp,
        "x-internal-signature": wrongSignature,
      },
      method: "POST",
      path: "/internal/github/tree",
      rawBody,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a request whose body was tampered with after signing", () => {
    const signedBody = Buffer.from(JSON.stringify({ taskId: "task1" }));
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(timestamp, "POST", "/internal/github/tree", signedBody);

    // The signature was computed over signedBody, but the request that
    // actually arrives carries a different body.
    const tamperedBody = Buffer.from(JSON.stringify({ taskId: "task2" }));
    const context = makeContext({
      headers: {
        "x-internal-timestamp": timestamp,
        "x-internal-signature": signature,
      },
      method: "POST",
      path: "/internal/github/tree",
      rawBody: tamperedBody,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a stale timestamp even with a valid signature for it", () => {
    const rawBody = Buffer.from(JSON.stringify({ taskId: "task1" }));
    const staleTimestamp = String(Math.floor(Date.now() / 1000) - 300); // 5 min old
    const signature = sign(staleTimestamp, "POST", "/internal/github/tree", rawBody);

    const context = makeContext({
      headers: {
        "x-internal-timestamp": staleTimestamp,
        "x-internal-signature": signature,
      },
      method: "POST",
      path: "/internal/github/tree",
      rawBody,
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it("rejects a request missing the signature header", () => {
    const context = makeContext({
      headers: {
        "x-internal-timestamp": String(Math.floor(Date.now() / 1000)),
      },
      method: "POST",
      path: "/internal/github/tree",
      rawBody: Buffer.alloc(0),
    });

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });
});
