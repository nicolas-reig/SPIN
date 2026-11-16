# De los cambios de la IA a una versión que tú aceptas

Un lote de cambios vive en una **rama de revisión**. Puede tener un commit o
veinte: al abrir la aplicación desde esa rama, pruebas todos los cambios
acumulados. Una **pull request (PR)** propone incorporar ese lote a `main`;
en GitHub se llama así a lo que otras plataformas llaman merge request.

El recorrido es:

```text
IA trabaja en review/... y hace commits
                 |
        Tú pruebas esa versión
                 |
      PR con los tests en verde
                 |
          Tú pulsas Merge
                 |
    main vuelve a pasar los tests
                 |
        Paquete para descargar
```

## 1. Pide un lote a la IA

Puedes decirle:

> Crea una rama `review/mejoras-inspector` desde el último `main`. Haz estos
> cambios y guarda los commits en esa rama. Déjame la aplicación lista para
> probarla e indica la rama y el commit exacto. Abre una PR con los tests y los
> pasos de prueba. No la fusiones ni publiques una release; decidiré yo después
> de probarla.

Si quieres agrupar lo hecho durante un día, puedes usar `review/2026-11-16`.
No hace falta una rama por commit ni un horario automático de revisión.
Para añadir más cambios al mismo lote, di **«continúa en esta misma rama»**.

Si los commits ya están repartidos en otras ramas, indica a la IA cuáles quieres
reunir y pídele una rama nueva con ese conjunto. No hace falta fusionar ramas
enteras si solo quieres algunos commits.

## 2. Prueba la aplicación con el lote completo

La IA debe dejarte la rama de revisión activa y el trabajo guardado en commits.
Puedes comprobarlo desde `WebApp`:

```sh
git branch --show-current
git status --short
git log -1 --oneline
```

El primer comando debe mostrar `review/...`; el segundo no debe mostrar cambios
pendientes. Así sabes qué versión estás probando. La carpeta `frontend/` contiene
esa versión de la aplicación.

Usa el servidor de desarrollo que ya tengas abierto. Si no hay uno en ese puerto,
puedes iniciarlo con:

```sh
php -S 127.0.0.1:8000 -t frontend
```

Abre <http://127.0.0.1:8000> y recarga la página. Esto prueba la copia local,
sin actualizar el servidor de Windows. Conserva tu `config.php` y los directorios
de contenido; si vas a borrar o modificar datos como parte de la prueba, usa una
copia separada del contenido.

Si no te gusta algo, pide los ajustes en la misma rama. Los nuevos commits se
añaden al lote y a su PR. Después vuelve a probar la nueva versión.

## 3. Revisa la PR y acepta cuando te convenza

Los tests automáticos arrancan al subir los commits y al abrir o actualizar la
PR. Pueden ejecutarse mientras tú pruebas: no tienes que iniciarlos a mano.

Cuando la aplicación te convenza y `CI / required` esté en verde para el commit
actual, marca tu comprobación manual en la PR y pulsa **Merge pull request**.
Si faltan correcciones, la PR se queda abierta y `main` conserva la versión
anterior. Si otra PR cambió `main`, actualiza la rama y vuelve a comprobar el
resultado antes de fusionar.

La casilla manual documenta tu decisión; las instrucciones para la IA le impiden
marcarla o fusionar por su cuenta. La casilla no es un bloqueo técnico adicional.

## 4. Descarga el paquete de lo aceptado

Después del merge se ejecuta CI sobre el nuevo `main`. Si pasa, en
[Actions > CI](https://github.com/nicolas-reig/SPIN/actions/workflows/ci.yml)
aparece el artefacto `spin-<commit>` de ese run. Contiene el `.tar.gz` de la
aplicación y su `.sha256`. Se conserva durante 14 días.

Las ramas de trabajo y las PR ejecutan los tests, pero no entregan un paquete de
instalación. Así el paquete descargable corresponde a lo ya aceptado en `main`.
Los tests internos de empaquetado sí prueban archivos temporales en todas las
ramas para detectar problemas antes del merge.

Un paquete de Actions ya sirve para la instalación manual. Una **GitHub Release
con número**, como `v1.0.0`, es opcional: se publica al pedir expresamente un tag
de versión sobre `main`, pasa de nuevo los tests y conserva sus archivos más allá
de los 14 días. El paso a Windows sigue siendo una decisión separada.

## Para empezar otro lote

Pide **«parte del último main y crea una nueva rama review/... para estos cambios»**.
Después del merge, la rama anterior se puede eliminar. Las instrucciones del
repositorio están en [AGENTS.md](../AGENTS.md) para las IA que lean ese archivo.
