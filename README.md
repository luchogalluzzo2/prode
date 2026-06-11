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
- `SCORING`

Las convocatorias para Goleador, Balon de Oro y Mejor arquero estan en
`src/squads.js`. Es un archivo estatico: no requiere una tabla adicional.

Para regenerarlo desde el PDF oficial:

```bash
python3 tools/extract_squads.py /ruta/SquadLists-Spanish.pdf src/squads.js
```

## Publicacion

La version hosteada esta preparada para Vercel. Subir el proyecto completo al
repositorio conectado a Vercel; para este cambio alcanzan:

- `src/app.js`
- `src/styles.css`
- `src/squads.js`
- `tools/extract_squads.py` y `README.md` (documentacion/reproducibilidad)

No hay que ejecutar SQL ni modificar Supabase para actualizar las listas.

El administrador carga los ganadores oficiales de Goleador, Balon de Oro y
Mejor arquero desde la pestana Admin. Se guardan junto con los resultados
reales existentes y el ranking suma automaticamente los puntos configurados en
`SCORING`.

Desde la pestana Admin tambien puede cerrar globalmente el prode. Al activarlo,
los pronosticos y premios de todos los participantes quedan en modo lectura,
pero el administrador puede seguir cargando resultados oficiales.

## Fuentes

- Fixture FIFA World Cup 26 Match Schedule v17, 10 April 2026.
- Pagina oficial FIFA de fixture y estadios 2026.

## Supabase

1. Crear proyecto en Supabase.
2. En Supabase, ir a SQL Editor y ejecutar `supabase/schema.sql`.
   Volver a ejecutarlo al desplegar cambios de politicas, como el cierre global
   del prode.
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
