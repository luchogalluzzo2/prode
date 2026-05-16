# Prode Mundial 2026

App web estatica para pronosticar el Mundial 2026.

## Correr local

```bash
python3 -m http.server 4173
```

Abrir `http://127.0.0.1:4173`.

## Admin inicial

- Usuario: `admin`
- Contrasena: `mundial2026`

## Persistencia

La app usa Supabase cuando Vercel expone `SUPABASE_URL` y `SUPABASE_ANON_KEY`.
Si no existen esas variables, cae a `localStorage` para poder probar local.

Los datos base del fixture siguen en `src/data.js`:

- `TEAMS`
- `GROUPS`
- `MATCHES`
- `KNOCKOUT`
- `AWARD_PLAYERS`
- `SCORING`

## Fuentes

- Fixture FIFA World Cup 26 Match Schedule v17, 10 April 2026.
- Pagina oficial FIFA de fixture y estadios 2026.

## Supabase

1. Crear proyecto en Supabase.
2. En Supabase, ir a SQL Editor y ejecutar `supabase/schema.sql`.
3. En Authentication > Providers > Email, desactivar confirmacion de email para este prode privado.
4. Crear el usuario `admin` desde la app.
5. En Supabase SQL Editor, ejecutar:

```sql
update public.profiles set role = 'admin' where username = 'admin';
```

6. En Vercel, configurar variables:

```text
SUPABASE_URL=...
SUPABASE_ANON_KEY=...
```

El endpoint `/api/config` las entrega al frontend.

Tablas creadas:

- `users`
- `predictions`
- `real_results`
- `profiles`
