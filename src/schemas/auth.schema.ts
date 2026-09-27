import { z } from "zod";

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(3, "El nombre de usuario debe tener al menos 3 caracteres")
    .max(100, "El nombre de usuario no puede superar los 100 caracteres"),

  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("El correo electrónico no es válido")
    .max(255, "El correo electrónico es demasiado largo"),

  password: z
    .string()
    .min(8, "La contraseña debe tener al menos 8 caracteres")
    .max(128, "La contraseña es demasiado larga")
    .regex(
      /[A-Z]/,
      "La contraseña debe contener al menos una letra mayúscula"
    )
    .regex(
      /[a-z]/,
      "La contraseña debe contener al menos una letra minúscula"
    )
    .regex(
      /[0-9]/,
      "La contraseña debe contener al menos un número"
    ),
});

export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("El correo electrónico no es válido")
    .max(255, "El correo electrónico es demasiado largo"),

  password: z
    .string()
    .min(1, "La contraseña es obligatoria")
    .max(128, "La contraseña es demasiado larga"),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;