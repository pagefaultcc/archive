import { describe, expect, it } from "vitest";
import { createUserSchema, loginSchema } from "@/lib/validation";

describe("createUserSchema", () => {
  it("rejects mismatched confirm-password", () => {
    const result = createUserSchema.safeParse({
      username: "operator_1",
      password: "ArchiveUser!2026",
      confirmPassword: "different",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "confirmPassword");
      expect(issue?.message).toBe("Passwords do not match.");
    }
  });

  it("accepts matching passwords", () => {
    const result = createUserSchema.safeParse({
      username: "operator_1",
      password: "ArchiveUser!2026",
      confirmPassword: "ArchiveUser!2026",
    });
    expect(result.success).toBe(true);
  });

  it("enforces username charset and 12-byte password minimum", () => {
    expect(
      createUserSchema.safeParse({
        username: "bad name!",
        password: "longenoughpassword",
        confirmPassword: "longenoughpassword",
      }).success,
    ).toBe(false);
    expect(
      createUserSchema.safeParse({
        username: "operator_1",
        password: "short12pass!",
        confirmPassword: "short12pass!",
      }).success,
    ).toBe(true);
    expect(
      createUserSchema.safeParse({
        username: "operator_1",
        password: "short11pass",
        confirmPassword: "short11pass",
      }).success,
    ).toBe(false);
  });
});

describe("loginSchema", () => {
  it("requires username and password presence with bounds", () => {
    expect(loginSchema.safeParse({ username: "ab", password: "x" }).success).toBe(false);
    expect(
      loginSchema.safeParse({ username: "playersclub", password: "" }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({
        username: "playersclub",
        password: "x".repeat(129),
      }).success,
    ).toBe(false);
    expect(
      loginSchema.safeParse({ username: "playersclub", password: "anything" })
        .success,
    ).toBe(true);
  });
});
