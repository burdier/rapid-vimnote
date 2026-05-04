# Despliegue de Rapid Vimnote en Cloudflare

Esta guia usa Cloudflare Workers + D1. Es la ruta mas rapida y barata para esta app porque el HTML queda cerca del usuario, el Worker no depende de una VM encendida y D1 aguanta buen volumen para notas pequenas.

## 1. Requisitos

- Cuenta de Cloudflare.
- Node.js instalado.
- Terminal en la carpeta del proyecto:

```powershell
cd C:\Users\burdier\Downloads\rapid-vimnote
```

## 2. Instalar herramientas

```powershell
npm install
```

## 3. Deploy rapido con script

El camino mas simple en Windows es:

```powershell
.\deploy.ps1
```

El script hace esto:

- Instala dependencias con `npm install`.
- Abre login de Cloudflare si hace falta.
- Si `wrangler.toml` no tiene `database_id`, te pregunta si quieres crear la base D1.
- Aplica `db/schema.sql` en D1 remoto.
- Publica el Worker y los assets de `public/`.

Si ya tienes un `database_id`, puedes pasarlo directo:

```powershell
.\deploy.ps1 -DatabaseId TU_DATABASE_ID
```

Si quieres preparar el repo para importarlo desde GitHub en Cloudflare:

```powershell
.\deploy.ps1 -PrepareGitHub
```

Si por ahora solo quieres subirlo a GitHub, sin deploy en Cloudflare:

```powershell
.\deploy.ps1 -GitHubOnly -GitHubRemoteUrl https://github.com/TU_USUARIO/rapid-vimnote.git
```

## 4. Login en Cloudflare

```powershell
npx wrangler login
```

Se abre el navegador para autorizar Wrangler.

## 5. Crear la base D1

```powershell
npm run db:create
```

Cloudflare devolvera un bloque parecido a este:

```toml
[[d1_databases]]
binding = "DB"
database_name = "rapid-vimnote"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copia el `database_id` y reemplaza `REPLACE_WITH_D1_DATABASE_ID` en `wrangler.toml`.

## 6. Crear tablas

Para local:

```powershell
npm run db:apply:local
```

Para produccion:

```powershell
npm run db:apply:remote
```

## 7. Ejecutar local

```powershell
npm run dev
```

Abre la URL que imprima Wrangler. Normalmente sera `http://localhost:8787`.

## 8. Publicar

```powershell
npm run deploy
```

Wrangler sube el Worker y los assets de `public/`.

## 9. Importar desde GitHub en Cloudflare

Cloudflare Workers Builds permite conectar un Worker a un repo de GitHub o GitLab y desplegar en cada push.

Primero sube este proyecto a GitHub:

```powershell
.\deploy.ps1 -GitHubOnly -GitHubRemoteUrl https://github.com/TU_USUARIO/rapid-vimnote.git
```

Luego en Cloudflare:

1. Workers & Pages.
2. Create application.
3. Import a repository.
4. Selecciona GitHub y el repo `rapid-vimnote`.
5. Configura:

```text
Production branch: main
Root directory: /
Build command: dejar vacio
Deploy command: npx wrangler deploy
```

El nombre del Worker en Cloudflare debe coincidir con `name = "rapid-vimnote"` en `wrangler.toml`; si no coincide, el build puede fallar.

Importante: GitHub/Workers Builds publica el codigo, pero la base D1 debe existir y el `database_id` debe estar en `wrangler.toml`. Corre `.\deploy.ps1 -SkipDeploy` una vez para crear D1 y aplicar el schema antes de depender solo de GitHub.

## 10. Dominio propio opcional

En Cloudflare Dashboard:

1. Workers & Pages.
2. Abre `rapid-vimnote`.
3. Settings.
4. Domains & Routes.
5. Add Custom Domain.

## 11. Como se usa

1. Entra a la URL publicada.
2. Escribe un `pin` y un `topic`.
3. Usa `i` para escribir.
4. Usa `Esc` y luego `:w` para guardar.
5. Usa `:share 5m` para crear un link publico de 5 minutos.

El PIN no se guarda. Si pierdes el PIN o cambias el topic, no podras descifrar esa nota.

## 12. Notas de seguridad

- El contenido se cifra en el navegador antes de tocar el backend.
- El servidor guarda ciphertext, IV, revision y expiracion de shares.
- Los links publicos usan una llave en el fragmento `#`. Ese fragmento no se envia al servidor.
- Un PIN corto puede ser adivinado por fuerza bruta si alguien consigue el ciphertext. Para algo sensible usa PIN largo o frase corta.

## 13. Limites iniciales elegidos

- Nota cifrada: maximo aproximado de 350 KB por request.
- Share: maximo aproximado de 350 KB.
- TTL publico: entre 30 segundos y 1 hora.

Estos limites se pueden subir, pero mantenerlos pequenos ayuda a que abra rapido con internet malo.

## 14. Referencias oficiales

- Workers Builds con GitHub/GitLab: https://developers.cloudflare.com/workers/ci-cd/builds/
- Wrangler deploy: https://developers.cloudflare.com/workers/wrangler/commands/workers/#deploy
- Static Assets en Workers: https://developers.cloudflare.com/workers/static-assets/
- D1 con Wrangler: https://developers.cloudflare.com/d1/wrangler-commands/
