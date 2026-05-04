# Rapid Vimnote

Nota temporal offline-first con sensacion de terminal/vim. Esta pensada para abrir rapido con internet lento, escribir primero en local y sincronizar cuando la red vuelva.

## Stack

- Frontend puro: HTML, CSS y JavaScript sin framework.
- Persistencia local: IndexedDB.
- Cifrado cliente: WebCrypto AES-GCM, derivado desde `pin + topic`.
- Backend: Cloudflare Worker.
- Base de datos: Cloudflare D1.
- Shares publicos: snapshot cifrado con llave en el fragmento `#`, expiracion corta en servidor.

## Tema visual

La UI usa una version simple con colores mate y referencias barrocas discretas: fondo nogal, tinta marfil, acentos bronce, vino y musgo. Mantiene la experiencia tipo vim, pero con una apariencia mas calmada y estetica.

## Backend en dos tuits

1. Es un Cloudflare Worker: una API edge sin servidor tradicional, rapida y barata. Recibe requests para leer/guardar notas, crear shares temporales y servir la app estatica. No guarda texto real, solo contenido cifrado desde el navegador.

2. La data vive en Cloudflare D1, tipo SQLite administrado. Guarda `topic_id`, nota cifrada, `iv`, revision y expiracion de links publicos. El PIN nunca llega al backend; la llave se genera en el cliente con `PIN + topic`.

## Comandos del editor

- `i`: modo insert.
- `Esc`: modo normal.
- `:w`: guardar local y sincronizar.
- `:w!`: forzar escritura si hubo conflicto.
- `:q`: bloquear.
- `:topic nombre`: abrir otro topic.
- `:ls`: listar topics locales.
- `:sync`: traer/subir cambios.
- `:share 5m`: crear link publico temporal.
- `/texto`: buscar texto.
- `dd`, `yy`, `p`, `h`, `j`, `k`, `l`, `0`, `$`, `x`: gestos basicos tipo vim.

## Desarrollo

```powershell
npm install
npm run dev
```

No se ejecutaron pruebas por solicitud. El proyecto queda listo para agregar tests despues.

## Despliegue

Lee [docs/DEPLOY.md](docs/DEPLOY.md).
