import { z } from "zod";

const email = z.string().trim().toLowerCase().email("Enter a valid email address");
const password = z.string().min(8, "Use at least 8 characters").regex(/[A-Za-z]/, "Include a letter").regex(/\d/, "Include a digit");

export const signupSchema = z.object({
  displayName: z.string().trim().min(1, "Enter your name").max(80),
  email, password, confirm: z.string(),
}).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

export const loginSchema = z.object({ email, password: z.string().min(1, "Enter your password") });
export const forgotSchema = z.object({ email });
export const resetSchema = z.object({ password, confirm: z.string() }).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match" });

export function firstError(result: { success: false; error: z.ZodError }): string {
  return result.error.issues[0]?.message ?? "Check the form";
}
