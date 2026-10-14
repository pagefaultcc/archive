import { afterEach, describe, expect, it } from "vitest";
import { serverGetMe, serverListUsers } from "@/lib/api";

const configuredUrl = process.env.INTERNAL_API_URL;

afterEach(() => {
  if (configuredUrl === undefined) {
    delete process.env.INTERNAL_API_URL;
  } else {
    process.env.INTERNAL_API_URL = configuredUrl;
  }
});

describe("server API configuration", () => {
  it("returns a retryable network result when INTERNAL_API_URL is absent", async () => {
    delete process.env.INTERNAL_API_URL;

    await expect(serverGetMe(undefined)).resolves.toEqual({
      ok: false,
      status: 0,
      error: null,
      networkError: true,
    });
    await expect(serverListUsers(undefined)).resolves.toEqual({
      ok: false,
      status: 0,
      error: null,
      networkError: true,
    });
  });
});
