import { z } from "zod";

/** Shared login/create constraints. Passwords are validated by UTF-8 byte length. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export const usernameSchema = z
  .string()
  .trim()
  .min(3, "Use 3 to 64 letters, numbers, dots, underscores, or hyphens.")
  .max(64, "Use 3 to 64 letters, numbers, dots, underscores, or hyphens.")
  .regex(
    /^[A-Za-z0-9._-]+$/,
    "Use 3 to 64 letters, numbers, dots, underscores, or hyphens.",
  );

export const passwordSchema = z
  .string()
  .refine((v) => byteLength(v) >= 12, "Use 12 to 128 characters.")
  .refine((v) => byteLength(v) <= 128, "Use 12 to 128 characters.");

export const loginSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "Username must be 3 to 64 characters.")
    .max(64, "Username must be 3 to 64 characters."),
  password: z
    .string()
    .min(1, "Enter your password.")
    .refine((v) => byteLength(v) <= 128, "Password is too long."),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z
  .object({
    username: usernameSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, "Confirm the password."),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords do not match.",
    path: ["confirmPassword"],
  });

export type CreateUserInput = z.infer<typeof createUserSchema>;
