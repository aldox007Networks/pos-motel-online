# POS Motel EN LÍNEA — Barcelona y Amsterdam

Punto de venta en la nube (React + Vite + Supabase + Vercel), estilo iTask.
Todas las terminales sincronizan en tiempo real y el administrador monitorea
ambos moteles desde cualquier lugar.

## Qué cambió respecto a la versión de escritorio

- **En línea, no stand-alone**: los datos viven en Supabase; ya no hay `.exe`.
- **Monitoreo central**: el admin ve en vivo ventas, stock bajo y cortes de
  Motel Barcelona y Motel Amsterdam, actualizado cada 15 segundos.
- **Dos sucursales**: cada motel tiene su propio catálogo, tickets y cortes.
  Se despliega una URL por motel (con la variable `VITE_SUCURSAL`).
- **Venta simplificada**: solo efectivo. Se eligen productos → COBRAR →
  se muestra el total → Confirmar. Sin tarjeta, sin transferencia y sin
  capturar el efectivo recibido.

---

## PASO 1 — Crear la base de datos en Supabase (gratis)

1. Entra a https://supabase.com y crea una cuenta.
2. **New project** → nombre `pos-moteles`, define una contraseña de base de
   datos (guárdala) y elige la región más cercana (US East). Espera ~2 min.
3. En el menú lateral abre **SQL Editor → New query**.
4. Abre el archivo `supabase-schema.sql` de este proyecto, copia **todo** su
   contenido, pégalo y presiona **Run**. Debe decir "Success".
5. Ve a **Settings (engrane) → API** y copia dos valores; los usarás en el paso 3:
   - **Project URL** (algo como `https://xxxx.supabase.co`)
   - **anon public** key (una cadena larga)
6. Ve a **Authentication → Providers → Email** y **desactiva** "Confirm email"
   (para que las cajeras entren de inmediato sin correo de confirmación).
   Guarda los cambios.

---

## PASO 2 — Subir el código a GitHub

1. Crea un repositorio nuevo (ej. `pos-motel-online`).
2. Sube el contenido de este proyecto con *Add file → Upload files*:
   - archivos sueltos: `package.json`, `index.html`, `vite.config.js`,
     `.gitignore`, `supabase-schema.sql`, `README.md`
   - carpeta `src` completa (`App.jsx`, `main.jsx`, `supabase.js`)
3. Commit.

> No subas `node_modules` (el `.gitignore` ya lo excluye).

---

## PASO 3 — Desplegar en Vercel (una URL por motel)

Entra a https://vercel.com, regístrate con tu cuenta de GitHub e importa el
repositorio `pos-motel-online`. Vercel detecta Vite automáticamente.

### Terminal de Motel Barcelona
En **Environment Variables** agrega estas tres:

| Nombre | Valor |
|---|---|
| `VITE_SUPABASE_URL` | (tu Project URL de Supabase) |
| `VITE_SUPABASE_ANON_KEY` | (tu anon public key) |
| `VITE_SUCURSAL` | `barcelona` |

Presiona **Deploy**. Obtendrás una URL, por ejemplo
`https://pos-barcelona.vercel.app`. Esa es la de la caja de Barcelona.

### Terminal de Motel Amsterdam
En el mismo proyecto de Vercel: **Settings → Domains** no; mejor usa
**Settings → Environment Variables** y crea un segundo despliegue así:

La forma más simple es **importar el mismo repositorio otra vez** como un
segundo proyecto en Vercel (botón *Add New → Project* → mismo repo), y en sus
variables poner `VITE_SUCURSAL = amsterdam` (las otras dos iguales).
Obtendrás otra URL, ej. `https://pos-amsterdam.vercel.app`.

> Resultado: dos URLs, una por motel, ambas apuntando a la misma base de datos
> pero cada una filtrando su propia sucursal. El administrador puede entrar por
> cualquiera de las dos (o por una tercera sin `VITE_SUCURSAL`) y cambiar de
> motel con el selector superior.

---

## PASO 4 — Primer arranque

1. Abre la URL de cualquier motel. En la pantalla de acceso, clic en
   **"Configuración inicial (crear administrador)"**.
2. Escribe un usuario (ej. `admin`) y una contraseña de al menos 6 caracteres.
   Crea el administrador. Este paso se hace **una sola vez**.
3. Inicia sesión con ese admin.
4. Ve a **👥 Usuarios → Nuevo usuario** y da de alta a cada cajera:
   nombre, usuario, contraseña y la **sucursal** que le corresponde.
5. Cambia de sucursal con el selector superior y captura el catálogo de cada
   motel en **📦 Inventario** (nombre, precio, mínimos y máximos).

Las cajeras entran con su usuario y contraseña en la URL de su motel; solo
verán Ventas y Mi resumen, siempre de su sucursal.

---

## Cómo se usa la venta (cajera)

1. Escanea o toca los productos → se agregan al ticket.
2. Presiona **COBRAR**.
3. Aparece el total en grande → **Confirmar venta**.
4. Se imprime el ticket. Listo. (Todo es efectivo.)

Al final del turno: **🗂️ Corte de turno** imprime el resumen de efectivo más el
inventario de entrega con firmas.

---

## Respaldos

Supabase respalda automáticamente la base de datos. Además, el administrador
puede descargar los cortes en CSV desde la pestaña Cortes. Para un respaldo
manual completo: Supabase → Database → Backups.

## Actualizaciones

Sube los cambios al repositorio de GitHub y Vercel redespliega solo, en ambas
terminales, en segundos.

## Nota sobre internet

Al ser un sistema en línea, la caja necesita conexión para registrar ventas.
Recomendación operativa: una conexión de respaldo (datos móviles / segundo
módem) en cada motel para no detener la fila si falla el internet principal.
