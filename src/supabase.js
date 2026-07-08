import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const configurado = Boolean(url && anon);

/* Cliente principal (sesión de la cajera o el admin) */
export const supabase = configurado ? createClient(url, anon) : null;

/* Cliente secundario SIN sesión persistente:
   lo usa el admin para dar de alta cajeras (signUp)
   sin que se cierre su propia sesión. */
export const supabaseAlta = configurado
  ? createClient(url, anon, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

/* Los usuarios inician sesión con un "usuario" corto;
   internamente se convierte en un correo sintético. */
export const usuarioAEmail = (usuario) =>
  `${usuario.trim().toLowerCase()}@pos-motel.local`;
