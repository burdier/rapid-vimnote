# Rapid Vimnote

Nota temporal offline-first con sensacion de terminal/vim. Esta pensada para abrir rapido con internet lento, escribir primero en local y sincronizar cuando la red vuelva.

## Stack

- Frontend puro: HTML, CSS y JavaScript sin framework.
- Persistencia local: IndexedDB.
- Cifrado cliente: WebCrypto AES-GCM, derivado desde `pin + topic`.
- Backend: Cloudflare Worker.
- Base de datos: Cloudflare D1.
- Shares publicos: snapshot cifrado de un archivo con expiracion corta en servidor.

## Tema visual

La UI usa una version simple con colores mate y referencias barrocas discretas: fondo nogal, tinta marfil, acentos bronce, vino y musgo. Mantiene la experiencia tipo vim, pero con una apariencia mas calmada y estetica.

## Backend en dos tuits

1. Es un Cloudflare Worker: una API edge sin servidor tradicional, rapida y barata. Recibe requests para leer/guardar notas, crear shares temporales y servir la app estatica. No guarda texto real, solo contenido cifrado desde el navegador.

2. La data vive en Cloudflare D1, tipo SQLite administrado. Guarda `topic_id`, nota cifrada, `iv`, revision y expiracion de links publicos. El PIN nunca llega al backend; la llave se genera en el cliente con `PIN + topic`.

## Modos

Rapid Vimnote tiene dos modos para el mismo cuaderno cifrado:

- Modo normal: escritorio simple con archivos `.txt`. Click derecho permite crear archivo, abrir, compartir, renombrar, borrar y cambiar el fondo.
- Modo nerd: terminal basica con comandos tipo Unix y `vim` para editar archivos.

El boton `Modo nerd` / `Modo normal` cambia entre ambos sin cambiar de cuaderno.

En movil, tocar un documento lo abre y toque prolongado abre el menu contextual. En modo nerd hay botones rapidos para `ls`, `cat`, `touch`, `vim`, `share` y `sync`.

## Links faciles

Cada cuaderno usa una URL corta basada en su nombre. Si tu dominio es `https://notas.dev` y el cuaderno se llama `ideas`, la URL queda:

```text
https://notas.dev/ideas
```

Esa URL solo prellena el cuaderno. Para abrirlo desde otro navegador todavia necesitas el mismo PIN.

El boton `Cuaderno` copia esa URL corta. Ese link abre el espacio/cuaderno, pero sigue pidiendo PIN.

El boton `Archivo` comparte solo el contenido del archivo actual. Los links publicos de archivo ahora tambien son cortos:

```text
https://notas.dev/ab30d
```

Para lograrlo, el share temporal guarda la llave del share en el servidor hasta que expire. El cuaderno privado no cambia: sigue cifrado con `PIN + cuaderno` y el PIN nunca llega al backend.

Si un link corto dice que no tiene llave temporal, fue creado antes de esta version o con cache vieja del navegador. Vuelve a compartir el archivo para generar un link corto nuevo.

## Comandos nerd

- `ls`: lista archivos.
- `cat file.txt`: muestra un archivo.
- `touch file.txt`: crea o actualiza un archivo.
- `echo "texto" >> file.txt`: agrega texto al archivo.
- `echo "texto" > file.txt`: reemplaza el archivo.
- `vim file.txt`: abre el archivo en editor tipo vim.
- `share 5m file.txt`: crea link publico temporal.
- `sync`: sincroniza.
- `desktop`: vuelve al modo normal.
- `lock`: bloquea el cuaderno.

## Vim dentro del modo nerd

- `i`: modo insert.
- `Esc`: modo normal.
- `:w`: guardar local y sincronizar.
- `:w!`: forzar escritura si hubo conflicto.
- `:q`: salir de vim y volver a la terminal.
- `:lock`: bloquear el cuaderno.
- `:e file.txt`: abrir otro archivo.
- `:ls`: listar archivos del cuaderno.
- `:sync`: traer/subir cambios.
- `:share 5m file.txt`: crear link publico temporal.
- `/texto`: buscar texto.
- `dd`, `yy`, `p`, `h`, `j`, `k`, `l`, `0`, `$`, `x`: gestos basicos tipo vim.

En modo normal tambien hay un boton visible `Archivo` en la barra superior para compartir solo el archivo actual por 5 minutos.

## Desarrollo

```powershell
npm install
npm run dev
```

No se ejecutaron pruebas por solicitud. El proyecto queda listo para agregar tests despues.

## Despliegue

Lee [docs/DEPLOY.md](docs/DEPLOY.md).
