import { z } from "zod";

export const roleSchema = z.enum(["owner", "member", "viewer"]);

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: roleSchema,
});

export const signInBody = z
  .object({
    email: z.string(),
    password: z.string(),
  })
  .strict();

export const userResponse = z.object({
  user: userSchema,
});

export type User = z.infer<typeof userSchema>;
export type SignInBody = z.infer<typeof signInBody>;
