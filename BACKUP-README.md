# BACKUP COMPLETO — La Mia Spesa V3.0

Questo branch è una fotografia completa dell'app alla versione 3.0.

## Contiene
- Tutto il codice della PWA.
- CSS, JavaScript, HTML, manifest e Service Worker.
- L'icona dell'app.
- products-master.json con la Libreria Master completa.
- Il codice del Cloudflare Worker in CLOUDFARE/worker.js.
- Le istruzioni di ripristino.

## Ripristino rapido
1. Scaricare questo branch come ZIP oppure caricarne il contenuto in un nuovo repository GitHub.
2. Pubblicare il repository con GitHub Pages.
3. Creare un Cloudflare Worker usando CLOUDFARE/worker.js.
4. Configurare le variabili/segreti indicate in CLOUDFARE/CONFIGURAZIONE.txt.
5. Se cambia il dominio del Worker, aggiornare MASTER_API_URL in js/app.js.
6. Se cambia il percorso GitHub Pages, verificare start_url e scope in manifest.json.

## Sicurezza
I segreti non sono inclusi in questo backup:
- GITHUB_TOKEN
- ADMIN_KEY

Devono essere conservati separatamente e reinseriti nel nuovo Worker.

Backup creato dal repository MarrapodiStefano/lista-spesa, branch main, versione applicazione V3.0.

## Ultimo aggiornamento backup
Include l'ultima modifica della modalità amministratore: pulsante “Esci dalla modalità amministratore”, correzione CSS e aggiornamento cache PWA.
